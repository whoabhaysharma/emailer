const BOUNCE_SUBJECT = /(undeliver|delivery status notification|delivery failure|failure notice|mail delivery failed|returned mail)/i
const BOUNCE_FROM = /^(mailer-daemon|postmaster)@/i
const OOO_SUBJECT = /(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|on leave|vacation|abwesenheit)/i
const UNSUB_SUBJECT = /^(unsubscribe|remove me|opt out)/i
const UNSUB_BODY = /\b(unsubscribe|remove me from|stop emailing|opt me out|don'?t email me|take me off)\b/i

/**
 * Cheap deterministic triage. Runs before any model call so opt-outs and bounces
 * are honoured even when no LLM is available.
 */
export function ruleTriage(parsed, text = "") {
  const from = String(parsed?.from?.value?.[0]?.address || "")
  const subject = String(parsed?.subject || "")
  const headers = parsed?.headers
  const autoSubmitted = headers?.get?.("auto-submitted") || ""
  const precedence = headers?.get?.("precedence") || ""
  const listId = headers?.get?.("list-id") || ""
  const contentType = headers?.get?.("content-type") || ""
  const head = String(text || "").slice(0, 1200)

  if (BOUNCE_FROM.test(from) || BOUNCE_SUBJECT.test(subject) || /multipart\/report/i.test(contentType)) return "bounce"
  if (String(autoSubmitted).toLowerCase().includes("auto") || OOO_SUBJECT.test(subject)) return "ooo"
  if (UNSUB_SUBJECT.test(subject) || UNSUB_BODY.test(head)) return "unsubscribe"
  if (listId || /bulk|list/i.test(String(precedence))) return "newsletter"
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
