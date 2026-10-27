import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import { assetsDir, opencodeConfigDir, packageRoot, pluginsDir } from "../paths.js"

export function installAsset(sourceRelative, destination, force = false) {
  const source = join(assetsDir, sourceRelative)
  if (!existsSync(source)) return { destination, skipped: true }

  const content = readFileSync(source, "utf8")
  if (existsSync(destination)) {
    const current = readFileSync(destination, "utf8")
    if (current === content) return { destination, changed: false }
    if (!force) return { destination, kept: true }
  }

  mkdirSync(dirname(destination), { recursive: true })
  if (existsSync(destination)) {
    writeFileSync(`${destination}.bak-${Date.now()}`, readFileSync(destination))
  }
  writeFileSync(destination, content)
  return { destination, changed: true }
}

function readOpencodeConfig() {
  const jsonPath = join(opencodeConfigDir, "opencode.json")
  const jsoncPath = join(opencodeConfigDir, "opencode.jsonc")
  const file = existsSync(jsonPath) ? jsonPath : existsSync(jsoncPath) ? jsoncPath : null
  if (!file) return { file: null, parsed: {} }
  return { file, parsed: parseJsonc(readFileSync(file, "utf8")) || {} }
}

function entrySpec(entry) {
  if (typeof entry === "string") return entry
  if (entry && typeof entry === "object" && typeof entry.package === "string") return entry.package
  return ""
}

function normalizeTarget(value) {
  return String(value || "")
    .replace(/^git\+/, "")
    .replace(/^github:/, "https://github.com/")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
}

function repositorySlug(repository) {
  const value = typeof repository === "string" ? repository : repository?.url
  if (!value) return ""
  const match = normalizeTarget(value).match(/github\.com\/([^/]+)\/([^/]+)/i)
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : ""
}

/**
 * Is this exact package already listed in OpenCode's `plugins` config?
 *
 * `opencode plugin add` registers the package by name or Git specifier, and
 * OpenCode then loads its server and TUI parts directly. Writing the local
 * loader shim as well would load the plugin twice.
 */
export function findPluginRegistration() {
  const { file, parsed } = readOpencodeConfig()
  if (!file) return { file: null, registered: false }

  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
  const name = String(manifest.name || "")
  const slug = repositorySlug(manifest.repository)
  const entries = Array.isArray(parsed.plugins) ? parsed.plugins : []

  for (const entry of entries) {
    const spec = entrySpec(entry)
    if (!spec) continue
    const target = normalizeTarget(spec)
    const bare = target.startsWith("npm:") ? target.slice(4) : target
    const matchesName = Boolean(name) && (bare === name || bare.startsWith(`${name}@`))
    const matchesRepo = Boolean(slug) && target.toLowerCase().includes(slug)
    if (matchesName || matchesRepo) return { file, registered: true, entry: spec }
  }

  return { file, registered: false }
}

/**
 * Remove the local loader package written by init, but only when it is ours.
 * A loader owned by another checkout is left alone.
 */
export function removePluginPackage() {
  const dir = join(pluginsDir, "email-agent")
  const manifest = join(dir, "package.json")
  if (!existsSync(manifest)) return { dir, removed: false }

  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8"))
    if (parsed.name !== "opencode-email-agent-local") return { dir, removed: false }
  } catch {
    return { dir, removed: false }
  }

  rmSync(dir, { recursive: true, force: true })
  return { dir, removed: true }
}

/**
 * OpenCode auto-loads plugin *directories* under <config>/plugins when they have
 * a package.json with `name` and `exports`. A directory lets the same entry
 * expose both the server part (`.`) and the TUI part (`./tui`), which a single
 * file shim cannot do. Local paths in the `plugins` config array are ignored,
 * so init still writes this directory itself.
 */
export function installPluginPackage() {
  const dir = join(pluginsDir, "email-agent")
  mkdirSync(dir, { recursive: true })

  const packageJson = {
    name: "opencode-email-agent-local",
    private: true,
    type: "module",
    exports: { ".": "./server.js", "./tui": "./tui.js" },
  }
  const files = [
    [join(dir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`],
    [join(dir, "server.js"), `export { default } from ${JSON.stringify(join(packageRoot, "src", "index.js"))}\n`],
    [join(dir, "tui.js"), `export { default } from ${JSON.stringify(join(packageRoot, "src", "tui.jsx"))}\n`],
  ]

  let changed = false
  for (const [file, content] of files) {
    if (!existsSync(file) || readFileSync(file, "utf8") !== content) {
      writeFileSync(file, content)
      changed = true
    }
  }

  // The pre-0.3.0 file shim cannot carry the TUI part; drop it so OpenCode does
  // not load the server twice.
  const legacy = join(pluginsDir, "email-agent.js")
  if (existsSync(legacy)) {
    rmSync(legacy)
    changed = true
  }

  return { dir, changed }
}

export function removeLegacyPluginEntry() {
  const jsonPath = join(opencodeConfigDir, "opencode.json")
  const jsoncPath = join(opencodeConfigDir, "opencode.jsonc")
  const file = existsSync(jsonPath) ? jsonPath : existsSync(jsoncPath) ? jsoncPath : null
  if (!file) return { file: null, removed: false }

  const text = readFileSync(file, "utf8")
  const parsed = parseJsonc(text) || {}
  if (!Array.isArray(parsed.plugins)) return { file, removed: false }

  const normalize = (value) => String(value || "").replace(/\/+$/, "")
  const next = parsed.plugins.filter((entry) => {
    const target = normalize(typeof entry === "string" ? entry : entry?.package)
    return target !== normalize(packageRoot) && target !== normalize(join(packageRoot, "src", "index.js"))
  })
  if (next.length === parsed.plugins.length) return { file, removed: false }

  const edits = modify(text, ["plugins"], next, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
  writeFileSync(`${file}.bak`, text)
  writeFileSync(file, applyEdits(text, edits))
  return { file, removed: true }
}
