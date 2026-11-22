# restore-drill: decisions

Why the project is the way it is, newest first. One entry per decision: the date it was made, what was decided, and why. Entries are records: when a decision stops being true, leave it and add `Superseded YYYY-MM-DD: <what replaced it>.` to its end, then add the new decision above.

The dossier had no Decisions section to copy. These entries come from the CHANGELOG, the workflow comments, CONTRIBUTING.md and the commit history, and each was checked against the code on 2026-11-22. Dates are the commit that introduced the thing.

- 2026-11-03: A run limited with `--only` sends no `ping_success`, but still sends `ping_fail`. Why: testing one drill by hand must not make a dead nightly job look alive. See CHANGELOG 0.2.0 and `src/runner.mjs`.
- 2026-11-03: A tar must end with the end-of-archive marker, a SQLite file must hold a table, and a `pg_dump` file is read in full with `pg_restore -f /dev/null`. Why: `tar -t`, `integrity_check` and `pg_restore --list` each pass a backup that cannot be restored. See CHANGELOG 0.2.0.
- 2026-11-03: The publish workflow ends green with a notice until the package is on npm or `NPM_TOKEN` is set. Why: a merge must never leave a red run on `main` while npm is not set up. See the header of `.github/workflows/publish.yml`.
- 2026-11-03: Release logic lives in `scripts/release.mjs`, not in the workflow YAML. Why: it can be tested without a runner, and it refuses a version older than the newest on npm because `npm publish` would move `latest` to it.
- 2026-11-02: Dependabot PRs auto-merge only for patch and minor npm updates and for any `actions/` update, and only once the required checks pass. Why: other majors need a person, and without the required-check ruleset auto-merge would merge at once. See `.github/scripts/automerge-eligible.mjs` and `.github/workflows/dependabot-automerge.yml`.
- 2026-11-02: The weekly upkeep job installs `dossier-scribe` from a release tag, never a branch. Why: the workflow comment says a bump must be a reviewed change. See `.github/workflows/upkeep.yml`.
- 2026-11-02: Published text is plain prose with no Claude attribution, and commits carry no AI trailers. Why: the repo is public under the `kd-011` identity and nothing personal or tool-generated may be in the tree or history. See `test/hygiene.test.mjs`.
- 2026-11-01: The config is JSON, with keys starting with an underscore ignored as comments. Why: Node has no YAML parser and the project has no dependencies. See `docs/reference.md`.
- 2026-11-01: The config rejects every unknown option. Why: a typo such as `max_ag` must not silently disable a check. See `src/config.mjs`.
- 2026-11-01: `size_drop` compares with the last passing run, not the last run. Why: a broken small backup must not become the new normal. See `docs/reference.md`.
- 2026-11-01: The SQLite check runs in a separate process on a private copy opened read-only. Why: a hung or crashing SQLite call can be killed on timeout, and the original is never opened. See `src/sqlite-worker.mjs`.
- 2026-11-01: Drills only read their source, work in a private temp dir with mode 700, and always remove it, including on Ctrl-C and SIGTERM. Why: the rule is in CONTRIBUTING.md, and a change that weakens it needs a test. The reasoning is not written down beyond that.
- 2026-11-01: A failed notification never changes the exit code. Why: not written down beyond the rule itself. See CHANGELOG 0.1.0.
- 2026-11-01: Zero dependencies, Node 22 or newer, and drills call the real tools (`tar`, `age`, `restic`, `pg_restore`) instead of reimplementing them. Why: the README says drills call the tools you already have, so there is nothing to install. See README.md and CONTRIBUTING.md.
- 2026-11-01: Built to be published open source (MIT) from day one, under the `kd-011` GitHub identity. Why: not written down beyond that. See `LICENSE` and `test/hygiene.test.mjs`.
