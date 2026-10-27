import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const root = mkdtempSync(join(tmpdir(), "email-agent-test-"))
const home = join(root, "home")
const data = join(root, "data")
mkdirSync(home, { recursive: true })
mkdirSync(data, { recursive: true })

process.env.EMAIL_AGENT_HOME = home
process.env.EMAIL_AGENT_DATA = data

writeFileSync(
  join(home, "config.json"),
  JSON.stringify({
    dryRun: true,
    timezone: "UTC",
    defaultDailyLimit: 10,
    businessHours: { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] },
    signature: "",
    footerAddress: "",
    unsubscribeUrl: "",
  }),
)

writeFileSync(
  join(home, "accounts.json"),
  JSON.stringify({
    accounts: [
      {
        id: "sales",
        email: "sales@example.com",
        displayName: "Sales",
        dailyLimit: 10,
        enabled: true,
      },
    ],
  }),
)
writeFileSync(join(home, "token"), "test-token\n")

const { openStore } = await import("../src/store.js")
const { createService } = await import("../src/service.js")
const { getAccount } = await import("../src/config.js")
const { createTools } = await import("../src/tools/index.js")

const store = openStore()
const service = createService(store)
const account = getAccount("sales")

process.on("exit", () => {
  try {
    store.close()
  } catch {}
  rmSync(root, { recursive: true, force: true })
})

test("plugin exposes the expected tool surface", () => {
  const tools = createTools({ get: async () => ({}), post: async () => ({}), request: async () => ({}) })
  const names = tools.map((tool) => tool.name)
  for (const required of ["send", "draft", "reply", "search", "thread", "campaign_create", "classify"]) {
    assert.ok(names.includes(required), `missing tool ${required}`)
  }
  for (const tool of tools) {
    assert.equal(tool.input.type, "object")
    assert.equal(typeof tool.description, "string")
  }
})

let firstSend

test("dry-run send stores a sent message and a thread", async () => {
  firstSend = await service.send({
    accountId: "sales",
    to: "bob@example.com",
    subject: "Hello Bob",
    text: "Hi Bob, quick question about your onboarding.",
  })

  assert.equal(firstSend.status, "simulated")
  assert.equal(firstSend.dryRun, true)
  assert.match(firstSend.rfcMessageId, /^<.+@example\.com>$/)

  const thread = service.getThread(firstSend.threadId)
  assert.equal(thread.messages.length, 1)
  assert.equal(thread.messages[0].direction, "out")
  assert.equal(thread.thread.contact_email, "bob@example.com")
})

test("duplicate recipient and subject are blocked", async () => {
  await assert.rejects(
    () =>
      service.send({
        accountId: "sales",
        to: "bob@example.com",
        subject: "Hello Bob",
        text: "second copy",
      }),
    /Duplicate send blocked/,
  )
})

test("suppression list blocks sending", async () => {
  service.suppress(["bad@example.com"], "unsubscribe")
  assert.equal(service.isSuppressed("BAD@example.com"), true)
  await assert.rejects(
    () =>
      service.send({
        accountId: "sales",
        to: "bad@example.com",
        subject: "Should not send",
        text: "nope",
      }),
    /suppressed/,
  )
})

test("inbound reply threads onto the outbound message", () => {
  const id = service.recordInbound(
    account,
    {
      from: { value: [{ address: "bob@example.com", name: "Bob" }] },
      subject: "Re: Hello Bob",
      messageId: "<reply-1@example.com>",
      inReplyTo: firstSend.rfcMessageId,
      references: [firstSend.rfcMessageId],
      text: "Interesting. What does the onboarding flow look like?",
      headers: new Map(),
      date: new Date(),
    },
    { uid: 1 },
  )

  assert.ok(id)
  const thread = service.getThread(firstSend.threadId)
  assert.equal(thread.messages.length, 2)
  assert.equal(thread.messages[1].direction, "in")
  assert.equal(thread.messages[1].needs_triage, 1)
})

test("unsubscribe intent during sync suppresses the sender", () => {
  service.recordInbound(
    account,
    {
      from: { value: [{ address: "carol@example.com", name: "Carol" }] },
      subject: "Re: Newsletter",
      messageId: "<reply-2@example.com>",
      inReplyTo: null,
      references: [],
      text: "Please unsubscribe me from this list.",
      headers: new Map(),
      date: new Date(),
    },
    { uid: 2 },
  )
  assert.equal(service.isSuppressed("carol@example.com"), true)
})

test("reply to a person stops an active campaign", async () => {
  const campaign = service.createCampaign({
    name: "Test sequence",
    accountId: "sales",
    mode: "draft",
    steps: [{ delayDays: 0, subject: "Hi {{first_name}}", body: "Hello {{first_name}} at {{company}}." }],
  })
  service.enrolContacts({ campaignId: campaign.id, contacts: [{ email: "bob@example.com", name: "Bob" }] })
  assert.equal(service.getCampaign(campaign.id).stats.active, 1)

  service.recordInbound(
    account,
    {
      from: { value: [{ address: "bob@example.com", name: "Bob" }] },
      subject: "Re: Hello Bob",
      messageId: "<reply-3@example.com>",
      inReplyTo: firstSend.rfcMessageId,
      references: [firstSend.rfcMessageId],
      text: "Let's talk next week.",
      headers: new Map(),
      date: new Date(),
    },
    { uid: 3 },
  )

  assert.equal(service.getCampaign(campaign.id).stats.replied, 1)
  assert.equal(service.getCampaign(campaign.id).stats.active, undefined)
})

test("campaign tick renders variables and advances to the next step", async () => {
  const campaign = service.createCampaign({
    name: "Two step",
    accountId: "sales",
    mode: "draft",
    steps: [
      { delayDays: 0, subject: "Hi {{first_name}}", body: "Hello {{first_name}} from {{company}}." },
      { delayDays: 2, subject: "Re: Hi {{first_name}}", body: "Following up with {{first_name}}." },
    ],
  })
  service.enrolContacts({
    campaignId: campaign.id,
    contacts: [{ email: "alice@example.com", name: "Alice Smith", company: "Acme" }],
  })
  service.setCampaignStatus(campaign.id, "running")

  const tick = await service.tickCampaigns()
  assert.equal(tick.started, 1)

  const drafts = service.listDrafts("simulated", 10)
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].subject, "Hi Alice")
  assert.match(drafts[0].body_text, /Hello Alice from Acme\./)

  const after = service.getCampaign(campaign.id)
  assert.equal(after.stats.active, 1)
  assert.equal(service.store.get("SELECT step_position FROM enrolments WHERE campaign_id = ?", campaign.id).step_position, 1)
})

test("classify clears the triage queue and updates contact status", () => {
  const pending = service.unclassified(10)
  assert.ok(pending.length >= 1)
  const target = pending.find((message) => message.from_addr === "bob@example.com")
  assert.ok(target)

  const result = service.classifyMessage({
    id: target.id,
    intent: "interested",
    urgency: "high",
    nextAction: "draft_reply",
    summary: "Wants to talk next week",
  })

  assert.equal(result.intent, "interested")
  assert.equal(service.getContact("bob@example.com").status, "interested")
  assert.equal(service.unclassified(10).some((message) => message.id === target.id), false)
})

test("stats and health report coherent values", () => {
  const stats = service.stats()
  assert.equal(stats.accounts.length, 1)
  assert.ok(stats.totals.messages24h >= 1)
  assert.equal(stats.totals.sent24h, 0)
  assert.ok(stats.totals.simulated24h >= 1)
  assert.ok(stats.totals.suppressed >= 2)

  const health = service.health()
  assert.equal(health.ok, true)
  assert.equal(health.accounts, 1)
  assert.equal(health.dryRun, true)
})
