# Using the email agent

The agent runs inside OpenCode. A local daemon owns Gmail, credentials, state, and
scheduling. The agent writes and decides; the daemon sends, syncs, and enforces
limits.

## The 30-second version

1. `npm i -g opencode-email-agent && opencode-email-agent setup`
2. Restart OpenCode (or `/reload` for server plugins)
3. `/status` or `/email` to see what needs you
4. `/inbox` to triage replies; drafts land in Gmail for review
5. `/campaign` to start outreach

## The daily loop

- **Morning:** `/status` → `/inbox` → open Gmail Drafts → review and send.
- **During the day:** the daemon syncs every 60s, threads replies, and stops a
  sequence on any human reply.
- **Weekly:** `/report` for sends, replies, unique repliers, and per-step
  performance.
- The footer status shows `EMAIL …`; click it, or run the `Email dashboard`
  palette command, to open the panel.

## OpenCode commands

| Command | What it does |
| --- | --- |
| `/status` | Dashboard plus a short explanation |
| `/email` | Visual dashboard panel (`/mail` alias) |
| `/inbox` | Classify replies, draft answers, list opt-outs |
| `/campaign` | Design a sequence, preview it, enrol contacts |
| `/prospect` | Clean and validate a list |
| `/report` | Funnel and campaign metrics |

## Common tasks

### See what needs you

```
/status
```

### Reply to a person

```
Draft a reply to Abhay saying Tuesday 3pm works.
```

The draft goes into the same Gmail thread. The human presses send.

### Email someone new

You do not have to save a contact first. Give the agent the address and the
context you have:

```
Draft an intro to priya@example.com. We met at the conference; she runs ops.
```

The agent uses only what you gave it, does not invent history, and does not
require a contact record. A saved contact is still required when
`requireConsent` is turned on.

### Send an update to a list

1. Put `email,name,company` in a CSV.
2. Import it:

   ```bash
   opencode-email-agent contacts import --file updates.csv --consented
   ```

3. Create a one-step campaign JSON (`mode: "send"` or `"draft"`), or ask the
   agent to write it:

   ```bash
   opencode-email-agent campaign create --file updates.json
   ```

4. Preview it:

   ```bash
   opencode-email-agent campaign preview <id> --to team@clickboostmedia.com
   ```

5. Enrol and start:

   ```bash
   opencode-email-agent campaign enrol <id> --file updates.csv
   opencode-email-agent campaign start <id>
   ```

### Run a follow-up sequence

```
Write a 3-step sequence for limo companies and show me the copy first.
```

### Emergency stop

```bash
opencode-email-agent pause-all
```

### Check health and quota

```bash
opencode-email-agent doctor
opencode-email-agent dashboard
```

## What the agent will not do

- Send without approval (`confirm: true` plus a clear "send it" in chat).
- Email anyone on the suppression list or with a blocked status.
- Invent contacts, history, case studies, or metrics.
- Bulk-send outside an approved campaign.
- Continue a sequence after a reply.

## Limits and defaults

- 40 sends per account per rolling 24h.
- Business hours 9-18, Mon-Fri, local timezone.
- Duplicate guard: same recipient + subject within 12h refused.
- Drafts by default; campaigns default to `mode: "draft"`.
- Warmup optional:

  ```bash
  opencode-email-agent account warmup team --start 20 --increment 10 --max 40
  ```

- Suppression and opt-outs are absolute.

## Where things live

| Path | What it is |
| --- | --- |
| `~/.config/opencode/email-agent/config.json` | Settings, limits, footer |
| `~/.config/opencode/email-agent/accounts.json` | Sending accounts |
| `~/.config/opencode/email-agent/token` | Daemon bearer token |
| `~/.local/share/opencode/email-agent/agent.db` | SQLite state |
| `~/.local/share/opencode/email-agent/daemon.log` | Daemon log |
| `~/.config/opencode/plugins/email-agent/` | OpenCode plugin loader |
| `~/.config/opencode/agents/`, `commands/`, `skills/email-playbook/` | Installed agent, commands, skill |

## Troubleshooting

- **Tools missing in OpenCode:** run `opencode plugin list`,
  `opencode-email-agent init`, then `/reload`.
- **`Invalid login`:** use a Google app password with 2FA enabled, then
  `opencode-email-agent secret set <id>`.
- **Daemon down:** `opencode-email-agent service install`.
- **Drafts unthreaded:** reply with `email.reply` or send instead of drafting.
- **`/email` missing:** restart the OpenCode TUI (TUI parts load at startup).
- **Update:** `opencode-email-agent update --check`, then
  `opencode-email-agent update`.

## First week checklist

- [ ] Set `footerAddress` with `opencode-email-agent config set footerAddress="..."`
- [ ] Set `signature` with `opencode-email-agent config set signature="..."`
- [ ] Run `opencode-email-agent doctor`
- [ ] Send one draft manually from Gmail
- [ ] Preview a campaign before starting it
- [ ] Keep volume under 40 sends per day
