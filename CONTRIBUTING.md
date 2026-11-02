# Contributing

Bug reports, fixes and new drill types are welcome.

## Ground rules

- Node 22, ES modules, **zero npm dependencies**. Use `node:` built-ins and invoke real tools (`tar`, `age`, `restic`, `pg_restore`) rather than reimplementing them.
- A drill only ever reads its source. Anything it needs to write goes in the temp dir, and the temp dir is always removed. Changes that weaken either guarantee need a test that proves they do not.
- Error text shown to the user is the real error from the tool, with secrets redacted.
- Tests use real fixtures built in the test (a real SQLite file, a real tar.gz, a truncated one). Stub executables on `PATH` are fine for tools that are too heavy to require, such as `pg_restore`.

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

That adds a `Signed-off-by:` line using your git name and email.

## Dependency updates and CI

Dependabot proposes GitHub Actions updates weekly. Patch and minor updates, and any update to an action from the `actions/` organisation, merge on their own once the required checks pass. Other major updates wait for a person. CI runs `node --test` on Node 22 and 24, and also once a week so the badge reflects the real state of `main`.

A weekly job checks the links in the README and runs `dossier-scribe check` against this repository's own dossier in `dossiers/`. If a cited file changed, it opens one issue. To clear it, re-read the cited files, fix the claims that are no longer true, run `dossier-scribe pin` and commit the dossier and lock.

## Pull requests

Keep them small and focused, add or update a test, and keep the README in step with behaviour changes. Plain commit messages in the imperative mood are fine.
