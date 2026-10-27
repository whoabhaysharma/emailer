import { simpleParser } from "mailparser"
import { getAccount, loadAccounts, resolvePassword } from "../config.js"
import { fetchNewMessages, findMailbox } from "../mail/imap.js"
import { nowIso } from "./shared.js"

export function createSync({ store, config, messages }) {
  async function syncFolder(account, password, { key, folder, direction, options }) {
    const cfg = config()
    const existing = store.get("SELECT * FROM folders WHERE account_id = ? AND path = ?", account.id, key)
    const startUid = existing?.uid_next ? Number(existing.uid_next) : 0
    const expectedUidValidity = existing?.uid_validity || null
    const triageDays = Number(cfg.triageWindowDays ?? 7)

    let inserted = 0
    const errors = []

    const result = await fetchNewMessages(account, password, {
      folder,
      startUid,
      initialLimit: options.initialLimit || cfg.initialSyncLimit || 200,
      expectedUidValidity,
      onMessage: async (message) => {
        try {
          const parsed = await simpleParser(message.source)
          const historical =
            Boolean(message.internalDate) && Date.now() - new Date(message.internalDate).getTime() > triageDays * 86400_000
          const id =
            direction === "in"
              ? messages.recordInbound(account, parsed, { uid: message.uid, folder: key, historical })
              : messages.recordSentSync(account, parsed, { uid: message.uid, folder: key })
          if (id) inserted += 1
        } catch (error) {
          errors.push(String(error.message || error))
        }
      },
    })

    store.run(
      `INSERT INTO folders (account_id, path, uid_validity, uid_next, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, path) DO UPDATE SET
         uid_validity = excluded.uid_validity,
         uid_next = excluded.uid_next,
         updated_at = excluded.updated_at`,
      account.id,
      key,
      result.uidValidity,
      result.lastUid + 1,
      nowIso(),
    )

    return { folder: key, path: folder, fetched: result.fetched, inserted, errors: errors.slice(0, 5) }
  }

  async function sentMailbox(account, password) {
    const cacheKey = `sentMailbox:${account.id}`
    const cached = store.getKv(cacheKey)
    if (cached?.path && Date.now() - Number(cached.at) < 7 * 86400_000) return cached.path
    const path = await findMailbox(account, password, "\\Sent", "[Gmail]/Sent Mail")
    store.setKv(cacheKey, { path, at: Date.now() })
    return path
  }

  async function syncAccount(accountOrId, options = {}) {
    const account = typeof accountOrId === "string" ? getAccount(accountOrId) : accountOrId
    if (account.enabled === false) return { account: account.id, skipped: "disabled" }

    const cfg = config()
    const password = resolvePassword(account)
    const inbox = await syncFolder(account, password, { key: "INBOX", folder: "INBOX", direction: "in", options })

    let sent = null
    if (cfg.syncSentFolder !== false) {
      try {
        const path = await sentMailbox(account, password)
        sent = await syncFolder(account, password, { key: "SENT", folder: path, direction: "out", options })
      } catch (error) {
        sent = { error: String(error.message || error) }
      }
    }

    const fetched = inbox.fetched + (sent?.fetched || 0)
    const inserted = inbox.inserted + (sent?.inserted || 0)
    store.event("sync.completed", {
      accountId: account.id,
      data: {
        fetched,
        inserted,
        inbox: { fetched: inbox.fetched, inserted: inbox.inserted },
        sent: sent ? { fetched: sent.fetched, inserted: sent.inserted } : null,
      },
    })

    return { account: account.id, fetched, inserted, inbox, sent }
  }

  async function syncAll(options = {}) {
    const results = []
    for (const account of loadAccounts()) {
      if (account.enabled === false) {
        results.push({ account: account.id, skipped: "disabled" })
        continue
      }
      try {
        results.push(await syncAccount(account, options))
      } catch (error) {
        store.event("sync.failed", { accountId: account.id, data: { error: String(error.message || error) } })
        results.push({ account: account.id, error: String(error.message || error) })
      }
    }
    return results
  }

  return { syncAccount, syncAll }
}
