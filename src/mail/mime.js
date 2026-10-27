import { randomUUID } from "node:crypto"
import MailComposer from "nodemailer/lib/mail-composer/index.js"
import { domainOf } from "./address.js"

export function newMessageId(account) {
  return `<${randomUUID()}@${domainOf(account.email) || "localhost"}>`
}

export function normalizeSubject(subject) {
  return String(subject || "")
    .replace(/^((re|fwd|fw)\s*:\s*)+/gi, "")
    .trim()
    .toLowerCase()
}

export function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function render(template, vars = {}) {
  return String(template || "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = vars[key]
    return value === undefined || value === null ? "" : String(value)
  })
}

export function listUnsubscribeHeaders(url, account = {}) {
  const target = url || (account.unsubscribeMailto ? `mailto:${account.unsubscribeMailto}` : "")
  if (!target) return {}
  const headers = { "List-Unsubscribe": `<${target}>` }
  // One-Click only applies to https URLs, not mailto.
  if (/^https:\/\//i.test(target)) headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
  return headers
}

export function composeFooter(config, account = {}) {
  const parts = []
  const signature = account.signature || config.signature
  const address = account.footerAddress || config.footerAddress
  const mailto = account.unsubscribeMailto || config.unsubscribeMailto
  if (signature) parts.push(signature)
  if (address) parts.push(address)
  if (config.unsubscribeUrl) parts.push(`Unsubscribe: ${config.unsubscribeUrl}`)
  else if (mailto) parts.push(`Unsubscribe: mailto:${mailto}`)
  return parts.filter(Boolean).join("\n")
}

export function applyFooter(text, footer) {
  if (!footer) return text
  return `${String(text || "").trimEnd()}\n\n--\n${footer}\n`
}

/** Build a raw RFC 5322 message for IMAP APPEND (drafts). */
export function buildRawMail({ from, to, cc, bcc, subject, text, html, inReplyTo, references, messageId, headers = {} }) {
  const mail = new MailComposer({
    from,
    to,
    cc,
    bcc,
    subject,
    text,
    html,
    inReplyTo,
    references,
    messageId,
    headers,
    date: new Date(),
  })
  const compiled = mail.compile()
  return new Promise((resolve, reject) => {
    compiled.build((error, buffer) => (error ? reject(error) : resolve(buffer)))
  })
}
