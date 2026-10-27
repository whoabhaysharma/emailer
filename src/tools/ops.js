import { bool, call, num, str, tool } from "./schema.js"

export function createOpsTools(client) {
  return [
    tool(
      "sync",
      "Force an IMAP sync now instead of waiting for the next poll. Returns per-account fetched/inserted counts and errors.",
      {
        type: "object",
        properties: { accountId: str("Optional single account id") },
        additionalProperties: false,
      },
      { execute: async (input, context) => client.post("/sync", input, call(context).signal) },
    ),
    tool(
      "reclassify",
      "Re-run deterministic triage over stored inbound mail nobody has classified yet. Use after a noisy first sync or a rules change. Run with dryRun:true first.",
      {
        type: "object",
        properties: {
          dryRun: bool("Only report what would change"),
          limit: num("Max messages to scan"),
        },
        additionalProperties: false,
      },
      {
        permission: "email.classify",
        execute: async (input, context) => client.post("/reclassify", input, call(context).signal),
      },
    ),
    tool(
      "classify",      "Persist the classification of a reply. This updates contact status, stops sequences, and suppresses opt-outs. Use one of the documented intents and keep the summary to one line.",
      {
        type: "object",
        properties: {
          id: str("Message id"),
          intent: str(
            "interested | not_now | objection | unsubscribe | ooo | bounce | newsletter | referral | wrong_person | question | other",
          ),
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
        execute: async (input, context) => client.post("/classify", input, call(context).signal),
      },
    ),
  ]
}
