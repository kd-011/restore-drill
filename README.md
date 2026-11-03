# restore-drill

[![ci](https://github.com/kd-011/restore-drill/actions/workflows/ci.yml/badge.svg)](https://github.com/kd-011/restore-drill/actions/workflows/ci.yml)

restore-drill takes your newest backup, restores it into a throwaway temp directory, runs a check you chose, and records pass or fail. A backup that stops restoring gets caught the night it breaks.

![restore-drill demo: two backups pass, two broken ones fail with the real tool error](docs/screenshots/terminal.png)

## Try it

Needs Node 22 or newer. Nothing is installed or configured:

```sh
npx github:kd-011/restore-drill demo
```

It builds four fake backups in a temp dir (a good SQLite file, a good tar.gz, a truncated tar.gz, an empty file), runs drills over them, prints the real tool errors, deletes everything and exits 1.

## Install

```sh
npm install -g github:kd-011/restore-drill
restore-drill --version
```

It is not on the npm registry yet. There are no dependencies and no daemon. Drills call the tools you already have (`tar`, `age`, `restic`, `pg_restore`). SQLite uses Node's built-in module. I develop and test it on Linux.

## Use it on your backups

```sh
restore-drill init        # writes an annotated drills.json
# edit the paths, then:
restore-drill run
restore-drill status
```

A config is a list of drills. This one restores the newest SQLite backup, decrypts and decompresses it first, and fails if it has no `users` table or fewer than 100 rows:

```json
{
  "defaults": { "max_age": "26h" },
  "drills": [
    {
      "name": "app-db",
      "type": "sqlite",
      "source": "/backups/app/*.db.gz.age",
      "decrypt": { "type": "age", "identity": "/etc/restore-drill/age-identity.txt" },
      "decompress": true,
      "table_exists": ["users"],
      "checks": [{ "sql": "SELECT count(*) FROM users", "min": 100 }]
    }
  ]
}
```

Set `max_age`. Without it, a backup job that stopped last spring still passes, because the old backup still restores.

Drill types: `sqlite`, `tar` (also `.zip`), `restic`, `pg_dump`, `file` (exists, recent, not much smaller than last time) and `command` (your own check, passes on exit 0). Exit codes: 0 all passed, 1 a drill failed, 2 config error.

Each drill type, every option and the exit codes are in [docs/reference.md](docs/reference.md).

## Run it every night

A timer, an alert when a backup does not restore, and an alert when the drill itself stops running: [docs/scheduling.md](docs/scheduling.md). There is a systemd timer, a cron line, a Dockerfile, ntfy and webhook alerts, and healthchecks-style pings. `restore-drill report --out status.html` writes a static status page from the same history.

## What it catches

I made broken versions of each backup type and ran them. These all fail, with the tool's own error text:

- A tar.gz cut short, with a flipped byte, or whose `tar` died between two files so the archive has no end marker. `tar -t` alone passes that last one.
- An age file that is truncated, tampered with, or opened with the wrong key. A gzip, zstd or xz stream that ends early.
- A SQLite file that is truncated, not a database, damaged, or a valid database with no tables.
- A restic repository with a corrupted or missing pack, a wrong password, or no snapshots.
- A pg_dump file cut in half or with damaged data. `pg_restore --list` alone passes both, so restore-drill reads the whole dump too.
- An empty file, a missing file, and a backup older than `max_age`.

## Compared with other tools

`restic check` and borgmatic's checks verify the repository. restic's `--read-data-subset` reads a share of the data, and borgmatic's `extract` check is a dry run. As far as their docs say, neither restores files into a directory and runs a check you wrote, and neither looks at a SQLite file or a pg_dump you keep outside a repository. restore-drill runs `restic check --read-data-subset` itself as part of the restic drill, so it adds to restic rather than replacing it.

[restverify](https://pypi.org/project/restverify/) is the closest tool I found. It does restic only, is written in Python, and compares the restore against the live source tree. restore-drill does not compare against the source.

Healthchecks-style monitors tell you whether a job ran. They do not look inside the backup. Use one for the nightly ping, as in [docs/scheduling.md](docs/scheduling.md).

## When not to use it

- Your backups are Borg. There is no Borg drill, and I have not tried Borg from a `command` drill.
- You want to know the restore matches the live data, not just that it restores and passes your check. restore-drill never touches the source.
- Your restores are too big to run nightly. A restic drill restores the whole snapshot unless you use `include`, and a pg_dump drill reads the whole dump.
- You are on Windows. It is not supported.
- You want a dashboard with accounts. There is a static page, nothing else.

It only checks your newest backup, and only as well as the check you give it. An `integrity_check` on a database missing last week's data still passes unless you add a row count. More in [docs/reference.md](docs/reference.md#limits).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `node --test` runs the suite. [CHANGELOG.md](CHANGELOG.md) lists what changed.

## Licence

MIT, see [LICENSE](LICENSE).
