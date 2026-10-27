import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { dbFile, logFile, packageRoot } from "../../paths.js"

const TAG_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/
const CHANGELOG_HEADING = /^##\s+\[?v?(\d+\.\d+\.\d+)\]?/
const HEALTH_URL = "http://127.0.0.1:8787/health"
const HEALTH_WAIT_MS = 3000
const HEALTH_TIMEOUT_MS = 2000

/** "v1.2.3" or "1.2.3" -> [1, 2, 3]; anything else -> null. */
export function parseVersion(value) {
  if (typeof value !== "string") return null
  const match = value.trim().match(TAG_PATTERN)
  return match ? match.slice(1).map(Number) : null
}

/** Compare two versions: -1 when a < b, 1 when a > b, 0 when equal or unparsable. */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

/** Extract the `## [x.y.z]` section of a changelog, without the next section. */
export function changelogSection(markdown, version) {
  const wanted = parseVersion(version)
  if (!wanted || typeof markdown !== "string") return ""

  const lines = markdown.split(/\r?\n/)
  let start = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const boundary = /^##\s/.test(line) || /^\[[^\]]+\]:\s/.test(line)
    if (!boundary) continue
    if (start !== -1) return lines.slice(start, index).join("\n").trimEnd()
    const match = line.match(CHANGELOG_HEADING)
    const found = match ? parseVersion(match[1]) : null
    if (found && found.every((part, position) => part === wanted[position])) start = index
  }
  return start === -1 ? "" : lines.slice(start).join("\n").trimEnd()
}

function readCurrentVersion({ existsSync, readFileSync }) {
  const versionFile = join(packageRoot, "src", "version.js")
  if (existsSync(versionFile)) {
    const match = readFileSync(versionFile, "utf8").match(/VERSION\s*=\s*["']([^"']+)["']/)
    if (match && parseVersion(match[1])) return match[1].replace(/^v/, "")
  }
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
  return String(manifest.version || "").replace(/^v/, "")
}

function readChangelog(readFileSync) {
  const file = join(packageRoot, "CHANGELOG.md")
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

function npmInstructions(version) {
  console.log(`opencode-email-agent ${version} was installed from npm, not a git checkout, so it cannot self-update.`)
  console.log("")
  console.log("Update with:")
  console.log("  npm i -g opencode-email-agent@latest")
  console.log("  opencode-email-agent init")
  console.log("  opencode-email-agent service install")
}

export async function updateCommand(flags = {}) {
  // File and process work stays here so the helpers above remain pure.
  const { existsSync, copyFileSync, readFileSync } = await import("node:fs")
  const checkOnly = flags.check === true || flags.check === "true"
  const current = readCurrentVersion({ existsSync, readFileSync })
  const changelog = readChangelog(readFileSync)

  if (!existsSync(join(packageRoot, ".git"))) {
    npmInstructions(current)
    return
  }

  try {
    execFileSync("git", ["fetch", "--tags", "--quiet"], { cwd: packageRoot, stdio: "pipe" })
  } catch (error) {
    console.log(`warning: could not fetch tags (${String(error?.message || error).split("\n")[0]})`)
  }

  const tags = execFileSync("git", ["tag", "--sort=-v:refname"], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => TAG_PATTERN.test(line))

  if (tags.length === 0) {
    console.log(`No release tags found (installed v${current}).`)
    return
  }

  const latest = tags[0].replace(/^v/, "")

  if (compareVersions(latest, current) <= 0) {
    console.log(`Already up to date (v${current}).`)
    return
  }

  if (checkOnly) {
    console.log(`Update available: v${current} → v${latest}`)
    const section = changelogSection(changelog, latest)
    if (section) console.log(`\n${section}`)
    console.log(`\nRun \`opencode-email-agent update\` to install it.`)
    return
  }

  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd()

  if (dirty) {
    console.error("Local changes detected; refusing to update. Commit or stash them first:")
    console.error("")
    for (const line of dirty.split("\n")) console.error(`  ${line}`)
    throw new Error("working tree is not clean")
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  if (existsSync(dbFile)) {
    const backup = `${dbFile}.bak-${stamp}`
    copyFileSync(dbFile, backup)
    console.log(`backed up database to ${backup}`)
  }

  console.log(`Updating v${current} → v${latest}...`)

  try {
    execFileSync("git", ["pull", "--ff-only"], { cwd: packageRoot, stdio: "inherit" })
    execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
      cwd: packageRoot,
      stdio: "inherit",
    })
    execFileSync(process.execPath, [join(packageRoot, "src", "cli.js"), "init"], {
      cwd: packageRoot,
      stdio: "inherit",
    })

    const { serviceCommand } = await import("./daemon.js")
    if (process.platform === "darwin" || process.platform === "linux") {
      serviceCommand("install")
    } else {
      const { stopDaemon } = await import("../../daemon.js")
      stopDaemon()
      console.log("daemon stopped; start it again with: opencode-email-agent daemon")
    }
  } catch (error) {
    console.error(`update failed: ${String(error?.message || error).split("\n")[0]}`)
    console.error(`The previous database backup is still available in ${dbFile}.bak-*`)
    throw error
  }

  console.log(`\nUpdated v${current} → v${latest}`)

  // Re-read after the pull: the new release ships its own changelog entry.
  const section = changelogSection(readChangelog(readFileSync), latest)
  if (section) console.log(`\n${section}`)

  await new Promise((resolve) => setTimeout(resolve, HEALTH_WAIT_MS))
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    if (response.ok) console.log(`\ndaemon healthy at ${HEALTH_URL}`)
    else console.log(`\ndaemon unhealthy: ${HEALTH_URL} returned HTTP ${response.status}`)
  } catch (error) {
    console.log(`\ndaemon unhealthy: ${String(error?.message || error).split("\n")[0]}`)
    console.log(`Check \`opencode-email-agent service status\` and ${logFile}, then start it with`)
    console.log("  opencode-email-agent service install")
  }
}
