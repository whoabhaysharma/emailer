import { randomUUID } from "node:crypto"
import { simpleParser } from "mailparser"
import { getAccount, loadAccounts, loadConfig, publicAccount, resolvePassword, saveAccounts } from "./config.js"
import { appendDraft, fetchNewMessages, findMailbox } from "./mail/imap.js"
import {
  applyFooter,
  buildRawMail,
  composeFooter,
  listUnsubscribeHeaders,
  newMessageId,
  normalizeSubject,
  render,
  stripHtml,
} from "./mail/mime.js"
import { formatAddress, isEmail, normalizeEmail, toAddressList } from "./mail/address.js"
import { sendSmtp } from "./mail/smtp.js"
import { TRIAGE_INTENTS, ruleTriage, triageDisposition } from "./triage.js"
import { signUnsubscribe } from "./unsubscribe.js"

const nowIso = () => new Date().toISOString()
const hoursAgo = (n) => new Date(Date.now() - n * 3600_000).toISOString()
const daysFromNow = (n) => new Date(Date.now() + n * 86400_000).toISOString()

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const BLOCKED_STATUS = new Set(["unsubscribed", "bounced", "do_not_contact", "complained", "wrong_person"])

const MESSAGE_COLUMNS = [
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

function normalizeMessageId(value) {
  if (!value) return null
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return null
  const trimmed = String(raw).trim().replace(/^</, "").replace(/>$/, "")
  return trimmed ? `<${trimmed}>` : null
}

function referenceList(value) {
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

function insertMessage(store, row) {
  store.run(
    `INSERT INTO messages (${MESSAGE_COLUMNS.join(", ")}) VALUES (${MESSAGE_COLUMNS.map(() => "?").join(", ")})`,
    ...MESSAGE_COLUMNS.map((column) => row[column]),
  )
  return row.id
}

function parseRefs(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return referenceList(value)
  }
}

function parseVars(value) {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function inBusinessWindow(date, cfg) {
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

export function createService(store) {
  const config = () => loadConfig()

  function contactVars(contact) {
    return {
      email: contact?.email || "",
      name: contact?.name || "",
      first_name: firstNameOf(contact),
      company: contact?.company || "",
      title: contact?.title || "",
      ...parseVars(contact?.vars),
    }
  }

  function firstNameOf(contact) {
    const value = String(contact?.name || "").trim()
    if (value) return value.split(/\s+/)[0]
    const local = String(contact?.email || "").split("@")[0].replace(/[._-]+/g, " ")
    return local.split(/\s+/)[0].replace(/^\w/, (character) => character.toUpperCase())
  }

  function ensureContact(input) {
    const email = normalizeEmail(input?.email)
    if (!email) throw new Error("Contact email is required")
    const existing = store.get("SELECT * FROM contacts WHERE email = ?", email)
    if (existing) {
      store.run(
        `UPDATE contacts SET
           name = COALESCE(?, name),
           company = COALESCE(?, company),
           title = COALESCE(?, title),
           tags = COALESCE(?, tags),
           vars = COALESCE(?, vars),
           consent_at = COALESCE(consent_at, ?)
         WHERE email = ?`,
        input.name ?? null,
        input.company ?? null,
        input.title ?? null,
        input.tags ? JSON.stringify(input.tags) : null,
        input.vars ? JSON.stringify(input.vars) : null,
        input.consentAt ?? null,
        email,
      )
      return store.get("SELECT * FROM contacts WHERE email = ?", email)
    }
    store.run(
      `INSERT INTO contacts (email, name, company, title, tags, source, status, consent_at, first_seen_at, vars)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      email,
      input.name ?? null,
      input.company ?? null,
      input.title ?? null,
      input.tags ? JSON.stringify(input.tags) : null,
      input.source ?? null,
      input.status ?? "active",
      input.consentAt ?? null,
      nowIso(),
      input.vars ? JSON.stringify(input.vars) : null,
    )
    return store.get("SELECT * FROM contacts WHERE email = ?", email)
  }

  function getContact(email) {
    return store.get("SELECT * FROM contacts WHERE email = ?", normalizeEmail(email))
  }

  function isSuppressed(email) {
    return Boolean(store.get("SELECT email FROM suppressions WHERE email = ?", normalizeEmail(email)))
  }

  /** Returns a human-readable reason when an address must not be contacted. */
  function contactBlockReason(email) {
    const contact = getContact(email)
    if (!contact) return null
    if (BLOCKED_STATUS.has(contact.status)) return `contact status is "${contact.status}"`
    if (contact.status === "not_now" && contact.not_before && new Date(contact.not_before) > new Date()) {
      return `asked not to be contacted before ${String(contact.not_before).slice(0, 10)}`
    }
    return null
  }

  function suppress(emails, reason = "manual", explicitStatus = null) {
    const list = (Array.isArray(emails) ? emails : String(emails || "").split(/[\s,;]+/))
      .map(normalizeEmail)
      .filter(Boolean)
    const status = explicitStatus || (reason === "bounce" ? "bounced" : reason === "complaint" ? "complained" : "unsubscribed")
    let added = 0
    for (const email of list) {
      const result = store.run(
        "INSERT OR IGNORE INTO suppressions (email, reason, created_at) VALUES (?, ?, ?)",
        email,
        reason,
        nowIso(),
      )
      added += result.changes ? 1 : 0
      stopEnrolments(email, reason === "bounce" ? "bounced" : "suppressed")
      store.run("UPDATE contacts SET status = ? WHERE email = ?", status, email)
    }
    store.event("suppression.added", { data: { reason, emails: list, added } })
    return { added, total: list.length, emails: list }
  }

  function listSuppressions() {
    return store.all("SELECT * FROM suppressions ORDER BY created_at DESC")
  }

  function stopEnrolments(email, state = "replied") {
    const result = store.run(
      "UPDATE enrolments SET state = ?, updated_at = ? WHERE contact_email = ? AND state = 'active'",
      state,
      nowIso(),
      normalizeEmail(email),
    )
    return result.changes || 0
  }

  function delayEnrolments(email, days) {
    const until = daysFromNow(days)
    return store.run(
      `UPDATE enrolments SET next_run_at = ?, updated_at = ?
       WHERE contact_email = ? AND state = 'active' AND (next_run_at IS NULL OR next_run_at < ?)`,
      until,
      nowIso(),
      normalizeEmail(email),
      until,
    ).changes
  }

  function touchThread({ id, accountId, subject, contactEmail, gmailThreadId, at, unread = false }) {
    store.run(
      `INSERT INTO threads (id, account_id, subject, contact_email, gmail_thread_id, status, unread, last_message_at)
       VALUES (?, ?, ?, ?, ?, 'open', 0, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_message_at = excluded.last_message_at,
         gmail_thread_id = COALESCE(excluded.gmail_thread_id, threads.gmail_thread_id),
         contact_email = COALESCE(threads.contact_email, excluded.contact_email)`,
      id,
      accountId,
      subject || null,
      contactEmail || null,
      gmailThreadId || null,
      at || nowIso(),
    )
    if (unread) store.run("UPDATE threads SET unread = 1 WHERE id = ?", id)
  }

  function resolveThreadId(accountId, { fromAddr, subject, inReplyTo, refs, gmailThreadId }, { contactFallback = true } = {}) {
    if (gmailThreadId) {
      const row = store.get("SELECT id FROM threads WHERE account_id = ? AND gmail_thread_id = ?", accountId, gmailThreadId)
      if (row) return row.id
    }
    const candidates = [inReplyTo, ...refs].filter(Boolean)
    if (candidates.length) {
      const placeholders = candidates.map(() => "?").join(", ")
      const row = store.get(
        `SELECT thread_id FROM messages WHERE rfc_message_id IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`,
        ...candidates,
      )
      if (row?.thread_id) return row.thread_id
    }
    const subjectKey = normalizeSubject(subject)
    if (subjectKey && fromAddr) {
      const rows = store.all(
        `SELECT thread_id, subject FROM messages
         WHERE account_id = ? AND to_addr LIKE ? AND created_at > ?
         ORDER BY created_at DESC LIMIT 25`,
        accountId,
        `%${fromAddr}%`,
        hoursAgo(24 * 90),
      )
      for (const row of rows) {
        if (normalizeSubject(row.subject) === subjectKey) return row.thread_id
      }
    }
    if (contactFallback && fromAddr) {
      const row = store.get(
        "SELECT id FROM threads WHERE account_id = ? AND contact_email = ? ORDER BY last_message_at DESC LIMIT 1",
        accountId,
        fromAddr,
      )
      if (row) return row.id
    }
    return null
  }

  function dailySentCount(accountId = null) {
    if (accountId) {
      const row = store.get(
        "SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND direction = 'out' AND status = 'sent' AND created_at > ?",
        accountId,
        hoursAgo(24),
      )
      return Number(row?.count || 0)
    }
    return Number(
      store.get("SELECT COUNT(*) AS count FROM messages WHERE direction = 'out' AND status = 'sent' AND created_at > ?", hoursAgo(24))?.count || 0,
    )
  }

  function enforceLimit(account) {
    const cfg = config()
    const limit = effectiveDailyLimit(account, cfg)
    const used = dailySentCount(account.id)
    if (used >= limit) throw new Error(`Daily limit reached for ${account.id}: ${used}/${limit} in the last 24h.`)

    const globalLimit = Number(cfg.globalDailyLimit || 0)
    if (globalLimit > 0 && dailySentCount() >= globalLimit) {
      throw new Error(`Global daily limit reached: ${dailySentCount()}/${globalLimit} across all accounts.`)
    }
    return { used, limit }
  }

  function markWarmupStarted(account) {
    if (!account.warmup || account.warmupStartedAt) return
    const accounts = loadAccounts()
    const target = accounts.find((entry) => entry.id === account.id)
    if (target && !target.warmupStartedAt) {
      target.warmupStartedAt = nowIso()
      saveAccounts(accounts)
    }
  }

  function checkRecipients(account, recipients, cfg, { allowSelf = false } = {}) {
    if (!recipients.length) throw new Error("No valid recipient address")
    const max = Number(cfg.maxRecipientsPerMessage || 20)
    if (recipients.length > max) throw new Error(`Too many recipients (${recipients.length}); maximum is ${max} per message.`)
    for (const recipient of recipients) {
      if (!allowSelf && recipient.address === normalizeEmail(account.email)) throw new Error("Refusing to send to the sending account")
      if (isSuppressed(recipient.address)) throw new Error(`${recipient.address} is suppressed (unsubscribed or bounced)`)
      const block = contactBlockReason(recipient.address)
      if (block) throw new Error(`Refusing to email ${recipient.address}: ${block}`)
      if (cfg.requireConsent) {
        const contact = getContact(recipient.address)
        if (!contact?.consent_at) throw new Error(`${recipient.address} has no recorded consent (requireConsent is on)`)
      }
    }
  }

  function unsubscribeUrlFor(account, email) {
    const cfg = config()
    if (!cfg.publicBaseUrl || !cfg.unsubscribeSecret) return ""
    return `${String(cfg.publicBaseUrl).replace(/\/+$/, "")}/u/${signUnsubscribe(cfg.unsubscribeSecret, email)}`
  }

  function bodyWithFooter(text, cfg, account, { bulk, unsubscribeUrl, noFooter }) {
    if (noFooter) return text
    const parts = [composeFooter(cfg, account, { includeUnsubscribe: bulk && !unsubscribeUrl })]
    if (bulk && unsubscribeUrl) parts.push(`Unsubscribe: ${unsubscribeUrl}`)
    return applyFooter(text, parts.filter(Boolean).join("\n"))
  }

  /* ------------------------------- inbound ------------------------------- */

  function recordInbound(account, parsed, meta = {}) {
    const fromValue = parsed.from?.value?.[0] || {}
    const fromAddr = normalizeEmail(fromValue.address)
    if (!fromAddr) return null
    if (fromAddr === normalizeEmail(account.email)) return null

    const rfcMessageId = normalizeMessageId(parsed.messageId)
    if (rfcMessageId) {
      const existing = store.get("SELECT id FROM messages WHERE account_id = ? AND rfc_message_id = ?", account.id, rfcMessageId)
      if (existing) return null
    }

    const subject = parsed.subject || "(no subject)"
    const text = parsed.text || stripHtml(parsed.html) || ""
    const inReplyTo = normalizeMessageId(parsed.inReplyTo)
    const refs = referenceList(parsed.references)
    const gmailThreadId = meta.gmailThreadId || null

    const threadId = resolveThreadId(account.id, { fromAddr, subject, inReplyTo, refs, gmailThreadId }) || randomUUID()

    ensureContact({ email: fromAddr, name: fromValue.name || null, source: "inbound", consentAt: nowIso() })
    touchThread({
      id: threadId,
      accountId: account.id,
      subject,
      contactEmail: fromAddr,
      gmailThreadId,
      at: parsed.date?.toISOString?.() || nowIso(),
      unread: true,
    })

    const verdict = ruleTriage(parsed, text)
    const disposition = verdict ? triageDisposition(verdict) : null
    const historical = Boolean(meta.historical)
    const needsTriage = verdict || historical ? 0 : 1

    const id = randomUUID()
    insertMessage(store, {
      id,
      account_id: account.id,
      thread_id: threadId,
      direction: "in",
      rfc_message_id: rfcMessageId,
      in_reply_to: inReplyTo,
      refs: JSON.stringify(refs),
      from_addr: fromAddr,
      to_addr: Array.isArray(parsed.to) ? parsed.to.map((entry) => entry.text).join(", ") : parsed.to?.text || account.email,
      cc: Array.isArray(parsed.cc) ? parsed.cc.map((entry) => entry.text).join(", ") : parsed.cc?.text || null,
      subject,
      body_text: text,
      body_html: parsed.html || null,
      snippet: text.slice(0, 240),
      folder: meta.folder || "INBOX",
      imap_uid: meta.uid ?? null,
      gmail_thread_id: gmailThreadId,
      sent_at: null,
      received_at: parsed.date?.toISOString?.() || nowIso(),
      created_at: nowIso(),
      needs_triage: needsTriage,
      triage_intent: verdict || (historical ? "archived" : null),
      triage_json: null,
      campaign_id: null,
      enrolment_id: null,
      step: null,
      bulk: 0,
      status: "received",
    })

    if (disposition?.suppress) suppress([fromAddr], verdict)
    const shouldStop = !historical && (disposition ? disposition.stopSequence : true)
    if (shouldStop) {
      const stopped = stopEnrolments(fromAddr, verdict === "unsubscribe" ? "unsubscribed" : "replied")
      if (stopped) {
        store.event("campaign.stopped", { email: fromAddr, accountId: account.id, data: { stopped, reason: verdict || "reply" } })
      }
    }
    if (disposition?.delayDays) delayEnrolments(fromAddr, disposition.delayDays)

    store.event("reply.received", {
      accountId: account.id,
      messageId: id,
      email: fromAddr,
      data: { subject, threadId, verdict, needsTriage: Boolean(needsTriage), historical },
    })

    return id
  }

  /** Capture mail sent from Gmail itself (or another client) so threads stay complete. */
  function recordSentSync(account, parsed, meta = {}) {
    const rfcMessageId = normalizeMessageId(parsed.messageId)
    if (!rfcMessageId) return null
    if (store.get("SELECT id FROM messages WHERE rfc_message_id = ? LIMIT 1", rfcMessageId)) return null

    const toList = [...(parsed.to?.value || []), ...(parsed.cc?.value || [])]
    const recipients = toList.map((entry) => normalizeEmail(entry.address)).filter(Boolean)
    if (!recipients.length) return null

    const subject = parsed.subject || "(no subject)"
    const text = parsed.text || stripHtml(parsed.html) || ""
    const inReplyTo = normalizeMessageId(parsed.inReplyTo)
    const refs = referenceList(parsed.references)
    const threadId =
      resolveThreadId(account.id, { fromAddr: recipients[0], subject, inReplyTo, refs }, { contactFallback: false }) ||
      randomUUID()

    touchThread({
      id: threadId,
      accountId: account.id,
      subject,
      contactEmail: recipients[0],
      at: parsed.date?.toISOString?.() || nowIso(),
    })

    const id = randomUUID()
    insertMessage(store, {
      id,
      account_id: account.id,
      thread_id: threadId,
      direction: "out",
      rfc_message_id: rfcMessageId,
      in_reply_to: inReplyTo,
      refs: JSON.stringify(refs),
      from_addr: normalizeEmail(account.email),
      to_addr: recipients.join(", "),
      cc: parsed.cc?.text || null,
      subject,
      body_text: text,
      body_html: parsed.html || null,
      snippet: text.slice(0, 240),
      folder: meta.folder || "Sent",
      imap_uid: meta.uid ?? null,
      gmail_thread_id: null,
      sent_at: parsed.date?.toISOString?.() || nowIso(),
      received_at: null,
      created_at: nowIso(),
      needs_triage: 0,
      triage_intent: null,
      triage_json: null,
      campaign_id: null,
      enrolment_id: null,
      step: null,
      bulk: 0,
      status: "synced",
    })

    store.run("UPDATE contacts SET last_contacted_at = ? WHERE email = ?", nowIso(), recipients[0])
    store.event("message.synced_out", { accountId: account.id, messageId: id, email: recipients[0], data: { subject, threadId } })
    return id
  }

  /* --------------------------------- sync -------------------------------- */

  async function syncFolder(account, password, { key, folder, direction, options }) {
    const cfg = config()
    const existing = store.get("SELECT * FROM folders WHERE account_id = ? AND path = ?", account.id, key)
    const startUid = existing?.uid_next ? Number(existing.uid_next) : 0
    const expectedUidValidity = existing?.uid_validity || null
    const triageDays = Number(cfg.triageWindowDays ?? 7)

    let inserted = 0
    const errors = []
    const result = await fetchNewMessages(account, password, {
      folder,
      startUid,
      initialLimit: options.initialLimit || cfg.initialSyncLimit || 200,
      expectedUidValidity,
      onMessage: async (message) => {
        try {
          const parsed = await simpleParser(message.source)
          const historical =
            Boolean(message.internalDate) && Date.now() - new Date(message.internalDate).getTime() > triageDays * 86400_000
          const id =
            direction === "in"
              ? recordInbound(account, parsed, { uid: message.uid, folder: key, historical })
              : recordSentSync(account, parsed, { uid: message.uid, folder: key })
          if (id) inserted += 1
        } catch (error) {
          errors.push(String(error.message || error))
        }
      },
    })

    store.run(
      `INSERT INTO folders (account_id, path, uid_validity, uid_next, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, path) DO UPDATE SET
         uid_validity = excluded.uid_validity,
         uid_next = excluded.uid_next,
         updated_at = excluded.updated_at`,
      account.id,
      key,
      result.uidValidity,
      result.lastUid + 1,
      nowIso(),
    )

    return { folder: key, path: folder, fetched: result.fetched, inserted, errors: errors.slice(0, 5) }
  }

  async function syncAccount(accountOrId, options = {}) {
    const account = typeof accountOrId === "string" ? getAccount(accountOrId) : accountOrId
    if (account.enabled === false) return { account: account.id, skipped: "disabled" }
    const cfg = config()
    const password = resolvePassword(account)

    const inbox = await syncFolder(account, password, { key: "INBOX", folder: "INBOX", direction: "in", options })

    let sent = null
    if (cfg.syncSentFolder !== false) {
      try {
        const cacheKey = `sentMailbox:${account.id}`
        const cached = store.getKv(cacheKey)
        let path = cached?.path && Date.now() - Number(cached.at) < 7 * 86400_000 ? cached.path : null
        if (!path) {
          path = await findMailbox(account, password, "\\Sent", "[Gmail]/Sent Mail")
          store.setKv(cacheKey, { path, at: Date.now() })
        }
        sent = await syncFolder(account, password, { key: "SENT", folder: path, direction: "out", options })
      } catch (error) {
        sent = { error: String(error.message || error) }
      }
    }

    const fetched = inbox.fetched + (sent?.fetched || 0)
    const inserted = inbox.inserted + (sent?.inserted || 0)
    store.event("sync.completed", {
      accountId: account.id,
      data: { fetched, inserted, inbox: { fetched: inbox.fetched, inserted: inbox.inserted }, sent: sent ? { fetched: sent.fetched, inserted: sent.inserted } : null },
    })

    return { account: account.id, fetched, inserted, inbox, sent }
  }

  async function syncAll(options = {}) {
    const results = []
    for (const account of loadAccounts()) {
      if (account.enabled === false) {
        results.push({ account: account.id, skipped: "disabled" })
        continue
      }
      try {
        results.push(await syncAccount(account, options))
      } catch (error) {
        store.event("sync.failed", { accountId: account.id, data: { error: String(error.message || error) } })
        results.push({ account: account.id, error: String(error.message || error) })
      }
    }
    return results
  }

  /* --------------------------------- send -------------------------------- */

  async function send(params) {
    const cfg = config()
    const account = getAccount(params.accountId)
    if (account.enabled === false) throw new Error(`Account ${account.id} is disabled`)

    const recipients = toAddressList(params.to)
    const cc = toAddressList(params.cc)
    const bcc = toAddressList(params.bcc)
    const all = [...recipients, ...cc, ...bcc]
    if (!recipients.length) throw new Error("No valid recipient address")
    checkRecipients(account, all, cfg, { allowSelf: params.preview === true })

    const rawSubject = String(params.subject || "").trim()
    if (!rawSubject) throw new Error("Subject is required")
    const subject = params.preview ? `[PREVIEW] ${rawSubject}` : rawSubject
    let text = params.text || (params.html ? stripHtml(params.html) : "")
    if (!String(text || "").trim()) throw new Error("Body is required")

    const dryRun = params.dryRun ?? cfg.dryRun
    const bulk = Boolean(params.campaignId) || params.bulk === true
    const unsubscribeUrl = bulk ? unsubscribeUrlFor(account, recipients[0].address) : ""
    if (!dryRun) {
      enforceLimit(account)
      markWarmupStarted(account)
    }

    text = bodyWithFooter(text, cfg, account, { bulk, unsubscribeUrl, noFooter: params.noFooter })

    let threadId = params.threadId || null
    let inReplyTo = params.inReplyTo ? normalizeMessageId(params.inReplyTo) : null
    let references = referenceList(params.references)

    if (threadId && !inReplyTo) {
      const last = store.get(
        "SELECT rfc_message_id, refs FROM messages WHERE thread_id = ? AND direction = 'out' AND rfc_message_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        threadId,
      )
      if (last) {
        inReplyTo = last.rfc_message_id
        references = [...new Set([...parseRefs(last.refs), last.rfc_message_id])]
      }
    }
    if (!threadId) threadId = randomUUID()

    if (!inReplyTo && params.dedupe !== false) {
      const duplicate = store.get(
        `SELECT id FROM messages WHERE account_id = ? AND direction = 'out' AND status != 'preview'
           AND to_addr LIKE ? AND lower(subject) = lower(?) AND created_at > ? LIMIT 1`,
        account.id,
        `%${recipients[0].address}%`,
        subject,
        hoursAgo(12),
      )
      if (duplicate) throw new Error("Duplicate send blocked (same recipient/subject within 12h). Use dedupe:false to override.")
    }

    const messageId = params.messageId || newMessageId(account)
    const headers = bulk ? listUnsubscribeHeaders(unsubscribeUrl, account) : {}
    let info = { messageId, response: "dry-run" }

    if (!dryRun) {
      const password = resolvePassword(account)
      info = await sendSmtp(account, password, {
        from: formatAddress(account),
        to: recipients.map((recipient) => (recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address)).join(", "),
        cc: cc.length ? cc.map((recipient) => recipient.address).join(", ") : undefined,
        bcc: bcc.length ? bcc.map((recipient) => recipient.address).join(", ") : undefined,
        subject,
        text,
        html: params.html || null,
        inReplyTo,
        references,
        messageId,
        headers,
        replyTo: account.replyTo || undefined,
      })
    }

    touchThread({ id: threadId, accountId: account.id, subject, contactEmail: recipients[0].address, at: nowIso() })
    const id = randomUUID()
    insertMessage(store, {
      id,
      account_id: account.id,
      thread_id: threadId,
      direction: "out",
      rfc_message_id: info.messageId || messageId,
      in_reply_to: inReplyTo,
      refs: JSON.stringify(references),
      from_addr: normalizeEmail(account.email),
      to_addr: recipients.map((recipient) => recipient.address).join(", "),
      cc: cc.length ? cc.map((recipient) => recipient.address).join(", ") : null,
      subject,
      body_text: text,
      body_html: params.html || null,
      snippet: text.slice(0, 240),
      folder: "Sent",
      imap_uid: null,
      gmail_thread_id: null,
      sent_at: nowIso(),
      received_at: null,
      created_at: nowIso(),
      needs_triage: 0,
      triage_intent: null,
      triage_json: null,
      campaign_id: params.campaignId || null,
      enrolment_id: params.enrolmentId || null,
      step: params.step ?? null,
      bulk: bulk ? 1 : 0,
      status: dryRun ? "simulated" : params.preview ? "preview" : "sent",
    })

    store.run("UPDATE contacts SET last_contacted_at = ? WHERE email = ?", nowIso(), recipients[0].address)
    store.event(dryRun ? "send.simulated" : "send.sent", {
      accountId: account.id,
      messageId: id,
      email: recipients[0].address,
      data: { subject, threadId, campaignId: params.campaignId || null, step: params.step ?? null, bulk },
    })

    return {
      id,
      threadId,
      rfcMessageId: info.messageId || messageId,
      account: account.id,
      from: account.email,
      to: recipients.map((recipient) => recipient.address),
      cc: cc.map((recipient) => recipient.address),
      subject,
      dryRun,
      bulk,
      status: dryRun ? "simulated" : params.preview ? "preview" : "sent",
    }
  }

  async function createDraft(params) {
    const cfg = config()
    const account = getAccount(params.accountId)
    const recipients = toAddressList(params.to)
    const cc = toAddressList(params.cc)
    checkRecipients(account, [...recipients, ...cc], cfg)

    const subject = String(params.subject || "").trim()
    if (!subject) throw new Error("Subject is required")
    let text = params.text || (params.html ? stripHtml(params.html) : "")
    if (!String(text || "").trim()) throw new Error("Body is required")

    const bulk = Boolean(params.campaignId) || params.bulk === true
    const unsubscribeUrl = bulk ? unsubscribeUrlFor(account, recipients[0].address) : ""
    text = bodyWithFooter(text, cfg, account, { bulk, unsubscribeUrl, noFooter: params.noFooter })

    let threadId = params.threadId || null
    let inReplyTo = params.inReplyTo ? normalizeMessageId(params.inReplyTo) : null
    let references = referenceList(params.references)

    if (threadId && !inReplyTo) {
      const last = store.get(
        "SELECT rfc_message_id, refs FROM messages WHERE thread_id = ? AND direction = 'out' AND rfc_message_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        threadId,
      )
      if (last) {
        inReplyTo = last.rfc_message_id
        references = [...new Set([...parseRefs(last.refs), last.rfc_message_id])]
      }
    }
    if (!threadId) threadId = randomUUID()

    const messageId = params.messageId || newMessageId(account)
    const raw = await buildRawMail({
      from: formatAddress(account),
      to: recipients.map((recipient) => (recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address)).join(", "),
      cc: cc.length ? cc.map((recipient) => recipient.address).join(", ") : undefined,
      subject,
      text,
      html: params.html || null,
      inReplyTo,
      references,
      messageId,
      headers: bulk ? listUnsubscribeHeaders(unsubscribeUrl, account) : {},
    })

    let appended = { mailbox: "Drafts", uid: null }
    let status = "pending"
    if (params.dryRun ?? cfg.dryRun) {
      status = "simulated"
    } else {
      const password = resolvePassword(account)
      appended = await appendDraft(account, password, raw, { mailbox: params.mailbox })
    }

    touchThread({ id: threadId, accountId: account.id, subject, contactEmail: recipients[0].address, at: nowIso() })
    const id = randomUUID()
    store.run(
      `INSERT INTO drafts (id, account_id, thread_id, to_addr, cc, subject, body_text, body_html, in_reply_to, refs, rfc_message_id, gmail_uid, mailbox, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      account.id,
      threadId,
      recipients.map((recipient) => recipient.address).join(", "),
      cc.length ? cc.map((recipient) => recipient.address).join(", ") : null,
      subject,
      text,
      params.html || null,
      inReplyTo,
      JSON.stringify(references),
      messageId,
      appended.uid,
      appended.mailbox,
      status,
      nowIso(),
    )
    store.event("draft.created", {
      accountId: account.id,
      email: recipients[0].address,
      data: { threadId, subject, mailbox: appended.mailbox, uid: appended.uid, dryRun: status !== "pending", bulk },
    })

    return {
      id,
      threadId,
      account: account.id,
      to: recipients.map((recipient) => recipient.address),
      subject,
      mailbox: appended.mailbox,
      uid: appended.uid,
      status,
    }
  }

  async function replyToMessage(params) {
    const message = store.get("SELECT * FROM messages WHERE id = ?", params.messageId)
    if (!message) throw new Error(`Message not found: ${params.messageId}`)
    if (message.direction !== "in") throw new Error("Only inbound messages can be replied to")
    const account = getAccount(message.account_id)
    const subject = /^\s*re\s*:/i.test(message.subject || "") ? message.subject : `Re: ${message.subject || "(no subject)"}`
    const references = parseRefs(message.refs)
    if (message.rfc_message_id) references.push(message.rfc_message_id)
    const payload = {
      accountId: account.id,
      to: message.from_addr,
      subject,
      text: params.text,
      html: params.html || null,
      threadId: message.thread_id,
      inReplyTo: message.rfc_message_id,
      references,
      dryRun: params.dryRun,
      noFooter: params.noFooter ?? true,
      bulk: false,
      dedupe: false,
    }
    const outcome = params.send ? await send(payload) : await createDraft(payload)
    return { ...outcome, repliedTo: params.messageId, mode: params.send ? "send" : "draft" }
  }

  /* -------------------------------- queries ------------------------------- */

  function searchMessages(params = {}) {
    const where = []
    const values = []
    if (params.accountId) {
      where.push("account_id = ?")
      values.push(params.accountId)
    }
    if (params.threadId) {
      where.push("thread_id = ?")
      values.push(params.threadId)
    }
    if (params.direction) {
      where.push("direction = ?")
      values.push(params.direction)
    }
    if (params.from) {
      where.push("from_addr LIKE ?")
      values.push(`%${normalizeEmail(params.from)}%`)
    }
    if (params.to) {
      where.push("to_addr LIKE ?")
      values.push(`%${normalizeEmail(params.to)}%`)
    }
    if (params.subject) {
      where.push("subject LIKE ?")
      values.push(`%${params.subject}%`)
    }
    if (params.since) {
      where.push("created_at >= ?")
      values.push(new Date(params.since).toISOString())
    }
    if (params.needsTriage) where.push("needs_triage = 1")
    if (params.query) {
      where.push("(subject LIKE ? OR body_text LIKE ? OR from_addr LIKE ? OR to_addr LIKE ?)")
      const like = `%${params.query}%`
      values.push(like, like, like, like)
    }
    const limit = Math.min(Math.max(Number(params.limit || 25), 1), 200)
    const sql = `SELECT id, account_id, thread_id, direction, rfc_message_id, from_addr, to_addr, subject,
                        snippet, received_at, sent_at, created_at, needs_triage, triage_intent, triage_json, campaign_id, step, status
                 FROM messages ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY created_at DESC LIMIT ${limit}`
    return store.all(sql, ...values)
  }

  function getThread(threadId) {
    const thread = store.get("SELECT * FROM threads WHERE id = ?", threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)
    const messages = store.all("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC", threadId)
    const drafts = store.all("SELECT * FROM drafts WHERE thread_id = ? ORDER BY created_at ASC", threadId)
    return { thread, messages, drafts }
  }

  function listContacts({ query, status, limit = 100 } = {}) {
    const where = []
    const values = []
    if (status) {
      where.push("status = ?")
      values.push(status)
    }
    if (query) {
      where.push("(email LIKE ? OR name LIKE ? OR company LIKE ?)")
      const like = `%${query}%`
      values.push(like, like, like)
    }
    return store.all(
      `SELECT * FROM contacts ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY COALESCE(last_contacted_at, first_seen_at) DESC LIMIT ?`,
      ...values,
      Math.min(Math.max(Number(limit), 1), 500),
    )
  }

  function setContactStatus(email, status, notBefore = null) {
    const target = normalizeEmail(email)
    if (!getContact(target)) throw new Error(`Contact not found: ${target}`)
    if (["unsubscribed", "bounced", "do_not_contact", "complained"].includes(status)) {
      suppress([target], status, status)
    }
    store.run("UPDATE contacts SET status = ?, not_before = ? WHERE email = ?", status, notBefore, target)
    return getContact(target)
  }

  function importContacts({ contacts = [], source = "import", consented = false } = {}) {
    let added = 0
    let updated = 0
    let skipped = 0
    for (const entry of contacts) {
      const input = typeof entry === "string" ? { email: entry } : entry
      const email = normalizeEmail(input?.email)
      if (!email || !isEmail(email)) {
        skipped += 1
        continue
      }
      const existed = Boolean(getContact(email))
      ensureContact({ ...input, email, source: input.source || source, consentAt: consented ? nowIso() : input.consentAt })
      if (existed) updated += 1
      else added += 1
    }
    store.event("contacts.imported", { data: { added, updated, skipped, source } })
    return { added, updated, skipped, total: contacts.length }
  }

  /* ------------------------------- campaigns ------------------------------ */

  function campaignStats(campaignId) {
    const states = Object.fromEntries(
      store
        .all("SELECT state, COUNT(*) AS count FROM enrolments WHERE campaign_id = ? GROUP BY state", campaignId)
        .map((row) => [row.state, Number(row.count)]),
    )
    const steps = store
      .all("SELECT position, subject, delay_days FROM campaign_steps WHERE campaign_id = ? ORDER BY position ASC", campaignId)
      .map((step) => {
        const sent = Number(
          store.get(
            "SELECT COUNT(*) AS count FROM messages WHERE campaign_id = ? AND step = ? AND status IN ('sent','simulated','preview')",
            campaignId,
            step.position,
          )?.count || 0,
        )
        const replies = Number(
          store.get(
            `SELECT COUNT(DISTINCT r.from_addr) AS count
             FROM messages r JOIN messages o ON o.thread_id = r.thread_id
             WHERE r.direction = 'in' AND o.campaign_id = ? AND o.step = ?`,
            campaignId,
            step.position,
          )?.count || 0,
        )
        return {
          position: step.position,
          subject: step.subject,
          delayDays: step.delay_days,
          sent,
          replies,
        }
      })
    return { ...states, steps }
  }

  function listCampaigns() {
    const campaigns = store.all("SELECT * FROM campaigns ORDER BY created_at DESC")
    return campaigns.map((campaign) => ({
      ...campaign,
      steps: store.all("SELECT * FROM campaign_steps WHERE campaign_id = ? ORDER BY position ASC", campaign.id),
      stats: campaignStats(campaign.id),
    }))
  }

  function getCampaign(campaignId) {
    const campaign = store.get("SELECT * FROM campaigns WHERE id = ?", campaignId)
    if (!campaign) throw new Error(`Campaign not found: ${campaignId}`)
    return {
      ...campaign,
      steps: store.all("SELECT * FROM campaign_steps WHERE campaign_id = ? ORDER BY position ASC", campaignId),
      stats: campaignStats(campaignId),
    }
  }

  function createCampaign(params) {
    const name = String(params.name || "").trim()
    if (!name) throw new Error("Campaign name is required")
    const account = getAccount(params.accountId)
    const steps = Array.isArray(params.steps) ? params.steps : []
    if (!steps.length) throw new Error("At least one campaign step is required")
    const mode = params.mode === "send" ? "send" : "draft"
    const id = randomUUID()
    const now = nowIso()
    store.transaction(() => {
      store.run(
        "INSERT INTO campaigns (id, name, account_id, mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)",
        id,
        name,
        account.id,
        mode,
        now,
        now,
      )
      steps.forEach((step, index) => {
        if (!step?.subject || !step?.body) throw new Error(`Step ${index + 1} needs subject and body`)
        store.run(
          "INSERT INTO campaign_steps (campaign_id, position, delay_days, subject, body, html) VALUES (?, ?, ?, ?, ?, ?)",
          id,
          index,
          Number(step.delayDays || (index === 0 ? 0 : 3)),
          step.subject,
          step.body,
          step.html || null,
        )
      })
    })
    store.event("campaign.created", { accountId: account.id, data: { id, name, mode, steps: steps.length } })
    return getCampaign(id)
  }

  function setCampaignStatus(campaignId, status) {
    if (!["draft", "running", "paused", "done"].includes(status)) throw new Error("Invalid campaign status")
    getCampaign(campaignId)
    store.run("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?", status, nowIso(), campaignId)
    store.event("campaign.status", { data: { campaignId, status } })
    return getCampaign(campaignId)
  }

  function pauseAll() {
    const result = store.run("UPDATE campaigns SET status = 'paused', updated_at = ? WHERE status = 'running'", nowIso())
    store.event("campaign.paused_all", { data: { count: result.changes } })
    return { paused: result.changes || 0 }
  }

  function resumeAll() {
    const result = store.run("UPDATE campaigns SET status = 'running', updated_at = ? WHERE status = 'paused'", nowIso())
    store.event("campaign.resumed_all", { data: { count: result.changes } })
    return { resumed: result.changes || 0 }
  }

  function enrolContacts(params) {
    const cfg = config()
    const campaign = getCampaign(params.campaignId)
    const inputs = (Array.isArray(params.contacts) ? params.contacts : []).map((entry) =>
      typeof entry === "string" ? { email: entry } : entry,
    )
    if (!inputs.length) throw new Error("No contacts supplied")
    const firstStep = campaign.steps[0]
    let added = 0
    let skipped = 0
    let skippedActive = 0

    for (const input of inputs) {
      const email = normalizeEmail(input.email)
      if (!email || !isEmail(email)) {
        skipped += 1
        continue
      }
      if (isSuppressed(email) || contactBlockReason(email)) {
        skipped += 1
        continue
      }
      if (cfg.requireConsent) {
        const contact = getContact(email)
        if (!contact?.consent_at && !input.consentAt) {
          skipped += 1
          continue
        }
      }
      if (!cfg.allowMultipleCampaigns) {
        const active = store.get(
          "SELECT id FROM enrolments WHERE contact_email = ? AND state = 'active' AND campaign_id != ? LIMIT 1",
          email,
          campaign.id,
        )
        if (active) {
          skippedActive += 1
          continue
        }
      }

      ensureContact({ ...input, source: input.source || `campaign:${campaign.name}` })
      const nextRun = new Date(Date.now() + Number(firstStep.delay_days || 0) * 86400_000).toISOString()
      const result = store.run(
        `INSERT OR IGNORE INTO enrolments (id, campaign_id, contact_email, step_position, state, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, 0, 'active', ?, ?, ?)`,
        randomUUID(),
        campaign.id,
        email,
        nextRun,
        nowIso(),
        nowIso(),
      )
      if (result.changes) added += 1
      else skipped += 1
    }

    store.event("campaign.enrolled", { data: { campaignId: campaign.id, added, skipped, skippedActive } })
    return { campaignId: campaign.id, added, skipped, skippedActive, status: campaign.status }
  }

  async function previewCampaign(campaignId, params = {}) {
    const campaign = getCampaign(campaignId)
    const account = getAccount(campaign.account_id)
    const to = params.to || account.email
    const sampleContact =
      params.contactEmail ? getContact(params.contactEmail) : store.get("SELECT * FROM contacts ORDER BY first_seen_at DESC LIMIT 1")
    const base = contactVars(sampleContact)
    const vars = {
      ...base,
      first_name: base.first_name || "Alex",
      name: base.name || "Alex Morgan",
      email: to,
      company: base.company || "Acme",
      title: base.title || "Founder",
      campaign: campaign.name,
    }

    const results = []
    for (const step of campaign.steps) {
      const result = await send({
        accountId: account.id,
        to,
        subject: render(step.subject, vars),
        text: render(step.body, vars),
        html: step.html ? render(step.html, vars) : null,
        bulk: true,
        preview: true,
        dedupe: false,
        dryRun: params.dryRun,
      })
      results.push({ step: step.position, id: result.id, subject: result.subject, status: result.status })
    }
    return { campaignId, to, results }
  }

  /** Cross-process claim so the daemon and a manual `campaign tick` never double-send. */
  function acquireTickLock(ttlMs = 120_000) {
    const now = Date.now()
    store.exec("BEGIN IMMEDIATE")
    try {
      const row = store.get("SELECT value FROM kv WHERE key = 'tickLock'")
      const lock = row?.value ? JSON.parse(row.value) : null
      if (lock && now - Number(lock.at) < ttlMs) {
        store.exec("ROLLBACK")
        return false
      }
      store.run(
        "INSERT INTO kv (key, value) VALUES ('tickLock', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        JSON.stringify({ at: now, pid: process.pid }),
      )
      store.exec("COMMIT")
      return true
    } catch (error) {
      try {
        store.exec("ROLLBACK")
      } catch {}
      throw error
    }
  }

  function releaseTickLock() {
    try {
      store.setKv("tickLock", { at: 0 })
    } catch {}
  }

  async function tickCampaigns() {
    const cfg = config()
    if (!inBusinessWindow(new Date(), cfg)) return { skipped: "outside-business-hours", started: 0 }
    let locked = false
    try {
      locked = acquireTickLock()
    } catch {
      locked = false
    }
    if (!locked) return { skipped: "another-tick-in-progress", started: 0 }
    try {
    const due = store.all(
      `SELECT e.id AS enrolment_id, e.step_position, e.campaign_id, e.contact_email, e.thread_id, e.last_message_id,
              c.name AS campaign_name, c.account_id, c.mode,
              s.subject AS step_subject, s.body AS step_body, s.html AS step_html
       FROM enrolments e
       JOIN campaigns c ON c.id = e.campaign_id
       JOIN campaign_steps s ON s.campaign_id = e.campaign_id AND s.position = e.step_position
       WHERE e.state = 'active' AND c.status = 'running' AND e.next_run_at <= ?
       ORDER BY e.next_run_at ASC LIMIT ?`,
      nowIso(),
      Math.min(Math.max(Number(cfg.maxPerTick || 25), 1), 100),
    )

    const results = []
    for (const row of due) {
      try {
        if (isSuppressed(row.contact_email)) {
          store.run("UPDATE enrolments SET state = 'suppressed', updated_at = ? WHERE id = ?", nowIso(), row.enrolment_id)
          continue
        }
        const block = contactBlockReason(row.contact_email)
        if (block) {
          store.run("UPDATE enrolments SET state = 'blocked', updated_at = ? WHERE id = ?", nowIso(), row.enrolment_id)
          store.event("campaign.step.blocked", { email: row.contact_email, data: { campaignId: row.campaign_id, reason: block } })
          continue
        }

        const account = getAccount(row.account_id)
        if (account.enabled === false) {
          store.run(
            "UPDATE enrolments SET next_run_at = ?, updated_at = ? WHERE id = ?",
            new Date(Date.now() + 6 * 3600_000).toISOString(),
            nowIso(),
            row.enrolment_id,
          )
          continue
        }

        const contact = getContact(row.contact_email) || ensureContact({ email: row.contact_email })
        const vars = { ...contactVars(contact), campaign: row.campaign_name }

        const lastOutbound = row.thread_id
          ? store.get(
              "SELECT rfc_message_id, refs FROM messages WHERE thread_id = ? AND direction = 'out' ORDER BY created_at DESC LIMIT 1",
              row.thread_id,
            )
          : null

        const payload = {
          accountId: account.id,
          to: row.contact_email,
          subject: render(row.step_subject, vars),
          text: render(row.step_body, vars),
          html: row.step_html ? render(row.step_html, vars) : null,
          threadId: row.thread_id || null,
          inReplyTo: lastOutbound?.rfc_message_id || null,
          references: lastOutbound ? [...parseRefs(lastOutbound.refs), lastOutbound.rfc_message_id] : [],
          campaignId: row.campaign_id,
          enrolmentId: row.enrolment_id,
          step: row.step_position,
          bulk: true,
          noFooter: false,
        }

        const outcome = row.mode === "send" ? await send(payload) : await createDraft(payload)
        const nextPosition = row.step_position + 1
        const nextStep = store.get(
          "SELECT * FROM campaign_steps WHERE campaign_id = ? AND position = ?",
          row.campaign_id,
          nextPosition,
        )

        if (!nextStep) {
          store.run(
            "UPDATE enrolments SET state = 'done', step_position = ?, thread_id = ?, last_message_id = ?, next_run_at = NULL, updated_at = ? WHERE id = ?",
            nextPosition,
            outcome.threadId,
            outcome.id,
            nowIso(),
            row.enrolment_id,
          )
        } else {
          const jitter = Number(nextStep.delay_days || 0) > 0 ? Math.floor(Math.random() * 4 * 3600_000) : 0
          const nextRun = new Date(Date.now() + Number(nextStep.delay_days || 0) * 86400_000 + jitter).toISOString()
          store.run(
            "UPDATE enrolments SET step_position = ?, thread_id = ?, last_message_id = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
            nextPosition,
            outcome.threadId,
            outcome.id,
            nextRun,
            nowIso(),
            row.enrolment_id,
          )
        }

        results.push({ enrolment: row.enrolment_id, email: row.contact_email, step: row.step_position, mode: row.mode, id: outcome.id })
        store.event("campaign.step", {
          accountId: account.id,
          email: row.contact_email,
          data: { campaignId: row.campaign_id, step: row.step_position, mode: row.mode, outcomeId: outcome.id },
        })
      } catch (error) {
        const message = String(error.message || error)
        store.event("campaign.step.failed", {
          email: row.contact_email,
          data: { campaignId: row.campaign_id, step: row.step_position, error: message },
        })
        const delayMs = /limit reached/i.test(message) ? 3600_000 : 900_000
        store.run(
          "UPDATE enrolments SET next_run_at = ?, updated_at = ? WHERE id = ?",
          new Date(Date.now() + delayMs).toISOString(),
          nowIso(),
          row.enrolment_id,
        )
        results.push({ enrolment: row.enrolment_id, email: row.contact_email, error: message })
      }
    }
    return { started: results.length, results }
    } finally {
      releaseTickLock()
    }
  }

  /* -------------------------------- metrics ------------------------------- */

  function stats() {
    const since = hoursAgo(24)
    const cfg = config()
    const accounts = loadAccounts().map((account) => {
      const sent = dailySentCount(account.id)
      const replies = Number(
        store.get(
          "SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND direction = 'in' AND created_at > ?",
          account.id,
          since,
        )?.count || 0,
      )
      const bounces = Number(
        store.get(
          "SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND direction = 'in' AND triage_intent = 'bounce' AND created_at > ?",
          account.id,
          since,
        )?.count || 0,
      )
      const lastSync = store.get(
        "SELECT created_at FROM events WHERE type = 'sync.completed' AND account_id = ? ORDER BY created_at DESC LIMIT 1",
        account.id,
      )
      return {
        id: account.id,
        email: account.email,
        enabled: account.enabled !== false,
        sent24h: sent,
        dailyLimit: Number(account.dailyLimit || cfg.defaultDailyLimit || 40),
        effectiveLimit: effectiveDailyLimit(account, cfg),
        replies24h: replies,
        bounces24h: bounces,
        lastSyncAt: lastSync?.created_at || null,
      }
    })

    const one = (sql, ...params) => Number(store.get(sql, ...params)?.count || 0)
    const intents = store.all(
      "SELECT triage_intent AS intent, COUNT(*) AS count FROM messages WHERE triage_intent IS NOT NULL GROUP BY triage_intent ORDER BY count DESC",
    )
    const totalSent = one("SELECT COUNT(*) AS count FROM messages WHERE direction = 'out' AND status = 'sent'")
    const totalBounces = one("SELECT COUNT(*) AS count FROM messages WHERE direction = 'in' AND triage_intent = 'bounce'")

    return {
      accounts,
      totals: {
        contacts: one("SELECT COUNT(*) AS count FROM contacts"),
        replies: one("SELECT COUNT(*) AS count FROM messages WHERE direction = 'in'"),
        uniqueRepliers: one("SELECT COUNT(DISTINCT from_addr) AS count FROM messages WHERE direction = 'in'"),
        replies24h: one("SELECT COUNT(*) AS count FROM messages WHERE direction = 'in' AND created_at > ?", since),
        sent: totalSent,
        sent24h: one("SELECT COUNT(*) AS count FROM messages WHERE direction = 'out' AND status = 'sent' AND created_at > ?", since),
        simulated24h: one("SELECT COUNT(*) AS count FROM messages WHERE direction = 'out' AND status = 'simulated' AND created_at > ?", since),
        messages24h: one("SELECT COUNT(*) AS count FROM messages WHERE created_at > ?", since),
        draftsPending: one("SELECT COUNT(*) AS count FROM drafts WHERE status = 'pending'"),
        needsTriage: one("SELECT COUNT(*) AS count FROM messages WHERE needs_triage = 1"),
        suppressed: one("SELECT COUNT(*) AS count FROM suppressions"),
        notNow: one("SELECT COUNT(*) AS count FROM contacts WHERE status = 'not_now'"),
        campaignsRunning: one("SELECT COUNT(*) AS count FROM campaigns WHERE status = 'running'"),
        bounceRate: totalSent ? Number(((totalBounces / totalSent) * 100).toFixed(2)) : 0,
      },
      intents: intents.map((row) => ({ intent: row.intent, count: Number(row.count) })),
    }
  }

  function unclassified(limit = 20) {
    return store.all(
      `SELECT m.id, m.account_id, m.thread_id, m.from_addr, m.subject, m.snippet, m.received_at, t.contact_email
       FROM messages m LEFT JOIN threads t ON t.id = m.thread_id
       WHERE m.needs_triage = 1 AND m.direction = 'in'
       ORDER BY m.created_at DESC LIMIT ?`,
      Math.min(Math.max(Number(limit), 1), 100),
    )
  }

  function classifyMessage(params) {
    const message = store.get("SELECT * FROM messages WHERE id = ?", params.id)
    if (!message) throw new Error(`Message not found: ${params.id}`)
    const intent = String(params.intent || "other")
    if (!TRIAGE_INTENTS.includes(intent)) {
      throw new Error(`Invalid intent "${intent}". Use one of: ${TRIAGE_INTENTS.join(", ")}`)
    }
    const disposition = triageDisposition(intent)
    const notBefore =
      intent === "not_now"
        ? params.notBefore || new Date(Date.now() + Number(disposition.delayDays || 90) * 86400_000).toISOString()
        : null

    store.run(
      "UPDATE messages SET needs_triage = 0, triage_intent = ?, triage_json = ? WHERE id = ?",
      intent,
      JSON.stringify(params),
      params.id,
    )
    if (disposition.suppress) suppress([message.from_addr], intent)
    if (disposition.stopSequence) stopEnrolments(message.from_addr, intent)
    if (disposition.delayDays && !disposition.stopSequence) delayEnrolments(message.from_addr, disposition.delayDays)
    if (disposition.contactStatus) {
      store.run(
        "UPDATE contacts SET status = ?, not_before = COALESCE(?, not_before) WHERE email = ?",
        disposition.contactStatus,
        notBefore,
        message.from_addr,
      )
    }
    if (params.notes) {
      const existing = getContact(message.from_addr)
      const stamp = new Date().toISOString().slice(0, 10)
      store.run(
        "UPDATE contacts SET notes = ? WHERE email = ?",
        `${existing?.notes || ""}\n[${stamp}] ${params.notes}`.trim(),
        message.from_addr,
      )
    }
    store.event("message.classified", {
      email: message.from_addr,
      messageId: params.id,
      data: { intent, disposition, notBefore },
    })
    return { id: params.id, intent, disposition, notBefore }
  }

  function listDrafts(status = "pending", limit = 50) {
    return store.all(
      `SELECT d.*, t.subject AS thread_subject FROM drafts d
       LEFT JOIN threads t ON t.id = d.thread_id
       WHERE (? = 'all' OR d.status = ?)
       ORDER BY d.created_at DESC LIMIT ?`,
      status,
      status,
      Math.min(Math.max(Number(limit), 1), 200),
    )
  }

  function health() {
    const cfg = config()
    const lastSync = store.get("SELECT created_at FROM events WHERE type = 'sync.completed' ORDER BY created_at DESC LIMIT 1")
    const lastError = store.get("SELECT created_at, data FROM events WHERE type IN ('sync.failed') ORDER BY created_at DESC LIMIT 1")
    let lastErrorDetail = null
    if (lastError) {
      try {
        lastErrorDetail = JSON.parse(lastError.data)
      } catch {
        lastErrorDetail = lastError.data
      }
    }
    return {
      ok: true,
      version: "0.1.0",
      dryRun: Boolean(cfg.dryRun),
      timezone: cfg.timezone,
      syncSentFolder: cfg.syncSentFolder !== false,
      accounts: loadAccounts().length,
      pendingDrafts: Number(store.get("SELECT COUNT(*) AS count FROM drafts WHERE status = 'pending'")?.count || 0),
      needsTriage: Number(store.get("SELECT COUNT(*) AS count FROM messages WHERE needs_triage = 1")?.count || 0),
      campaignsRunning: Number(store.get("SELECT COUNT(*) AS count FROM campaigns WHERE status = 'running'")?.count || 0),
      lastSyncAt: lastSync?.created_at || null,
      lastError: lastError ? { at: lastError.created_at, detail: lastErrorDetail } : null,
    }
  }

  function listAccounts() {
    const cfg = config()
    return loadAccounts().map((account) => ({
      ...publicAccount(account),
      sent24h: dailySentCount(account.id),
      effectiveLimit: effectiveDailyLimit(account, cfg),
      warmupActive: Boolean(account.warmup) && effectiveDailyLimit(account, cfg) < Number(account.dailyLimit || cfg.defaultDailyLimit || 40),
    }))
  }

  return {
    store,
    config,
    listAccounts,
    ensureContact,
    getContact,
    contactVars,
    isSuppressed,
    contactBlockReason,
    suppress,
    listSuppressions,
    stopEnrolments,
    delayEnrolments,
    recordInbound,
    recordSentSync,
    syncAccount,
    syncAll,
    send,
    createDraft,
    replyToMessage,
    searchMessages,
    getThread,
    listContacts,
    importContacts,
    setContactStatus,
    listCampaigns,
    getCampaign,
    createCampaign,
    setCampaignStatus,
    pauseAll,
    resumeAll,
    enrolContacts,
    previewCampaign,
    tickCampaigns,
    stats,
    unclassified,
    classifyMessage,
    listDrafts,
    health,
    dailySentCount,
    effectiveLimit: (account) => effectiveDailyLimit(account, config()),
    unsubscribeUrlFor,
  }
}
