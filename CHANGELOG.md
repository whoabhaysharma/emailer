# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.2] - 2026-10-28

### Changed

- Removed the repeated email consent prompt. The email-marketer agent now has
  `email.send` and `email.campaign.write` set to `allow`; the send tool still
  requires `confirm: true`, and a campaign still starts only after an explicit
  status change.
- Rule 1 now says a clear "send it" or "yes" in chat is approval. The agent asks
  once per batch, not once per message, and does not ask for written consent or
  signed forms.
- The playbook no longer tells the agent to keep consent records. If the user
  says they have permission, the agent proceeds.
- `requireConsent` is still off by default and remains the only contact gate when
  explicitly enabled.

## [0.4.1] - 2026-10-28

### Changed

- The email-marketer agent may now write to a new address the user supplies
  without a saved contact. It still must not invent history or facts; it uses
  only the contact record, the conversation, or what the user provided.
- Softened the pre-send check: `email.contact` and `email.search` are required
  for known addresses, not for a brand-new one.
- The playbook and usage guide document new-address outreach. `requireConsent`
  remains the only setting that gates unknown contacts, and it is off by default.

## [0.4.0] - 2026-10-28

### Added

- Installable package metadata: `repository`, `homepage`, `bugs`, `keywords`,
  `publishConfig`, a `./package.json` export, and a `prepublishOnly` check.
  The TUI peers (`@opencode/plugin`, OpenTUI, Solid) are optional so a global
  CLI install stays small and OpenCode supplies them at runtime.
- `setup` now installs the OpenCode agents, skill, commands, and plugin loader
  itself, so `npm i -g opencode-email-agent && opencode-email-agent setup` is
  enough on a fresh machine.
- `init` detects a package already registered through `opencode plugin add`
  (by package name, Git specifier, or local path) and skips the local loader,
  removing an older loader so the plugin is not loaded twice.
- `init --no-plugin` skips plugin registration entirely.
- `test/install.test.js` covers asset installation, registration detection, and
  loader ownership.

### Docs

- README documents the npm, Git, tarball, and `opencode plugin add` install
  paths, and notes that a global install is available in every OpenCode
  project on the machine.

## [0.3.1] - 2026-10-27

### Docs

- `USAGE.md`: a one-page operator guide covering the daily loop, OpenCode
  commands, common tasks, limits, file locations, and troubleshooting.
- README links the usage guide near the top.

## [0.3.0] - 2026-10-27

### Added

- OpenCode TUI plugin (`src/tui.jsx`): a `/email` route with the live dashboard
  and a `home.footer.status` line, with `r` to refresh and `escape` to go home.
- Shared `GET /dashboard` HTTP endpoint behind the existing bearer auth, so the
  TUI, the CLI dashboard, and `/status` render one model.
- `src/dashboard/model.js`: the read-only dashboard projection shared by the
  CLI and the TUI.
- `npm run check:jsx` (esbuild transform check) and OpenTUI/Solid peer
  dependencies.

### Changed

- The OpenCode loader is now a plugin **package directory** at
  `~/.config/opencode/plugins/email-agent/` (`package.json`, `server.js`,
  `tui.js`) instead of an `email-agent.js` file shim. `init` migrates existing
  installs and removes the legacy file.
- README documents `/email` for the TUI and keeps `/status` as the agent's
  explanation; the CLI `dashboard` command remains for terminal use.

## [0.2.0] - 2026-10-27

### Added

- Terminal dashboard (`dashboard`, also available in OpenCode as `/status`) with
  inbox, draft, campaign, and deliverability panels plus a `--watch` mode.
- `reclassify` command to re-run deterministic triage over stored inbound mail
  without re-syncing.
- `contacts prune` to drop addresses that only ever sent newsletters or
  automated mail.
- `update [--check]` command: checks release tags, backs up the database, pulls,
  installs, re-runs `init`, restarts the service, and reports daemon health.
- Warmup ramp: per-account daily limits increase automatically day by day from a
  configurable start, increment, and maximum.
- One-click unsubscribe: signed `List-Unsubscribe` and `List-Unsubscribe-Post`
  headers plus the public `/u/:token` endpoint.
- Campaign preview with per-contact rendering and a `--dry-run` mode.
- `pause-all` and `resume-all` commands and matching agent tools.
- CHANGELOG, CI workflow, tag-driven GitHub Releases, and `UPDATING.md`.

### Changed

- Reply metrics count human replies only; automated replies, bounces, and
  newsletters no longer inflate engagement.
- Triage classifies newsletters and automated notifications without suppressing
  contacts or stopping sequences.
- Contact pruning treats machine-generated senders as noise rather than leads.
- Campaign ticks share a cross-process lock so two daemons cannot double-send.
- `init` is documented as non-destructive: edited assets are kept unless
  `--force` is passed.

### Fixed

- Opt-out detection ignores quoted history, so a reply quoting our unsubscribe
  footer is no longer treated as an unsubscribe.
- Positive replies quoting the footer remain human and keep their disposition.
- Campaign ticks no longer race when the daemon and CLI run at the same time.
- Dashboard handles a closed stdout without throwing.

## [0.1.0] - 2026-10-27

Initial release.

- Multi-account Gmail/IMAP + SMTP sending with app passwords.
- Reply tracking, thread matching, and Gmail draft replies.
- Drip campaigns with daily caps, business hours, and stop-on-reply.
- Deterministic triage, contact statuses, suppression, and consent checks.
- OpenCode plugin, agent, skill, and slash commands installed by `init`.
- SQLite store with additive migrations.
