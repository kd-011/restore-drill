import assert from 'node:assert/strict';
import { test } from 'node:test';
import { H, age, sandbox, writeFile } from '../test-support/helpers.mjs';

test('file: newest matching file passes and is recorded in history', async (t) => {
  const sb = sandbox(t);
  const old = writeFile(sb.backup('app-1.dump'), 'x'.repeat(2000));
  const fresh = writeFile(sb.backup('app-2.dump'), 'y'.repeat(3000));
  writeFile(sb.backup('notes.txt'), 'newer but not a match');
  age(old, 30 * H);
  age(fresh, 2 * H);
  sb.writeConfig([{ name: 'app', type: 'file', source: sb.backup('app-*.dump'), max_age: '26h' }]);

  const r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /app/);

  const [rec] = sb.history();
  assert.equal(rec.drill, 'app');
  assert.equal(rec.ok, true);
  assert.equal(rec.backup_path, fresh);
  assert.equal(rec.backup_size, 3000);
  assert.ok(Math.abs(Date.parse(rec.backup_mtime) - (Date.now() - 2 * H)) < 60_000);
  assert.ok(Number.isFinite(Date.parse(rec.started)));
  assert.equal(typeof rec.duration_ms, 'number');
  assert.equal(rec.error ?? null, null);
});

test('file: glob in a directory segment finds the newest across directories', async (t) => {
  const sb = sandbox(t);
  const a = writeFile(sb.backup('2026-01-01', 'dump.sql'), 'old data');
  const b = writeFile(sb.backup('2026-01-02', 'dump.sql'), 'new data');
  age(a, 48 * H);
  age(b, 1 * H);
  sb.writeConfig([{ name: 'dated', type: 'file', source: sb.backup('*/dump.sql') }]);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(sb.history()[0].backup_path, b);
});

test('file: no matching file fails', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('other.txt'), 'hello');
  sb.writeConfig([{ name: 'gone', type: 'file', source: sb.backup('*.dump') }]);
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /no backup found/i);
  const [rec] = sb.history();
  assert.equal(rec.ok, false);
  assert.match(rec.error, /no backup found/i);
});

test('file: an empty file fails', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('empty.dump'), '');
  sb.writeConfig([{ name: 'empty', type: 'file', source: sb.backup('*.dump') }]);
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /empty/i);
  assert.equal(sb.history()[0].ok, false);
});

test('file: a backup older than max_age fails, a fresh one passes', async (t) => {
  const sb = sandbox(t);
  const f = writeFile(sb.backup('a.dump'), 'data data data');
  age(f, 53 * H);
  sb.writeConfig([{ name: 'stale', type: 'file', source: sb.backup('*.dump'), max_age: '26h' }]);
  let r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /too old|max_age/i);
  assert.match(r.stdout, /53h/);

  age(f, 1 * H);
  r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

test('file: min_size is enforced', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('a.dump'), 'x'.repeat(500));
  sb.writeConfig([{ name: 'small', type: 'file', source: sb.backup('*.dump'), min_size: '1KB' }]);
  let r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /too small|min_size/i);

  sb.writeConfig([{ name: 'small', type: 'file', source: sb.backup('*.dump'), min_size: '400' }]);
  r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
});
