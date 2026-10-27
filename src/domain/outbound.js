import { randomUUID } from "node:crypto"
import { getAccount, loadAccounts, resolvePassword, saveAccounts } from "../config.js"
import { appendDraft } from "../mail/imap.js"
import {
  applyFooter,
  buildRawMail,
  composeFooter,
  listUnsubscribeHeaders,
  newMessageId,
  stripHtml,
} from "../mail/mime.js"
import { formatAddress, normalizeEmail, toAddressList } from "../mail/address.js"
import { sendSmtp } from "../mail/smtp.js"
import { signUnsubscribe } from "../unsubscribe.js"
import {
  clamp,
  countSent,
  effectiveDailyLimit,
  hoursAgo,
  insertMessage,
  normalizeMessageId,
  nowIso,
  parseRefs,
  referenceList,
} from "./shared.js"

export function createOutbound({ store, config, contacts, threads }) {
  function enforceLimit(account) {
    const cfg = config()
    const limit = effectiveDailyLimit(account, cfg)
    const used = countSent(store, account.id)
    if (used >= limit) throw new Error(`Daily limit reached for ${account.id}: ${used}/${limit} in the last 24h.`)

    const globalLimit = Number(cfg.globalDailyLimit || 0)
    if (globalLimit > 0) {
      const total = countSent(store)
      if (total >= globalLimit) throw new Error(`Global daily limit reached: ${total}/${globalLimit} across all accounts.`)
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
      if (!allowSelf && recipient.address === normalizeEmail(account.email)) {
        throw new Error("Refusing to send to the sending account")
      }
      if (contacts.isSuppressed(recipient.address)) {
        throw new Error(`${recipient.address} is suppressed (unsubscribed or bounced)`)
      }
      const block = contacts.contactBlockReason(recipient.address)
      if (block) throw new Error(`Refusing to email ${recipient.address}: ${block}`)
      if (cfg.requireConsent) {
        const contact = contacts.getContact(recipient.address)
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

  /** Resolve thread id and the headers that keep a message inside it. */
  function resolveThreadContext({ threadId, inReplyTo, references }) {
    let nextThreadId = threadId || null
    let nextInReplyTo = inReplyTo ? normalizeMessageId(inReplyTo) : null
    let nextReferences = referenceList(references)

    if (nextThreadId && !nextInReplyTo) {
      const last = store.get(
        "SELECT rfc_message_id, refs FROM messages WHERE thread_id = ? AND direction = 'out' AND rfc_message_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        nextThreadId,
      )
      if (last) {
        nextInReplyTo = last.rfc_message_id
        nextReferences = [...new Set([...parseRefs(last.refs), last.rfc_message_id])]
      }
    }
    if (!nextThreadId) nextThreadId = randomUUID()

    return { threadId: nextThreadId, inReplyTo: nextInReplyTo, references: nextReferences }
  }

  async function send(params) {
    const cfg = config()
    const account = getAccount(params.accountId)
    if (account.enabled === false) throw new Error(`Account ${account.id} is disabled`)

    const recipients = toAddressList(params.to)
    const cc = toAddressList(params.cc)
    const bcc = toAddressList(params.bcc)
    if (!recipients.length) throw new Error("No valid recipient address")
    checkRecipients(account, [...recipients, ...cc, ...bcc], cfg, { allowSelf: params.preview === true })

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

    const context = resolveThreadContext(params)

    if (!context.inReplyTo && params.dedupe !== false) {
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
        to: recipients.map(formatRecipient).join(", "),
        cc: cc.length ? cc.map((recipient) => recipient.address).join(", ") : undefined,
        bcc: bcc.length ? bcc.map((recipient) => recipient.address).join(", ") : undefined,
        subject,
        text,
        html: params.html || null,
        inReplyTo: context.inReplyTo,
        references: context.references,
        messageId,
        headers,
        replyTo: account.replyTo || undefined,
      })
    }

    threads.touchThread({
      id: context.threadId,
      accountId: account.id,
      subject,
      contactEmail: recipients[0].address,
      at: nowIso(),
    })

    const id = randomUUID()
    const status = dryRun ? "simulated" : params.preview ? "preview" : "sent"
    insertMessage(store, {
      id,
      account_id: account.id,
      thread_id: context.threadId,
      direction: "out",
      rfc_message_id: info.messageId || messageId,
      in_reply_to: context.inReplyTo,
      refs: JSON.stringify(context.references),
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
      status,
    })

    contacts.touchContact(recipients[0].address)
    store.event(dryRun ? "send.simulated" : "send.sent", {
      accountId: account.id,
      messageId: id,
      email: recipients[0].address,
      data: { subject, threadId: context.threadId, campaignId: params.campaignId || null, step: params.step ?? null, bulk },
    })

    return {
      id,
      threadId: context.threadId,
      rfcMessageId: info.messageId || messageId,
      account: account.id,
      from: account.email,
      to: recipients.map((recipient) => recipient.address),
      cc: cc.map((recipient) => recipient.address),
      subject,
      dryRun,
      bulk,
      status,
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

    const context = resolveThreadContext(params)
    const messageId = params.messageId || newMessageId(account)
    const raw = await buildRawMail({
      from: formatAddress(account),
      to: recipients.map(formatRecipient).join(", "),
      cc: cc.length ? cc.map((recipient) => recipient.address).join(", ") : undefined,
      subject,
      text,
      html: params.html || null,
      inReplyTo: context.inReplyTo,
      references: context.references,
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

    threads.touchThread({
      id: context.threadId,
      accountId: account.id,
      subject,
      contactEmail: recipients[0].address,
      at: nowIso(),
    })

    const id = randomUUID()
    store.run(
      `INSERT INTO drafts (id, account_id, thread_id, to_addr, cc, subject, body_text, body_html, in_reply_to, refs, rfc_message_id, gmail_uid, mailbox, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      account.id,
      context.threadId,
      recipients.map((recipient) => recipient.address).join(", "),
      cc.length ? cc.map((recipient) => recipient.address).join(", ") : null,
      subject,
      text,
      params.html || null,
      context.inReplyTo,
      JSON.stringify(context.references),
      messageId,
      appended.uid,
      appended.mailbox,
      status,
      nowIso(),
    )
    store.event("draft.created", {
      accountId: account.id,
      email: recipients[0].address,
      data: {
        threadId: context.threadId,
        subject,
        mailbox: appended.mailbox,
        uid: appended.uid,
        dryRun: status !== "pending",
        bulk,
      },
    })

    return {
      id,
      threadId: context.threadId,
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

  function listDrafts(status = "pending", limit = 50) {
    return store.all(
      `SELECT d.*, t.subject AS thread_subject FROM drafts d
       LEFT JOIN threads t ON t.id = d.thread_id
       WHERE (? = 'all' OR d.status = ?)
       ORDER BY d.created_at DESC LIMIT ?`,
      status,
      status,
      clamp(limit, 1, 200),
    )
  }

  return { send, createDraft, replyToMessage, listDrafts, unsubscribeUrlFor }
}

function formatRecipient(recipient) {
  return recipient.name ? `${recipient.name} <${recipient.address}>` : recipient.address
}
