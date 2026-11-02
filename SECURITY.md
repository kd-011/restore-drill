# Security

## Reporting a vulnerability

Please use GitHub private vulnerability reporting. Open the Security tab of this repository and choose "Report a vulnerability". The report stays private until a fix is out. Don't open a public issue for something exploitable.

Say what you ran, what you expected and what happened. A drill config that reproduces it helps most. Take out real passwords and hostnames first.

## What is in scope

restore-drill reads backups and writes only into a private temp dir and its own state directory. It runs the tools you point it at. These are the areas worth a look:

- Anything that makes a drill write to, rename or delete the backup it reads, or leave the temp dir behind.
- Secrets (restic passwords, database passwords, credentials in repository or notification URLs) appearing in output, in `history.jsonl` or in the HTML report.
- Path and glob handling in `source` and `expect_paths`, including `..` segments and symlinks.
- The `command` drill, which runs a command you supply, and the `restore_url` option of `pg_dump`, which creates and drops a scratch database.
- The HTML report, which should escape everything taken from a config or a tool's error text.

## Supported versions

Only the latest release gets fixes. The project is small and has no runtime dependencies.
