import { bool, call, num, str, tool } from "./schema.js"

const empty = { type: "object", properties: {}, additionalProperties: false }

export function createCampaignTools(client) {
  return [
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
        execute: async (input, context) => client.post("/campaigns", input, call(context).signal),
      },
    ),
    tool(
      "campaign_enrol",
      "Add contacts to a campaign. Suppressed, blocked, unconsented, or already-active contacts are skipped. Enrolment never sends immediately; use campaign_status to start it.",
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
          client.post(
            `/campaigns/${encodeURIComponent(input.campaignId)}/enrol`,
            { contacts: input.contacts },
            call(context).signal,
          ),
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
          client.post(
            `/campaigns/${encodeURIComponent(input.campaignId)}/status`,
            { status: input.status },
            call(context).signal,
          ),
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
          client.post(`/campaigns/${encodeURIComponent(input.campaignId)}/preview`, input, call(context).signal),
      },
    ),
    tool(
      "pause_all",
      "Emergency stop: pause every running campaign. Use when the user says stop, when a list is bad, or when the account is at risk. Replies already drafted are unaffected.",
      empty,
      {
        permission: "email.campaign.write",
        execute: async (_input, context) => client.post("/campaigns/pause-all", {}, call(context).signal),
      },
    ),
    tool(
      "resume_all",
      "Resume every paused campaign. Confirm with the user first.",
      empty,
      {
        permission: "email.campaign.write",
        execute: async (_input, context) => client.post("/campaigns/resume-all", {}, call(context).signal),
      },
    ),
  ]
}
