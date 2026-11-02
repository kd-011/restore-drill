---
slug: restore-drill
name: restore-drill
repo: .
status: active
last_verified: 2026-11-02
tags: [cli, node, backups]
---

A command line tool that restores your newest backup into a temp dir, checks it and records pass or fail. These claims are the README's main promises, each tied to the code that keeps it.

## Features

- Runs on Node 22 or newer and installs one command, `restore-drill`. <!-- src: package.json:12, package.json:14 -->
- Has no runtime or development dependencies, only Node built-ins. <!-- src: package.json -->
- Treats any config key starting with an underscore as a comment and rejects every other unknown option, so a typo cannot silently disable a check. <!-- src: src/config.mjs:36-42 -->
- `size_drop` defaults to 50 percent and compares the backup with the last passing run, not the last run. <!-- src: src/config.mjs:33, src/steps.mjs:29-31, src/history.mjs:46 -->
- The SQLite drill opens a private copy of the backup read-only, in a separate process. <!-- src: src/drills/sqlite.mjs:14-18, src/sqlite-worker.mjs:17 -->
- The restic drill runs with `--no-lock` and samples 5 percent of the repository data by default. <!-- src: src/drills/restic.mjs:28, src/drills/restic.mjs:63 -->
- With `restore_url`, the pg_dump drill restores into a database named `restore_drill_` plus random hex, passes the password in `PGPASSWORD`, and drops the database afterwards. <!-- src: src/drills/pg_dump.mjs:13, src/drills/pg_dump.mjs:23, src/drills/pg_dump.mjs:63-68 -->
- `run` exits 0 when every drill passed and 1 when any failed. <!-- src: src/cli.mjs:94-96 -->

## Architecture

- Every attempt gets its own temp dir under the OS temp dir with mode 700. <!-- src: src/util.mjs:215-217 -->
- Ctrl-C and SIGTERM remove the temp dirs first and exit 130 and 143. <!-- src: src/runner.mjs:92-98, src/util.mjs:231 -->
- Results go to `history.jsonl` in the state directory, which defaults to `.restore-drill` in the working directory. <!-- src: src/history.mjs:4, src/cli.mjs:46-50 -->

## Deploy

- CI runs `node --test` on Node 22 and 24 for every pull request and once a week. <!-- src: .github/workflows/ci.yml:9-10, .github/workflows/ci.yml:24 -->
- Dependabot opens grouped weekly updates for GitHub Actions and qualifying ones merge automatically once CI is green. <!-- src: .github/dependabot.yml, .github/scripts/automerge-eligible.mjs -->

<!-- auto:start -->
- package: restore-drill 0.1.0
- npm scripts (1): test
<!-- auto:end -->
