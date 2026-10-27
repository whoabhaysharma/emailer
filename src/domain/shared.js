import { loadConfig } from "../config.js"

export const nowIso = () => new Date().toISOString()
export const hoursAgo = (hours) => new Date(Date.now() - hours * 3600_000).toISOString()
export const daysFromNow = (days) => new Date(Date.now() + days * 86400_000).toISOString()

export const BLOCKED_STATUS = new Set(["unsubscribed", "bounced", "do_not_contact", "complained", "wrong_person"])

export const MESSAGE_COLUMNS = [
  "id",
  "account_id",
  "thread_id",
  "direction",
  "rfc_message_id",
  "in_reply_to",
  "refs",
  "from_addr",
  "to_addr",
  "cc",
  "subject",
  "body_text",
  "body_html",
  "snippet",
  "folder",
  "imap_uid",
  "gmail_thread_id",
  "sent_at",
  "received_at",
  "created_at",
  "needs_triage",
  "triage_intent",
  "triage_json",
  "campaign_id",
  "enrolment_id",
  "step",
  "bulk",
  "status",
]

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export function clamp(value, min, max) {
  return Math.min(Math.max(Number(value), min), max)
}

export function normalizeMessageId(value) {
  if (!value) return null
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return null
  const trimmed = String(raw).trim().replace(/^</, "").replace(/>$/, "")
  return trimmed ? `<${trimmed}>` : null
}

export function referenceList(value) {
  if (!value) return []
  const entries = Array.isArray(value) ? value : [value]
  const out = []
  for (const entry of entries) {
    const text = String(entry)
    const matches = [...text.matchAll(/<([^>]+)>/g)]
    if (matches.length) for (const match of matches) out.push(`<${match[1]}>`)
    else if (text.trim()) out.push(`<${text.trim()}>`)
  }
  return [...new Set(out)]
}

export function parseRefs(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return referenceList(value)
  }
}

export function parseVars(value) {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

export function insertMessage(store, row) {
  store.run(
    `INSERT INTO messages (${MESSAGE_COLUMNS.join(", ")}) VALUES (${MESSAGE_COLUMNS.map(() => "?").join(", ")})`,
    ...MESSAGE_COLUMNS.map((column) => row[column]),
  )
  return row.id
}

export function inBusinessWindow(date, cfg) {
  const window = cfg.businessHours
  if (!window || !Array.isArray(window.days) || !window.days.length) return true
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: cfg.timezone || "UTC",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date)
  const get = (type) => parts.find((part) => part.type === type)?.value
  const day = WEEKDAYS[get("weekday")]
  const hour = Number(get("hour")) % 24
  return window.days.includes(day) && hour >= window.start && hour < window.end
}

export function effectiveDailyLimit(account, cfg = loadConfig()) {
  const base = Number(account.dailyLimit || cfg.defaultDailyLimit || 40)
  const warmup = account.warmup
  if (!warmup || warmup.enabled === false) return base
  const started = account.warmupStartedAt || account.createdAt || nowIso()
  const days = Math.max(0, Math.floor((Date.now() - new Date(started).getTime()) / 86400_000))
  const start = Number(warmup.start ?? 20)
  const increment = Number(warmup.incrementPerDay ?? 10)
  const max = Number(warmup.max ?? base)
  return Math.max(1, Math.min(base, max, start + days * increment))
}

export function firstNameOf(contact) {
  const value = String(contact?.name || "").trim()
  if (value) return value.split(/\s+/)[0]
  const local = String(contact?.email || "").split("@")[0].replace(/[._-]+/g, " ")
  return local.split(/\s+/)[0].replace(/^\w/, (character) => character.toUpperCase())
}

export function contactVars(contact) {
  return {
    email: contact?.email || "",
    name: contact?.name || "",
    first_name: firstNameOf(contact),
    company: contact?.company || "",
    title: contact?.title || "",
    ...parseVars(contact?.vars),
  }
}

/** Real sends in the last 24h, optionally for one account. */
export function countSent(store, accountId = null) {
  if (accountId) {
    const row = store.get(
      "SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND direction = 'out' AND status = 'sent' AND created_at > ?",
      accountId,
      hoursAgo(24),
    )
    return Number(row?.count || 0)
  }
  return Number(
    store.get(
      "SELECT COUNT(*) AS count FROM messages WHERE direction = 'out' AND status = 'sent' AND created_at > ?",
      hoursAgo(24),
    )?.count || 0,
  )
}
