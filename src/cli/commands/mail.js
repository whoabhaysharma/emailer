import { readFileSync } from "node:fs"
import { getAccount } from "../../config.js"
import { withService } from "../context.js"
import { fail, printJson, readStdin } from "../io.js"

export async function inboxCommand(flags) {
  await withService(async (instance) => {
    const pending = instance.unclassified(20)
    const drafts = instance.listDrafts("pending", 20)
    const stats = instance.stats()

    if (flags.json) return printJson({ pending, drafts, totals: stats.totals })

    console.log(
      `pending triage: ${pending.length}   drafts: ${drafts.length}   replies 24h: ${stats.totals.replies24h}   suppressed: ${stats.totals.suppressed}\n`,
    )

    if (pending.length) {
      console.log("unclassified replies")
      console.table(
        pending.map((message) => ({
          id: message.id.slice(0, 8),
          from: message.from_addr,
          subject: String(message.subject || "").slice(0, 56),
          received: String(message.received_at || "").slice(0, 16),
        })),
      )
    }

    if (drafts.length) {
      console.log("\ndrafts waiting in Gmail")
      console.table(
        drafts.map((draft) => ({
          id: draft.id.slice(0, 8),
          to: draft.to_addr,
          subject: String(draft.subject || "").slice(0, 56),
          created: String(draft.created_at || "").slice(0, 16),
        })),
      )
    }
  })
}

export async function statsCommand(flags) {
  await withService(async (instance) => {
    const stats = instance.stats()
    if (flags.json) return printJson(stats)
    console.log("accounts")
    console.table(stats.accounts)
    console.log("\ntotals")
    console.log(stats.totals)
    if (stats.intents.length) {
      console.log("\nreply intents")
      console.table(stats.intents)
    }
  })
}

export async function searchCommand(flags) {
  await withService(async (instance) => {
    const messages = instance.searchMessages({
      accountId: flags.account,
      query: flags.query,
      from: flags.from,
      subject: flags.subject,
      direction: flags.direction,
      since: flags.since,
      limit: flags.limit || 25,
    })

    if (flags.json) return printJson(messages)

    console.table(
      messages.map((message) => ({
        id: message.id.slice(0, 8),
        dir: message.direction,
        from: String(message.from_addr || "").slice(0, 28),
        subject: String(message.subject || "").slice(0, 56),
        at: String(message.created_at || "").slice(0, 16),
        intent: message.triage_intent || "",
      })),
    )
  })
}

export async function threadCommand(positional) {
  const id = positional[0]
  if (!id) fail("thread id is required")

  await withService(async (instance) => {
    const data = instance.getThread(id)
    console.log(`thread ${data.thread.id}\nsubject ${data.thread.subject}\n`)
    for (const message of data.messages) {
      console.log(`[${message.direction}] ${message.created_at}  ${message.from_addr} → ${message.to_addr}`)
      console.log(`  ${message.subject}`)
      console.log(`  ${String(message.body_text || "").slice(0, 400).replace(/\n/g, "\n  ")}\n`)
    }
    for (const draft of data.drafts) {
      console.log(`[draft ${draft.status}] ${draft.created_at}  ${draft.to_addr}`)
      console.log(`  ${String(draft.body_text || "").slice(0, 400).replace(/\n/g, "\n  ")}\n`)
    }
  })
}

function bodyFromFlags(flags) {
  const body = flags["text-file"] ? readFileSync(flags["text-file"], "utf8") : flags.text || readStdin()
  if (!body.trim()) fail("provide --text, --text-file, or pipe the body on stdin")
  return body
}

export async function sendCommand(flags) {
  const body = bodyFromFlags(flags)
  const account = getAccount(flags.account)
  const dryRun = flags["dry-run"] === true || !flags.confirm

  const result = await withService((instance) =>
    instance.send({
      accountId: account.id,
      to: flags.to,
      cc: flags.cc,
      bcc: flags.bcc,
      subject: flags.subject,
      text: body,
      html: flags.html,
      threadId: flags.thread,
      dryRun,
      bulk: flags.bulk === true,
      dedupe: flags["allow-duplicate"] ? false : true,
    }),
  )

  printJson(result)
  if (dryRun) console.log("\n(dry run: nothing was sent. add --confirm to send for real)")
}

export async function draftCommand(flags) {
  const body = bodyFromFlags(flags)
  const account = getAccount(flags.account)

  const result = await withService((instance) =>
    instance.createDraft({
      accountId: account.id,
      to: flags.to,
      cc: flags.cc,
      subject: flags.subject,
      text: body,
      html: flags.html,
      threadId: flags.thread,
      bulk: flags.bulk === true,
      dryRun: flags["dry-run"] === true,
    }),
  )

  printJson(result)
}

export async function syncCommand() {
  await withService(async (instance) => printJson(await instance.syncAll()))
}
