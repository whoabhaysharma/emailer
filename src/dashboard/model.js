/**
 * Shared dashboard projection.
 *
 * `buildDashboardModel` is a read-only projection of the service: it never
 * sends, syncs, classifies, or mutates anything. Both the terminal dashboard
 * (`src/cli/dashboard.js`) and the OpenCode TUI (`src/tui.jsx`, via
 * `GET /dashboard`) render the same model so the two views cannot drift.
 */

const HUMAN_REPLY = `direction = 'in' AND COALESCE(triage_intent, '') NOT IN ('newsletter','automated','archived','ooo','bounce')`
const RECEIVED_AT = "COALESCE(received_at, created_at)"

function attempt(fn, fallback) {
  try {
    return fn() ?? fallback
  } catch {
    return fallback
  }
}

function num(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function oneLine(value, max = 240) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
}

function iso(value) {
  return value ? String(value) : null
}

/** Contact names live in the contacts table; a missing name is fine. */
function contactName(service, email) {
  if (!email) return null
  const row = attempt(() => service.store.get("SELECT name FROM contacts WHERE email = ? LIMIT 1", email), null)
  return row?.name || null
}

export function buildDashboardModel(service, { daemon } = {}) {
  const stats = service.stats() || {}
  const health = service.health() || {}
  const config = attempt(() => service.config(), {}) || {}
  const campaigns = attempt(() => service.listCampaigns(), []) || []
  const drafts = attempt(() => service.listDrafts("pending", 20), []) || []
  const pending = attempt(() => service.unclassified(20), []) || []

  const accounts = Array.isArray(stats.accounts) ? stats.accounts : []
  const primary = accounts[0] || null
  const directory = attempt(() => service.listAccounts(), []) || []
  const profile = primary ? directory.find((entry) => entry.id === primary.id) || {} : {}

  const account = primary
    ? {
        email: primary.email || null,
        name: profile.displayName || profile.name || primary.displayName || primary.name || null,
        dryRun: Boolean(health.dryRun),
        sentToday: num(primary.sent24h),
        limit: num(primary.effectiveLimit ?? primary.dailyLimit),
        lastSyncAt: iso(primary.lastSyncAt || health.lastSyncAt),
      }
    : null

  // Newest first, but explicit "needs a human" rows (no intent) before anything else.
  const hot = pending
    .slice()
    .sort((a, b) => {
      const aManual = a.triage_intent == null ? 0 : 1
      const bManual = b.triage_intent == null ? 0 : 1
      if (aManual !== bManual) return aManual - bManual
      return new Date(b.received_at || b.created_at || 0) - new Date(a.received_at || a.created_at || 0)
    })
    .slice(0, 3)
    .map((row) => ({
      id: row.id,
      from: row.from_addr || null,
      name: contactName(service, row.from_addr),
      subject: oneLine(row.subject || "(no subject)", 160),
      at: iso(row.received_at || row.created_at),
      intent: row.triage_intent ?? null,
      snippet: oneLine(row.snippet, 160),
    }))

  const recentRows = attempt(
    () =>
      service.store.all(
        `SELECT from_addr, subject, ${RECEIVED_AT} AS at, triage_intent
         FROM messages
         WHERE ${HUMAN_REPLY}
         ORDER BY ${RECEIVED_AT} DESC
         LIMIT 3`,
      ),
    [],
  ) || []

  const recent = recentRows.map((row) => ({
    from: row.from_addr || null,
    name: contactName(service, row.from_addr),
    subject: oneLine(row.subject || "(no subject)", 160),
    at: iso(row.at),
    intent: row.triage_intent ?? null,
  }))

  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const optOuts24h = num(
    attempt(() => service.store.get("SELECT COUNT(*) AS count FROM suppressions WHERE created_at > ?", since), null)?.count,
  )
  const bounces24h = accounts.reduce((total, entry) => total + num(entry.bounces24h), 0)

  const campaignRows = campaigns.map((campaign) => {
    const statsRow = campaign.stats || {}
    const next = attempt(
      () =>
        service.store.get(
          `SELECT MIN(next_run_at) AS at FROM enrolments
           WHERE campaign_id = ? AND state = 'active' AND next_run_at IS NOT NULL`,
          campaign.id,
        ),
      null,
    )
    const stepRows = statsRow.steps?.length ? statsRow.steps : campaign.steps || []
    const sent = stepRows.reduce((total, step) => total + num(step.sent), 0)
    return {
      id: campaign.id,
      name: oneLine(campaign.name || "Untitled campaign", 80),
      status: campaign.status || "draft",
      active: num(statsRow.active),
      replied: num(statsRow.replied),
      done: num(statsRow.done),
      sent,
      nextStepAt: next?.at ? String(next.at) : null,
    }
  })

  const counts = {
    hot: num(stats.totals?.needsTriage ?? pending.length),
    drafts: num(stats.totals?.draftsPending ?? drafts.length),
    unclassified: num(stats.totals?.needsTriage ?? pending.length),
    optOuts24h,
    bounces24h,
    campaignsRunning: num(stats.totals?.campaignsRunning ?? campaigns.filter((c) => c.status === "running").length),
  }

  const actions = []
  if (counts.unclassified > 0) {
    actions.push(`Run /inbox — ${counts.unclassified} ${counts.unclassified === 1 ? "reply needs" : "replies need"} triage`)
  }
  if (counts.drafts > 0) {
    actions.push(`Review ${counts.drafts} draft${counts.drafts === 1 ? "" : "s"} in Gmail`)
  }
  if (counts.campaignsRunning > 0) {
    actions.push(
      `${counts.campaignsRunning} campaign${counts.campaignsRunning === 1 ? "" : "s"} running — /report for performance`,
    )
  }
  if (!config.footerAddress) actions.push("Set footerAddress before cold outreach")
  if (account?.dryRun) actions.push("Dry run is ON — config set dryRun=false when ready")
  if (!actions.length) actions.push("Start a campaign with /campaign")

  return {
    account,
    daemon: { running: Boolean(daemon?.running), pid: daemon?.pid ?? null },
    hot,
    drafts: drafts.slice(0, 3).map((draft) => ({
      id: draft.id,
      to: draft.to_addr || null,
      subject: oneLine(draft.subject || draft.thread_subject || "(no subject)", 160),
      at: iso(draft.created_at),
    })),
    campaigns: campaignRows,
    recent,
    counts,
    actions: actions.slice(0, 3),
  }
}
