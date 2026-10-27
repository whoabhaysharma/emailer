import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const root = mkdtempSync(join(tmpdir(), "email-agent-features-"))
const home = join(root, "home")
const data = join(root, "data")
mkdirSync(home, { recursive: true })
mkdirSync(data, { recursive: true })
process.env.EMAIL_AGENT_HOME = home
process.env.EMAIL_AGENT_DATA = data

const baseConfig = {
  dryRun: true,
  timezone: "UTC",
  defaultDailyLimit: 10,
  businessHours: { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] },
  signature: "",
  footerAddress: "",
  unsubscribeUrl: "",
  triageWindowDays: 7,
}
writeFileSync(join(home, "config.json"), JSON.stringify(baseConfig))
writeFileSync(
  join(home, "accounts.json"),
  JSON.stringify({
    accounts: [{ id: "sales", email: "sales@example.com", displayName: "Sales", dailyLimit: 10, enabled: true }],
  }),
)
writeFileSync(join(home, "token"), "test\n")

const { openStore } = await import("../src/store.js")
const { createService, effectiveDailyLimit } = await import("../src/service.js")
const { saveAccounts } = await import("../src/config.js")
const { signUnsubscribe, verifyUnsubscribe } = await import("../src/unsubscribe.js")

const store = openStore()
const service = createService(store)

process.on("exit", () => {
  try {
    store.close()
  } catch {}
  rmSync(root, { recursive: true, force: true })
})

function inbound(fields) {
  return {
    from: { value: [{ address: fields.from, name: fields.name || "" }] },
    subject: fields.subject || "Re: Hello",
    messageId: fields.messageId,
    inReplyTo: fields.inReplyTo || null,
    references: fields.references || [],
    text: fields.text || "",
    headers: fields.headers || new Map(),
    date: new Date(),
  }
}

const account = { id: "sales", email: "sales@example.com", displayName: "Sales", dailyLimit: 10, enabled: true }

test("newsletter auto-replies do not stop a sequence", async () => {
  const campaign = service.createCampaign({
    name: "NL",
    accountId: "sales",
    mode: "draft",
    steps: [{ delayDays: 0, subject: "Hi", body: "Hello" }],
  })
  service.enrolContacts({ campaignId: campaign.id, contacts: [{ email: "dave@example.com", name: "Dave" }] })

  service.recordInbound(
    account,
    inbound({
      from: "dave@example.com",
      messageId: "<nl-1@example.com>",
      text: "Monthly digest from somewhere",
      headers: new Map([["list-id", "<digest.example.com>"]]),
    }),
    { uid: 10 },
  )

  const row = store.get(
    "SELECT state FROM enrolments WHERE campaign_id = ? AND contact_email = ?",
    campaign.id,
    "dave@example.com",
  )
  assert.equal(row.state, "active")
})

test("out-of-office replies postpone the next step instead of stopping it", async () => {
  const campaign = service.createCampaign({
    name: "OOO",
    accountId: "sales",
    mode: "draft",
    steps: [
      { delayDays: 0, subject: "One", body: "One" },
      { delayDays: 0, subject: "Two", body: "Two" },
    ],
  })
  service.enrolContacts({ campaignId: campaign.id, contacts: [{ email: "erin@example.com", name: "Erin" }] })
  service.setCampaignStatus(campaign.id, "running")
  await service.tickCampaigns()

  service.recordInbound(
    account,
    inbound({
      from: "erin@example.com",
      messageId: "<ooo-1@example.com>",
      subject: "Automatic reply: out of office",
      text: "I am away until Monday.",
      headers: new Map([["auto-submitted", "auto-replied"]]),
    }),
    { uid: 11 },
  )

  const row = store.get("SELECT state, next_run_at FROM enrolments WHERE campaign_id = ?", campaign.id)
  assert.equal(row.state, "active")
  assert.ok(new Date(row.next_run_at).getTime() > Date.now() + 24 * 3600_000)
})

test("classify not_now stores a date and blocks further sends", async () => {
  const messageId = service.recordInbound(
    account,
    inbound({ from: "frank@example.com", messageId: "<nn-1@example.com>", text: "Not now, maybe next quarter." }),
    { uid: 12 },
  )

  const result = service.classifyMessage({ id: messageId, intent: "not_now", summary: "Revisit next quarter" })
  assert.equal(result.intent, "not_now")
  assert.ok(result.notBefore)

  const contact = service.getContact("frank@example.com")
  assert.equal(contact.status, "not_now")

  await assert.rejects(
    () =>
      service.send({
        accountId: "sales",
        to: "frank@example.com",
        subject: "Checking in",
        text: "Hi Frank",
        dedupe: false,
      }),
    /asked not to be contacted before/,
  )
})

test("classify rejects unknown intents", () => {
  const messageId = service.recordInbound(
    account,
    inbound({ from: "grace@example.com", messageId: "<bad-1@example.com>", text: "Hello" }),
    { uid: 13 },
  )
  assert.throws(() => service.classifyMessage({ id: messageId, intent: "maybe" }), /Invalid intent/)
})

test("campaign preview sends every step to the account owner", async () => {
  const campaign = service.createCampaign({
    name: "Preview me",
    accountId: "sales",
    mode: "draft",
    steps: [
      { delayDays: 0, subject: "Hi {{first_name}}", body: "Hello {{first_name}} at {{company}}" },
      { delayDays: 2, subject: "Re: Hi {{first_name}}", body: "Second touch" },
    ],
  })
  const preview = await service.previewCampaign(campaign.id, {})
  assert.equal(preview.to, "sales@example.com")
  assert.equal(preview.results.length, 2)
  assert.match(preview.results[0].subject, /^\[PREVIEW\]/)

  const sent = store.get("SELECT * FROM messages WHERE campaign_id IS NULL AND direction = 'out' AND status = 'simulated' ORDER BY created_at DESC LIMIT 1")
  assert.equal(sent.account_id, "sales")
})

test("warmup ramps the effective daily limit", () => {
  const accountWarm = {
    id: "w",
    dailyLimit: 50,
    warmup: { start: 5, incrementPerDay: 5, max: 20 },
    warmupStartedAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
  }
  assert.equal(effectiveDailyLimit(accountWarm, baseConfig), 15)
  const fresh = { ...accountWarm, warmupStartedAt: new Date().toISOString() }
  assert.equal(effectiveDailyLimit(fresh, baseConfig), 5)
})

test("contacts import counts and cross-campaign duplicates are skipped", async () => {
  const imported = service.importContacts({
    contacts: [
      { email: "hana@example.com", name: "Hana" },
      { email: "not-an-email", name: "Broken" },
      { email: "ivan@example.com", name: "Ivan" },
    ],
    source: "test",
  })
  assert.equal(imported.added, 2)
  assert.equal(imported.skipped, 1)

  const first = service.createCampaign({
    name: "A",
    accountId: "sales",
    mode: "draft",
    steps: [{ delayDays: 0, subject: "A", body: "A" }],
  })
  const second = service.createCampaign({
    name: "B",
    accountId: "sales",
    mode: "draft",
    steps: [{ delayDays: 0, subject: "B", body: "B" }],
  })
  service.enrolContacts({ campaignId: first.id, contacts: [{ email: "hana@example.com" }] })
  const result = service.enrolContacts({ campaignId: second.id, contacts: [{ email: "hana@example.com" }] })
  assert.equal(result.added, 0)
  assert.equal(result.skippedActive, 1)
})

test("sent-folder sync dedupes by Message-ID", () => {
  const messageId = "<manual-1@example.com>"
  const parsed = {
    from: { value: [{ address: "sales@example.com" }] },
    to: { value: [{ address: "judy@example.com" }] },
    cc: { value: [] },
    subject: "Manual reply",
    messageId,
    inReplyTo: null,
    references: [],
    text: "Sent from Gmail",
    headers: new Map(),
    date: new Date(),
  }
  assert.ok(service.recordSentSync(account, parsed, { uid: 20 }))
  assert.equal(service.recordSentSync(account, parsed, { uid: 20 }), null)
})

test("unsubscribe tokens round-trip and reject tampering", () => {
  const token = signUnsubscribe("secret", "kate@example.com")
  assert.equal(verifyUnsubscribe("secret", token), "kate@example.com")
  assert.equal(verifyUnsubscribe("other", token), null)
})

test("account signature is used in the campaign footer", async () => {
  saveAccounts([{ ...account, signature: "— Abhay, Acme" }])
  const result = await service.send({
    accountId: "sales",
    to: "lena@example.com",
    subject: "Signature check",
    text: "Body only",
    bulk: true,
    dedupe: false,
  })
  const row = store.get("SELECT body_text FROM messages WHERE id = ?", result.id)
  assert.match(row.body_text, /Abhay, Acme/)
})

test("bulk drafts include signature and unsubscribe footer", async () => {
  saveAccounts([{ ...account, signature: "— Abhay, Acme", unsubscribeMailto: "unsub@example.com" }])
  const result = await service.createDraft({
    accountId: "sales",
    to: "mia@example.com",
    subject: "Draft footer",
    text: "Hello there",
    bulk: true,
  })
  const row = store.get("SELECT body_text FROM drafts WHERE id = ?", result.id)
  assert.match(row.body_text, /Abhay, Acme/)
  assert.match(row.body_text, /unsub@example\.com/)
})
