# Updating

This project ships two ways: a git checkout (the recommended install) and, later,
the npm registry. The update path depends on which one you have.

## For users

### Check for a newer release

```bash
opencode-email-agent update --check
```

This fetches tags and reports whether a newer release exists, with its changelog
section. It never modifies files, never pulls, and never restarts the daemon. Safe
to run any time.

### Update

```bash
opencode-email-agent update
```

From a git checkout, `update`:

1. Refuses to touch a dirty tree. Any modified or untracked file is listed and the
   update aborts; your changes are never discarded.
2. Backs up the database to `~/.local/share/opencode/email-agent/agent.db.bak-<timestamp>`
   (or under `EMAIL_AGENT_DATA` when set).
3. Runs `git pull --ff-only`, so it never rewrites history and never force-pulls.
4. Runs `npm install --omit=dev --no-audit --no-fund`.
5. Runs `node src/cli.js init`, which is non-destructive: edited agents, skills,
   and commands are kept unless you pass `--force`.
6. Reinstalls the login service on macOS (launchd) and Linux (systemd), which
   restarts the daemon. Other platforms stop the daemon and tell you to start it
   yourself.
7. Waits a few seconds, then probes `http://127.0.0.1:8787/health` and reports
   healthy or unhealthy.
8. Prints `Updated vX → vY` plus the matching `CHANGELOG.md` section.

Nothing is published and no email is sent by an update.

### If you installed from npm

`update` detects a non-git install and prints:

```bash
npm i -g opencode-email-agent@latest
opencode-email-agent service install
```

Run both. The first replaces the package, the second points the service at the
new install and restarts it.

### Manual fallback

```bash
cd ~/opencode-email-agent
git pull --ff-only
npm install --omit=dev
node src/cli.js init
opencode-email-agent service install     # or: node src/cli.js service install
curl -s http://127.0.0.1:8787/health
```

### Where backups live

- Database: `${EMAIL_AGENT_DATA:-~/.local/share/opencode/email-agent}/agent.db.bak-<timestamp>`
- Edited assets replaced with `init --force`: alongside the destination file,
  with a `.bak-<timestamp>` suffix.
- OpenCode config edited by `init`: `opencode.json.bak`.

Back up the config directory (`~/.config/opencode/email-agent`) too: the database
can be rebuilt from IMAP, but campaign history and notes cannot.

### If the daemon does not come back

```bash
opencode-email-agent service status
opencode-email-agent doctor
tail -n 50 ~/.local/share/opencode/email-agent/daemon.log
```

Then reinstall the service:

```bash
opencode-email-agent service install
```

If that fails, run the daemon in the foreground to see the error:

```bash
opencode-email-agent daemon
```

Roll back with `git checkout v<previous>` (or `git reset --hard v<previous>` on a
clean tree), `npm install`, `init`, and `service install`. Restore the database
from the `.bak-<timestamp>` file only if the schema migration is the problem.

## For maintainers

### Semantic versioning policy

- **Patch** (`0.2.0 → 0.2.1`): bug fixes and documentation only. No config keys,
  database columns, CLI flags, or tool schemas change.
- **Minor** (`0.2.0 → 0.3.0`): new features, new config keys with defaults, new
  CLI commands or flags, additive database columns. Existing installs keep
  working without edits.
- **Major** (`0.2.0 → 1.0.0`): breaking changes to config, database, HTTP API, or
  agent tool schemas; removed commands or renamed settings.

The version lives in two places and they must match: `package.json` and
`src/version.js`. `update` reads `src/version.js` first and falls back to
`package.json`.

### Release checklist

1. `npm test` is green and `node --check $(find src -name '*.js')` passes.
2. Add a `CHANGELOG.md` entry under `## [x.y.z] - YYYY-MM-DD` with Added /
   Changed / Fixed sections. `update` prints this exact block after upgrading.
3. Bump the version and the lockfile:

   ```bash
   npm version 0.2.1 --no-git-tag-version
   npm install --package-lock-only
   # update VERSION in src/version.js to match
   ```

4. Commit, then tag and push both branches and tags:

   ```bash
   git add -A
   git commit -m "Release v0.2.1"
   npm version 0.2.1          # creates the v0.2.1 tag
   git push --follow-tags
   ```

   `npm version` bumps `package.json`, writes the lockfile, and creates an
   annotated tag. Remember to keep `src/version.js` in sync (or bump both by hand
   and `git tag -a v0.2.1 -m "v0.2.1"`).
5. The tag push triggers `.github/workflows/release.yml`, which runs the tests and
   creates a GitHub Release with generated notes. Every push (and pull request)
   runs `.github/workflows/ci.yml`.

Tags drive GitHub Releases. CI runs on every push; the release workflow runs only
for tags matching `v*`.

### Database migration rules

- Migrations are **additive only**: add tables, columns, and indexes. Do not drop
  or rename columns in a release.
- Every schema change goes through `migrate()` in `src/store.js`, using the
  existing `add(table, column, definition)` helper so old databases upgrade in
  place on first open.
- New columns must be nullable or have a default, because existing rows are not
  rewritten.
- Test against a copy of an old database before tagging.

### Asset rules

- `init` is non-destructive by design: it writes missing assets, leaves identical
  files alone, and keeps edited files, printing `kept ... (differs; use --force
  to replace)`.
- Use `--force` only when intentionally replacing user-visible agents, skills, or
  commands. `init --force` writes `.bak-<timestamp>` copies first.
- `update` always runs `init` without `--force`, so local customisations survive.

### Publishing to npm later

The package name `opencode-email-agent` is available, and `package.json` is
already set up for it (`bin`, `exports`, `files`). When ready:

```bash
npm login
npm publish --access public
```

Then verify a clean install in a scratch directory and that
`opencode-email-agent update` reports the npm path on a non-git install. Do not add
`npm publish` to CI: releases are cut by tag here, and publishing stays manual.
