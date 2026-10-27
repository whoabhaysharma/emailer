# AGENTS.md

This repository is a self-contained OpenCode plugin plus a local email daemon.

## Setup on a new machine

```bash
npm install
npm link                     # optional
opencode-email-agent setup
```

`setup` = `init` + account creation + service install. `init` writes the plugin
loader package directory at `~/.config/opencode/plugins/email-agent/` (OpenCode
ignores local paths in the `plugins` config array) and copies the agent, skill,
and commands. The directory's `package.json` exposes the server part as `.` and
the TUI part as `./tui`. It never overwrites an edited file unless `--force` is
passed.

## Packaging

`npm pack` builds the installable tarball (`src`, `assets`, and the docs).
`package.json` exposes `.` (server), `./tui`, and `./cli`; the TUI peers are
optional because OpenCode supplies them at runtime. `prepublishOnly` runs the
tests and the JSX check. Publish with `npm publish`.

If OpenCode already loads the package through `opencode plugin add` (npm name or
Git specifier), `init` detects the registration and skips the local loader so the
plugin is not loaded twice. `init --no-plugin` forces that behaviour.

## Architecture

```
src/
  index.js               OpenCode plugin entry (dependency-free)
  tui.jsx                OpenCode TUI part: /email route and home footer
  client.js              local HTTP client, token, daemon auto-start
  service.js             composition root; wires domain modules together
  version.js
  dashboard/
    model.js             shared read-only dashboard projection (CLI + TUI + HTTP)
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
      ops.js             /stats, /dashboard, /unclassified, /classify, /tick
  cli.js                 thin executable entry
  cli/
    index.js             command dispatch
    args.js  io.js  context.js  install.js  help.js
    dashboard.js         text renderer; re-exports the shared model
    commands/            init, setup, account, doctor, mail, contacts,
                         campaign, config, daemon, dashboard, update
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

## Releases and updates

`update [--check]` (`src/cli/commands/update.js`) is the user-facing upgrade path.
It resolves the newest `vX.Y.Z` tag, refuses a dirty tree, backs up `agent.db`,
runs `git pull --ff-only`, `npm install --omit=dev`, `init`, reinstalls the
service, and probes `/health`. Non-git installs get the `npm i -g` instructions.
The pure helpers (`parseVersion`, `compareVersions`, `changelogSection`) stay
free of filesystem access and are covered by `test/update.test.js`.

Release flow: bump `package.json` and `src/version.js` together, add a
`CHANGELOG.md` section, run the tests, commit, then `git tag -a vX.Y.Z` and
`git push --follow-tags`. CI (`.github/workflows/ci.yml`) runs on every push and
PR; the tag push triggers `.github/workflows/release.yml`, which creates the
GitHub Release. npm publishing is manual and is not in CI. See `UPDATING.md`.

## Verify a change

```bash
npm test
npm run check:jsx
node --check $(find src -name '*.js')
node src/cli.js update --check
```

### Verify the TUI plugin loads

`npm run check:jsx` only proves the JSX transforms; it cannot render the TUI
headlessly. After `node src/cli.js init`:

1. `opencode plugin list` must show `email-agent` (source resolves to
   `.../plugins/email-agent/server.js`), and
   `opencode api get /api/plugin` must report `"features":{"server":true,"tui":true}`.
2. `opencode api post /api/location/reload`, wait ~3s, then
   `tail -5 ~/.local/share/opencode/email-agent/plugin.log` must show a fresh
   `setup:start` from the server part.
3. `curl -s http://127.0.0.1:8787/health` must still report healthy, and
   `/dashboard` must answer with the bearer token.

If the directory does not load, keep the server shim working and add a
TUI-only directory instead; never leave a state where `plugin list` omits the
plugin.
