# Contributing

Bug reports, fixes and new drill types are all welcome.

## Ground rules

- Node 22, ES modules, no npm dependencies. Use `node:` built-ins and call the real tools (`tar`, `age`, `restic`, `pg_restore`) instead of reimplementing them.
- A drill only reads its source. Anything it writes goes in the temp dir, and the temp dir is always removed. A change that weakens either of those needs a test showing it doesn't.
- Error text shown to the user is the tool's real error, with secrets redacted.
- Tests build real fixtures: a real SQLite file, a real tar.gz, a truncated one. Stub executables on `PATH` are fine for tools that are too heavy to require, such as `pg_restore`.

## Running the tests

```sh
node --test                     # everything, about half a minute
node --test test/sqlite.test.mjs   # one file while you work
```

Tests that need `age`, `restic`, `gpg`, `zstd`, `xz` or `zip` skip themselves when the binary is missing.

## Sign-off (DCO)

There is no CLA. Certify the [Developer Certificate of Origin](https://developercertificate.org/) by signing off each commit:

```sh
git commit -s -m "Fix glob matching for dotfiles"
```

That adds a `Signed-off-by:` line with your git name and email.

## Dependency updates and CI

Dependabot proposes GitHub Actions updates weekly. Patch and minor updates, and any update to an action from the `actions/` organisation, merge on their own once the required checks pass. Other major updates wait for a person. CI runs `node --test` on Node 22 and 24, and once a week so the badge shows the current state of `main`.

A weekly job checks the links in the README and runs `dossier-scribe check` against this repository's dossier in `dossiers/`. If a cited file changed, it opens one issue. To clear it, re-read the cited files, fix any claims that are no longer true, run `dossier-scribe pin` and commit the dossier and lock.

## Pull requests

Keep them small, add or update a test, and update the README when behaviour changes. Plain imperative commit messages are fine.
