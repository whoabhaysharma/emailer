import { bool, call, num, str, tool } from "./schema.js"

const empty = { type: "object", properties: {}, additionalProperties: false }

export function createReadTools(client) {
  return [
    tool(
      "accounts",
      "List configured sending accounts with their 24h send counts, effective limits, and warmup state. Call this first when you need to know which identity to send from.",
      empty,
      { execute: async (_input, context) => client.get("/accounts", undefined, call(context).signal) },
    ),
    tool(
      "health",
      "Check whether the email daemon is running, plus pending drafts, unclassified replies, last sync time, and the last sync error.",
      empty,
      { execute: async (_input, context) => client.get("/health", undefined, call(context).signal) },
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
      { execute: async (input, context) => client.get("/search", input, call(context).signal) },
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
          client.get(`/threads/${encodeURIComponent(input.threadId)}`, undefined, call(context).signal),
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
          client.get(`/contacts/${encodeURIComponent(input.email)}`, undefined, call(context).signal),
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
      { execute: async (input, context) => client.get("/contacts", input, call(context).signal) },
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
      { execute: async (input, context) => client.get("/drafts", input, call(context).signal) },
    ),
    tool("campaigns", "List campaigns with their steps, enrolment counts, and per-step performance.", empty, {
      execute: async (_input, context) => client.get("/campaigns", undefined, call(context).signal),
    }),
    tool(
      "suppressions",
      "List the do-not-contact list. Check this before adding contacts to a campaign.",
      empty,
      { execute: async (_input, context) => client.get("/suppressions", undefined, call(context).signal) },
    ),
    tool(
      "stats",
      "Overall funnel metrics: sends, replies, unique repliers, drafts pending, suppression count, bounce rate, campaign status, and reply intent breakdown.",
      empty,
      { execute: async (_input, context) => client.get("/stats", undefined, call(context).signal) },
    ),
    tool(
      "unclassified",
      "List inbound replies that no rule has classified yet. Read each one, then call classify with the result.",
      {
        type: "object",
        properties: { limit: num("Max results (default 20)") },
        additionalProperties: false,
      },
      { execute: async (input, context) => client.get("/unclassified", input, call(context).signal) },
    ),
  ]
}
