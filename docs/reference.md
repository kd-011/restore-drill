# Reference

Every command, option and drill type. For running it on a schedule, see [scheduling.md](scheduling.md).

## Commands

| Command | What it does |
| --- | --- |
| `run [--config drills.json] [--only name] [--json] [--state dir]` | Run every drill (or the named ones, repeatable), print one line each, append results to the state dir. |
| `status [--config] [--state]` | Table of each drill's last result, how long ago it last passed, and the current streak. |
| `report [--out status.html] [--config] [--state]` | Write one static, self-contained HTML page. Dark, phone-first, no external requests. A failing row expands to show the error. |
| `init [--out drills.json] [--force]` | Write an annotated example config. Refuses to overwrite without `--force`. |
| `demo [--out status.html]` | Run drills over fake backups so you see a pass and a fail with no setup. |

The state directory defaults to `./.restore-drill/`. Override it with `--state` or `"state"` in the config. Results go to `<state>/history.jsonl`, one JSON line per drill per run.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every drill passed. |
| 1 | At least one drill failed (or restore-drill itself crashed, which is reported as a failure on purpose). |
| 2 | Config or usage error. Nothing was run. |
| 130 | Interrupted with Ctrl-C. Temp dirs were removed first. |

## Configuration

The config is JSON (`drills.json`), because Node has no YAML parser and this project has no dependencies. JSON has no comments, so any key that starts with an underscore (`"_comment"`) is ignored at every level. Relative paths in the config resolve against the config file, not the working directory. `restore-drill init` writes an annotated example, which is also in [`examples/drills.json`](examples/drills.json).

```json
{
  "state": "/var/lib/restore-drill",
  "defaults": { "timeout": "10m", "max_age": "26h" },
  "notify": { "ntfy": "https://ntfy.sh/my-private-topic" },
  "drills": [
    { "name": "app-db", "type": "sqlite", "source": "/backups/app/*.db" }
  ]
}
```

`defaults` apply to every drill that supports the option. Unknown options are an error (exit 2), so a typo like `max_ag` cannot silently disable a check.

### Options shared by every drill

| Option | Meaning |
| --- | --- |
| `name` | Unique, short, plain. |
| `type` | `file`, `sqlite`, `tar`, `restic`, `pg_dump` or `command`. |
| `timeout` | Kill the drill after this long. Default `30m`. Child processes are killed too. |
| `retries`, `retry_delay` | Extra attempts after a failure (0 to 10, default 0) and the pause between them (default `5s`). Only the final outcome is recorded. |

Durations are `90s`, `30m`, `26h`, `2d`, `1h30m` or a bare number of seconds. Sizes are `500`, `10KB`, `2MB`, `1GiB` (1024-based).

### Options for drills that read a backup file

`file`, `sqlite`, `tar`, `pg_dump`, and `command` when it has a `source`.

| Option | Meaning |
| --- | --- |
| `source` | A path or glob (`*`, `?`, `[a-z]`, `**`) in any path segment. The newest regular file by mtime wins. A plain directory means "the files in it". |
| `max_age` | Fail if the newest backup is older than this. Set it. Without it, a backup job that stopped months ago still passes, because the old backup still restores. A passing drill with no `max_age` and a backup over 7 days old prints a warning on stderr. |
| `min_size` | Fail if smaller than this. |
| `size_drop` | Fail if smaller than this percent of the last passing run's size. Default `50`, `0` turns it off. The baseline is the last *passing* run, so a broken small backup cannot become the new normal. |
| `decrypt` | `{ "type": "age", "identity": "key.txt" }` or `{ "type": "gpg", "passphrase_file": "pass.txt", "homedir": "..." }`. |
| `decompress` | `true` (pick by extension: `.gz`, `.zst`, `.xz`, `.tgz`) or force `"gz"`, `"zst"`, `"xz"`. |

The order of work is: find, check existence, size and age, decrypt, decompress, then the drill's own check. Decrypt and decompress write into the temp dir, and the original is never touched. `age`, `gpg`, `zstd` and `xz` are run as binaries. If one is missing, that drill fails with an error like `age not found in PATH (needed to decrypt age backups)`.

## Drill types

### file

Checks that the newest match exists, is non-empty, is recent and hasn't collapsed in size. Use it for anything you can't open but can at least watch.

```json
{ "name": "app-dump", "type": "file", "source": "/backups/app/*.sql.gz",
  "max_age": "26h", "min_size": "10KB", "size_drop": 50 }
```

### sqlite

A private copy of the newest database is opened read-only, in a separate process. The original is never opened. `PRAGMA integrity_check` must return `ok`, the database must contain at least one table (an empty database passes `integrity_check`, and is what you get when a backup script points at the wrong file), every `table_exists` table must exist, and each check must return a number of at least `min` (default 1) from the first column of the first row. Checks run on a read-only connection, so they can't change anything.

```json
{ "name": "app-db", "type": "sqlite", "source": "/backups/app/*.db", "max_age": "26h",
  "table_exists": ["users", "orders"],
  "checks": [{ "sql": "SELECT count(*) FROM users", "min": 100 }] }
```

Nightly backups are often encrypted and compressed:

```json
{ "name": "vault-db", "type": "sqlite", "source": "/backups/vault/*.db.gz.age",
  "decrypt": { "type": "age", "identity": "/etc/restore-drill/age-identity.txt" },
  "decompress": true }
```

### tar

Takes the newest `.tar`, `.tar.gz`, `.tgz` or `.zip`, lists it and extracts it into the temp dir. For `.tar` and `.tar.gz` it also checks that the archive ends with tar's end-of-archive marker. `tar -t` is happy with an archive that stops after any complete file, so without this check a job that died between files would pass. Then `expect_paths` (relative to the archive root, globs allowed) must exist and `min_files` files must have been restored. Needs `tar`, or `unzip` for zips.

```json
{ "name": "site-files", "type": "tar", "source": "/backups/site/*.tar.gz",
  "expect_paths": ["config/app.json", "uploads/*"], "min_files": 10 }
```

### restic

Runs `restic restore latest --target <temp>` (with `--include` for each `include` entry), requires `expect_paths`, then `restic check --read-data-subset` (default `5%`). Everything runs with `--no-lock`, so a read-only repository works and nothing is written to it. The snapshot time is recorded as the backup time, so `max_age` works.

The password comes from `password_file`, from the environment variable named in `password_env`, or from `RESTIC_PASSWORD`, `RESTIC_PASSWORD_FILE` or `RESTIC_PASSWORD_COMMAND`. Passwords are never printed, and credentials in repository URLs are masked in output and history. Paths are as stored in the snapshot, without the leading slash, because restic restores the full original path under the target.

```json
{ "name": "nas-restic", "type": "restic", "source": "/mnt/nas/restic-repo",
  "password_file": "/etc/restore-drill/restic-password",
  "include": ["/srv/app"], "expect_paths": ["srv/app/config.json"],
  "read_data_subset": "5%", "max_age": "26h" }
```

Restores land in the OS temp dir (`TMPDIR`). Point `TMPDIR` somewhere with room, or use `include` to restore only the paths you check.

### pg_dump

Newest dump file (custom format; plain SQL and directory-format dumps are not picked up, see [plain SQL dumps](#plain-sql-dumps)). `pg_restore --list` must succeed and list at least `min_entries` entries (default 1). `--list` only reads the table of contents at the front of the file, so a dump cut in half still lists. restore-drill then reads the whole dump with `pg_restore -f /dev/null`, which catches truncation and damaged compressed data. That takes as long as decompressing the dump.

```json
{ "name": "postgres", "type": "pg_dump", "source": "/backups/postgres/*.dump",
  "max_age": "26h", "min_entries": 20 }
```

With `restore_url`, the dump is also restored for real: restore-drill connects to that server, creates a database with a random name (`restore_drill_<random>`), runs `pg_restore` into it, runs optional `restore_checks` (same `{ sql, min }` shape, via `psql`), and always drops the database again. Point `restore_url` at a scratch server. The source database is never named or touched, and the password travels in `PGPASSWORD`, not on the command line. If the process is killed mid-restore, a `restore_drill_*` database may remain on the scratch server.

```json
{ "name": "postgres-full", "type": "pg_dump", "source": "/backups/postgres/*.dump",
  "restore_url": "postgres://scratch:secret@scratch-host:5432/postgres",
  "restore_checks": [{ "sql": "SELECT count(*) FROM users", "min": 1 }] }
```

Needs `pg_restore`, plus `psql` for `restore_url`.

#### Plain SQL dumps

`pg_dump` without `-Fc` writes plain SQL, which `pg_restore` refuses ("input file appears to be a text format dump"). The drill fails with that message. To drill a `.sql.gz` against a scratch server, use a `command` drill:

```json
{ "name": "postgres-plain", "type": "command", "source": "/backups/postgres/*.sql.gz", "decompress": true,
  "command": "tail -c 300 \"$RESTORE_DRILL_FILE\" | grep -q 'PostgreSQL database dump complete' || { echo 'dump is cut short: no completion marker' >&2; exit 1; }; psql -X -v ON_ERROR_STOP=1 -d scratch_db -f \"$RESTORE_DRILL_FILE\" >/dev/null && psql -X -tA -d scratch_db -c 'SELECT count(*) FROM users' | grep -qv '^0$'" }
```

The completion marker check is there because a plain dump cut at a statement boundary restores without any error. `scratch_db` has to be empty, and you recreate it before each run. I ran this against Postgres 16 with a good dump and a cut one; it is not tested on other setups.

### command

For anything the other types don't cover. Your command runs with the temp dir as its working directory and `RESTORE_DRILL_TMP` set to it. It passes on exit 0. With a `source`, the newest backup is found, checked, decrypted and decompressed as above, and `RESTORE_DRILL_FILE` is a private copy of the result.

```json
{ "name": "custom", "type": "command", "source": "/backups/app/*.db",
  "command": "sqlite3 \"$RESTORE_DRILL_FILE\" 'SELECT count(*) FROM users' | grep -qv '^0$'" }
```

`command` is a string (run with `/bin/sh -c`) or an argument list that runs without a shell: `["my-check", "--strict"]`.

## Notifications

All optional, under `notify` in the config. A failing notification prints a warning on stderr and never changes the exit code. Notification URLs are never printed.

| Key | Behaviour |
| --- | --- |
| `webhook` | POST JSON on each failure (`"event": "failure"`) and once when a failing drill passes again (`"event": "recovery"`). Body fields: `event`, `drill`, `ok`, `started`, `duration_ms`, `backup_path`, `backup_size`, `backup_mtime`, `error`. |
| `ping_success`, `ping_fail` | healthchecks.io style GET after each run: `ping_success` if every drill that ran passed, `ping_fail` otherwise. A missed ping on `ping_success` is what tells you the nightly run itself stopped. A run limited with `--only` never sends `ping_success`, so testing one drill by hand cannot make a dead nightly job look alive. It still sends `ping_fail`. |
| `ntfy` | POST a plain-text message to an ntfy topic URL on failure and on recovery. |

## What gets recorded

Each result is one line in `<state>/history.jsonl`:

```json
{"drill":"app-db","ok":true,"started":"2026-01-01T04:30:01.120Z","duration_ms":412,"backup_path":"/backups/app/app-2026-01-01.db","backup_size":1048576,"backup_mtime":"2026-01-01T02:00:03.000Z","error":null}
```

`status` and `report` read this file. Delete lines (or the file) to reset a drill's baseline, for example after a backup legitimately shrinks.

## Safety guarantees

- Sources are read-only. A drill never opens, writes, renames or deletes the original. Checks that need to open a file work on a private copy in the temp dir. The restic drill uses `--no-lock`, so it doesn't even write lock files to the repository. Tests hash the backup directory before and after the sqlite, tar, file and command drills, and run them against a read-only directory.
- Temp dirs are private and always removed. Each attempt gets its own directory under the OS temp dir (`TMPDIR`), mode 700, removed on success, on failure, on timeout, and on Ctrl-C or SIGTERM. Child processes run in their own process group and are killed with the drill.
- Secrets are masked. Credentials in URLs and known secret values (restic password, database password) are masked in output and in `history.jsonl`. Notification URLs never appear in output.
- A failed drill shows the real error text from `tar`, `restic`, SQLite and the rest.

## Limits

restore-drill proves that your newest backup restores and passes the check you gave it. It can't tell whether your check is any good. An `integrity_check` on a database that is missing last week's data still passes unless you add a row count or a freshness query. It only looks at the newest backup, not the whole history. Restic's `--read-data-subset` samples the repository, so a very small corrupt region can be missed on any single night, though you can configure a different subset. `size_drop` compares file sizes and only catches big drops. "Newest" and `max_age` go by file modification time, so a copy that resets the time makes an old backup look new.

There is no Borg drill, and I have not tried Borg from a `command` drill.

Left out on purpose: a web server or daemon, a results database, accounts, cloud storage backends beyond what the restic binary handles, and Windows support.

