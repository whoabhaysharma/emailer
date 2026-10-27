import { readFileSync } from "node:fs"
import { homedir } from "node:os"

export function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

export function readStdin() {
  try {
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

export function printJson(value) {
  console.log(JSON.stringify(value, null, 2))
}

export function formatPath(value) {
  return String(value).replace(homedir(), "~")
}

export async function promptHidden(question) {
  process.stdout.write(question)
  const stdin = process.stdin
  const wasRaw = stdin.isRaw
  if (stdin.setRawMode) stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding("utf8")

  let value = ""
  return new Promise((resolve) => {
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\n" || char === "\r" || char === "\u0004") {
          if (stdin.setRawMode) stdin.setRawMode(Boolean(wasRaw))
          stdin.pause()
          stdin.off("data", onData)
          process.stdout.write("\n")
          return resolve(value)
        }
        if (char === "\u0003") {
          process.stdout.write("\n")
          process.exit(130)
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1)
          continue
        }
        value += char
      }
    }
    stdin.on("data", onData)
  })
}

export async function ask(question, fallback = "") {
  const answer = await promptHidden(question)
  return answer.trim() || fallback
}

export async function askYes(question, fallback = true) {
  const answer = (await ask(`${question} [${fallback ? "Y/n" : "y/N"}]: `)).toLowerCase()
  if (!answer) return fallback
  return answer.startsWith("y")
}

export function parseCsvLine(line) {
  const values = []
  let current = ""
  let quoted = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        current += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ",") {
      values.push(current.trim())
      current = ""
    } else {
      current += char
    }
  }

  values.push(current.trim())
  return values
}

export function parseContactsFile(file) {
  const raw = readFileSync(file, "utf8").trim()
  if (!raw) return []

  if (raw.startsWith("[") || raw.startsWith("{")) {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : parsed.contacts || []
  }

  const lines = raw.split(/\r?\n/).filter(Boolean)
  const header = parseCsvLine(lines[0]).map((value) => value.trim().toLowerCase())
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line)
    const entry = {}
    header.forEach((key, index) => {
      entry[key] = values[index]
    })
    return { email: entry.email || entry["e-mail"], name: entry.name, company: entry.company, title: entry.title }
  })
}
