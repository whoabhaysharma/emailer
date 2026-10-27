import { bool, call, str, tool } from "./schema.js"

export function createComposeTools(client) {
  return [
    tool(
      "draft",
      "Create a Gmail draft (default) instead of sending. Drafts land in the account's Drafts folder, threaded when threadId is provided, so a human can review and press send. Prefer this over send.",
      {
        type: "object",
        properties: {
          accountId: str("Sending account id; defaults to the first configured account"),
          to: str("Recipient email(s), comma separated"),
          cc: str("Optional cc addresses, comma separated"),
          subject: str("Subject line"),
          text: str("Plain-text body"),
          html: str("Optional HTML body"),
          threadId: str("Existing thread id to reply into"),
          inReplyTo: str("RFC Message-ID being replied to (optional; inferred from threadId)"),
          bulk: bool("Add List-Unsubscribe headers (true for campaigns, false for personal mail)"),
          dryRun: bool("Skip IMAP append and only record the draft"),
        },
        required: ["to", "subject", "text"],
        additionalProperties: false,
      },
      {
        permission: "email.draft",
        execute: async (input, context) => client.post("/drafts", input, call(context).signal),
      },
    ),
    tool(
      "reply",
      "Draft a threaded reply to an inbound message. This is the default way to answer people: it resolves the account, recipient, subject, and threading headers automatically. Set send:true only when the user explicitly approved sending.",
      {
        type: "object",
        properties: {
          messageId: str("Inbound message id from search or unclassified"),
          text: str("Plain-text reply body"),
          html: str("Optional HTML body"),
          send: bool("Actually send. Default false = create a Gmail draft"),
          dryRun: bool("Simulate without touching IMAP/SMTP"),
        },
        required: ["messageId", "text"],
        additionalProperties: false,
      },
      {
        permission: "email.reply",
        execute: async (input, context) => client.post("/reply", input, call(context).signal),
      },
    ),
    tool(
      "send",
      "Send one email immediately. Requires confirm:true and is always permission-gated. Never call this for bulk outreach; use a campaign instead. Respects suppression list, daily limits, and duplicate protection.",
      {
        type: "object",
        properties: {
          accountId: str("Sending account id"),
          to: str("Recipient email(s), comma separated"),
          cc: str("Optional cc addresses, comma separated"),
          bcc: str("Optional bcc addresses, comma separated"),
          subject: str("Subject line"),
          text: str("Plain-text body"),
          html: str("Optional HTML body"),
          threadId: str("Existing thread id to reply into"),
          bulk: bool("Add List-Unsubscribe headers (campaign/bulk mail only)"),
          confirm: bool("Must be true. Set only after the user approved this exact recipient, account, and copy"),
          dryRun: bool("Simulate the send without contacting SMTP"),
          noFooter: bool("Skip signature/address/unsubscribe footer"),
        },
        required: ["to", "subject", "text", "confirm"],
        additionalProperties: false,
      },
      {
        permission: "email.send",
        execute: async (input, context) => {
          if (input.confirm !== true) {
            return { error: "Refused: confirm must be true. Show the recipient, account, and copy to the user first." }
          }
          return client.post("/send", input, call(context).signal)
        },
      },
    ),
  ]
}
