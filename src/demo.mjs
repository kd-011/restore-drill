import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendResult, readHistory, summarize } from './history.mjs';
import { renderReport } from './report.mjs';
import { runDrills } from './runner.mjs';
import { DrillError, exec, makeTmp, removeTmp, tail } from './util.mjs';

const WORKER = fileURLToPath(new URL('./sqlite-worker.mjs', import.meta.url));
const HOUR = 3600 * 1000;

async function must(cmd, args, opts) {
  const res = await exec(cmd, args, { env: process.env, ...opts });
  if (res.code !== 0) throw new DrillError(`${cmd} failed while building demo files: ${tail(res.stderr)}`);
}

function setAge(file, ms) {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(file, when, when);
}

async function makeTarGz(root, file, files) {
  const stage = path.join(root, 'stage');
  fs.rmSync(stage, { recursive: true, force: true });
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
    fs.writeFileSync(path.join(stage, rel), data);
  }
  await must('tar', ['-czf', file, '-C', stage, '.']);
}

/** Fake nightly history so the status page shows more than one run. */
function seedHistory(stateDir, drills) {
  // [drill, outcomes for the last three nights, oldest first]
  const story = { 'app-db': [1, 1, 1], photos: [1, 1, 1], notes: [1, 1, 0], 'mail-export': [1, 0, 0] };
  for (const d of drills) {
    (story[d.name] ?? []).forEach((ok, i) => {
      appendResult(stateDir, {
        drill: d.name,
        ok: Boolean(ok),
        started: new Date(Date.now() - (3 - i) * 24 * HOUR).toISOString(),
        duration_ms: 400,
        backup_path: null,
        backup_size: null,
        backup_mtime: null,
        error: ok ? null : 'seeded demo history',
      });
    });
  }
}

/** Build fake backups in a temp dir, run drills over them, show the result, clean up. */
export async function runDemo({ out, line }) {
  const root = makeTmp('restore-drill-demo-');
  try {
    const dir = path.join(root, 'backups');
    fs.mkdirSync(dir);

    const db = path.join(dir, 'app-2026.db');
    await must(process.execPath, ['--disable-warning=ExperimentalWarning', WORKER, 'make', db, '500']);
    setAge(db, 2 * HOUR);

    const photos = path.join(dir, 'photos.tar.gz');
    await makeTarGz(root, photos, { 'photos/index.json': '{"count":2}', 'photos/a.jpg': randomBytes(40_000), 'photos/b.jpg': randomBytes(40_000) });
    setAge(photos, 5 * HOUR);

    const notes = path.join(dir, 'notes.tar.gz');
    await makeTarGz(root, notes, { 'notes/big.bin': randomBytes(300_000), 'notes/todo.md': 'buy milk' });
    fs.truncateSync(notes, Math.floor(fs.statSync(notes).size * 0.45));
    setAge(notes, 3 * HOUR);

    const mail = path.join(dir, 'mail-export.sql');
    fs.writeFileSync(mail, '');
    setAge(mail, 7 * HOUR);

    const drills = [
      { name: 'app-db', type: 'sqlite', source: path.join(dir, 'app-*.db'), max_age: '26h', table_exists: 'users', checks: [{ sql: 'SELECT count(*) FROM users', min: 100 }] },
      { name: 'photos', type: 'tar', source: photos, max_age: '26h', expect_paths: ['photos/index.json'] },
      { name: 'notes', type: 'tar', source: notes, max_age: '26h', expect_paths: ['notes/todo.md'] },
      { name: 'mail-export', type: 'file', source: mail, max_age: '26h' },
    ];
    const stateDir = path.join(root, 'state');
    seedHistory(stateDir, drills);

    console.log('restore-drill demo: four fake backups in a temp dir (two good, two broken on purpose), removed afterwards.\n');
    const width = Math.max(...drills.map((d) => d.name.length));
    const results = await runDrills(drills, {
      stateDir,
      warn: () => {},
      onResult: (rec) => console.log(line(rec, width)),
    });

    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, renderReport(summarize(readHistory(stateDir)), { now: Date.now() }));
    }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed. The same run on your own backups: restore-drill init, then restore-drill run.`);
    if (out) console.log(`status page: ${out}`);
    return failed ? 1 : 0;
  } finally {
    removeTmp(root);
  }
}
