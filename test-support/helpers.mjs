// Shared fixtures for the acceptance tests. Everything is built for real:
// real SQLite files, real tar.gz archives, real age/restic when installed.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../bin/restore-drill.mjs', import.meta.url));

export function have(bin) {
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0;
}

function forceRemove(dir) {
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      fs.chmodSync(p, 0o755);
      for (const n of fs.readdirSync(p)) walk(path.join(p, n));
    } else {
      try { fs.chmodSync(p, 0o644); } catch { /* ignore */ }
    }
  };
  walk(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Start the CLI. Returns { child, done } where done resolves to { code, signal, stdout, stderr }. */
export function startCli(args, { env = {}, cwd, input } = {}) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.end(input ?? '');
  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

export function runCli(args, opts) {
  return startCli(args, opts).done;
}

/** A throwaway directory tree with backups/, state/ and an isolated TMPDIR. */
export function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-test-'));
  const backups = path.join(root, 'backups');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(backups);
  fs.mkdirSync(tmp);
  t.after(() => forceRemove(root));
  const sb = {
    root,
    backups,
    tmp,
    state: path.join(root, 'state'),
    config: path.join(root, 'drills.json'),
    path: (...p) => path.join(root, ...p),
    backup: (...p) => path.join(backups, ...p),
    writeConfig(drills, extra = {}) {
      fs.writeFileSync(sb.config, JSON.stringify({ ...extra, drills }, null, 2));
      return sb.config;
    },
    cli(args, opts = {}) {
      return runCli(args, { ...opts, env: { TMPDIR: tmp, ...opts.env } });
    },
    /** restore-drill run with this sandbox's config and state. */
    run(extra = [], opts = {}) {
      return sb.cli(['run', '--config', sb.config, '--state', sb.state, ...extra], opts);
    },
    history() {
      const f = path.join(sb.state, 'history.jsonl');
      if (!fs.existsSync(f)) return [];
      return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    /** Names of leftover restore-drill temp dirs in this sandbox's TMPDIR. */
    leftovers() {
      return fs.readdirSync(tmp).filter((n) => n.startsWith('restore-drill'));
    },
  };
  return sb;
}

export function writeFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

/** Set a file's mtime to `ageMs` milliseconds ago. */
export function age(file, ageMs) {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
}

export const H = 3600 * 1000;

export function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Hash of names, modes and contents of everything under dir. */
export function treeHash(dir) {
  const h = createHash('sha256');
  const walk = (p) => {
    for (const n of fs.readdirSync(p).sort()) {
      const full = path.join(p, n);
      const st = fs.lstatSync(full);
      h.update(`${path.relative(dir, full)}:${st.mode}:${st.size}:${st.mtimeMs}\n`);
      if (st.isDirectory()) walk(full);
      else h.update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return h.digest('hex');
}

export function makeSqlite(file, { rows = 200, wal = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (wal) db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, bio TEXT)');
  const ins = db.prepare('INSERT INTO users (name, bio) VALUES (?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < rows; i++) ins.run(`user${i}`, randomBytes(64).toString('hex'));
  db.exec('COMMIT');
  if (wal) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  for (const ext of ['-wal', '-shm']) fs.rmSync(file + ext, { force: true });
  return file;
}

/** Create a tar archive. compress: 'gz' | 'none'. files: { 'rel/path': content } */
export function makeTar(file, files, { compress = 'gz' } = {}) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-stage-'));
  try {
    for (const [rel, content] of Object.entries(files)) writeFile(path.join(stage, rel), content);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const r = spawnSync('tar', [compress === 'gz' ? '-czf' : '-cf', file, '-C', stage, '.'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return file;
}

export function makeZip(file, files) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-stage-'));
  try {
    for (const [rel, content] of Object.entries(files)) writeFile(path.join(stage, rel), content);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const r = spawnSync('zip', ['-qr', file, '.'], { cwd: stage, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`zip failed: ${r.stderr}`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return file;
}

/** Content that does not compress, so truncating lands mid-stream. */
export function noise(bytes) {
  return randomBytes(bytes);
}

export function truncate(file, keepFraction, extra = 0) {
  const size = fs.statSync(file).size;
  fs.truncateSync(file, Math.floor(size * keepFraction) + extra);
}

/** Run a shell-free command, throw on failure. */
export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r;
}

/** Local HTTP server that records every request. */
export async function recorder(t, { status = 200 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.statusCode = typeof status === 'function' ? status(req) : status;
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

/** A directory holding stub executables, to be prepended to PATH. */
export function stubBin(sb, scripts) {
  const dir = sb.path('stubs');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(scripts)) {
    const f = path.join(dir, name);
    fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(f, 0o755);
  }
  return dir;
}

/** PATH that finds nothing except the given dirs (for "binary missing" tests). */
export function emptyPath(sb) {
  const dir = sb.path('emptybin');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
