import { loadAccounts, publicAccount } from "../config.js"
import { countSent, effectiveDailyLimit, hoursAgo } from "./shared.js"
import { VERSION } from "../version.js"

export function createMetrics({ store, config }) {
  function dailySentCount(accountId = null) {
    return countSent(store, accountId)
  }

  function stats() {
    const since = hoursAgo(24)
    const cfg = config()

    const accounts = loadAccounts().map((account) => {
      const replies = Number(
        store.get(
          "SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND direction = 'in' AND created_at > ?",
          account.id,
          since,
        )?.count || 0,
      )
      const bounces = Number(
        store.get(
          "SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND direction = 'in' AND triage_intent = 'bounce' AND created_at > ?",
          account.id,
          since,
        )?.count || 0,
      )
      const lastSync = store.get(
        "SELECT created_at FROM events WHERE type = 'sync.completed' AND account_id = ? ORDER BY created_at DESC LIMIT 1",
        account.id,
      )
      return {
        id: account.id,
        email: account.email,
        enabled: account.enabled !== false,
        sent24h: dailySentCount(account.id),
        dailyLimit: Number(account.dailyLimit || cfg.defaultDailyLimit || 40),
        effectiveLimit: effectiveDailyLimit(account, cfg),
        replies24h: replies,
        bounces24h: bounces,
        lastSyncAt: lastSync?.created_at || null,
      }
    })

    const one = (sql, ...params) => Number(store.get(sql, ...params)?.count || 0)
    const intents = store.all(
      "SELECT triage_intent AS intent, COUNT(*) AS count FROM messages WHERE triage_intent IS NOT NULL GROUP BY triage_intent ORDER BY count DESC",
    )
    const totalSent = one("SELECT COUNT(*) AS count FROM messages WHERE direction = 'out' AND status = 'sent'")
    const totalBounces = one("SELECT COUNT(*) AS count FROM messages WHERE direction = 'in' AND triage_intent = 'bounce'")

    return {
      accounts,
      totals: {
        contacts: one("SELECT COUNT(*) AS count FROM contacts"),
        replies: one("SELECT COUNT(*) AS count FROM messages WHERE direction = 'in'"),
        uniqueRepliers: one("SELECT COUNT(DISTINCT from_addr) AS count FROM messages WHERE direction = 'in'"),
        replies24h: one("SELECT COUNT(*) AS count FROM messages WHERE direction = 'in' AND created_at > ?", since),
        sent: totalSent,
        sent24h: one("SELECT COUNT(*) AS count FROM messages WHERE direction = 'out' AND status = 'sent' AND created_at > ?", since),
        simulated24h: one(
          "SELECT COUNT(*) AS count FROM messages WHERE direction = 'out' AND status = 'simulated' AND created_at > ?",
          since,
        ),
        messages24h: one("SELECT COUNT(*) AS count FROM messages WHERE created_at > ?", since),
        draftsPending: one("SELECT COUNT(*) AS count FROM drafts WHERE status = 'pending'"),
        needsTriage: one("SELECT COUNT(*) AS count FROM messages WHERE needs_triage = 1"),
        suppressed: one("SELECT COUNT(*) AS count FROM suppressions"),
        notNow: one("SELECT COUNT(*) AS count FROM contacts WHERE status = 'not_now'"),
        campaignsRunning: one("SELECT COUNT(*) AS count FROM campaigns WHERE status = 'running'"),
        bounceRate: totalSent ? Number(((totalBounces / totalSent) * 100).toFixed(2)) : 0,
      },
      intents: intents.map((row) => ({ intent: row.intent, count: Number(row.count) })),
    }
  }

  function health() {
    const cfg = config()
    const lastSync = store.get("SELECT created_at FROM events WHERE type = 'sync.completed' ORDER BY created_at DESC LIMIT 1")
    const lastError = store.get("SELECT created_at, data FROM events WHERE type = 'sync.failed' ORDER BY created_at DESC LIMIT 1")

    let lastErrorDetail = null
    if (lastError) {
      try {
        lastErrorDetail = JSON.parse(lastError.data)
      } catch {
        lastErrorDetail = lastError.data
      }
    }

    return {
      ok: true,
      version: VERSION,
      dryRun: Boolean(cfg.dryRun),
      timezone: cfg.timezone,
      syncSentFolder: cfg.syncSentFolder !== false,
      accounts: loadAccounts().length,
      pendingDrafts: Number(store.get("SELECT COUNT(*) AS count FROM drafts WHERE status = 'pending'")?.count || 0),
      needsTriage: Number(store.get("SELECT COUNT(*) AS count FROM messages WHERE needs_triage = 1")?.count || 0),
      campaignsRunning: Number(store.get("SELECT COUNT(*) AS count FROM campaigns WHERE status = 'running'")?.count || 0),
      lastSyncAt: lastSync?.created_at || null,
      lastError: lastError ? { at: lastError.created_at, detail: lastErrorDetail } : null,
    }
  }

  function listAccounts() {
    const cfg = config()
    return loadAccounts().map((account) => {
      const limit = effectiveDailyLimit(account, cfg)
      return {
        ...publicAccount(account),
        sent24h: dailySentCount(account.id),
        effectiveLimit: limit,
        warmupActive: Boolean(account.warmup) && limit < Number(account.dailyLimit || cfg.defaultDailyLimit || 40),
      }
    })
  }

  return { stats, health, listAccounts, dailySentCount }
}
