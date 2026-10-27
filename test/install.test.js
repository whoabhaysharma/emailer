import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const root = mkdtempSync(join(tmpdir(), "email-agent-install-"))
const home = join(root, "home")
const data = join(root, "data")
const configDir = join(root, "opencode")
mkdirSync(home, { recursive: true })
mkdirSync(data, { recursive: true })
mkdirSync(configDir, { recursive: true })
process.env.EMAIL_AGENT_HOME = home
process.env.EMAIL_AGENT_DATA = data
process.env.OPENCODE_CONFIG_DIR = configDir

const { installAsset, installPluginPackage, findPluginRegistration, removePluginPackage } = await import(
  "../src/cli/install.js"
)
const { packageRoot } = await import("../src/paths.js")

process.on("exit", () => rmSync(root, { recursive: true, force: true }))

function writeConfig(plugins) {
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ plugins }, null, 2))
}

test("installAsset writes, leaves identical files alone, and keeps edits without --force", () => {
  const destination = join(root, "assets", "note.md")

  const first = installAsset("commands/status.md", destination)
  assert.equal(first.changed, true)
  assert.match(readFileSync(destination, "utf8"), /dashboard/i)

  const second = installAsset("commands/status.md", destination)
  assert.equal(second.changed, false)

  writeFileSync(destination, "edited\n")
  const kept = installAsset("commands/status.md", destination)
  assert.equal(kept.kept, true)
  assert.equal(readFileSync(destination, "utf8"), "edited\n")

  const forced = installAsset("commands/status.md", destination, true)
  assert.equal(forced.changed, true)
  assert.notEqual(readFileSync(destination, "utf8"), "edited\n")
})

test("installPluginPackage writes a loader that points at this checkout", () => {
  const result = installPluginPackage()
  assert.equal(result.changed, true)
  assert.ok(existsSync(join(result.dir, "package.json")))
  assert.match(readFileSync(join(result.dir, "server.js"), "utf8"), /src\/index\.js/)
  assert.match(readFileSync(join(result.dir, "tui.js"), "utf8"), /src\/tui\.jsx/)

  const again = installPluginPackage()
  assert.equal(again.changed, false)
})

test("findPluginRegistration is false with no config and for unrelated plugins", () => {
  assert.equal(findPluginRegistration().registered, false)

  writeConfig(["other-plugin", { package: "another-plugin", options: {} }])
  assert.equal(findPluginRegistration().registered, false)
})

test("findPluginRegistration recognises npm names, versions, objects, and Git specs", () => {
  for (const entry of [
    "opencode-email-agent",
    "opencode-email-agent@0.4.0",
    "npm:opencode-email-agent",
    "npm:opencode-email-agent@0.4.0",
    { package: "opencode-email-agent", options: { namespace: "email" } },
    "github:whoabhaysharma/emailer",
    "git+https://github.com/whoabhaysharma/emailer.git",
  ]) {
    writeConfig([entry])
    const result = findPluginRegistration()
    assert.equal(result.registered, true, `${JSON.stringify(entry)} should register`)
    assert.ok(result.file)
  }
})

test("findPluginRegistration ignores local path entries that init migrates", () => {
  for (const entry of [packageRoot, join(packageRoot, "src", "index.js")]) {
    writeConfig([entry])
    assert.equal(findPluginRegistration().registered, false, `${entry} is a legacy path entry`)
  }
})

test("removePluginPackage removes our loader and leaves foreign loaders alone", () => {
  const installed = installPluginPackage()
  const manifest = join(installed.dir, "package.json")

  writeFileSync(manifest, JSON.stringify({ name: "someone-elses-loader" }))
  assert.equal(removePluginPackage().removed, false)
  assert.ok(existsSync(installed.dir))

  writeFileSync(manifest, JSON.stringify({ name: "opencode-email-agent-local" }))
  assert.equal(removePluginPackage().removed, true)
  assert.equal(existsSync(installed.dir), false)
})
