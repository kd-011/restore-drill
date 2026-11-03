import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  H, age, makeSqlite, makeTar, noise, sandbox, sha256, startCli, treeHash, truncate, writeFile,
} from '../test-support/helpers.mjs';

test('read-only: no drill type modifies, adds or removes anything in the backup dir', async (t) => {
  const sb = sandbox(t);
  makeSqlite(sb.backup('good.db'), { wal: true });
  writeFile(sb.backup('corrupt.db'), noise(9000));
  age(sb.backup('corrupt.db'), 3 * H);
  makeTar(sb.backup('good.tar.gz'), { 'a/b.txt': 'hello', 'a/blob': noise(100_000) });
  const trunc = makeTar(sb.backup('bad.tar.gz'), { 'a/blob': noise(100_000) });
  truncate(trunc, 0.4);
  writeFile(sb.backup('plain.dump'), 'some dump data');
  sb.writeConfig([
    { name: 'sq-good', type: 'sqlite', source: sb.backup('good.db'), table_exists: 'users' },
    { name: 'sq-bad', type: 'sqlite', source: sb.backup('corrupt.db') },
    { name: 'tar-good', type: 'tar', source: sb.backup('good.tar.gz'), expect_paths: ['a/b.txt'] },
    { name: 'tar-bad', type: 'tar', source: sb.backup('bad.tar.gz') },
    { name: 'file', type: 'file', source: sb.backup('plain.dump') },
    { name: 'cmd', type: 'command', source: sb.backup('plain.dump'), command: 'cat "$RESTORE_DRILL_FILE" > /dev/null' },
  ]);
  const before = treeHash(sb.backups);
  const r = await sb.run();
  assert.equal(r.code, 1, 'two of these drills are meant to fail');
  assert.equal(treeHash(sb.backups), before);
  const byName = Object.fromEntries(sb.history().map((h) => [h.drill, h.ok]));
  assert.deepEqual(byName, {
    'sq-good': true, 'sq-bad': false, 'tar-good': true, 'tar-bad': false, file: true, cmd: true,
  });
});

test('read-only: a command that tries to destroy its input cannot touch the source', async (t) => {
  const sb = sandbox(t);
  const src = writeFile(sb.backup('data.bin'), noise(4096));
  const before = sha256(src);
  sb.writeConfig([{
    name: 'vandal', type: 'command', source: sb.backup('*.bin'),
    command: 'echo tampered >> "$RESTORE_DRILL_FILE"; truncate -s 0 "$RESTORE_DRILL_FILE"; rm -f "$RESTORE_DRILL_FILE"',
  }]);
  await sb.run();
  assert.ok(fs.existsSync(src));
  assert.equal(sha256(src), before);
});

test('read-only: drills work on a read-only backup directory (nothing is written next to the source)', {
  skip: process.getuid?.() === 0,
}, async (t) => {
  const sb = sandbox(t);
  makeSqlite(sb.backup('app.db'), { wal: true });
  makeTar(sb.backup('site.tar.gz'), { 'x.txt': 'x' });
  fs.chmodSync(sb.backup('app.db'), 0o444);
  fs.chmodSync(sb.backup('site.tar.gz'), 0o444);
  fs.chmodSync(sb.backups, 0o555);
  sb.writeConfig([
    { name: 'db', type: 'sqlite', source: sb.backup('*.db'), table_exists: 'users' },
    { name: 'site', type: 'tar', source: sb.backup('*.tar.gz'), expect_paths: ['x.txt'] },
  ]);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(fs.readdirSync(sb.backups).sort(), ['app.db', 'site.tar.gz']);
});

test('cleanup: temp dirs are removed after passes and failures of every kind', async (t) => {
  const sb = sandbox(t);
  makeSqlite(sb.backup('good.db'));
  writeFile(sb.backup('bad.db'), noise(5000));
  const trunc = makeTar(sb.backup('bad.tar.gz'), { 'a/blob': noise(100_000) });
  truncate(trunc, 0.4);
  sb.writeConfig([
    { name: 'a', type: 'sqlite', source: sb.backup('good.db') },
    { name: 'b', type: 'sqlite', source: sb.backup('bad.db') },
    { name: 'c', type: 'tar', source: sb.backup('bad.tar.gz') },
    { name: 'd', type: 'command', command: 'exit 7' },
    { name: 'e', type: 'command', command: 'touch inside.txt; mkdir -p deep/dir; chmod 500 deep/dir; exit 0' },
  ]);
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.deepEqual(sb.leftovers(), []);
});

test('cleanup: Ctrl-C mid-drill kills the child and removes the temp dir', async (t) => {
  const sb = sandbox(t);
  const seen = sb.path('seen');
  const pidfile = sb.path('pid');
  const started = sb.path('started');
  sb.writeConfig([{
    name: 'slow', type: 'command',
    command: `echo "$RESTORE_DRILL_TMP" > "${seen}"; echo $$ > "${pidfile}"; touch inside; touch "${started}"; sleep 60`,
  }]);
  const { child, done } = startCli(['run', '--config', sb.config, '--state', sb.state], { env: { TMPDIR: sb.tmp } });
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(started) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(started), 'command did not start');
  const tmpDir = fs.readFileSync(seen, 'utf8').trim();
  assert.ok(fs.existsSync(tmpDir));

  child.kill('SIGINT');
  const r = await done;
  assert.equal(r.code, 130);
  assert.equal(fs.existsSync(tmpDir), false, 'temp dir removed after SIGINT');
  assert.deepEqual(sb.leftovers(), []);
  await new Promise((res) => setTimeout(res, 300));
  assert.throws(() => process.kill(Number(fs.readFileSync(pidfile, 'utf8')), 0), /ESRCH/);
});

test('cleanup: SIGTERM is handled the same way', async (t) => {
  const sb = sandbox(t);
  const started = sb.path('started');
  sb.writeConfig([{ name: 'slow', type: 'command', command: `touch "${started}"; sleep 60` }]);
  const { child, done } = startCli(['run', '--config', sb.config, '--state', sb.state], { env: { TMPDIR: sb.tmp } });
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(started) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.kill('SIGTERM');
  const r = await done;
  assert.notEqual(r.code, 0);
  assert.deepEqual(sb.leftovers(), []);
});

const sizeDrill = (sb, extra = {}) =>
  sb.writeConfig([{ name: 'big', type: 'file', source: sb.backup('*.dump'), ...extra }]);

function put(sb, name, bytes, agoMs = 0) {
  const f = writeFile(sb.backup(name), Buffer.alloc(bytes, 97));
  age(f, agoMs);
  return f;
}

test('size_drop: a backup under half the last good size fails by default', async (t) => {
  const sb = sandbox(t);
  put(sb, 'night1.dump', 10_000, 25 * H);
  sizeDrill(sb);
  assert.equal((await sb.run()).code, 0);

  put(sb, 'night2.dump', 1_000, 1 * H);
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /size_drop|dropped|smaller/i);
  assert.match(r.stdout, /10(,|\.)?0?\s?(KB|B|000)|9\.8\s?KB|10000/i, 'mentions the previous size');
});

test('size_drop: a modest shrink is fine', async (t) => {
  const sb = sandbox(t);
  put(sb, 'night1.dump', 10_000, 25 * H);
  sizeDrill(sb);
  await sb.run();
  put(sb, 'night2.dump', 6_000, 1 * H);
  assert.equal((await sb.run()).code, 0);
});

test('size_drop: the threshold is configurable and 0 turns it off', async (t) => {
  const sb = sandbox(t);
  put(sb, 'night1.dump', 10_000, 25 * H);
  sizeDrill(sb);
  await sb.run();
  put(sb, 'night2.dump', 8_000, 1 * H);

  sizeDrill(sb, { size_drop: 90 });
  assert.equal((await sb.run()).code, 1);

  sizeDrill(sb, { size_drop: 0 });
  assert.equal((await sb.run()).code, 0);
});

test('size_drop: a failing small backup does not become the new baseline', async (t) => {
  const sb = sandbox(t);
  put(sb, 'night1.dump', 10_000, 49 * H);
  sizeDrill(sb);
  await sb.run();
  put(sb, 'night2.dump', 500, 25 * H);
  assert.equal((await sb.run()).code, 1);
  put(sb, 'night3.dump', 500, 1 * H);
  assert.equal((await sb.run()).code, 1, 'must not heal itself by comparing against the bad run');
});

test('size_drop: the first run has no baseline and passes', async (t) => {
  const sb = sandbox(t);
  put(sb, 'night1.dump', 10, 1 * H);
  sizeDrill(sb);
  assert.equal((await sb.run()).code, 0);
});

test('size_drop: applies to sqlite drills too', async (t) => {
  const sb = sandbox(t);
  const f = makeSqlite(sb.backup('app.db'), { rows: 800 });
  age(f, 25 * H);
  sb.writeConfig([{ name: 'db', type: 'sqlite', source: sb.backup('*.db') }]);
  assert.equal((await sb.run()).code, 0);
  makeSqlite(sb.backup('app-new.db'), { rows: 5 });
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /size_drop|dropped|smaller/i);
});

test('cleanup: each drill removes its temp dir before the next starts (not only at process exit)', async (t) => {
  const sb = sandbox(t);
  const count = 'test "$(ls "$(dirname "$RESTORE_DRILL_TMP")" | grep -c "^restore-drill")" = 1';
  sb.writeConfig([
    { name: 'a', type: 'command', command: 'touch leftover; exit 1' },
    { name: 'b', type: 'command', command: count },
    { name: 'c', type: 'command', command: count },
  ]);
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.deepEqual(sb.history().map((h) => [h.drill, h.ok]), [['a', false], ['b', true], ['c', true]]);
});
