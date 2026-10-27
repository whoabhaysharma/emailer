import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { getBaseUrl } from "./config.js"
import { packageRoot, tokenFile } from "./paths.js"

function connectionFailed(error) {
  const code = error?.cause?.code || error?.code
  return code === "ECONNREFUSED" || code === "ECONNRESET" || /fetch failed/i.test(String(error?.message || ""))
}

export function makeClient({ baseUrl, autoStart = true } = {}) {
  const root = String(baseUrl || getBaseUrl()).replace(/\/+$/, "")
  let starting = null

  function readToken() {
    if (process.env.EMAIL_AGENT_TOKEN) return process.env.EMAIL_AGENT_TOKEN.trim()
    if (!existsSync(tokenFile)) {
      throw new Error(
        `No email-agent token at ${tokenFile}. Run "opencode-email-agent init" once to create it and start the daemon.`,
      )
    }
    return readFileSync(tokenFile, "utf8").trim()
  }

  async function healthy() {
    try {
      const response = await fetch(`${root}/health`, { signal: AbortSignal.timeout(1500) })
      return response.ok
    } catch {
      return false
    }
  }

  async function startDaemon() {
    const cli = join(packageRoot, "src", "cli.js")
    const child = spawn(process.env.EMAIL_AGENT_NODE || "node", [cli, "daemon", "--quiet"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    })
    child.on("error", () => {})
    child.unref()

    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      if (await healthy()) return true
    }
    return false
  }

  async function ensureRunning() {
    if (await healthy()) return
    if (!autoStart) {
      throw new Error(`Email agent daemon is not running at ${root}. Start it with: opencode-email-agent daemon`)
    }
    if (!starting) {
      starting = startDaemon().finally(() => {
        starting = null
      })
    }
    const ok = await starting
    if (!ok) {
      throw new Error(
        `Email agent daemon did not start at ${root}. Run "opencode-email-agent doctor" or start it manually with "opencode-email-agent daemon".`,
      )
    }
  }

  async function doRequest(path, { method = "GET", body, query, signal } = {}) {
    const params = query
      ? "?" +
        new URLSearchParams(
          Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== ""),
        ).toString()
      : ""
    const response = await fetch(`${root}${path}${params}`, {
      method,
      headers: {
        authorization: `Bearer ${readToken()}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal || AbortSignal.timeout(120_000),
    })
    const text = await response.text()
    let payload = {}
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      payload = { raw: text }
    }
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status} ${response.statusText}`)
    return payload
  }

  async function request(path, options = {}) {
    try {
      return await doRequest(path, options)
    } catch (error) {
      if (connectionFailed(error)) {
        await ensureRunning()
        return await doRequest(path, options)
      }
      throw error
    }
  }

  return {
    root,
    request,
    healthy,
    ensureRunning,
    get: (path, query, signal) => request(path, { query, signal }),
    post: (path, body, signal) => request(path, { method: "POST", body, signal }),
  }
}
