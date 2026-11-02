# restore-drill

[![ci](https://github.com/kd-011/restore-drill/actions/workflows/ci.yml/badge.svg)](https://github.com/kd-011/restore-drill/actions/workflows/ci.yml)

A backup you have never restored might not work. restore-drill finds your newest backup, restores it into a throwaway temp dir, runs a sanity check and records pass or fail with a timestamp. A broken backup gets caught the night it breaks, not the day you need it.

No dependencies. It needs Node 22 and the tools you already use (`tar`, `age`, `restic`, `pg_restore`). Developed and tested on Linux. There is no daemon and no database.

![restore-drill demo: two backups pass, two broken ones fail with the real tool error](docs/screenshots/terminal.png)

## 30-second demo

```sh
git clone https://github.com/KD011/restore-drill.git
cd restore-drill
node bin/restore-drill.mjs demo
```

The demo builds four fake backups in a temp dir (a good SQLite file, a good tar.gz, a truncated tar.gz, an empty file) and runs drills over them. It prints passes and fails with the real error text, deletes everything and exits 1.

```
PASS  app-db         38ms  backup 2h old
PASS  photos         10ms  backup 5h old
FAIL  notes           4ms  tar -tf failed (exit 2): gzip: stdin: unexpected end of file / tar: Unexpected EOF in archive ...
FAIL  mail-export     0ms  backup is empty (0 bytes): ...
```

Add `--out status.html` to also get the status page from the demo data.

| Phone | Desktop |
| --- | --- |
| ![Status page on a phone](docs/screenshots/status-phone-390x844.png) | ![Status page on a desktop](docs/screenshots/status-desktop-1440x900.png) |

## Quick start

```sh
node bin/restore-drill.mjs init            # writes an annotated drills.json
# edit the paths, then:
node bin/restore-drill.mjs run
node bin/restore-drill.mjs status
node bin/restore-drill.mjs report --out status.html
```

To get a `restore-drill` command, run `npm link` in the checkout, or call the script by path.

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
| `max_age` | Fail if the newest backup is older than this. |
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

A private copy of the newest database is opened read-only, in a separate process. The original is never opened. `PRAGMA integrity_check` must return `ok`, every `table_exists` table must exist, and each check must return a number of at least `min` (default 1) from the first column of the first row. Checks run on a read-only connection, so they can't change anything.

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

Takes the newest `.tar`, `.tar.gz`, `.tgz` or `.zip`, lists it and extracts it into the temp dir. Then `expect_paths` (relative to the archive root, globs allowed) must exist and `min_files` files must have been restored. Needs `tar`, or `unzip` for zips.

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

Newest dump file (custom format; directory-format dumps are not picked up yet). `pg_restore --list` must succeed and list at least `min_entries` entries (default 1).

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

### command

For anything the other types don't cover. Your command runs with the temp dir as its working directory and `RESTORE_DRILL_TMP` set to it. It passes on exit 0. With a `source`, the newest backup is found, checked, decrypted and decompressed as above, and `RESTORE_DRILL_FILE` is a private copy of the result.

```json
{ "name": "custom", "type": "command", "source": "/backups/app/*.db",
  "command": "sqlite3 \"$RESTORE_DRILL_FILE\" 'SELECT count(*) FROM users' | grep -qv '^0$'" }
```

`command` is a string (run with `/bin/sh -c`) or an argument list that runs without a shell: `["my-check", "--strict"]`.

## Running it nightly

Run it after your backups finish. Anything that calls `restore-drill run` and watches the exit code will do.

### systemd user timer

[`examples/restore-drill.service`](examples/restore-drill.service) and [`examples/restore-drill.timer`](examples/restore-drill.timer):

```sh
cp examples/restore-drill.{service,timer} ~/.config/systemd/user/
# edit the paths in the .service file
systemctl --user daemon-reload
systemctl --user enable --now restore-drill.timer
loginctl enable-linger "$USER"      # keep it firing while logged out
systemctl --user list-timers restore-drill.timer
```

A failed run leaves the unit in the failed state, which is easy to alert on.

### cron

```cron
30 4 * * * cd /srv/restore-drill && node bin/restore-drill.mjs run --config /etc/restore-drill/drills.json --state /var/lib/restore-drill && node bin/restore-drill.mjs report --state /var/lib/restore-drill --config /etc/restore-drill/drills.json --out /var/www/status.html
```

### Docker

[`examples/Dockerfile`](examples/Dockerfile) is `node:22-alpine` with `sqlite`, `tar`, `unzip`, `zstd`, `xz`, `gnupg`, `age`, `restic` and `postgresql-client`.

```sh
docker build -f examples/Dockerfile -t restore-drill .
docker run --rm \
  -v "$PWD/drills.json:/config/drills.json:ro" \
  -v /backups:/backups:ro \
  -v restore-drill-state:/state \
  --tmpfs /tmp:size=2g \
  restore-drill
```

There is a compose version in [`examples/docker-compose.yml`](examples/docker-compose.yml). Inside the container the paths in your config are container paths.

## Notifications

All optional, under `notify` in the config. A failing notification prints a warning on stderr and never changes the exit code. Notification URLs are never printed.

| Key | Behaviour |
| --- | --- |
| `webhook` | POST JSON on each failure (`"event": "failure"`) and once when a failing drill passes again (`"event": "recovery"`). Body fields: `event`, `drill`, `ok`, `started`, `duration_ms`, `backup_path`, `backup_size`, `backup_mtime`, `error`. |
| `ping_success`, `ping_fail` | healthchecks.io style GET after each run: `ping_success` if every drill that ran passed, `ping_fail` otherwise. A missed ping on `ping_success` is what tells you the nightly run itself stopped. |
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

restore-drill proves that your newest backup restores and passes the check you gave it. It can't tell whether your check is any good. An `integrity_check` on a database that is missing last week's data still passes unless you add a row count or a freshness query. It only looks at the newest backup, not the whole history. Restic's `--read-data-subset` samples the repository, so a very small corrupt region can be missed on any single night, though you can configure a different subset. `size_drop` compares file sizes and only catches big drops.

Left out on purpose: a web server or daemon, a results database, accounts, cloud storage backends beyond what the restic binary handles, and Windows support.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Sign-off (DCO), no CLA. `node --test` runs the suite.

## Licence

MIT, see [LICENSE](LICENSE).
