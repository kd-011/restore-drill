---
slug: restore-drill-agents
name: restore-drill agent guide
repo: .
status: active
last_verified: 2026-11-22
---

# restore-drill: guide for coding agents

The doc index is docs/README.md. Read docs/ARCHITECTURE.md before changing structure. The README stands in as the product requirements.

## Commands

- Install: nothing to install, the package has no dependencies. <!-- src: package.json -->
- Test everything: `node --test`. <!-- src: package.json:15 -->
- Test one file while working: `node --test test/sqlite.test.mjs`. <!-- src: CONTRIBUTING.md:13-17 -->
- Run the CLI from the checkout: `node bin/restore-drill.mjs <run|status|report|init|demo>`. `demo` builds fake backups in a temp dir and exits 1 on purpose. <!-- src: bin/restore-drill.mjs, src/cli.mjs:35-41, src/demo.mjs:54-105 -->
- There is no lint, format or typecheck script. <!-- src: package.json:15 -->
- Dry-run the release plan without touching npm or GitHub: `node scripts/release.mjs plan --published 0.1.0,0.2.0 --release-exists false`. <!-- src: scripts/release.mjs:1-12, scripts/release.mjs:33-35 -->
- Regenerate the README terminal image from a real demo run (needs a Chromium-family browser): `node scripts/make-hero.mjs`. <!-- src: scripts/make-hero.mjs:1-4 -->
- Docs drift check: `dossier-scribe lint`, then `dossier-scribe check`, run from the repo root. `pin` after fixing claims. <!-- src: dossier-scribe.json, .github/workflows/upkeep.yml:62-70 -->

## Conventions

- Node 22 or newer, ES modules, no npm dependencies. Use `node:` built-ins and call the real tools (`tar`, `age`, `restic`, `pg_restore`) rather than reimplementing them. <!-- src: CONTRIBUTING.md:7, package.json:14 -->
- A drill only reads its source. Anything it writes goes in its temp dir, and the temp dir is always removed. A change that weakens either needs a test showing it does not. <!-- src: CONTRIBUTING.md:8 -->
- Error text shown to the user is the tool's real error with secrets redacted. <!-- src: CONTRIBUTING.md:9 -->
- Tests build real fixtures (a real SQLite file, a real tar.gz, a truncated one). Stub executables on `PATH` are fine for heavy tools such as `pg_restore`. <!-- src: CONTRIBUTING.md:10 -->
- Layout: `src/cli.mjs` is the command entry, `src/runner.mjs` runs drills, one module per drill type in `src/drills/`, shared backup steps in `src/steps.mjs`, helpers in `src/util.mjs`, tests in `test/`, shared fixtures in `test-support/helpers.mjs`. <!-- src: src/cli.mjs, src/runner.mjs:14, src/steps.mjs:1-2, src/util.mjs:1-5, test-support/helpers.mjs:1-2 -->
- A drill module exports `run(drill, ctx)` and throws a `DrillError` with a message fit to show as is. <!-- src: src/drills/command.mjs:5-16, src/util.mjs:6-7 -->
- Contributions are signed off (`git commit -s`, DCO), PRs stay small, add or update a test, and update the README when behaviour changes. <!-- src: CONTRIBUTING.md:21-39, .github/PULL_REQUEST_TEMPLATE.md -->
- A version bump is a PR with a `## x.y.z` CHANGELOG section and `npm version <patch|minor|major> --no-git-tag-version`. <!-- src: .github/workflows/publish.yml:1-6 -->

## Traps

- `test/hygiene.test.mjs` scans every tracked and untracked, non-ignored text file for an em dash, the strings for a personal mail domain and a home-directory path, and a hashed personal name. Keep all of those out of docs and fixtures. <!-- src: test/hygiene.test.mjs:14-23, test/hygiene.test.mjs:43-62 -->
- The same file checks every commit: author must be `kd-011` or `KD011` with a `users.noreply.github.com` email, and a message containing `claude`, `anthropic`, `co-authored-by` or `generated with` fails. Do not add AI attribution trailers to commits here. <!-- src: test/hygiene.test.mjs:41, test/hygiene.test.mjs:67-86 -->
- `.restore-drill/` is not in `.gitignore`, and the default state directory is `.restore-drill` in the working directory. Running `run` from the repo root leaves an untracked `history.jsonl` that the hygiene scan then reads. Run from a temp dir or pass `--state`. <!-- src: .gitignore, src/cli.mjs:46-50, test/hygiene.test.mjs:43-49 -->
- A new drill option must be added to that type's `keys` in `src/config.mjs`, or the config is rejected as an unknown option. Add it to `DEFAULTABLE` only if `defaults` may set it. <!-- src: src/config.mjs:12-28, src/config.mjs:94 -->
- `examples/drills.json` must equal `EXAMPLE_CONFIG` in `src/example-config.mjs`, and `restore-drill init` writes that object. Change both together. <!-- src: test/examples.test.mjs:11-15, src/cli.mjs:135-143 -->
- `size_drop` compares against the last passing run, not the last run, so a broken small backup cannot become the new normal. <!-- src: src/runner.mjs:118-120, src/steps.mjs:29-31 -->
- A run limited with `--only` never sends `ping_success` when it passes, so a hand test cannot make a dead nightly job look alive. It still sends `ping_fail`. <!-- src: src/runner.mjs:133-135 -->
- The SQLite check runs in a child process (`src/sqlite-worker.mjs`) so a hung call can be killed on timeout. The same file builds the demo database in `make` mode. <!-- src: src/drills/sqlite.mjs:5-16, src/sqlite-worker.mjs:1-3 -->
- Child processes start detached in their own process group and are killed with the drill. Signal and exit handlers remove live temp dirs. New code that spawns tools should go through `exec` in `src/util.mjs`, not `child_process` directly. <!-- src: src/util.mjs:222-230, src/util.mjs:241-289, src/runner.mjs:99-112 -->
- `ci.yml` job names are the required status checks in `.github/rulesets/main.json`. Renaming the matrix or the job leaves a required check that never reports. The Dependabot auto-merge workflow merges at once if the ruleset has no required check. <!-- src: .github/workflows/ci.yml:16-24, .github/rulesets/main.json:13-20, .github/workflows/dependabot-automerge.yml:1-4 -->
- `publish.yml` runs on any push to `main` that touches `package.json`, so a version bump is a release. It ends green without publishing until the package is on npm or `NPM_TOKEN` is set. <!-- src: .github/workflows/publish.yml:21-25, .github/workflows/publish.yml:51-62 -->
- Tests that need `age`, `restic`, `gpg`, `zstd`, `xz`, `zip` or `jq` skip when the binary is missing, so a green local run can skip drill types that CI exercises. <!-- src: test/steps.test.mjs:30, test/tar.test.mjs:94, test/kit.test.mjs:179, .github/workflows/ci.yml:32-33 -->
- Cite `package.json` by line, not `#key`. `upkeep.yml` installs `dossier-scribe` v0.1.0, and its `lint` rejects `#key` specs as paths that do not exist. Bump the tag in a reviewed change before using them. <!-- src: .github/workflows/upkeep.yml:62 -->

## Unverified

None.

<!-- auto:start -->
- package: restore-drill 0.2.0
- npm scripts (1): test
<!-- auto:end -->
