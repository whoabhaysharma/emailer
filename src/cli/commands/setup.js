import { existsSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { ensureLayout, ensureToken, loadAccounts, loadConfig, saveConfig } from "../../config.js"
import { configFile } from "../../paths.js"
import { ask, askYes, fail, promptHidden } from "../io.js"
import { addAccount } from "./account.js"
import { initCommand } from "./init.js"
import { serviceCommand } from "./daemon.js"
import { doctorCommand } from "./doctor.js"

export async function setupCommand(flags) {
  ensureLayout()
  ensureToken()
  if (!existsSync(configFile)) saveConfig({})

  const cfg = loadConfig()
  if (!cfg.unsubscribeSecret) saveConfig({ unsubscribeSecret: randomBytes(32).toString("hex") })

  console.log("OpenCode email agent setup\n")

  // Install the agent, skill, commands, and plugin loader before asking for
  // credentials. This is what makes `npm i -g` (or a tarball install) enough on
  // a fresh machine: setup no longer leaves OpenCode without the assets.
  const init = await initCommand({ ...flags, quiet: true })
  if (init.plugin.registered) console.log("plugin: registered in OpenCode")
  else if (init.plugin.dir) console.log(`plugin: ${init.plugin.dir}`)
  else console.log("plugin: skipped (--no-plugin)")
  console.log("agents, commands, and skill: installed\n")

  if (!loadAccounts().length) {
    if (!process.stdin.isTTY && !flags.email) {
      fail('No TTY. Use: setup --email you@gmail.com --name "Your Name" --password <app-password>')
    }

    const email = flags.email || (await ask("Gmail address: "))
    if (!email.includes("@")) fail("That does not look like an email address")

    const name = flags.name || (await ask("Display name (what recipients see): ", email.split("@")[0]))
    const id = flags.id || email.split("@")[0].replace(/[^a-z0-9_-]/gi, "-").toLowerCase()
    const limit = Number(flags.limit || (await ask("Daily send limit for this account [40]: ", "40")))
    const signature = flags.signature ?? (await ask("Email signature (one line, blank to skip): "))
    const address = flags.address ?? (await ask("Postal address for the footer (required for cold email, blank to skip): "))
    const mailto = flags["unsubscribe-mailto"] ?? (await ask("Unsubscribe mailto address (blank to use replies): "))
    const password = flags.password || (await promptHidden("Google app password (16 characters, hidden): "))

    if (!password) fail("An app password is required. Create one at https://myaccount.google.com/apppasswords")

    await addAccount({
      email,
      id,
      name,
      password,
      "daily-limit": String(limit),
      signature,
      "unsubscribe-mailto": mailto,
    })

    saveConfig({
      signature: signature || cfg.signature,
      footerAddress: address || cfg.footerAddress,
      unsubscribeMailto: mailto || cfg.unsubscribeMailto,
    })

    if (await askYes("Start in dry-run mode so nothing can be sent accidentally?", true)) {
      saveConfig({ dryRun: true })
    }
  } else {
    console.log(`accounts: ${loadAccounts().map((account) => `${account.id} <${account.email}>`).join(", ")}`)
  }

  if (process.stdin.isTTY && (await askYes("Install the background service so replies are tracked 24/7?", true))) {
    try {
      serviceCommand("install")
    } catch (error) {
      console.error(`warning: could not install the service: ${String(error.message || error)}`)
      console.error("You can still run: opencode-email-agent daemon")
    }
  }

  console.log("\nRunning doctor...\n")
  await doctorCommand()

  console.log("\nDone. In OpenCode run /reload, then /inbox.")
  console.log("Turn off dry-run when ready: opencode-email-agent config set dryRun=false")
}
