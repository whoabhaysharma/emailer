import { ImapFlow } from "imapflow"

function clientFor(account, password, overrides = {}) {
  const imap = account.imap || {}
  return new ImapFlow({
    host: imap.host || "imap.gmail.com",
    port: Number(imap.port || 993),
    secure: imap.secure !== false,
    auth: { user: account.email, pass: password },
    logger: false,
    emitLogs: false,
    clientInfo: { name: "opencode-email-agent", version: "0.1.0" },
    ...overrides,
  })
}

async function withClient(account, password, fn, overrides) {
  const client = clientFor(account, password, overrides)
  client.on("error", () => {})
  await client.connect()
  try {
    return await fn(client)
  } finally {
    try {
      await client.logout()
    } catch {
      try {
        client.close()
      } catch {}
    }
  }
}

export async function verifyImap(account, password) {
  return withClient(account, password, async (client) => {
    const folders = await client.list()
    return folders.map((folder) => ({ path: folder.path, specialUse: folder.specialUse || null }))
  })
}

export async function listFolders(account, password) {
  return verifyImap(account, password)
}

/**
 * Stream new messages from a mailbox. Returns sync markers that the caller persists
 * so the next run starts at the right UID.
 */
export async function fetchNewMessages(account, password, { folder = "INBOX", startUid = 0, initialLimit = 300, expectedUidValidity = null, onMessage }) {
  return withClient(account, password, async (client) => {
    const lock = await client.getMailboxLock(folder)
    try {
      const mailbox = client.mailbox
      const uidValidity = String(mailbox.uidValidity)
      const uidNext = Number(mailbox.uidNext || 1)
      const exists = Number(mailbox.exists || 0)

      if (expectedUidValidity && String(expectedUidValidity) !== uidValidity) startUid = 0

      let start = startUid > 0 ? startUid : 1
      if (!startUid && exists > 0) start = Math.max(1, uidNext - initialLimit)
      if (exists === 0 || start >= uidNext) {
        return { uidValidity, uidNext, fetched: 0, lastUid: startUid > 0 ? startUid - 1 : 0 }
      }

      let fetched = 0
      let lastUid = startUid > 0 ? startUid - 1 : 0
      for await (const message of client.fetch(`${start}:*`, { uid: true, source: true, internalDate: true, flags: true }, { uid: true })) {
        if (!message.uid || message.uid < start) continue
        fetched += 1
        lastUid = Math.max(lastUid, Number(message.uid))
        await onMessage({
          uid: Number(message.uid),
          source: message.source,
          internalDate: message.internalDate,
          flags: message.flags ? [...message.flags] : [],
        })
      }
      return { uidValidity, uidNext, fetched, lastUid }
    } finally {
      lock.release()
    }
  })
}

export async function appendDraft(account, password, raw, { mailbox } = {}) {
  return withClient(account, password, async (client) => {
    let path = mailbox
    if (!path) {
      const folders = await client.list()
      path = folders.find((folder) => folder.specialUse === "\\Drafts")?.path || "[Gmail]/Drafts"
    }
    const result = await client.append(path, raw, ["\\Draft"], new Date())
    return {
      mailbox: path,
      uid: result?.uid ? Number(result.uid) : null,
      uidValidity: result?.uidValidity ? String(result.uidValidity) : null,
    }
  })
}

export async function findDraftsMailbox(account, password) {
  const folders = await listFolders(account, password)
  return folders.find((folder) => folder.specialUse === "\\Drafts")?.path || "[Gmail]/Drafts"
}

export async function findMailbox(account, password, specialUse, fallback) {
  const folders = await listFolders(account, password)
  return folders.find((folder) => folder.specialUse === specialUse)?.path || fallback
}
