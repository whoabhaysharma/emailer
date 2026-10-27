const str = (description) => ({ type: "string", description })
const num = (description) => ({ type: "number", description })
const bool = (description) => ({ type: "boolean", description })

function tool(name, description, input, options = {}) {
  return { name, description, input, permission: options.permission || null, execute: options.execute }
}

export function createTools(client) {
  const call = (input, context) => ({ signal: context?.signal })

  return [
    tool(
      "accounts",
      "List configured sending accounts with their 24h send counts and daily limits. Call this first when you need to know which identity to send from.",
      { type: "object", properties: {}, additionalProperties: false },
      { execute: async (_input, context) => client.get("/accounts", undefined, call(_input, context).signal) },
    ),
    tool(
      "health",
      "Check whether the email daemon is running, plus pending drafts, unclassified replies, and last sync time.",
      { type: "object", properties: {}, additionalProperties: false },
      { execute: async (_input, context) => client.get("/health", undefined, call(_input, context).signal) },
    ),
    tool(
      "search",
      "Search stored messages. Use this before writing to anyone so you do not repeat a pitch or miss an earlier reply.",
      {
        type: "object",
        properties: {
          accountId: str("Restrict to one account id"),
          query: str("Free text across subject, body, sender, recipient"),
          from: str("Sender address filter"),
          to: str("Recipient address filter"),
          subject: str("Subject substring filter"),
          since: str("ISO date; only messages at or after this time"),
          direction: str("in = received, out = sent"),
          needsTriage: bool("Only messages awaiting classification"),
          limit: num("Max results (1-200, default 25)"),
        },
        additionalProperties: false,
      },
      { execute: async (input, context) => client.get("/search", input, call(input, context).signal) },
    ),
    tool(
      "thread",
      "Fetch a full conversation: all messages and any Gmail drafts in the thread, oldest first. Use the threadId from search results.",
      {
        type: "object",
        properties: { threadId: str("Thread id from search results") },
        required: ["threadId"],
        additionalProperties: false,
      },
      {
        execute: async (input, context) =>
          client.get(`/threads/${encodeURIComponent(input.threadId)}`, undefined, call(input, context).signal),
      },
    ),
    tool(
      "contact",
      "Fetch one contact record and their recent messages. Use it to check history, status, and notes before contacting them.",
      {
        type: "object",
        properties: { email: str("Contact email address") },
        required: ["email"],
        additionalProperties: false,
      },
      {
        execute: async (input, context) =>
          client.get(`/contacts/${encodeURIComponent(input.email)}`, undefined, call(input, context).signal),
      },
    ),
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
        execute: async (input, context) => client.post("/drafts", input, call(input, context).signal),
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
        execute: async (input, context) => client.post("/reply", input, call(input, context).signal),
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
          return client.post("/send", input, call(input, context).signal)
        },
      },
    ),
    tool(
      "drafts",
      "List drafts the agent created, newest first. Use status 'pending' to see what is waiting in Gmail for human review.",
      {
        type: "object",
        properties: {
          status: str("pending | simulated | sent | all"),
          limit: num("Max results"),
        },
        additionalProperties: false,
      },
      { execute: async (input, context) => client.get("/drafts", input, call(input, context).signal) },
    ),
    tool(
      "campaigns",
      "List campaigns with their steps and enrolment counts.",
      { type: "object", properties: {}, additionalProperties: false },
      { execute: async (_input, context) => client.get("/campaigns", undefined, call(_input, context).signal) },
    ),
    tool(
      "campaign_create",
      "Create a multi-step sequence. mode 'draft' writes each step into Gmail Drafts for human review; mode 'send' sends automatically inside business hours and within the daily cap. Creating a campaign does not start it.",
      {
        type: "object",
        properties: {
          name: str("Campaign name"),
          accountId: str("Sending account id"),
          mode: str("draft (recommended) or send"),
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                delayDays: num("Days to wait after the previous step (0 for the first step)"),
                subject: str("Subject template; supports {{first_name}}, {{company}}, {{email}}"),
                body: str("Body template; supports the same variables"),
                html: str("Optional HTML template"),
              },
              required: ["subject", "body"],
              additionalProperties: false,
            },
          },
        },
        required: ["name", "steps"],
        additionalProperties: false,
      },
      {
        permission: "email.campaign.write",
        execute: async (input, context) => client.post("/campaigns", input, call(input, context).signal),
      },
    ),
    tool(
      "campaign_enrol",
      "Add contacts to a campaign. Suppressed or invalid addresses are skipped. Enrolment never sends immediately; use campaign_status to start it.",
      {
        type: "object",
        properties: {
          campaignId: str("Campaign id"),
          contacts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                email: str("Email address"),
                name: str("Full name"),
                company: str("Company"),
                title: str("Job title"),
              },
              required: ["email"],
              additionalProperties: false,
            },
          },
        },
        required: ["campaignId", "contacts"],
        additionalProperties: false,
      },
      {
        permission: "email.campaign.write",
        execute: async (input, context) =>
          client.post(`/campaigns/${encodeURIComponent(input.campaignId)}/enrol`, { contacts: input.contacts }, call(input, context).signal),
      },
    ),
    tool(
      "campaign_status",
      "Start, pause, resume, or finish a campaign. Starting a campaign is a real-world action: confirm with the user first and show the volume estimate.",
      {
        type: "object",
        properties: {
          campaignId: str("Campaign id"),
          status: str("running | paused | done | draft"),
        },
        required: ["campaignId", "status"],
        additionalProperties: false,
      },
      {
        permission: "email.campaign.write",
        execute: async (input, context) =>
          client.post(`/campaigns/${encodeURIComponent(input.campaignId)}/status`, { status: input.status }, call(input, context).signal),
      },
    ),
    tool(
      "campaign_preview",
      "Send a preview of every campaign step to one address (defaults to the sending account itself). Use this before starting a campaign so the user can see exactly what recipients will get.",
      {
        type: "object",
        properties: {
          campaignId: str("Campaign id"),
          to: str("Where to send the preview (defaults to the account's own address)"),
          contactEmail: str("Render variables from this contact instead of the most recent one"),
          dryRun: bool("Do not actually send the preview"),
        },
        required: ["campaignId"],
        additionalProperties: false,
      },
      {
        permission: "email.send",
        execute: async (input, context) =>
          client.post(`/campaigns/${encodeURIComponent(input.campaignId)}/preview`, input, call(input, context).signal),
      },
    ),
    tool(
      "pause_all",
      "Emergency stop: pause every running campaign. Use when the user says stop, when a list is bad, or when the account is at risk. Replies already drafted are unaffected.",
      { type: "object", properties: {}, additionalProperties: false },
      {
        permission: "email.campaign.write",
        execute: async (_input, context) => client.post("/campaigns/pause-all", {}, call(_input, context).signal),
      },
    ),
    tool(
      "resume_all",
      "Resume every paused campaign. Confirm with the user first.",
      { type: "object", properties: {}, additionalProperties: false },
      {
        permission: "email.campaign.write",
        execute: async (_input, context) => client.post("/campaigns/resume-all", {}, call(_input, context).signal),
      },
    ),
    tool(
      "contacts",
      "List or search contacts with their status, consent, and last contact date. Use this before adding people to a campaign.",
      {
        type: "object",
        properties: {
          query: str("Match email, name, or company"),
          status: str("active | interested | engaged | not_now | unsubscribed | bounced | wrong_person"),
          limit: num("Max results (default 100)"),
        },
        additionalProperties: false,
      },
      { execute: async (input, context) => client.get("/contacts", input, call(input, context).signal) },
    ),
    tool(
      "contact_status",
      "Set a contact's status (for example do_not_contact) and optionally a not-before date. Unsubscribed, bounced, and complained statuses also add the address to the suppression list.",
      {
        type: "object",
        properties: {
          email: str("Contact email"),
          status: str("active | do_not_contact | not_now | unsubscribed | bounced"),
          notBefore: str("ISO date; for not_now, do not contact before this date"),
        },
        required: ["email", "status"],
        additionalProperties: false,
      },
      {
        permission: "email.suppress",
        execute: async (input, context) => client.post("/contacts/status", input, call(input, context).signal),
      },
    ),
    tool(
      "suppress",
      "Permanently add addresses to the do-not-contact list. Also stops any active campaign for them. Use immediately for opt-outs, complaints, bounces, or when the user asks.",
      {
        type: "object",
        properties: {
          emails: str("Email address(es), comma separated"),
          reason: str("unsubscribe | bounce | complaint | manual"),
        },
        required: ["emails"],
        additionalProperties: false,
      },
      {
        permission: "email.suppress",
        execute: async (input, context) => client.post("/suppress", input, call(input, context).signal),
      },
    ),
    tool(
      "suppressions",
      "List the do-not-contact list. Check this before adding contacts to a campaign.",
      { type: "object", properties: {}, additionalProperties: false },
      { execute: async (_input, context) => client.get("/suppressions", undefined, call(_input, context).signal) },
    ),
    tool(
      "sync",
      "Force an IMAP sync now instead of waiting for the next poll. Returns per-account fetched/inserted counts and errors.",
      {
        type: "object",
        properties: { accountId: str("Optional single account id") },
        additionalProperties: false,
      },
      { execute: async (input, context) => client.post("/sync", input, call(input, context).signal) },
    ),
    tool(
      "stats",
      "Overall funnel metrics: sends, replies, drafts pending, suppression count, campaign status, and reply intent breakdown.",
      { type: "object", properties: {}, additionalProperties: false },
      { execute: async (_input, context) => client.get("/stats", undefined, call(_input, context).signal) },
    ),
    tool(
      "unclassified",
      "List inbound replies that no rule has classified yet. Read each one, then call classify with the result.",
      {
        type: "object",
        properties: { limit: num("Max results (default 20)") },
        additionalProperties: false,
      },
      { execute: async (input, context) => client.get("/unclassified", input, call(input, context).signal) },
    ),
    tool(
      "classify",
      "Persist the classification of a reply. This updates contact status, stops sequences, and suppresses opt-outs. Use one of the documented intents and keep the summary to one line.",
      {
        type: "object",
        properties: {
          id: str("Message id"),
          intent: str("interested | not_now | objection | unsubscribe | ooo | bounce | newsletter | referral | wrong_person | question | other"),
          objection: str("price | timing | trust | need | authority | none"),
          urgency: str("high | normal | low"),
          nextAction: str("draft_reply | notify_human | suppress | stop_sequence | none"),
          summary: str("One-line summary of the reply"),
          notBefore: str("For not_now: ISO date when it is acceptable to contact again (default +90 days)"),
          notes: str("Optional note to append to the contact timeline"),
        },
        required: ["id", "intent"],
        additionalProperties: false,
      },
      {
        permission: "email.classify",
        execute: async (input, context) => client.post("/classify", input, call(input, context).signal),
      },
    ),
  ]
}
