import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ensureLayout, loadAccounts, loadConfig, resolvePassword } from "../../config.js"
import { verifyImap } from "../../mail/imap.js"
import { closeTransports, verifySmtp } from "../../mail/smtp.js"
import { daemonStatus } from "../../daemon.js"
import { DATA, tokenFile } from "../../paths.js"
import { withService } from "../context.js"

export async function doctorCommand() {
  ensureLayout()
  const config = loadConfig()
  const accounts = loadAccounts()

  const checks = []
  const ok = (label, detail = "") => checks.push({ ok: true, label, detail })
  const bad = (label, detail = "") => checks.push({ ok: false, label, detail })

  ok("node", process.versions.node)
  ok("dry run", config.dryRun ? "on — nothing will actually send" : "off")

  if (!existsSync(tokenFile)) {
    bad("token", "missing — run init")
  } else {
    const mode = statSync(tokenFile).mode & 0o777
    if (mode & 0o077) bad("token", `permissions are ${mode.toString(8)} — should be 600`)
    else ok("token", "present, mode 600")
  }

  try {
    const probe = join(DATA, ".write-test")
    mkdirSync(DATA, { recursive: true })
    writeFileSync(probe, "ok")
    unlinkSync(probe)
    ok("database", "writable")
  } catch (error) {
    bad("database", String(error.message || error))
  }

  const status = daemonStatus()
  if (status.running) ok("daemon", `running (pid ${status.pid})`)
  else bad("daemon", "not running — try: opencode-email-agent service install")

  if (!accounts.length) bad("accounts", "none configured — run: opencode-email-agent setup")
  else ok("accounts", `${accounts.length} configured`)

  const rows = []
  for (const account of accounts) {
    let password
    try {
      password = resolvePassword(account)
    } catch (error) {
      rows.push({ account: account.id, smtp: "no secret", imap: "no secret", detail: String(error.message || error) })
      continue
    }

    let smtp = "ok"
    let imap = "ok"
    try {
      await verifySmtp(account, password)
    } catch (error) {
      smtp = String(error.message || error).split("\n")[0].slice(0, 60)
    }
    try {
      await verifyImap(account, password)
    } catch (error) {
      imap = String(error.message || error).split("\n")[0].slice(0, 60)
    }
    rows.push({ account: account.id, smtp, imap })
  }

  for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.label.padEnd(10)} ${check.detail}`)
  if (rows.length) {
    console.log("")
    console.table(rows)
  }

  try {
    const health = await withService(async (instance) => instance.health())
    console.log(
      `\nstate: ${health.pendingDrafts} drafts pending, ${health.needsTriage} unclassified, ${health.campaignsRunning} campaigns running`,
    )
    if (health.lastSyncAt) console.log(`last sync: ${health.lastSyncAt}`)
    if (health.lastError) console.log(`last error: ${JSON.stringify(health.lastError.detail)}`)
  } catch (error) {
    console.log(`\nstate: unavailable (${String(error.message || error)})`)
  }

  closeTransports()

  if (checks.some((check) => !check.ok) || rows.some((row) => row.smtp !== "ok" || row.imap !== "ok")) {
    console.log("\nSome checks failed. See README → Troubleshooting.")
    process.exitCode = 1
  }
}
