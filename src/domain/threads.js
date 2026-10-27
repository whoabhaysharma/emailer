import { normalizeSubject } from "../mail/mime.js"
import { hoursAgo, nowIso } from "./shared.js"

export function createThreads({ store }) {
  function touchThread({ id, accountId, subject, contactEmail, gmailThreadId, at, unread = false }) {
    store.run(
      `INSERT INTO threads (id, account_id, subject, contact_email, gmail_thread_id, status, unread, last_message_at)
       VALUES (?, ?, ?, ?, ?, 'open', 0, ?)
       ON CONFLICT(id) DO UPDATE SET
         last_message_at = excluded.last_message_at,
         gmail_thread_id = COALESCE(excluded.gmail_thread_id, threads.gmail_thread_id),
         contact_email = COALESCE(threads.contact_email, excluded.contact_email)`,
      id,
      accountId,
      subject || null,
      contactEmail || null,
      gmailThreadId || null,
      at || nowIso(),
    )
    if (unread) store.run("UPDATE threads SET unread = 1 WHERE id = ?", id)
  }

  function resolveThreadId(accountId, { fromAddr, subject, inReplyTo, refs, gmailThreadId }, { contactFallback = true } = {}) {
    if (gmailThreadId) {
      const row = store.get("SELECT id FROM threads WHERE account_id = ? AND gmail_thread_id = ?", accountId, gmailThreadId)
      if (row) return row.id
    }

    const candidates = [inReplyTo, ...refs].filter(Boolean)
    if (candidates.length) {
      const placeholders = candidates.map(() => "?").join(", ")
      const row = store.get(
        `SELECT thread_id FROM messages WHERE rfc_message_id IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`,
        ...candidates,
      )
      if (row?.thread_id) return row.thread_id
    }

    const subjectKey = normalizeSubject(subject)
    if (subjectKey && fromAddr) {
      const rows = store.all(
        `SELECT thread_id, subject FROM messages
         WHERE account_id = ? AND to_addr LIKE ? AND created_at > ?
         ORDER BY created_at DESC LIMIT 25`,
        accountId,
        `%${fromAddr}%`,
        hoursAgo(24 * 90),
      )
      for (const row of rows) {
        if (normalizeSubject(row.subject) === subjectKey) return row.thread_id
      }
    }

    if (contactFallback && fromAddr) {
      const row = store.get(
        "SELECT id FROM threads WHERE account_id = ? AND contact_email = ? ORDER BY last_message_at DESC LIMIT 1",
        accountId,
        fromAddr,
      )
      if (row) return row.id
    }

    return null
  }

  function getThread(threadId) {
    const thread = store.get("SELECT * FROM threads WHERE id = ?", threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)
    const messages = store.all("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC", threadId)
    const drafts = store.all("SELECT * FROM drafts WHERE thread_id = ? ORDER BY created_at ASC", threadId)
    return { thread, messages, drafts }
  }

  return { touchThread, resolveThreadId, getThread }
}
