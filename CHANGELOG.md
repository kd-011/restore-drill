# Changelog

Notable changes are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [semantic versioning](https://semver.org/).

## Unreleased

### Added

- Weekly Dependabot updates for GitHub Actions, grouped by minor and patch with a seven-day cooldown, and auto-merge once the required checks pass.
- A weekly upkeep workflow that checks README links and the project's dossier. It opens one issue per problem.
- A dossier for this repository, with a committed lock file.
- A security policy, a code of conduct, and issue and pull request templates.

### Changed

- CI runs on Node 22 and 24, and once a week.
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
