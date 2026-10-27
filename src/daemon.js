import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { createService } from "./service.js"
import { createHttpServer } from "./server.js"
import { openStore } from "./store.js"
import { ensureToken, loadConfig, readToken } from "./config.js"
import { closeTransports } from "./mail/smtp.js"
import { dbFile, pidFile } from "./paths.js"
import { packageRoot } from "./paths.js"

function log(message, extra) {
  const stamp = new Date().toISOString()
  if (extra === undefined) console.log(`[${stamp}] ${message}`)
  else console.log(`[${stamp}] ${message}`, JSON.stringify(extra))
}

export function daemonStatus() {
  if (!existsSync(pidFile)) return { running: false }
  const pid = Number(readFileSync(pidFile, "utf8").trim())
  if (!pid) return { running: false }
  try {
    process.kill(pid, 0)
    return { running: true, pid }
  } catch {
    return { running: false, stalePid: pid }
  }
}

export function stopDaemon() {
  const status = daemonStatus()
  if (!status.running) return { stopped: false }
  try {
    process.kill(status.pid, "SIGTERM")
    return { stopped: true, pid: status.pid }
  } catch {
    return { stopped: false }
  }
}

export async function startDaemon({ port, host = "127.0.0.1", once = false, quiet = false } = {}) {
  const config = loadConfig()
  const resolvedPort = Number(port || new URL(config.baseUrl).port || 8787)
  const store = openStore()
  const service = createService(store)
  const token = ensureToken()
  const server = createHttpServer({ service, token })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(resolvedPort, host, resolve)
  })

  const address = `http://${host}:${resolvedPort}`
  writeFileSync(pidFile, String(process.pid) + "\n", { mode: 0o600 })
  if (!quiet) log(`listening on ${address}`, { db: dbFile, dryRun: Boolean(config.dryRun), root: packageRoot })

  let closed = false
  async function shutdown(code = 0) {
    if (closed) return
    closed = true
    log("shutting down")
    closeTransports()
    await new Promise((resolve) => server.close(resolve))
    try {
      if (existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() === String(process.pid)) unlinkSync(pidFile)
    } catch {}
    store.close()
    process.exit(code)
  }

  process.on("SIGINT", () => void shutdown(0))
  process.on("SIGTERM", () => void shutdown(0))

  if (once) {
    const results = await service.syncAll()
    const tick = await service.tickCampaigns()
    log("single pass complete", { sync: results, campaign: tick })
    await shutdown(0)
    return
  }

  let busy = false
  async function pass() {
    if (busy) return
    busy = true
    try {
      const results = await service.syncAll()
      const fetched = results.reduce((total, entry) => total + (entry.inserted || 0), 0)
      if (fetched) log(`synced ${fetched} new message(s)`, results)
      const tick = await service.tickCampaigns()
      if (tick.started) log(`campaign tick started ${tick.started} step(s)`)
      const failures = results.filter((entry) => entry.error)
      if (failures.length) log("sync failures", failures)
    } catch (error) {
      log("pass failed", { error: String(error.message || error) })
    } finally {
      busy = false
    }
  }

  await pass()
  const interval = setInterval(() => void pass(), Math.max(Number(config.pollSeconds || 60), 15) * 1000)
  interval.unref?.()

  return { server, service, address, token, shutdown }
}

export function daemonToken() {
  return readToken()
}
