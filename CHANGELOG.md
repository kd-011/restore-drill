# Changelog

Notable changes are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## 0.2.0 - 2026-11-03

### Fixed

Four ways a backup that could not be restored used to pass:

- A `.tar` or `.tar.gz` that stops after a complete file, with no end-of-archive marker, passed `tar -t`. It now fails with "tar has no end-of-archive marker". This is what a job that died between files, or `tar | gzip` after `tar` failed, leaves behind.
- A SQLite file that opens and passes `integrity_check` but has no tables passed when no `table_exists` or `checks` were set. It now fails with "database has no tables".
- A `pg_dump` custom-format file that was cut in half or had damaged data passed, because `pg_restore --list` only reads the table of contents. The drill now also reads the whole dump with `pg_restore -f /dev/null`, which takes as long as decompressing it.
- `restore-drill run --only name` sent the `ping_success` request when that one drill passed, which could make a dead nightly job look alive. A partial run now sends no success ping. It still sends `ping_fail`.

The README clone URL used `KD011`, which is not the account, and so returned "Repository not found". It is `kd-011` everywhere now.

### Added

- A warning on stderr when a drill passes against a backup more than 7 days old and no `max_age` is set.
- `docs/scheduling.md`: systemd timer, cron, Docker, ntfy and webhook alerts, and a healthchecks-style ping for noticing when the drill itself stops running. `examples/nightly.json` is a config to start from.
- `docs/reference.md` holds the full command, option and drill reference that used to be in the README. It also has a `command` drill recipe for plain-SQL Postgres dumps.
- `scripts/make-hero.mjs` regenerates the README terminal image from a real `restore-drill demo` run.
- The README install route that works today: `npx github:kd-011/restore-drill demo` and `npm install -g github:kd-011/restore-drill`.
- A publish workflow that releases to npm when the version in `package.json` is new. It exits quietly until the package exists on npm and an `NPM_TOKEN` secret is set. It can also be run by hand.
- Weekly Dependabot updates for GitHub Actions, grouped by minor and patch with a seven-day cooldown, and auto-merge once the required checks pass.
- A weekly upkeep workflow that checks README links and the project's dossier. It opens one issue per problem.
- A dossier for this repository, with a committed lock file.
- A security policy, a code of conduct, and issue and pull request templates.

### Changed

- CI runs on Node 22 and 24, and once a week. It installs `postgresql-client` so the `pg_dump` tests run against a real `pg_restore`.
- The commit history check now accepts commits made by Dependabot and by GitHub when it merges a pull request. Any other identity is still rejected.

## 0.1.0

First release.

- Drill types: `file`, `sqlite`, `tar` (including `.zip`), `restic`, `pg_dump` and `command`.
- Each drill finds the newest backup, restores or opens it in a private temp dir, runs its check and removes the temp dir. It never writes to the original.
- Optional `decrypt` (age, gpg) and `decompress` (gz, zst, xz) steps, and `max_age`, `min_size` and `size_drop` checks.
- Commands `run`, `status`, `report`, `init` and `demo`, with exit codes 0, 1, 2 and 130.
- Results append to `history.jsonl`. `report` writes one self-contained HTML status page.
- Notifications by webhook, healthchecks-style ping and ntfy. A failing notification never changes the exit code.
- No dependencies. Needs Node 22 or newer.
