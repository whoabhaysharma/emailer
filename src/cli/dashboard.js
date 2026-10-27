/**
 * One-screen operator dashboard.
 *
 * `buildDashboardModel` is a read-only projection of the service: it never sends,
 * syncs, classifies, or mutates anything. `renderDashboard` turns that model into
 * plain text (no dependencies, no box drawing, no emoji) so it works in any
 * terminal and inside OpenCode.
 */

const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
const RESET = "\x1b[0m"

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

/** `just now`, `12m ago`, `3h ago`, `2d ago` — and nothing at all for bad input. */
export function relativeTime(value, now = Date.now()) {
  if (!value) return ""
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return ""

  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  return `${Math.floor(hours / 24)}d ago`
}

/** Relative time for scheduled work: `now`, `in 20m`, `in 3h`, `in 2d`. */
export function relativeWhen(value, now = Date.now()) {
  if (!value) return "none"
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return "none"

  const diff = timestamp - now
  if (diff <= 45_000) {
    const past = relativeTime(value, now)
    return past || "now"
  }

  const minutes = Math.ceil(diff / 60_000)
  if (minutes < 60) return `in ${minutes}m`

  const hours = Math.ceil(minutes / 60)
  if (hours < 24) return `in ${hours}h`

  return `in ${Math.ceil(hours / 24)}d`
}

/** Collapse whitespace, hard-clip with an ellipsis, and keep lines single-line. */
export function truncate(value, max) {
  const text = oneLine(value)
  if (max <= 0) return ""
  if (text.length <= max) return text
  if (max === 1) return "…"
  return `${text.slice(0, max - 1).trimEnd()}…`
}

function padRight(value, width) {
  return String(value).length >= width ? String(value) : String(value) + " ".repeat(width - String(value).length)
}

export function renderDashboard(model, { color = true, width = 76 } = {}) {
  const useColor = color !== false && !process.env.NO_COLOR && Boolean(process.stdout?.isTTY)
  const page = Math.min(160, Math.max(1, num(width) || 76))
  const lines = []

  const paint = (text, code) => (useColor && code ? `${code}${text}${RESET}` : text)
  const push = (text = "", code = null) => {
    lines.push(paint(truncateEnd(String(text), page), code))
  }

  if (!model?.account) {
    push("No account configured. Run: opencode-email-agent setup", YELLOW)
    return `${lines.join("\n")}\n`
  }

  const account = model.account
  push([account.name, account.email].filter(Boolean).join(" · "), BOLD)

  const limit = account.limit > 0 ? `${account.sentToday}/${account.limit} sent today` : `${account.sentToday} sent today`
  const sync = account.lastSyncAt ? `sync ${relativeTime(account.lastSyncAt)}` : "sync never"
  const daemon = model.daemon?.running ? "daemon up" : "daemon down"
  const mode = account.dryRun ? "DRY RUN" : "LIVE"
  const statusColor = !model.daemon?.running ? RED : account.dryRun ? YELLOW : GREEN
  push(`${mode} · ${limit} · ${sync} · ${daemon}`, statusColor)

  const hotCount = model.hot?.length || 0
  const draftList = model.drafts || []
  const counts = model.counts || {}

  push()
  push("NEEDS YOU", BOLD)

  if (!hotCount && !draftList.length) {
    push("  Nothing needs you right now.", GREEN)
  } else {
    if (hotCount) {
      const total = num(counts.hot)
      const label = hotCount === 1 ? "1 hot reply" : `${hotCount} hot replies`
      push(`  ${label}${total > hotCount ? ` (${total} total)` : ""}`, YELLOW)
      for (const item of model.hot) push(hotLine(item, page))
    }
    if (draftList.length) {
      push(`  ${draftList.length} draft${draftList.length === 1 ? "" : "s"} waiting`, YELLOW)
      for (const draft of draftList) push(draftLine(draft, page))
    }
  }

  const optOuts = num(counts.optOuts24h)
  const bounces = num(counts.bounces24h)
  push(
    `  ${optOuts} opt-out${optOuts === 1 ? "" : "s"} / ${bounces} bounce${bounces === 1 ? "" : "s"} (24h)`,
    optOuts || bounces ? RED : DIM,
  )

  push()
  push("CAMPAIGNS", BOLD)
  const campaigns = model.campaigns || []
  if (!campaigns.length) {
    push("  No campaigns yet. Start one with /campaign.", DIM)
  } else {
    for (const campaign of campaigns.slice(0, 4)) {
      const meta = []
      if (campaign.active) meta.push(`${campaign.active} active`)
      if (campaign.replied) meta.push(`${campaign.replied} replied`)
      if (campaign.done) meta.push(`${campaign.done} done`)
      meta.push(`${num(campaign.sent)} sent`)
      push(`  ${campaign.name}   ${campaign.status}   ${meta.join(" · ")}`, statusColorFor(campaign.status))
    }
    if (campaigns.length > 4) push(`  …and ${campaigns.length - 4} more`, DIM)

    const upcoming = campaigns.map((campaign) => campaign.nextStepAt).filter(Boolean).sort()
    push(`  next: ${upcoming.length ? relativeWhen(upcoming[0]) : "none"}`, DIM)
  }

  push()
  push("RECENT REPLIES", BOLD)
  const recent = model.recent || []
  if (!recent.length) {
    push("  No human replies yet.", DIM)
  } else {
    for (const entry of recent.slice(0, 3)) push(recentLine(entry, page))
  }

  push()
  push("NEXT", BOLD)
  const actions = model.actions || []
  if (!actions.length) push("  Nothing to do. Nice.", GREEN)
  else for (const action of actions.slice(0, 3)) push(`  → ${action}`, YELLOW)

  return `${lines.join("\n")}\n`
}

function statusColorFor(status) {
  if (status === "running") return GREEN
  if (status === "paused") return YELLOW
  return DIM
}

function hotLine(item, page) {
  const nameWidth = Math.min(20, Math.max(12, Math.floor(page * 0.28)))
  const timeWidth = 9
  const indent = "    "
  const name = padRight(truncate(item.name || item.from || "Unknown", nameWidth - 1), nameWidth)
  const time = padRight(relativeTime(item.at), timeWidth)
  const quoteSpace = page - indent.length - nameWidth - timeWidth
  const quote = quoteSpace > 8 ? `"${truncate(item.snippet || item.subject || "", quoteSpace - 2)}"` : ""
  return `${indent}${name}${time}${quote}`
}

function draftLine(draft, page) {
  const indent = "    "
  const toWidth = 28
  const timeWidth = 9
  const to = padRight(truncate(draft.to || "unknown recipient", toWidth - 1), toWidth)
  const time = padRight(relativeTime(draft.at), timeWidth)
  const subjectSpace = page - indent.length - toWidth - timeWidth
  const subject = subjectSpace > 4 ? truncate(draft.subject || "", subjectSpace) : ""
  return `${indent}${to}${time}${subject}`
}

function recentLine(entry, page) {
  const indent = "  "
  const nameWidth = 24
  const timeWidth = 9
  const name = padRight(truncate(entry.name || entry.from || "Unknown", nameWidth - 1), nameWidth)
  const time = padRight(relativeTime(entry.at), timeWidth)
  const subjectSpace = page - indent.length - nameWidth - timeWidth
  const subject = subjectSpace > 4 ? truncate(entry.subject || "", subjectSpace) : ""
  return `${indent}${name}${time}${subject}`
}

/** Clip a composed line without eating its indentation, then drop trailing spaces. */
function truncateEnd(value, max) {
  const text = value.replace(/\r?\n/g, " ")
  if (text.length <= max) return text.replace(/\s+$/, "")
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}
