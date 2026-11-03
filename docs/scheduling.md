# Running it on a schedule

A drill that only runs when you remember is not much better than no drill. This page is the nightly setup: a timer, alerts when a backup does not restore, and an alert when the drill itself stops running.

Start from [`examples/nightly.json`](../examples/nightly.json). It sets `max_age` on every drill, one retry, and the three notification keys.

## Three things to be told about

| What went wrong | How you hear about it |
| --- | --- |
| A backup does not restore | `notify.ntfy` or `notify.webhook` fires on that drill's failure, and once more when it passes again. |
| The newest backup is stale because the backup job stopped | `max_age` makes the drill fail. Without it the old backup still restores and the drill passes. |
| restore-drill itself stopped running (timer off, host down, config broken) | A missed `ping_success`. |

The third one matters most and is the one people skip. A failure alert only fires if the script runs. Point `ping_success` at a dead man's switch such as healthchecks.io (hosted or self-hosted): it expects a ping every day and alerts you when one does not arrive. `ping_fail` is the same URL with `/fail` on the end.

restore-drill sends `ping_success` only when every drill passed, and `ping_fail` otherwise. A config error (exit 2) sends nothing, so a broken config shows up as a missed ping. A run limited with `--only` never sends `ping_success`, so running one drill by hand cannot make a dead nightly job look alive.

Notification failures print a warning on stderr and never change the exit code.

## systemd user timer

[`examples/restore-drill.service`](../examples/restore-drill.service) and [`examples/restore-drill.timer`](../examples/restore-drill.timer):

```sh
cp examples/restore-drill.{service,timer} ~/.config/systemd/user/
# edit the node path, script path and config path in the .service file
systemctl --user daemon-reload
systemctl --user enable --now restore-drill.timer
loginctl enable-linger "$USER"      # keep it firing while logged out
systemctl --user list-timers restore-drill.timer
```

If you installed with `npm install -g`, the script is at `$(npm root -g)/restore-drill/bin/restore-drill.mjs`.

The unit uses `PrivateTmp=yes`, so the restored data is invisible to other units and goes away with the service. It also means a backup that lives under `/tmp` is invisible to the drill. Keep backups elsewhere.

Exit 1 leaves the unit in the failed state. I ran a transient unit with one good and one broken backup: `systemctl --user is-failed` printed `failed`, and the journal held the `PASS` and `FAIL` lines with the real error:

```
PASS  good      58ms  backup 0s old
FAIL  broken    33ms  file is not a database
```

```sh
journalctl --user -u restore-drill --since yesterday
systemctl --user is-failed restore-drill.service
```

## cron

```cron
30 4 * * * restore-drill run --config /etc/restore-drill/nightly.json && restore-drill report --config /etc/restore-drill/nightly.json --out /var/www/status.html
```

cron has a short `PATH`. Use the full path from `command -v restore-drill`, and make sure `node` is on that `PATH` too.

## Docker

[`examples/Dockerfile`](../examples/Dockerfile) and [`examples/docker-compose.yml`](../examples/docker-compose.yml). Mount backups read-only and give `/tmp` enough room for your largest restore:

```sh
docker build -f examples/Dockerfile -t restore-drill .
docker run --rm \
  -v "$PWD/drills.json:/config/drills.json:ro" \
  -v /backups:/backups:ro \
  -v restore-drill-state:/state \
  --tmpfs /tmp:size=2g \
  restore-drill
```

Inside the container the paths in your config are container paths. The image is built from this repo and I have not published it anywhere.

## Checking in by hand

```sh
restore-drill status --config nightly.json
```

```
DRILL   LAST  LAST PASS  STREAK
good    pass  just now   2 pass
broken  fail  never      2 fail
```

`report` writes one static HTML page from the same history, for a phone bookmark or a web server directory. See [the reference](reference.md) for both.

## Sizing

Each drill restores into the OS temp dir (`TMPDIR`) and removes it afterwards. A restic drill without `include` restores the whole snapshot, and a `pg_dump` drill reads the whole dump. Set `TMPDIR` to somewhere with room, set `timeout` (default 30 minutes) to something that fits your biggest backup, and use `include` on restic to restore only what you check.
