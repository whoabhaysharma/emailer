/**
 * One-screen operator dashboard.
 *
 * `buildDashboardModel` (shared with the OpenCode TUI) lives in
 * `src/dashboard/model.js` and is a read-only projection of the service: it never
 * sends, syncs, classifies, or mutates anything. `renderDashboard` turns that
 * model into plain text (no dependencies, no box drawing, no emoji) so it works
 * in any terminal and inside OpenCode.
 */

import { buildDashboardModel } from "../dashboard/model.js"

export { buildDashboardModel }

const BOLD = "\x1b[1m"
const DIM = "\x1b[2m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
const RESET = "\x1b[0m"

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
