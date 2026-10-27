import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { dirname, join } from "node:path"
import { accountsFile, configFile, DATA, HOME, secretsFile, tokenFile } from "./paths.js"

const DEFAULTS = {
  baseUrl: "http://127.0.0.1:8787",
  pollSeconds: 60,
  dryRun: false,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  businessHours: { start: 9, end: 18, days: [1, 2, 3, 4, 5] },
  defaultDailyLimit: 40,
  signature: "",
  footerAddress: "",
  unsubscribeUrl: "",
  unsubscribeMailto: "",
  maxPerTick: 25,
  initialSyncLimit: 200,
  triageWindowDays: 7,
  syncSentFolder: true,
  maxRecipientsPerMessage: 20,
  globalDailyLimit: 0,
  allowMultipleCampaigns: false,
  requireConsent: false,
  publicBaseUrl: "",
  unsubscribeSecret: "",
}

export function ensureLayout() {
  for (const dir of [HOME, DATA]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  try {
    chmodSync(HOME, 0o700)
  } catch {}
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  ensureLayout()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {}
}

export function loadConfig() {
  return { ...DEFAULTS, ...readJson(configFile, {}) }
}

export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch }
  writeJson(configFile, next)
  return next
}

export function loadAccounts() {
  const raw = readJson(accountsFile, { accounts: [] })
  const accounts = Array.isArray(raw) ? raw : raw.accounts
  return (accounts || []).filter((a) => a && a.id && a.email)
}

export function saveAccounts(accounts) {
  writeJson(accountsFile, { accounts })
}

export function getAccount(id) {
  const accounts = loadAccounts()
  const account = id ? accounts.find((a) => a.id === id) : accounts[0]
  if (!account) {
    throw new Error(
      id
        ? `Unknown account "${id}". Configured: ${accounts.map((a) => a.id).join(", ") || "none"}`
        : "No accounts configured. Run: opencode-email-agent account add ...",
    )
  }
  return account
}

export function publicAccount(account) {
  const { secretRef, ...rest } = account
  return {
    ...rest,
    secretRef: secretRef ? secretRef.replace(/(keychain:[^/]+\/).*/, "$1***") : undefined,
    hasPassword: Boolean(secretRef),
  }
}

/** Resolve an app password. Never logs or returns it to the agent. */
export function resolvePassword(account) {
  const envKey = `EMAIL_AGENT_PASSWORD_${account.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
  if (process.env[envKey]) return normalizePassword(process.env[envKey])

  const ref = account.secretRef || ""
  if (ref.startsWith("env:")) {
    const value = process.env[ref.slice(4)]
    if (value) return normalizePassword(value)
    throw new Error(`Environment variable ${ref.slice(4)} is empty (account ${account.id})`)
  }

  if (ref.startsWith("keychain:")) {
    const rest = ref.slice("keychain:".length)
    const slash = rest.lastIndexOf("/")
    const service = slash === -1 ? rest : rest.slice(0, slash)
    const user = slash === -1 ? account.email : rest.slice(slash + 1)
    if (process.platform === "darwin") {
      try {
        const out = execFileSync("security", ["find-generic-password", "-s", service, "-a", user, "-w"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
        return normalizePassword(out)
      } catch {
        throw new Error(`Keychain item not found: ${service}/${user}. Run: opencode-email-agent secret set ${account.id}`)
      }
    }
  }

  const secrets = readJson(secretsFile, {})
  if (secrets[account.id]) return normalizePassword(secrets[account.id])

  throw new Error(`No password for account ${account.id}. Run: opencode-email-agent secret set ${account.id}`)
}

export function normalizePassword(value) {
  return String(value || "").replace(/\s+/g, "")
}

export function setSecret(account, password, { useKeychain = process.platform === "darwin" } = {}) {
  const clean = normalizePassword(password)
  if (!clean) throw new Error("Empty password")

  if (useKeychain) {
    const service = `opencode-email-${account.id}`
    execFileSync("security", ["add-generic-password", "-s", service, "-a", account.email, "-w", clean, "-U"], {
      stdio: ["ignore", "ignore", "ignore"],
    })
    account.secretRef = `keychain:${service}/${account.email}`
    return account
  }

  const secrets = readJson(secretsFile, {})
  secrets[account.id] = clean
  writeJson(secretsFile, secrets)
  account.secretRef = `file:${account.id}`
  return account
}

export function ensureToken() {
  ensureLayout()
  if (existsSync(tokenFile)) {
    const existing = readFileSync(tokenFile, "utf8").trim()
    if (existing) return existing
  }
  const token = randomBytes(32).toString("hex")
  writeFileSync(tokenFile, token + "\n", { mode: 0o600 })
  return token
}

export function readToken() {
  try {
    return readFileSync(tokenFile, "utf8").trim()
  } catch {
    return ""
  }
}

export function getBaseUrl() {
  return process.env.EMAIL_AGENT_URL || loadConfig().baseUrl || DEFAULTS.baseUrl
}

export { DEFAULTS }
