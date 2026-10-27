import { randomUUID } from "node:crypto"
import { stripHtml } from "../mail/mime.js"
import { normalizeEmail } from "../mail/address.js"
import { TRIAGE_INTENTS, ruleTriage, triageDisposition } from "../triage.js"
import { clamp, insertMessage, normalizeMessageId, nowIso, referenceList } from "./shared.js"

export function createMessages({ store, contacts, threads, enrolments }) {
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

    const threadId = threads.resolveThreadId(account.id, { fromAddr, subject, inReplyTo, refs, gmailThreadId }) || randomUUID()

    contacts.ensureContact({ email: fromAddr, name: fromValue.name || null, source: "inbound", consentAt: nowIso() })
    threads.touchThread({
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

    if (disposition?.suppress) contacts.suppress([fromAddr], verdict)
    const shouldStop = !historical && (disposition ? disposition.stopSequence : true)
    if (shouldStop) {
      const stopped = enrolments.stopEnrolments(fromAddr, verdict === "unsubscribe" ? "unsubscribed" : "replied")
      if (stopped) {
        store.event("campaign.stopped", { email: fromAddr, accountId: account.id, data: { stopped, reason: verdict || "reply" } })
      }
    }
    if (disposition?.delayDays) enrolments.delayEnrolments(fromAddr, disposition.delayDays)

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
      threads.resolveThreadId(account.id, { fromAddr: recipients[0], subject, inReplyTo, refs }, { contactFallback: false }) ||
      randomUUID()

    threads.touchThread({
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

    contacts.touchContact(recipients[0])
    store.event("message.synced_out", { accountId: account.id, messageId: id, email: recipients[0], data: { subject, threadId } })
    return id
  }

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
    const limit = clamp(params.limit || 25, 1, 200)
    const sql = `SELECT id, account_id, thread_id, direction, rfc_message_id, from_addr, to_addr, subject,
                        snippet, received_at, sent_at, created_at, needs_triage, triage_intent, triage_json,
                        campaign_id, step, status
                 FROM messages ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY created_at DESC LIMIT ${limit}`
    return store.all(sql, ...values)
  }

  function unclassified(limit = 20) {
    return store.all(
      `SELECT m.id, m.account_id, m.thread_id, m.from_addr, m.subject, m.snippet, m.received_at, t.contact_email
       FROM messages m LEFT JOIN threads t ON t.id = m.thread_id
       WHERE m.needs_triage = 1 AND m.direction = 'in'
       ORDER BY m.created_at DESC LIMIT ?`,
      clamp(limit, 1, 100),
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
    if (disposition.suppress) contacts.suppress([message.from_addr], intent)
    if (disposition.stopSequence) enrolments.stopEnrolments(message.from_addr, intent)
    if (disposition.delayDays && !disposition.stopSequence) enrolments.delayEnrolments(message.from_addr, disposition.delayDays)
    if (disposition.contactStatus) {
      store.run(
        "UPDATE contacts SET status = ?, not_before = COALESCE(?, not_before) WHERE email = ?",
        disposition.contactStatus,
        notBefore,
        message.from_addr,
      )
    }
    contacts.appendNote(message.from_addr, params.notes)

    store.event("message.classified", {
      email: message.from_addr,
      messageId: params.id,
      data: { intent, disposition, notBefore },
    })

    return { id: params.id, intent, disposition, notBefore }
  }

  return { recordInbound, recordSentSync, searchMessages, unclassified, classifyMessage }
}
