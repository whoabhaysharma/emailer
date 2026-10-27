import {
  getAccount,
  loadAccounts,
  loadConfig,
  resolvePassword,
  saveAccounts,
  setSecret,
} from "../../config.js"
import { effectiveDailyLimit } from "../../service.js"
import { verifyImap } from "../../mail/imap.js"
import { verifySmtp } from "../../mail/smtp.js"
import { fail, printJson, promptHidden } from "../io.js"

const GMAIL_IMAP = { host: "imap.gmail.com", port: 993, secure: true }
const GMAIL_SMTP = { host: "smtp.gmail.com", port: 465, secure: true }

export async function addAccount(flags) {
  const email = String(flags.email || "").trim().toLowerCase()
  if (!email || !email.includes("@")) fail("--email is required")

  const accounts = loadAccounts()
  const id = String(flags.id || email.split("@")[0]).replace(/[^a-z0-9_-]/gi, "-").toLowerCase()
  if (accounts.some((account) => account.id === id)) fail(`account id "${id}" already exists`)
  if (accounts.some((account) => account.email.toLowerCase() === email)) fail(`${email} is already configured`)

  const account = {
    id,
    email,
    displayName: flags.name || email.split("@")[0],
    replyTo: flags["reply-to"] || undefined,
    dailyLimit: Number(flags["daily-limit"] || loadConfig().defaultDailyLimit),
    enabled: true,
    imap: {
      host: flags["imap-host"] || GMAIL_IMAP.host,
      port: Number(flags["imap-port"] || GMAIL_IMAP.port),
      secure: true,
    },
    smtp: {
      host: flags["smtp-host"] || GMAIL_SMTP.host,
      port: Number(flags["smtp-port"] || GMAIL_SMTP.port),
      secure: true,
    },
    signature: flags.signature || "",
    unsubscribeMailto: flags["unsubscribe-mailto"] || undefined,
    secretRef: flags["secret-ref"] || undefined,
    createdAt: new Date().toISOString(),
  }

  if (flags["warmup-start"] || flags["warmup-increment"] || flags["warmup-max"]) {
    account.warmup = {
      start: Number(flags["warmup-start"] || 20),
      incrementPerDay: Number(flags["warmup-increment"] || 10),
      max: Number(flags["warmup-max"] || account.dailyLimit),
    }
  }

  accounts.push(account)
  saveAccounts(accounts)

  const password = flags.password || process.env.EMAIL_AGENT_PASSWORD?.trim() || ""
  let secretSet = false

  if (password) {
    setSecret(account, password, { useKeychain: !flags["no-keychain"] })
    saveAccounts(accounts)
    secretSet = true
  } else if (!flags["no-secret"] && process.stdin.isTTY) {
    const entered = await promptHidden(`Google app password for ${email} (hidden, blank to skip): `)
    if (entered) {
      setSecret(account, entered, { useKeychain: !flags["no-keychain"] })
      saveAccounts(accounts)
      secretSet = true
    }
  }

  console.log(`added account ${id} (${email})${secretSet ? " with app password" : ""}`)
  console.log(`test it: opencode-email-agent account test ${id}`)
}

export function showAccounts(flags) {
  const accounts = loadAccounts()
  if (!accounts.length) {
    console.log("No accounts yet. Add one:\n  opencode-email-agent setup")
    return
  }

  if (flags.json) {
    return printJson(accounts.map((account) => ({ ...account, secretRef: undefined })))
  }

  const cfg = loadConfig()
  console.table(
    accounts.map((account) => ({
      id: account.id,
      email: account.email,
      name: account.displayName || "",
      limit: account.dailyLimit ?? cfg.defaultDailyLimit,
      effective: effectiveDailyLimit(account, cfg),
      warmup: account.warmup ? "on" : "",
      status: account.enabled === false ? "disabled" : "enabled",
      secret: account.secretRef ? "set" : "missing",
    })),
  )
}

export async function warmupAccount(flags, positional) {
  const id = positional[0] || flags.id
  const account = getAccount(id)
  const accounts = loadAccounts()
  const target = accounts.find((entry) => entry.id === account.id)

  if (flags.off) {
    delete target.warmup
    delete target.warmupStartedAt
    saveAccounts(accounts)
    console.log(`warmup disabled for ${account.id}`)
    return
  }

  target.warmup = {
    start: Number(flags.start || 20),
    incrementPerDay: Number(flags.increment || 10),
    max: Number(flags.max || account.dailyLimit || 40),
  }
  target.warmupStartedAt = target.warmupStartedAt || new Date().toISOString()
  saveAccounts(accounts)
  printJson({ account: account.id, warmup: target.warmup, startedAt: target.warmupStartedAt })
}

export async function testAccount(flags, positional) {
  const id = positional[0] || flags.id
  const account = getAccount(id)
  const password = resolvePassword(account)
  const result = { account: account.id, smtp: false, imap: false }

  try {
    await verifySmtp(account, password)
    result.smtp = true
  } catch (error) {
    result.smtpError = String(error.message || error)
  }

  try {
    const folders = await verifyImap(account, password)
    result.imap = true
    result.folders = folders.map((folder) => folder.specialUse || folder.path).slice(0, 12)
  } catch (error) {
    result.imapError = String(error.message || error)
  }

  printJson(result)
}

export async function setSecretCommand(flags, positional) {
  const id = positional[0]
  if (!id) fail("account id is required")

  const account = getAccount(id)
  const value = flags.password || (await promptHidden(`Google app password for ${account.email} (hidden): `))
  if (!value) fail("empty password")

  setSecret(account, value, { useKeychain: !flags["no-keychain"] })
  saveAccounts(loadAccounts().map((entry) => (entry.id === account.id ? { ...entry, secretRef: account.secretRef } : entry)))
  console.log(`stored secret for ${id}`)
}

export function removeAccount(id) {
  if (!id) fail("account id is required")
  saveAccounts(loadAccounts().filter((account) => account.id !== id))
  console.log(`removed ${id}`)
}
