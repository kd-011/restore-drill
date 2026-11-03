import { performance } from 'node:perf_hooks';
import { DEFAULT_TIMEOUT_MS } from './config.mjs';
import { appendResult, readHistory } from './history.mjs';
import { notifyResult, pingRun } from './notify.mjs';
import { DrillError, emergencyCleanup, formatSpan, makeTmp, parseDuration, redact, removeTmp } from './util.mjs';

import * as file from './drills/file.mjs';
import * as sqlite from './drills/sqlite.mjs';
import * as tar from './drills/tar.mjs';
import * as restic from './drills/restic.mjs';
import * as pgDump from './drills/pg_dump.mjs';
import * as command from './drills/command.mjs';

const IMPLEMENTATIONS = { file, sqlite, tar, restic, pg_dump: pgDump, command };
const ERROR_LIMIT = 4000;
const GRACE_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function describe(err) {
  if (err instanceof DrillError) return err.message;
  if (err?.code && typeof err.code === 'string') return err.message; // fs and system errors read fine as they are
  return `internal error: ${err?.message ?? err}`;
}

/** One attempt: private temp dir, a timeout, cleanup no matter what. */
async function attempt(drill, { lastPass }) {
  const impl = IMPLEMENTATIONS[drill.type];
  const tmp = makeTmp();
  const ctl = new AbortController();
  const timeoutMs = drill.timeout !== undefined ? parseDuration(drill.timeout) : DEFAULT_TIMEOUT_MS;
  const ctx = { tmp, signal: ctl.signal, now: Date.now(), lastPass, backup: null };

  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  let abortedPromise;
  const aborted = new Promise((_, reject) => {
    abortedPromise = () => reject(new DrillError(`timed out after ${drill.timeout ?? formatSpan(timeoutMs)}`));
    ctl.signal.addEventListener('abort', abortedPromise, { once: true });
  });
  aborted.catch(() => {});

  let error = null;
  const work = impl.run(drill, ctx);
  work.catch(() => {});
  try {
    await Promise.race([work, aborted]);
  } catch (err) {
    error = timedOut ? new DrillError(`timed out after ${drill.timeout ?? formatSpan(timeoutMs)}`) : err;
    if (timedOut) await Promise.race([work.catch(() => {}), sleep(GRACE_MS)]);
  } finally {
    clearTimeout(timer);
    removeTmp(tmp);
  }
  return { error, backup: ctx.backup };
}

export async function runDrill(drill, { lastPass }) {
  const started = new Date();
  const t0 = performance.now();
  const retries = drill.retries ?? 0;
  const delay = drill.retry_delay !== undefined ? parseDuration(drill.retry_delay) : 5000;

  let outcome;
  for (let i = 0; i <= retries; i++) {
    try {
      outcome = await attempt(drill, { lastPass });
    } catch (err) {
      outcome = { error: err, backup: null };
    }
    if (!outcome.error) break;
    if (i < retries) await sleep(delay);
  }

  const b = outcome.backup;
  return {
    drill: drill.name,
    ok: !outcome.error,
    started: started.toISOString(),
    duration_ms: Math.round(performance.now() - t0),
    backup_path: b?.path ?? null,
    backup_size: b?.size ?? null,
    backup_mtime: b?.mtime ?? null,
    error: outcome.error ? redact(describe(outcome.error)).slice(0, ERROR_LIMIT) : null,
  };
}

const STALE_MS = 7 * 24 * 3600 * 1000;

/** Without max_age a backup job that stopped months ago still passes, so say so. */
function warnIfStale(drill, record, warn) {
  if (!record.ok || drill.max_age !== undefined || !record.backup_mtime) return;
  const age = Date.parse(record.started) - Date.parse(record.backup_mtime);
  if (age > STALE_MS) {
    warn(`${drill.name}: passed, but the newest backup is ${formatSpan(age)} old and no max_age is set, so a backup job that stopped would not fail this drill`);
  }
}

let handlersInstalled = false;
function installHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const die = (signal, code) => () => {
    emergencyCleanup();
    process.stderr.write(`\nrestore-drill: interrupted (${signal}), temp files removed\n`);
    process.exit(code);
  };
  process.on('SIGINT', die('SIGINT', 130));
  process.on('SIGTERM', die('SIGTERM', 143));
  process.on('SIGHUP', die('SIGHUP', 129));
  process.on('exit', emergencyCleanup);
}

export async function runDrills(drills, { stateDir, notify, onResult = () => {}, warn = () => {}, partial = false }) {
  installHandlers();
  const prior = readHistory(stateDir);
  const results = [];
  for (const drill of drills) {
    const mine = prior.filter((r) => r.drill === drill.name);
    const lastPass = [...mine].reverse().find((r) => r.ok) ?? null;
    const previous = mine.at(-1) ?? null;

    const record = await runDrill(drill, { lastPass });
    appendResult(stateDir, record);
    results.push(record);
    onResult(record);

    warnIfStale(drill, record, warn);

    if (!record.ok) await notifyResult(notify, record, 'failure', warn);
    else if (previous && !previous.ok) await notifyResult(notify, record, 'recovery', warn);
  }
  const allOk = results.every((r) => r.ok);
  // A run of a few drills says nothing about the rest, so it must not stand in for the nightly one.
  if (!(partial && allOk)) await pingRun(notify, allOk, warn);
  return results;
}
