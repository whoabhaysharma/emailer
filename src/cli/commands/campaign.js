import { readFileSync } from "node:fs"
import { withService } from "../context.js"
import { fail, parseContactsFile, printJson } from "../io.js"

export async function campaignCommand(action, flags, positional) {
  await withService(async (instance) => {
    if (action === "list" || !action) {
      const campaigns = instance.listCampaigns()
      if (flags.json) return printJson(campaigns)
      if (!campaigns.length) return console.log("no campaigns yet")

      console.table(
        campaigns.map((campaign) => ({
          id: campaign.id.slice(0, 8),
          name: campaign.name,
          mode: campaign.mode,
          status: campaign.status,
          steps: campaign.steps.length,
          active: campaign.stats.active || 0,
          replied: campaign.stats.replied || 0,
          done: campaign.stats.done || 0,
        })),
      )
      return
    }

    if (action === "create") {
      if (!flags.file) fail("--file campaign.json is required")
      return printJson(instance.createCampaign(JSON.parse(readFileSync(flags.file, "utf8"))))
    }

    if (action === "pause-all") return printJson(instance.pauseAll())
    if (action === "resume-all") return printJson(instance.resumeAll())
    if (action === "tick") return printJson(await instance.tickCampaigns())

    const id = positional[0] || flags.id
    if (!id) fail("campaign id is required")

    if (action === "show") return printJson(instance.getCampaign(id))

    if (action === "preview") {
      return printJson(
        await instance.previewCampaign(id, {
          to: flags.to,
          contactEmail: flags.contact,
          dryRun: flags["dry-run"] === true,
        }),
      )
    }

    if (["start", "pause", "resume", "done"].includes(action)) {
      const status = action === "start" || action === "resume" ? "running" : action === "pause" ? "paused" : "done"
      return printJson(instance.setCampaignStatus(id, status))
    }

    if (action === "enrol") {
      let contacts = []
      if (flags.file) contacts = parseContactsFile(flags.file)
      else if (flags.emails) {
        contacts = String(flags.emails)
          .split(/[\s,;]+/)
          .filter(Boolean)
          .map((email) => ({ email }))
      }
      if (!contacts.length) fail("provide --emails or --file")
      return printJson(instance.enrolContacts({ campaignId: id, contacts }))
    }

    fail(`unknown campaign action: ${action}`)
  })
}

export async function pauseAllCommand() {
  await withService(async (instance) => printJson(instance.pauseAll()))
}

export async function resumeAllCommand() {
  await withService(async (instance) => printJson(instance.resumeAll()))
}
