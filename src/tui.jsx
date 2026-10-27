/**
 * OpenCode TUI plugin: `/email` dashboard plus a home-footer status line.
 *
 * The TUI never talks to Gmail. It reads the daemon's shared dashboard model
 * over the existing bearer-authenticated HTTP API, so the terminal view, the
 * `/status` agent command, and the TUI all render the same numbers.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup, Show, For } from "solid-js"

const HOME =
  process.env.EMAIL_AGENT_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "email-agent")
const BASE = (process.env.EMAIL_AGENT_URL || "http://127.0.0.1:8787").replace(/\/+$/, "")

function token() {
  try {
    return readFileSync(join(HOME, "token"), "utf8").trim()
  } catch {
    return ""
  }
}

async function fetchDashboard(signal) {
  const response = await fetch(`${BASE}/dashboard`, {
    headers: token() ? { authorization: `Bearer ${token()}` } : {},
    signal,
  })
  if (!response.ok) throw new Error(`daemon returned ${response.status}`)
  return response.json()
}

const [dashboardData, setDashboardData] = createSignal(null)
const [dashboardError, setDashboardError] = createSignal(null)

let inflight = false

async function refreshDashboard() {
  if (inflight) return
  inflight = true
  try {
    const data = await fetchDashboard(AbortSignal.timeout(4000))
    setDashboardData(data)
    setDashboardError(null)
  } catch (error) {
    setDashboardError(String(error?.message || error))
  } finally {
    inflight = false
  }
}

let subscribers = 0
let timer = null

/**
 * Shared polling: the route and the footer subscribe to the same signals, so
 * OpenCode makes one request per interval no matter how many guests mount.
 */
function useDashboard() {
  subscribers += 1
  if (subscribers === 1) {
    refreshDashboard()
    timer = setInterval(refreshDashboard, 15_000)
    if (typeof timer?.unref === "function") timer.unref()
  }

  onCleanup(() => {
    subscribers = Math.max(0, subscribers - 1)
    if (subscribers === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  })

  return { data: dashboardData, error: dashboardError, refresh: refreshDashboard }
}

const MAX = 100

function clean(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
}

function clip(value, max = MAX) {
  const text = clean(value)
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

function pad(value, width) {
  const text = clip(value, width)
  return text.length >= width ? text : text + " ".repeat(width - text.length)
}

/** Compact relative time: `2m`, `3h`, `2d`. */
function relative(value) {
  if (!value) return ""
  const stamp = new Date(value).getTime()
  if (!Number.isFinite(stamp)) return ""
  const minutes = Math.floor(Math.max(0, Date.now() - stamp) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`
}

function statusLabel(data, error) {
  if (error || !data) return "EMAIL offline"
  const counts = data.counts || {}
  const hot = Number(counts.hot) || 0
  const drafts = Number(counts.drafts) || 0
  const parts = []
  if (hot > 0) parts.push(`${hot} hot`)
  if (drafts > 0) parts.push(plural(drafts, "draft"))
  return parts.length ? `EMAIL ${parts.join(" · ")}` : "EMAIL clear"
}

function dashboardLines(data) {
  const lines = []
  const account = data.account
  const counts = data.counts || {}

  if (!account) {
    lines.push("No account configured — run: opencode-email-agent setup")
  } else {
    lines.push(clip([account.name, account.email].filter(Boolean).join(" · ")))
    const limit =
      account.limit > 0 ? `${account.sentToday}/${account.limit} sent today` : `${account.sentToday} sent today`
    const daemon = data.daemon?.running ? "daemon up" : "daemon down"
    lines.push(clip(`${account.dryRun ? "DRY RUN" : "LIVE"} · ${limit} · ${daemon}`))
  }

  lines.push("")
  lines.push("NEEDS YOU")

  const hot = data.hot || []
  const drafts = data.drafts || []
  if (!hot.length) lines.push("  No hot replies")
  for (let index = 0; index < hot.length; index += 1) {
    const item = hot[index]
    const label = index === 0 ? plural(hot.length, "hot reply", "hot replies") : ""
    const name = pad(item.name || item.from || "Unknown", 18)
    const when = pad(relative(item.at), 5)
    const quote = clip(item.snippet || item.subject || "", Math.max(10, MAX - 2 - 20 - name.length - when.length))
    lines.push(clip(`  ${pad(label, 18)}${name}${when}"${quote}"`))
  }

  const draftCount = Number(counts.drafts) || drafts.length
  if (draftCount > 0) lines.push(`  ${plural(draftCount, "draft")} waiting`)
  else lines.push("  No drafts waiting")

  const optOuts = Number(counts.optOuts24h) || 0
  const bounces = Number(counts.bounces24h) || 0
  lines.push(`  ${optOuts} opt-outs / ${bounces} bounces (24h)`)

  lines.push("")
  lines.push("CAMPAIGNS")
  const campaigns = data.campaigns || []
  if (!campaigns.length) {
    lines.push("  No campaigns yet")
  } else {
    for (const campaign of campaigns.slice(0, 4)) {
      const meta = []
      if (campaign.active) meta.push(`${campaign.active} active`)
      if (campaign.replied) meta.push(`${campaign.replied} replied`)
      if (campaign.done) meta.push(`${campaign.done} done`)
      meta.push(`${Number(campaign.sent) || 0} sent`)
      lines.push(clip(`  ${campaign.name}   ${campaign.status}   ${meta.join(" · ")}`))
    }
    if (campaigns.length > 4) lines.push(`  …and ${campaigns.length - 4} more`)
  }

  lines.push("")
  lines.push("NEXT")
  const actions = data.actions || []
  if (!actions.length) lines.push("  Nothing to do")
  else for (const action of actions.slice(0, 3)) lines.push(clip(`  → ${action}`))

  lines.push("")
  lines.push("  r refresh · esc home")

  return lines
}

function EmailStatus() {
  const context = usePlugin()
  const { data, error } = useDashboard()
  return <text fg={context.theme.text.base}>{statusLabel(data(), error())}</text>
}

function EmailDashboard() {
  const context = usePlugin()
  const { data, error, refresh } = useDashboard()

  context.keymap.layer(() => ({
    mode: "global",
    priority: 20,
    commands: [
      {
        id: "email.refresh",
        title: "Refresh email dashboard",
        bind: "r",
        run: () => refresh(),
      },
      {
        id: "email.home",
        title: "Close email dashboard",
        bind: "escape",
        run: () => context.ui.router.navigate({ type: "home" }),
      },
    ],
  }))

  const lines = () => {
    if (error()) return []
    const current = data()
    if (!current) return ["Loading email dashboard…"]
    return dashboardLines(current)
  }

  return (
    <box flexDirection="column">
      <Show
        when={!error()}
        fallback={<text fg={context.theme.text.base}>Email daemon offline — run: opencode-email-agent service install</text>}
      >
        <For each={lines()}>{(line) => <text fg={context.theme.text.base}>{line}</text>}</For>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "email-agent.tui",
  setup(context) {
    const disposeRoute = context.ui.router.register({
      name: "email",
      render: () => <EmailDashboard />,
    })
    const disposeSlot = context.ui.slot({
      append: "home.footer.status",
      render: () => <EmailStatus />,
    })
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "email.dashboard",
          title: "Email dashboard",
          group: "Email",
          palette: true,
          suggested: true,
          slash: { name: "email", aliases: ["mail"] },
          run: () => context.ui.router.navigate({ type: "plugin", name: "email" }),
        },
      ],
    }))
    return () => {
      disposeRoute?.()
      disposeSlot?.()
    }
  },
})
