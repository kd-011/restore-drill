import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** An expected failure with a message fit to show the user as is. */
export class DrillError extends Error {}

// ---- durations and sizes ------------------------------------------------------------

const DURATION_UNITS = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 };

/** "26h", "90m", "1h30m", "45s" or a bare number of seconds. Returns ms, or null if invalid. */
export function parseDuration(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value * 1000 : null;
  if (typeof value !== 'string') return null;
  let rest = value.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(rest)) return Number(rest) * 1000;
  let total = 0;
  let matched = false;
  while (rest.length) {
    const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*/.exec(rest);
    if (!m) return null;
    total += Number(m[1]) * DURATION_UNITS[m[2]];
    rest = rest.slice(m[0].length);
    matched = true;
  }
  return matched ? total : null;
}

const SIZE_UNITS = { b: 1, k: 1024, kb: 1024, kib: 1024, m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4 };

/** "10MB", "1.5GiB", "500" (bytes). 1024-based. Returns bytes, or null if invalid. */
export function parseSize(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(value.trim());
  if (!m) return null;
  const unit = m[2] ? SIZE_UNITS[m[2].toLowerCase()] : 1;
  return unit ? Math.floor(Number(m[1]) * unit) : null;
}

export function formatSize(bytes) {
  if (bytes == null) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)}${units[i]}`;
}

/** Compact span: 45m, 53h, 4d. */
export function formatSpan(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 72 * 3600) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** "3h ago", or "just now" under a minute. */
export function formatAgo(ms) {
  return ms < 60_000 ? 'just now' : `${formatSpan(ms)} ago`;
}

export function formatElapsed(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ---- secrets -------------------------------------------------------------------------

/** Mask credentials in URLs and any literal secret values. */
export function redact(text, secrets = []) {
  let out = String(text ?? '').replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@');
  for (const s of secrets) if (s) out = out.split(s).join('***');
  return out;
}

/** Last lines of tool output, trimmed to something worth printing. */
export function tail(text, { lines = 12, chars = 2000 } = {}) {
  const t = String(text ?? '').trim().split('\n').slice(-lines).join('\n');
  return t.length > chars ? `...${t.slice(-chars)}` : t;
}

// ---- globbing --------------------------------------------------------------------------

const GLOB_CHARS = /[*?[]/;

function segmentRegExp(seg) {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = seg.indexOf(']', i + 2);
      if (end === -1) { re += '\\['; continue; }
      let cls = seg.slice(i + 1, end);
      if (cls[0] === '!') cls = `^${cls.slice(1)}`;
      re += `[${cls.replace(/\\/g, '\\\\')}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Expand a shell-style glob (* ? [..] and ** for any depth) into existing paths.
 * Relative patterns are resolved against `cwd`. Dotfiles match only a pattern that starts with a dot.
 */
export async function expandGlob(pattern, cwd = process.cwd()) {
  const abs = path.isAbsolute(pattern);
  const segs = pattern.split('/').filter((s) => s !== '' && s !== '.');
  let current = [abs ? '/' : path.resolve(cwd)];

  for (const seg of segs) {
    const next = [];
    if (seg === '**') {
      for (const base of current) {
        next.push(base);
        const stack = [base];
        while (stack.length) {
          const dir = stack.pop();
          let entries;
          try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
          for (const e of entries) {
            if (e.name.startsWith('.') || !e.isDirectory()) continue;
            const full = path.join(dir, e.name);
            next.push(full);
            stack.push(full);
          }
        }
      }
    } else if (!GLOB_CHARS.test(seg)) {
      for (const base of current) next.push(path.join(base, seg));
    } else {
      const re = segmentRegExp(seg);
      for (const base of current) {
        let names;
        try { names = await fs.promises.readdir(base); } catch { continue; }
        for (const n of names) {
          if (n.startsWith('.') && !seg.startsWith('.')) continue;
          if (re.test(n)) next.push(path.join(base, n));
        }
      }
    }
    current = next;
    if (!current.length) return [];
  }

  const found = [];
  for (const p of new Set(current)) {
    try { await fs.promises.lstat(p); found.push(p); } catch { /* does not exist */ }
  }
  return found;
}

/** Newest regular file matching `pattern` (a glob, or a directory meaning "files in it"). */
export async function findNewest(pattern) {
  let pat = pattern;
  try {
    if ((await fs.promises.stat(pattern)).isDirectory()) pat = path.join(pattern, '*');
  } catch { /* not a literal path */ }
  let best = null;
  for (const p of await expandGlob(pat)) {
    let st;
    try { st = await fs.promises.stat(p); } catch { continue; }
    if (!st.isFile()) continue;
    if (!best || st.mtimeMs > best.mtimeMs || (st.mtimeMs === best.mtimeMs && p > best.path)) {
      best = { path: p, size: st.size, mtimeMs: st.mtimeMs };
    }
  }
  return best;
}

/** Every non-directory under dir. */
export async function walkFiles(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else files.push(full);
    }
  }
  return files;
}

// ---- temp dirs and child processes ------------------------------------------------------

const liveChildren = new Set();
const liveTmpDirs = new Set();

/** Remove a tree even when it contains read-only directories. */
export function removeTreeSync(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  } catch { /* fall through and loosen modes */ }
  const loosen = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (!st.isDirectory()) return;
    try { fs.chmodSync(p, 0o700); } catch { /* ignore */ }
    for (const n of fs.readdirSync(p)) loosen(path.join(p, n));
  };
  loosen(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

export function makeTmp(prefix = 'restore-drill-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  liveTmpDirs.add(dir);
  return dir;
}

export function removeTmp(dir) {
  try {
    removeTreeSync(dir);
  } finally {
    liveTmpDirs.delete(dir);
  }
}

/** Kill every running child and delete every temp dir. Synchronous, for signal and exit handlers. */
export function emergencyCleanup() {
  for (const child of liveChildren) killGroup(child, 'SIGKILL');
  for (const dir of [...liveTmpDirs]) {
    try { removeTreeSync(dir); } catch { /* best effort */ }
    liveTmpDirs.delete(dir);
  }
}

function killGroup(child, sig) {
  try { process.kill(-child.pid, sig); } catch {
    try { child.kill(sig); } catch { /* already gone */ }
  }
}

/**
 * Run a binary. Resolves with { code, signal, stdout, stderr } whatever the exit status;
 * rejects with a DrillError only when the binary cannot be started.
 * `need` is shown when the binary is missing, e.g. "needed for restic drills".
 */
export function exec(cmd, args, { cwd, env, signal, stdoutFile, need } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted?.();
    let outFd;
    if (stdoutFile) outFd = fs.openSync(stdoutFile, 'w', 0o600);
    const child = spawn(cmd, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', outFd ?? 'pipe', 'pipe'],
    });
    if (outFd !== undefined) fs.closeSync(outFd);
    liveChildren.add(child);

    const MAX = 4 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { if (stdout.length < MAX) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < MAX) stderr += d; });

    let killTimer;
    const onAbort = () => {
      killGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), 2000);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const finish = () => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      liveChildren.delete(child);
    };
    child.on('error', (err) => {
      finish();
      if (err.code === 'ENOENT') {
        reject(new DrillError(`${path.basename(cmd)} not found in PATH${need ? ` (${need})` : ''}`));
      } else {
        reject(new DrillError(`could not run ${path.basename(cmd)}: ${err.message}`));
      }
    });
    child.on('close', (code, sig) => {
      finish();
      // The child may have left the group's other members behind.
      killGroup(child, 'SIGKILL');
      resolve({ code, signal: sig, stdout, stderr });
    });
  });
}
