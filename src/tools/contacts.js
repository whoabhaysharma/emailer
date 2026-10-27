import { call, str, tool } from "./schema.js"

export function createContactTools(client) {
  return [
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
        execute: async (input, context) => client.post("/contacts/status", input, call(context).signal),
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
        execute: async (input, context) => client.post("/suppress", input, call(context).signal),
      },
    ),
  ]
}
