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

## Pull requests

Keep them small and focused, add or update a test, and keep the README in step with behaviour changes. Plain commit messages in the imperative mood are fine.
