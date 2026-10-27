import { spawnSync } from "node:child_process"
import { loadConfig, saveConfig } from "../../config.js"
import { configFile } from "../../paths.js"
import { fail, printJson } from "../io.js"

function setPath(object, path, value) {
  const keys = String(path).split(".")
  let cursor = object
  for (const key of keys.slice(0, -1)) {
    if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {}
    cursor = cursor[key]
  }
  cursor[keys[keys.length - 1]] = value
}

function getPath(object, path) {
  return String(path)
    .split(".")
    .reduce((cursor, key) => (cursor && typeof cursor === "object" ? cursor[key] : undefined), object)
}

function coerce(raw, current) {
  if (typeof current === "boolean") return raw === "true" || raw === "1"
  if (typeof current === "number" && raw.trim() !== "" && !Number.isNaN(Number(raw))) return Number(raw)
  if (raw === "true") return true
  if (raw === "false") return false
  return raw
}

export function configCommand(action, positional, flags) {
  if (!action || action === "show") return printJson(loadConfig())
  if (action === "path") return console.log(configFile)

  if (action === "edit") {
    const editor = process.env.VISUAL || process.env.EDITOR || "vi"
    const result = spawnSync(editor, [configFile], { stdio: "inherit" })
    if (result.status !== 0) fail(`editor exited with ${result.status}`)
    return
  }

  if (action === "set") {
    const pairs = positional.length ? positional : Object.entries(flags).map(([key, value]) => `${key}=${value}`)
    if (!pairs.length) fail("usage: config set key=value [key=value...]")

    const cfg = loadConfig()
    for (const pair of pairs) {
      const eq = String(pair).indexOf("=")
      if (eq === -1) fail(`expected key=value, got "${pair}"`)
      const key = pair.slice(0, eq)
      const raw = pair.slice(eq + 1)
      setPath(cfg, key, coerce(raw, getPath(cfg, key)))
    }
    return printJson(saveConfig(cfg))
  }

  fail(`unknown config action: ${action}. Use show, set, edit, path.`)
}
