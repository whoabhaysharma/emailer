const BOUNCE_SUBJECT = /(undeliver|delivery status notification|delivery failure|failure notice|mail delivery failed|returned mail)/i
const BOUNCE_FROM = /^(mailer-daemon|postmaster)@/i
const OOO_SUBJECT = /(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|on leave|vacation|abwesenheit)/i
const UNSUB_SUBJECT = /^\s*(unsubscribe|remove me|opt out)\s*$/i
const UNSUB_BODY = /\b(unsubscribe|remove me from|stop emailing|opt me out|don'?t email me|take me off)\b/i

/** Sender local-parts that are machine mail, never a human reply. */
const AUTOMATED_LOCAL = /(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?)/i
const AUTOMATED_PREFIX = /^(notifications?|notify|alerts?|reminders?|changelog|newsletter|digest|updates?)/i
const BULK_SUBJECT = /\b(newsletter|digest|weekly recap|webinar|promotion|product update|what'?s new|last chance)\b/i
const BULK_BODY = /\b(unsubscribe|manage (your )?preferences|email preferences|view (this|it) in (your )?browser|no longer wish to receive)\b/i
const BULK_LINK = /(list-manage\.com|customer\.io|mailchimp|sendgrid|hubspot|klaviyo|mailgun|constantcontact|activehosted|convertkit)/i

/**
 * Remove quoted history and our own footer before looking for opt-out words.
 * A positive reply that quotes "Unsubscribe: ..." must not look like an opt-out.
 */
function stripQuoted(text) {
  const kept = []
  for (const line of String(text || "").split(/\r?\n/)) {
    if (/^\s*>/.test(line)) continue
    if (/^\s*On .+ wrote:\s*$/i.test(line)) break
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break
    if (/^\s*Unsubscribe:\s/i.test(line)) break
    kept.push(line)
  }
  return kept.join("\n").trim()
}

/**
 * Cheap deterministic triage. Runs before any model call so opt-outs and bounces
 * are honoured even when no LLM is available.
 *
 * Order matters:
 *   1. bounces and auto-replies are unambiguous
 *   2. machine senders are automated
 *   3. bulk headers beat body text, so a newsletter footer is not an opt-out
 *   4. "unsubscribe" in a body only counts when it is a direct reply
 */
export function ruleTriage(parsed, text = "") {
  const from = String(parsed?.from?.value?.[0]?.address || "")
  const local = from.split("@")[0]
  const subject = String(parsed?.subject || "")
  const headers = parsed?.headers
  const get = (name) => String(headers?.get?.(name) || "")
  const autoSubmitted = get("auto-submitted")
  const precedence = get("precedence")
  const listId = get("list-id")
  const listUnsubscribe = get("list-unsubscribe")
  const contentType = get("content-type")
  const full = String(text || "").slice(0, 20_000)
  const isReply =
    Boolean(parsed?.inReplyTo) ||
    (Array.isArray(parsed?.references) && parsed.references.length > 0) ||
    /^\s*re\s*:/i.test(subject)
  const replyText = isReply ? stripQuoted(full) : full

  if (BOUNCE_FROM.test(from) || BOUNCE_SUBJECT.test(subject) || /multipart\/report/i.test(contentType)) return "bounce"
  if (autoSubmitted.toLowerCase().includes("auto") || OOO_SUBJECT.test(subject)) return "ooo"
  if (AUTOMATED_LOCAL.test(local) || AUTOMATED_PREFIX.test(local)) return "automated"
  if (listId || listUnsubscribe || /bulk|list/i.test(precedence)) return "newsletter"
  if (UNSUB_SUBJECT.test(subject)) return "unsubscribe"
  if (isReply && UNSUB_BODY.test(replyText.slice(0, 800))) return "unsubscribe"
  if (!isReply && (BULK_SUBJECT.test(subject) || BULK_BODY.test(full) || BULK_LINK.test(full))) return "newsletter"
  return null
}

export const TRIAGE_INTENTS = [
  "interested",
  "not_now",
  "objection",
  "unsubscribe",
  "ooo",
  "bounce",
  "newsletter",
  "automated",
  "referral",
  "wrong_person",
  "question",
  "other",
]

export function triageDisposition(intent) {
  switch (intent) {
    case "unsubscribe":
      return { suppress: true, stopSequence: true, contactStatus: "unsubscribed" }
    case "bounce":
      return { suppress: true, stopSequence: true, contactStatus: "bounced" }
    case "not_now":
      return { suppress: false, stopSequence: true, contactStatus: "not_now", delayDays: 90 }
    case "wrong_person":
      return { suppress: false, stopSequence: true, contactStatus: "wrong_person" }
    case "newsletter":
    case "automated":
      return { suppress: false, stopSequence: false, contactStatus: null }
    case "ooo":
      return { suppress: false, stopSequence: false, contactStatus: null, delayDays: 2 }
    case "interested":
      return { suppress: false, stopSequence: true, contactStatus: "interested" }
    case "referral":
      return { suppress: false, stopSequence: true, contactStatus: "referred" }
    case "objection":
    case "question":
      return { suppress: false, stopSequence: true, contactStatus: "engaged" }
    default:
      return { suppress: false, stopSequence: true, contactStatus: null }
  }
}
