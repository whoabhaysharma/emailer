import { VERSION } from "../version.js"

export function printHelp() {
  console.log(`opencode-email-agent ${VERSION}

Usage: opencode-email-agent <command> [options]

Setup
  setup                             guided setup: account, password, footer, service
  init [--force]                    install agent, skill, commands, plugin shim
  account add --email <addr>        add another sending account
        [--id sales] [--name "Name"] [--daily-limit 40]
        [--warmup-start 20 --warmup-increment 10 --warmup-max 40]
  account list|test|remove
  account warmup <id> [--start 20 --increment 10 --max 40] [--off]
  secret set <id>                   store the Google app password

Daily use
  dashboard [--watch] [--json]      one-screen overview of inbox, drafts, campaigns
  inbox                             replies needing triage + pending drafts
  search [--query q] [--from a]     search stored messages
  thread <id>                       print a conversation
  send --to a@b.com --subject "..." --text "..." [--confirm]
  draft --to a@b.com --subject "..." --text "..."
  stats                             funnel metrics

Contacts
  contacts list [--query q] [--status active]
  contacts import --file contacts.csv [--consented]
  contacts show <email>
  contacts status <email> <status> [--not-before 2027-01-01]
  contacts prune [--dry-run]        drop contacts that only sent newsletters

Campaigns
  campaign list
  campaign create --file campaign.json
  campaign preview <id> [--to me@x.com] [--dry-run]
  campaign enrol <id> --emails a@b.com,c@d.com   (or --file contacts.csv)
  campaign start|pause|resume|done <id>
  campaign pause-all | resume-all
  campaign tick                     run one scheduling pass

Operations
  sync                              sync inbox + sent once
  reclassify [--dry-run]            re-run triage rules on stored inbound mail
  daemon [--port 8787] [--once]
  service install|uninstall|status  run on login (launchd/systemd)
  doctor                            verify config, credentials, SMTP/IMAP
  config show|set|edit|path
  update [--check]                  pull the latest release, migrate, restart

Config examples
  config set dryRun=false
  config set businessHours.start=9 businessHours.end=17
  config set footerAddress="123 Main St, City"
  config set publicBaseUrl=https://mail.example.com
  config set globalDailyLimit=100

Environment
  EMAIL_AGENT_HOME   config dir (default ~/.config/opencode/email-agent)
  EMAIL_AGENT_DATA   data dir (default ~/.local/share/opencode/email-agent)
  EMAIL_AGENT_PASSWORD_<ID>  per-account app password override
  EMAIL_AGENT_URL    daemon URL (default http://127.0.0.1:8787)

Add --json to list/stats commands for machine-readable output.
`)
}
