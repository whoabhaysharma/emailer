import { MIN_NODE_MAJOR, MIN_NODE_MINOR, VERSION, nodeVersionOk } from "../version.js"
import { parseArgs } from "./args.js"
import {
  addAccount,
  removeAccount,
  setSecretCommand,
  showAccounts,
  testAccount,
  warmupAccount,
} from "./commands/account.js"
import { campaignCommand, pauseAllCommand, resumeAllCommand } from "./commands/campaign.js"
import { configCommand } from "./commands/config.js"
import { contactsCommand } from "./commands/contacts.js"
import { dashboardCommand } from "./commands/dashboard.js"
import { daemonCommand, serviceCommand, statusCommand } from "./commands/daemon.js"
import { doctorCommand } from "./commands/doctor.js"
import { initCommand } from "./commands/init.js"
import {
  draftCommand,
  inboxCommand,
  reclassifyCommand,
  searchCommand,
  sendCommand,
  statsCommand,
  syncCommand,
  threadCommand,
} from "./commands/mail.js"
import { setupCommand } from "./commands/setup.js"
import { printHelp } from "./help.js"
import { fail } from "./io.js"

export async function run(argv = process.argv.slice(2)) {
  if (!nodeVersionOk()) {
    console.error(`error: Node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} is required (found ${process.versions.node}).`)
    console.error("The email agent uses the built-in node:sqlite module.")
    process.exit(1)
  }

  const { flags, positional } = parseArgs(argv)
  const command = positional.shift()

  try {
    switch (command) {
      case "init":
        await initCommand(flags)
        break

      case "setup":
        await setupCommand(flags)
        break

      case "account": {
        const action = positional.shift()
        if (!action || action === "list") showAccounts(flags)
        else if (action === "add") await addAccount(flags)
        else if (action === "test") await testAccount(flags, positional)
        else if (action === "warmup") await warmupAccount(flags, positional)
        else if (action === "remove") removeAccount(positional[0])
        else fail(`unknown account action: ${action}`)
        break
      }

      case "secret": {
        const action = positional.shift()
        if (action !== "set") fail("usage: secret set <accountId>")
        await setSecretCommand(flags, positional)
        break
      }

      case "doctor":
        await doctorCommand()
        break

      case "inbox":
        await inboxCommand(flags)
        break

      case "dashboard":
        await dashboardCommand(flags)
        break

      case "stats":
        await statsCommand(flags)
        break

      case "search":
        await searchCommand(flags)
        break

      case "thread":
        await threadCommand(positional)
        break

      case "send":
        await sendCommand(flags)
        break

      case "draft":
        await draftCommand(flags)
        break

      case "contacts":
        await contactsCommand(positional.shift(), flags, positional)
        break

      case "campaign":
        await campaignCommand(positional.shift(), flags, positional)
        break

      case "pause-all":
        await pauseAllCommand()
        break

      case "resume-all":
        await resumeAllCommand()
        break

      case "sync":
        await syncCommand()
        break

      case "reclassify":
        await reclassifyCommand(flags)
        break

      case "daemon":
        await daemonCommand(flags)
        break

      case "service":
        serviceCommand(positional[0] || "status")
        break

      case "config":
        configCommand(positional[0] || "show", positional.slice(1), flags)
        break

      case "status":
        await statusCommand()
        break

      case "version":
      case "--version":
        console.log(VERSION)
        break

      case undefined:
      case "help":
      case "--help":
        printHelp()
        break

      default:
        fail(`unknown command: ${command}. Run --help.`)
    }
  } catch (error) {
    fail(String(error?.message || error))
  }
}
