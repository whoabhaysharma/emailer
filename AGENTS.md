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

- `src/index.js` — OpenCode plugin entry. Registers `email.*` tools. Dependency-free.
- `src/tools.js` — tool schemas and HTTP calls. No business logic.
- `src/client.js` — local HTTP client, token lookup, daemon auto-start.
- `src/server.js` — local HTTP API + signed unsubscribe route.
- `src/service.js` — send, draft, sync, threading, campaigns, metrics.
- `src/mail/` — IMAP, SMTP, MIME, address helpers.
- `src/store.js` — SQLite schema and additive migrations (`node:sqlite`).
- `src/triage.js` — deterministic reply rules.
- `src/unsubscribe.js` — HMAC unsubscribe tokens.
- `assets/` — agent, skill, and command templates installed by `init`.
- `test/` — offline tests using dry-run and a temp `EMAIL_AGENT_HOME`.

The plugin must stay dependency-free: `node:` builtins and `fetch` only. All npm
dependencies belong to the daemon.

## Invariants

- Never log or return passwords.
- Enforce suppression, contact status, caps, and stop-on-reply in `src/service.js`,
  never in prompts.
- Bulk mail (campaigns) gets `List-Unsubscribe`; personal mail does not.
- Any inbound human reply stops a sequence, even before classification.
- `tickCampaigns` must hold the cross-process lock.
- Schema changes are additive and go through `migrate()` in `src/store.js`.

## Verify a change

```bash
npm test
node --check src/*.js src/mail/*.js
```
