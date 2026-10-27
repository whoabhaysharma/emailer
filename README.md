# opencode-email-agent

A multi-account email marketing agent for [OpenCode](https://opencode.ai).

[Usage guide](USAGE.md)

New here? Read [USAGE.md](USAGE.md) for the daily loop, commands, and limits.

Drafts replies inside Gmail for human approval, tracks conversations, stops
sequences the moment someone answers, and runs drip campaigns with hard safety
limits. Works with Gmail app passwords or any IMAP/SMTP provider.

```
OpenCode (agent + email.* tools)  ──HTTP──▶  email-agent daemon  ──IMAP/SMTP──▶  mailbox
                                              SQLite, scheduler,
                                              IMAP poller, Gmail drafts
```

The plugin is a dependency-free HTTP client, so it loads in any OpenCode runtime.
The daemon owns credentials, state, IMAP, SMTP, and scheduling. That split is what
makes it portable and safe: the model never sees a password, and limits are
enforced in code rather than in a prompt.

## Install

Requires **Node 22.5+** (uses the built-in `node:sqlite`, so there are no native
modules to compile).

### From npm (recommended)

```bash
npm i -g opencode-email-agent
opencode-email-agent setup
```

`setup` installs the OpenCode agents, commands, skill, and plugin loader, walks
through account, app password, limits, footer, compliance address, dry-run mode,
and installs the background service. Then run `/reload` in OpenCode (restart it
once for the TUI part) and open `/email` or `/inbox`.

A global install lives in OpenCode's global config, so the plugin is available in
**every project** on that machine. Nothing is project-specific.

### From GitHub

No npm publish is required:

```bash
npm i -g github:whoabhaysharma/emailer
opencode-email-agent setup
```

### From a tarball (offline)

```bash
npm pack                                  # in this repo, writes opencode-email-agent-X.Y.Z.tgz
npm i -g ./opencode-email-agent-X.Y.Z.tgz
opencode-email-agent setup
```

Copy the `.tgz` to any machine and install it there. `npm pack --dry-run` shows
exactly what ships (`src`, `assets`, and the docs).

### Through OpenCode's plugin manager

OpenCode can install the package itself, which also gives you the `/email` TUI
part:

```bash
opencode plugin add opencode-email-agent
# or, before publishing to npm:
opencode plugin add github:whoabhaysharma/emailer
```

Then install the CLI once for the daemon, credentials, and agents/commands:

```bash
npm i -g opencode-email-agent
opencode-email-agent setup --no-plugin
```

`--no-plugin` tells setup not to write the local loader, because OpenCode already
loads the package directly. Running setup without it is safe too: `init` detects
the registration and skips the loader automatically.

### From a git checkout (for development)

```bash
git clone https://github.com/whoabhaysharma/emailer.git ~/opencode-email-agent
cd ~/opencode-email-agent
npm install
npm link                    # optional: gives you the `opencode-email-agent` command
opencode-email-agent setup
```

`setup` installs:

- `~/.config/opencode/agents/email-marketer.md` and `inbox-triage.md`
- `~/.config/opencode/skills/email-playbook/SKILL.md`
- `~/.config/opencode/commands/{inbox,campaign,prospect,report,status}.md`
- `~/.config/opencode/plugins/email-agent/` (the loader package: server + TUI)
- a launchd / systemd user service

Re-running `init` is safe: it never overwrites files you edited unless you pass
`--force`. If you move a checkout, run `opencode-email-agent init` again so the
loader points at the new path.

### Add another account

```bash
opencode-email-agent account add --email sales@yourdomain.com --name "Abhay from Acme" --id sales --daily-limit 40
opencode-email-agent secret set sales
opencode-email-agent account test sales
```

App passwords: enable 2-Step Verification, create one at
<https://myaccount.google.com/apppasswords>, and enable IMAP in Gmail settings.

## Updating

```bash
opencode-email-agent update --check   # is a newer release available?
opencode-email-agent update           # back up, pull, install, init, restart
opencode-email-agent service status   # confirm the daemon is back
```

`update` refuses to run on a dirty tree, backs up the SQLite database first, pulls
fast-forward only, reinstalls dependencies, re-runs `init` (your edited agents and
commands are kept), restarts the service, and checks `/health`. Installed from
npm instead? Run:

```bash
npm i -g opencode-email-agent@latest
opencode-email-agent init
opencode-email-agent service install
```

See [UPDATING.md](UPDATING.md) for backups, manual fallback, release policy, and
rollback.

## Daily use

In OpenCode:

```text
/email        TUI dashboard of inbox, drafts, and campaigns (r refreshes, esc goes home)
/inbox        triage replies, classify them, draft responses
/status       ask the agent to explain the dashboard and what needs attention
/report       funnel and campaign metrics
/campaign …   design a sequence and enrol contacts
/prospect …   clean a list before outreach
```

Or ask directly: *"what came in since yesterday?"*, *"draft a reply to Priya
saying we can start Monday"*, *"pause the Q4 campaign"*.

From the CLI:

```bash
opencode-email-agent dashboard --no-color
opencode-email-agent inbox
opencode-email-agent search --query invoice
opencode-email-agent thread <threadId>
opencode-email-agent stats
```

`/email` renders inside the TUI and has a home-footer status line; the CLI
`dashboard` command remains the terminal-only view (and still powers `/status`).
The TUI reads the daemon's `/dashboard` endpoint, so it shows the same numbers
without sending anything.

## What it does now

**Sending**
- Multiple accounts, per-account signature, reply-to, and footer.
- Daily caps (rolling 24h) and an optional global cap across all accounts.
- Warmup ramp: start low and increase automatically per day.
- Business-hours window with timezone and jitter on delayed steps.
- Duplicate protection: same recipient + subject within 12h is refused.
- CC/BCC and recipient-count limits.
- New addresses are allowed: a saved contact is not required unless
  `requireConsent` is turned on.

**Replies**
- Thread matching via `In-Reply-To` / `References`, subject + participants, then
  the latest thread with that contact.
- Syncs both **INBOX and Sent**, so a reply you send from Gmail itself is captured
  and the agent will not answer twice.
- Deterministic triage before any model call: bounces, opt-outs, auto-replies,
  and newsletters.
- Any real reply stops the sequence immediately. Out-of-office postpones it.
- Historical mail (older than `triageWindowDays`) is stored without flooding the
  triage queue.

**Drafting**
- `email.reply` builds a threaded MIME message and appends it to Gmail's
  `\Drafts` folder. It appears inside the original thread; you press send.
- `email.draft` for new mail. Sending requires `confirm: true` plus a permission
  prompt.

**Contacts and compliance**
- Contact statuses: `active`, `interested`, `engaged`, `not_now` (with a
  not-before date), `unsubscribed`, `bounced`, `do_not_contact`, `complained`.
- A suppression list checked in the daemon on every send. No prompt can override
  it.
- `List-Unsubscribe` on bulk mail only, with one-click POST only for HTTPS URLs.
- Signed unsubscribe links (`/u/<token>`) if you set a public base URL. Mailto
  unsubscribe works without hosting.

**Campaigns**
- Multi-step sequences with delays, per-step preview, and per-step stats.
- `mode: "draft"` (default) writes steps to Gmail Drafts; `mode: "send"` sends
  inside the hours/caps.
- Refuses to enrol someone already active in another campaign unless
  `allowMultipleCampaigns` is on.
- Cross-process tick lock, so the daemon and a manual `campaign tick` cannot
  double-send.

## Tools exposed to the agent

| Tool | Purpose |
| --- | --- |
| `email.accounts`, `email.health` | identities, warmup limits, sync state |
| `email.search`, `email.thread`, `email.contact` | mailbox and history |
| `email.contacts`, `email.contact_status` | list contacts, set status / not-before |
| `email.reply` | threaded draft reply (default) or send |
| `email.draft`, `email.send` | compose from scratch |
| `email.drafts` | what is waiting in Gmail for review |
| `email.campaign_create`, `campaign_enrol`, `campaign_status`, `campaign_preview` | sequences |
| `email.pause_all`, `email.resume_all` | emergency stop |
| `email.unclassified`, `email.classify` | triage loop |
| `email.suppress`, `email.suppressions` | do-not-contact list |
| `email.sync`, `email.stats` | ops |

Read-only tools are always available. `email.send` still requires
`confirm: true`, and a campaign still starts only after an explicit status
change. The agent asks for approval in chat once per batch, not through a
repeated permission prompt.

## Configuration

```bash
opencode-email-agent config show
opencode-email-agent config set dryRun=false
opencode-email-agent config set businessHours.start=9 businessHours.end=17
opencode-email-agent config set footerAddress="123 Main St, City"
opencode-email-agent config set globalDailyLimit=100
opencode-email-agent config edit
```

| Key | Default | Meaning |
| --- | --- | --- |
| `dryRun` | `false` | Simulate every send. Recommended for the first day. |
| `pollSeconds` | `60` | IMAP poll interval. |
| `timezone` | system | Timezone for the send window. |
| `businessHours` | 9–18, Mon–Fri | `{ start, end, days }`, days 0=Sun. |
| `defaultDailyLimit` | `40` | Per-account rolling 24h cap. |
| `globalDailyLimit` | `0` | Cap across all accounts (`0` = off). |
| `signature` | empty | Footer signature; account-level overrides. |
| `footerAddress` | empty | Postal address (required for cold email). |
| `unsubscribeMailto` | empty | Mailto unsubscribe fallback. |
| `publicBaseUrl` | empty | Public URL of the daemon, enables one-click links. |
| `maxPerTick` | `25` | Max campaign steps per scheduler pass. |
| `initialSyncLimit` | `200` | Messages fetched on first mailbox sync. |
| `triageWindowDays` | `7` | Older mail is stored but not queued for triage. |
| `syncSentFolder` | `true` | Capture mail you send from Gmail itself. |
| `maxRecipientsPerMessage` | `20` | Guard against accidental bulk sends. |
| `allowMultipleCampaigns` | `false` | Allow one contact in several active campaigns. |
| `requireConsent` | `false` | Only email contacts with recorded consent. |

Warmup per account:

```bash
opencode-email-agent account warmup sales --start 20 --increment 10 --max 40
```

The effective limit is `min(dailyLimit, max, start + days × increment)`.

## Campaign file

```json
{
  "name": "Q4 founders",
  "accountId": "sales",
  "mode": "draft",
  "steps": [
    { "delayDays": 0, "subject": "Quick question about {{company}}", "body": "Hi {{first_name}}, …" },
    { "delayDays": 3, "subject": "Re: Quick question about {{company}}", "body": "…" }
  ]
}
```

```bash
opencode-email-agent campaign create --file campaign.json
opencode-email-agent campaign preview <id>          # sends [PREVIEW] copies to you
opencode-email-agent campaign enrol <id> --file contacts.csv
opencode-email-agent campaign start <id>
```

Variables: `{{first_name}}`, `{{name}}`, `{{email}}`, `{{company}}`, `{{title}}`,
`{{campaign}}`. Unknown variables render empty.

## One-click unsubscribe

Set a public URL that reaches the daemon, for example a Cloudflare tunnel:

```bash
opencode-email-agent config set publicBaseUrl=https://mail.yourdomain.com
```

Then every bulk email gets `List-Unsubscribe: <https://…/u/<signed-token>>` and
an HTTPS `List-Unsubscribe-Post`. The token is HMAC-signed with an auto-generated
secret; no database lookup or login is needed to unsubscribe.

Without a public URL, set `unsubscribeMailto` and the agent still honours replies
containing "unsubscribe" by suppressing the sender automatically.

## Safety model

- Suppression and contact status are checked in the daemon on **every** send.
- Daily caps, warmup, duplicate protection, and recipient limits are enforced in
  code.
- Any real reply stops the sequence before the agent sees it.
- Campaigns start only after an explicit status change.
- `email.send` requires `confirm: true` and a clear approval in chat; the agent
  asks once per batch, not once per message.
- Passwords live in the macOS Keychain (or a 600-mode file), never in config or
  prompts.
- The local HTTP API is bound to `127.0.0.1` and requires a 600-mode bearer token.
- The only unauthenticated route is the signed unsubscribe endpoint.

## Deliverability and the rules

Gmail app passwords are for personal, interactive use. Google's terms prohibit
unsolicited bulk mail, and accounts that send it get restricted. Practical limits
are roughly 500 recipients/day for free accounts and 2,000 for Workspace — but
**start at 20–40/day per account and ramp**.

For cold outreach at volume, use a warmed custom domain with an ESP (SES, Resend,
Postmark) and SPF/DKIM/DMARC. Keep Gmail for warm, opt-in, or low-volume
high-touch conversations.

Compliance is not optional: postal address, working opt-out, honest subject
lines, immediate permanent suppression, no purchased lists.

## CLI reference

```bash
opencode-email-agent setup
opencode-email-agent init [--force]
opencode-email-agent account add|list|test|remove|warmup
opencode-email-agent secret set <id>
opencode-email-agent doctor
opencode-email-agent inbox
opencode-email-agent search [--query q] [--from a] [--limit 25] [--json]
opencode-email-agent thread <id>
opencode-email-agent send --to a@b.com --subject "…" --text "…" --confirm
opencode-email-agent draft --to a@b.com --subject "…" --text "…"
opencode-email-agent contacts list|show|import|status|prune
opencode-email-agent campaign list|create|preview|enrol|start|pause|resume|done|tick
opencode-email-agent campaign pause-all|resume-all
opencode-email-agent stats [--json]
opencode-email-agent sync
opencode-email-agent reclassify [--dry-run]
opencode-email-agent daemon [--port 8787] [--once]
opencode-email-agent service install|uninstall|status
opencode-email-agent update [--check]
opencode-email-agent config show|set|edit|path
```

## Layout

```text
~/.config/opencode/
  agents/email-marketer.md
  agents/inbox-triage.md
  skills/email-playbook/SKILL.md
  commands/{inbox,campaign,prospect,report,status}.md
  plugins/email-agent/            # loader package (server.js + tui.js)
    package.json
    server.js
    tui.js
  email-agent/
    config.json
    accounts.json                 # identities, no passwords
    secrets.json                  # only when Keychain is unavailable
    token                         # bearer token, mode 600

~/.local/share/opencode/email-agent/
  agent.db                        # SQLite
  daemon.log
  plugin.log                      # plugin load diagnostics
```

Back up the config directory. The database can be rebuilt from IMAP, but campaign
history and notes would be lost.

## Code layout

```
src/
  index.js        plugin entry (no dependencies)
  client.js       HTTP client + daemon auto-start
  service.js      composition root
  domain/         contacts, enrolments, threads, messages, outbound,
                  campaigns, sync, metrics, shared helpers
  tools/          read / compose / campaign / contact / ops tool groups
  http/           server, responder, one module per route group
  cli/            argument parsing, IO, install, one module per command group
  mail/           IMAP, SMTP, MIME, address helpers
  store.js        SQLite schema and migrations
  triage.js       deterministic reply rules
  unsubscribe.js  HMAC tokens
```

Each domain module receives its collaborators as arguments, so the dependency
graph is acyclic and every module can be tested in isolation. `service.js` only
wires them together.

## Troubleshooting

**Tools do not appear in OpenCode** — check `opencode plugin list`. It should show
`email-agent  local  ~/.config/opencode/plugins/email-agent` (OpenCode may display
the resolved `server.js` entry). If not, run `opencode-email-agent init`, then
`/reload`. `cat ~/.local/share/opencode/email-agent/plugin.log` shows whether the
plugin's `setup` ran.

**`/email` is missing from the TUI** — the TUI part loads only from the plugin
package directory. Run `opencode-email-agent init`, restart OpenCode (the TUI
part is not hot-reloaded like commands), then check `opencode plugin list`.

**`Invalid login` / `Application-specific password required`** — no app password,
or 2FA is off. Re-run `secret set`.

**`IMAP is disabled`** — enable IMAP in Gmail settings.

**Daemon not running** — `service status`, then read `daemon.log`.

**Drafts land unthreaded** — some Gmail accounts refuse to thread appended drafts.
Verify once per account. If it happens, send replies instead of drafting.

**Rate limited** — lower `dailyLimit`, add accounts, or enable warmup.

## Not built yet

Deliberately out of scope for this version: A/B subject testing, link/click
tracking, attachment support, and per-recipient send-time optimization. Open/click
tracking is unreliable anyway (Gmail proxy, Apple MPP); replies are the metric
that matters.

## License

MIT
