import { existsSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { ensureLayout, ensureToken, loadConfig, saveConfig } from "../../config.js"
import { accountsFile, agentsDir, commandsDir, configFile, DATA, skillsDir } from "../../paths.js"
import { formatPath } from "../io.js"
import { installAsset, installPluginShim, removeLegacyPluginEntry } from "../install.js"

export async function initCommand(flags) {
  ensureLayout()
  ensureToken()

  if (!existsSync(configFile)) {
    saveConfig({ unsubscribeSecret: randomBytes(32).toString("hex") })
  } else if (!loadConfig().unsubscribeSecret) {
    saveConfig({ unsubscribeSecret: randomBytes(32).toString("hex") })
  }
  if (!existsSync(accountsFile)) {
    writeFileSync(accountsFile, JSON.stringify({ accounts: [] }, null, 2) + "\n", { mode: 0o600 })
  }

  const force = flags.force === true
  const installed = [
    installAsset("agents/email-marketer.md", join(agentsDir, "email-marketer.md"), force),
    installAsset("agents/inbox-triage.md", join(agentsDir, "inbox-triage.md"), force),
    installAsset("skills/email-playbook/SKILL.md", join(skillsDir, "email-playbook", "SKILL.md"), force),
    installAsset("commands/inbox.md", join(commandsDir, "inbox.md"), force),
    installAsset("commands/campaign.md", join(commandsDir, "campaign.md"), force),
    installAsset("commands/prospect.md", join(commandsDir, "prospect.md"), force),
    installAsset("commands/report.md", join(commandsDir, "report.md"), force),
  ]

  const shim = installPluginShim()
  const legacy = removeLegacyPluginEntry()

  console.log("email-agent initialised\n")
  console.log(`  config     ${formatPath(configFile)}`)
  console.log(`  accounts   ${formatPath(accountsFile)}`)
  console.log(`  database   ${formatPath(join(DATA, "agent.db"))}`)
  console.log(`  plugin     ${formatPath(shim.file)}${shim.changed ? "" : " (unchanged)"}`)
  if (legacy.removed) console.log(`  cleaned    legacy plugins entry in ${formatPath(legacy.file)}`)

  for (const item of installed) {
    if (item.skipped) continue
    if (item.kept) console.log(`  kept       ${formatPath(item.destination)} (differs; use --force to replace)`)
    else console.log(`  ${item.changed ? "wrote     " : "unchanged "} ${formatPath(item.destination)}`)
  }

  console.log("\nnext")
  console.log("  opencode-email-agent setup           # guided setup in one command")
  console.log("  opencode-email-agent doctor          # verify credentials and config")
  console.log("  opencode-email-agent service install # run 24/7\n")
  console.log("Then in OpenCode: /inbox")
  if (shim.changed || legacy.removed) console.log("Run /reload in OpenCode so it picks up the plugin.")
}
