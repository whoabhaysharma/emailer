import assert from "node:assert/strict"
import { test } from "node:test"
import { buildDashboardModel, relativeTime, renderDashboard } from "../src/cli/dashboard.js"

const MINUTE = 60_000
const ago = (minutes) => new Date(Date.now() - minutes * MINUTE).toISOString()
const ahead = (minutes) => new Date(Date.now() + minutes * MINUTE).toISOString()

function stubService(overrides = {}) {
  const defaultAccount = {
    id: "team",
    email: "team@example.com",
    sent24h: 1,
    dailyLimit: 40,
    effectiveLimit: 40,
    bounces24h: 0,
    lastSyncAt: ago(2),
  }

  const state = {
    stats: {
      accounts: [overrides.account || defaultAccount],
      totals: { needsTriage: 1, draftsPending: 1, campaignsRunning: 1 },
    },
    health: { dryRun: false },
    config: { footerAddress: "" },
    campaigns: [
      {
        id: "camp-1",
        name: "Website development — Abhay",
        status: "running",
        steps: [{ position: 0, sent: 1 }],
        stats: { active: 1, replied: 1, done: 0, steps: [{ position: 0, sent: 1 }] },
      },
    ],
    drafts: [{ id: "draft-1", to_addr: "lead@example.com", subject: "Re: quick idea", created_at: ago(5) }],
    pending: [
      {
        id: "msg-1",
        from_addr: "abhay@example.com",
        subject: "Re: Abhay — a quick idea for the limo sites",
        snippet: "when can we do it",
        received_at: ago(2),
        created_at: ago(2),
        triage_intent: null,
      },
    ],
    recent: [
      {
        from_addr: "abhay@example.com",
        subject: "Re: Abhay — a quick idea for the limo sites",
        at: ago(2),
        triage_intent: "interested",
      },
    ],
    suppressions: 0,
    nextStepAt: ahead(120),
  }

  const service = {
    stats: () => state.stats,
    health: () => state.health,
    config: () => state.config,
    listCampaigns: () => state.campaigns,
    listDrafts: () => state.drafts,
    unclassified: () => state.pending,
    listAccounts: () => [{ id: "team", email: "team@example.com", displayName: "ClickBoost Media" }],
    store: {
      get(sql, ...params) {
        if (sql.includes("FROM suppressions")) return { count: state.suppressions }
        if (sql.includes("FROM enrolments")) return { at: state.nextStepAt }
        if (sql.includes("FROM contacts")) {
          const email = params[0]
          return email === "abhay@example.com" ? { name: "Abhay Sharma" } : null
        }
        return null
      },
      all(sql) {
        if (sql.includes("FROM messages")) return state.recent
        return []
      },
    },
  }

  Object.assign(service, overrides.service)
  Object.assign(state.stats, overrides.stats)
  if (overrides.stats?.accounts) state.stats.accounts = overrides.stats.accounts
  if (overrides.health) state.health = overrides.health
  if (overrides.config) state.config = overrides.config
  if (overrides.campaigns) state.campaigns = overrides.campaigns
  if (overrides.drafts) state.drafts = overrides.drafts
  if (overrides.pending) state.pending = overrides.pending
  if (overrides.recent) state.recent = overrides.recent
  if (overrides.suppressions !== undefined) state.suppressions = overrides.suppressions
  if (overrides.nextStepAt !== undefined) state.nextStepAt = overrides.nextStepAt

  return { service, state }
}

test("dashboard model collects hot replies, drafts, campaigns, and recent replies", () => {
  const { service } = stubService()
  const model = buildDashboardModel(service, { daemon: { running: true, pid: 1234 } })

  assert.equal(model.account.email, "team@example.com")
  assert.equal(model.account.name, "ClickBoost Media")
  assert.equal(model.account.dryRun, false)
  assert.equal(model.account.sentToday, 1)
  assert.equal(model.account.limit, 40)

  assert.deepEqual(model.daemon, { running: true, pid: 1234 })
  assert.equal(model.hot.length, 1)
  assert.equal(model.hot[0].from, "abhay@example.com")
  assert.equal(model.hot[0].name, "Abhay Sharma")
  assert.equal(model.hot[0].intent, null)

  assert.equal(model.drafts.length, 1)
  assert.equal(model.drafts[0].to, "lead@example.com")

  assert.equal(model.campaigns.length, 1)
  assert.equal(model.campaigns[0].sent, 1)
  assert.equal(model.campaigns[0].replied, 1)
  assert.ok(model.campaigns[0].nextStepAt)

  assert.equal(model.recent.length, 1)
  assert.equal(model.recent[0].from, "abhay@example.com")
  assert.equal(model.recent[0].intent, "interested")

  assert.deepEqual(model.counts, {
    hot: 1,
    drafts: 1,
    unclassified: 1,
    optOuts24h: 0,
    bounces24h: 0,
    campaignsRunning: 1,
  })

  assert.deepEqual(model.actions, [
    "Run /inbox — 1 reply needs triage",
    "Review 1 draft in Gmail",
    "1 campaign running — /report for performance",
  ])
})

test("dashboard renderer is plain text, sized to the terminal", () => {
  const { service } = stubService()
  const model = buildDashboardModel(service, { daemon: { running: true, pid: 1234 } })
  const output = renderDashboard(model, { color: false })

  assert.match(output, /NEEDS YOU/)
  assert.match(output, /Abhay Sharma/)
  assert.match(output, /CAMPAIGNS/)
  assert.match(output, /NEXT/)
  assert.ok(!output.includes("\x1b["), "no ANSI escapes when color is off")
  assert.ok(output.endsWith("\n"))
  assert.ok(!output.endsWith("\n\n"), "exactly one trailing newline")

  const narrow = renderDashboard(model, { color: false, width: 40 })
  for (const line of narrow.split("\n")) {
    assert.ok(line.length <= 40, `line too long (${line.length}): ${line}`)
  }
})

test("dashboard model includes opt-outs, bounces, and dry-run guidance", () => {
  const { service } = stubService({
    account: { id: "team", email: "team@example.com", sent24h: 4, effectiveLimit: 40, bounces24h: 2, lastSyncAt: ago(1) },
    stats: { totals: { needsTriage: 0, draftsPending: 0, campaignsRunning: 0 } },
    campaigns: [],
    drafts: [],
    pending: [],
    recent: [],
    suppressions: 3,
    health: { dryRun: true },
    config: { footerAddress: "" },
  })
  const model = buildDashboardModel(service, { daemon: { running: false } })

  assert.equal(model.counts.optOuts24h, 3)
  assert.equal(model.counts.bounces24h, 2)
  assert.deepEqual(model.actions, [
    "Set footerAddress before cold outreach",
    "Dry run is ON — config set dryRun=false when ready",
  ])

  const output = renderDashboard(model, { color: false })
  assert.match(output, /Nothing needs you right now\./)
  assert.match(output, /DRY RUN/)
  assert.match(output, /daemon down/)
  assert.match(output, /3 opt-outs \/ 2 bounces \(24h\)/)
  assert.match(output, /No campaigns yet/)
})

test("dashboard shows a setup hint when no account is configured", () => {
  const { service } = stubService({ stats: { accounts: [] } })
  const model = buildDashboardModel(service)

  assert.equal(model.account, null)
  const output = renderDashboard(model, { color: false })
  assert.match(output, /No account configured/)
  assert.match(output, /setup/)
})

test("dashboard model is plain JSON-serialisable data", () => {
  const { service } = stubService()
  const model = buildDashboardModel(service, { daemon: { running: true, pid: 99 } })

  assert.equal(Object.getPrototypeOf(model), Object.prototype)
  for (const hot of model.hot) assert.equal(Object.getPrototypeOf(hot), Object.prototype)
  for (const campaign of model.campaigns) assert.equal(Object.getPrototypeOf(campaign), Object.prototype)

  const json = JSON.parse(JSON.stringify(model))
  assert.deepEqual(json, model)
  assert.deepEqual(Object.keys(json).sort(), [
    "account",
    "actions",
    "campaigns",
    "counts",
    "daemon",
    "drafts",
    "hot",
    "recent",
  ])
})

test("relative time stays human", () => {
  const now = Date.parse("2026-10-27T12:00:00.000Z")
  assert.equal(relativeTime(new Date(now - 20_000).toISOString(), now), "just now")
  assert.equal(relativeTime(new Date(now - 12 * MINUTE).toISOString(), now), "12m ago")
  assert.equal(relativeTime(new Date(now - 3 * 3600_000).toISOString(), now), "3h ago")
  assert.equal(relativeTime(new Date(now - 2 * 86_400_000).toISOString(), now), "2d ago")
  assert.equal(relativeTime(null, now), "")
})
