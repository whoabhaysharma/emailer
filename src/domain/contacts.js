import { isEmail, normalizeEmail } from "../mail/address.js"
import { BLOCKED_STATUS, clamp, contactVars, nowIso } from "./shared.js"

export function createContacts({ store, enrolments }) {
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
      return getContact(email)
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
    return getContact(email)
  }

  function getContact(email) {
    return store.get("SELECT * FROM contacts WHERE email = ?", normalizeEmail(email))
  }

  function isSuppressed(email) {
    return Boolean(store.get("SELECT email FROM suppressions WHERE email = ?", normalizeEmail(email)))
  }

  /** Human-readable reason when an address must not be contacted, or null. */
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
      enrolments.stopEnrolments(email, reason === "bounce" ? "bounced" : "suppressed")
      store.run("UPDATE contacts SET status = ? WHERE email = ?", status, email)
    }
    store.event("suppression.added", { data: { reason, emails: list, added } })
    return { added, total: list.length, emails: list }
  }

  function listSuppressions() {
    return store.all("SELECT * FROM suppressions ORDER BY created_at DESC")
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
      clamp(limit, 1, 500),
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

  function touchContact(email) {
    store.run("UPDATE contacts SET last_contacted_at = ? WHERE email = ?", nowIso(), normalizeEmail(email))
  }

  function appendNote(email, note) {
    if (!note) return
    const existing = getContact(email)
    const stamp = nowIso().slice(0, 10)
    store.run(
      "UPDATE contacts SET notes = ? WHERE email = ?",
      `${existing?.notes || ""}\n[${stamp}] ${note}`.trim(),
      normalizeEmail(email),
    )
  }

  return {
    ensureContact,
    getContact,
    isSuppressed,
    contactBlockReason,
    suppress,
    listSuppressions,
    listContacts,
    setContactStatus,
    importContacts,
    touchContact,
    appendNote,
    contactVars,
  }
}
