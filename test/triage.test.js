import assert from "node:assert/strict"
import { test } from "node:test"
import { ruleTriage, triageDisposition } from "../src/triage.js"

function parsed({ from, subject = "Hello", headers = [], text = "", inReplyTo = null, references = [] }) {
  return {
    from: { value: [{ address: from, name: "" }] },
    subject,
    text,
    headers: new Map(headers),
    inReplyTo,
    references,
  }
}

test("bulk headers beat an unsubscribe footer", () => {
  const message = parsed({
    from: "news@company.com",
    subject: "Product update",
    text: "Read the news. Unsubscribe here.",
    headers: [["list-id", "<news.company.com>"]],
  })
  assert.equal(ruleTriage(message, message.text), "newsletter")
})

test("machine senders are automated, not human replies", () => {
  for (const address of [
    "no-reply@example.com",
    "notifications@example.com",
    "reminders@facebookmail.com",
    "sc-noreply@google.com",
    "do-not-reply@example.com",
  ]) {
    assert.equal(ruleTriage(parsed({ from: address }), ""), "automated", address)
  }
})

test("unsubscribe in a non-reply body is a newsletter, not an opt-out", () => {
  const message = parsed({
    from: "marketing@vendor.com",
    subject: "Weekly digest",
    text: "Some content. Click to unsubscribe.",
  })
  assert.equal(ruleTriage(message, message.text), "newsletter")
})

test("unsubscribe in a direct reply is an opt-out", () => {
  const message = parsed({
    from: "person@example.com",
    subject: "Re: Quick question",
    text: "Please unsubscribe me from this.",
    inReplyTo: "<parent@example.com>",
    references: ["<parent@example.com>"],
  })
  assert.equal(ruleTriage(message, message.text), "unsubscribe")
})

test("bounces and out-of-office are detected first", () => {
  assert.equal(ruleTriage(parsed({ from: "mailer-daemon@example.com" }), ""), "bounce")
  assert.equal(
    ruleTriage(parsed({ from: "person@example.com", subject: "Automatic reply: out of office" }), ""),
    "ooo",
  )
})

test("automated detection also catches prefixed no-reply addresses", () => {
  for (const address of ["localservices-noreply@google.com", "googleads-noreply@google.com", "digest@vendor.com"]) {
    assert.equal(ruleTriage(parsed({ from: address }), ""), "automated", address)
  }
})

test("bulk subject or preference footer makes non-replies newsletters", () => {
  assert.equal(ruleTriage(parsed({ from: "person@vendor.com", subject: "Clarity digest: weekly recap" }), ""), "newsletter")
  assert.equal(
    ruleTriage(parsed({ from: "person@vendor.com", subject: "Hello", text: "Manage your preferences here." }), "Manage your preferences here."),
    "newsletter",
  )
})

test("a human reply is never downgraded by bulk wording", () => {
  const message = parsed({
    from: "client@example.com",
    subject: "Re: Weekly recap",
    text: "Thanks, can you send the digest?",
    inReplyTo: "<parent@example.com>",
  })
  assert.equal(ruleTriage(message, message.text), null)
})

test("footers and bulk link domains are found beyond the first block", () => {
  const footer = "x".repeat(1500) + " Unsubscribe"
  assert.equal(ruleTriage(parsed({ from: "person@vendor.com", subject: "Hello" }), footer), "newsletter")
  assert.equal(
    ruleTriage(parsed({ from: "person@vendor.com", subject: "Hello" }), "Sent via us.list-manage.com"),
    "newsletter",
  )
})

test("a human reply quoting an unsubscribe footer stays human", () => {
  const quoted = "x".repeat(1500) + " Unsubscribe"
  const message = parsed({
    from: "client@example.com",
    subject: "Re: Proposal",
    text: quoted,
    inReplyTo: "<parent@example.com>",
  })
  assert.equal(ruleTriage(message, message.text), null)
})

test("automated and newsletter dispositions never suppress or stop sequences", () => {
  for (const intent of ["automated", "newsletter"]) {
    const disposition = triageDisposition(intent)
    assert.equal(disposition.suppress, false)
    assert.equal(disposition.stopSequence, false)
    assert.equal(disposition.contactStatus, null)
  }
})
