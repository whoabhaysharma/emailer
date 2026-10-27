# AGENTS.md

This repository is a self-contained OpenCode plugin plus a local email daemon.

## Setup on a new machine

```bash
npm install
npm link                     # optional
opencode-email-agent setup
```

`setup` = `init` + account creation + service install. `init` writes the plugin
loader shim at `~/.config/opencode/plugins/email-agent.js` (OpenCode ignores local
paths in the `plugins` config array) and copies the agent, skill, and commands.
It never overwrites an edited file unless `--force` is passed.

## Architecture

```
src/
  index.js               OpenCode plugin entry (dependency-free)
  client.js              local HTTP client, token, daemon auto-start
  service.js             composition root; wires domain modules together
  version.js
  domain/
    shared.js            time, message-id, footer, window, limit helpers
    contacts.js          contacts, suppression, consent, status
    enrolments.js        per-contact sequence state
    threads.js           thread creation and matching
    messages.js          inbound parse/store, sent-folder sync, triage, search
    outbound.js          send, Gmail draft, reply, limits, threading headers
    campaigns.js         sequences, enrolment, preview, tick + lock
    sync.js              IMAP folder sync
    metrics.js           stats, health, account views
  tools/
    index.js             combines the tool groups
    schema.js            JSON-schema helpers
    read.js              read-only tools
    compose.js           draft / reply / send
    campaigns.js         campaign + pause/resume tools
    contacts.js          contact status + suppression tools
    ops.js               sync + classify
  http/
    server.js            auth, dispatch, error mapping
    respond.js           JSON/HTML responses, body parsing, token compare
    routes/
      public.js          /health, /u/:token
      accounts.js        /accounts, /sync
      messages.js        /search, /threads, /drafts, /reply, /send
      contacts.js        /contacts, /suppress, /suppressions
      campaigns.js       /campaigns, preview, pause-all
      ops.js             /stats, /unclassified, /classify, /tick
  cli.js                 thin executable entry
  cli/
    index.js             command dispatch
    args.js  io.js  context.js  install.js  help.js
    dashboard.js         pure model + text renderer for the overview screen
    commands/            init, setup, account, doctor, mail, contacts,
                         campaign, config, daemon, dashboard
  mail/                  IMAP, SMTP, MIME, address helpers
  store.js               SQLite schema + additive migrations
  triage.js              deterministic reply rules
  unsubscribe.js         HMAC unsubscribe tokens
assets/                  agent, skill, command templates installed by init
test/                    offline tests (dry-run, temp config, stub HTTP)
```

The plugin must stay dependency-free: `node:` builtins and `fetch` only. All npm
dependencies belong to the daemon.

## Invariants

- Never log or return passwords.
- Enforce suppression, contact status, caps, and stop-on-reply in `src/domain/*`,
  never in prompts.
- Bulk mail (campaigns) gets `List-Unsubscribe`; personal mail does not.
- Any inbound human reply stops a sequence, even before classification.
- `tickCampaigns` must hold the cross-process lock.
- Domain modules receive collaborators explicitly; no module imports `service.js`.
- Schema changes are additive and go through `migrate()` in `src/store.js`.

## Verify a change

```bash
npm test
node --check $(find src -name '*.js')
```
