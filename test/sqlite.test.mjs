import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { H, age, makeSqlite, noise, sandbox, truncate, writeFile } from '../test-support/helpers.mjs';

const drill = (sb, extra = {}) => sb.writeConfig([{ name: 'db', type: 'sqlite', source: sb.backup('*.db'), ...extra }]);

test('sqlite: a good database passes', async (t) => {
  const sb = sandbox(t);
  makeSqlite(sb.backup('app.db'));
  drill(sb, { max_age: '26h' });
  const r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(sb.history()[0].ok, true);
});

test('sqlite: a file that is not a database fails with the real error', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('app.db'), noise(8192));
  drill(sb);
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /not a database|malformed|corrupt/i);
});

test('sqlite: a database with trashed pages fails', async (t) => {
  const sb = sandbox(t);
  const f = makeSqlite(sb.backup('app.db'), { rows: 600 });
  const fd = fs.openSync(f, 'r+');
  fs.writeSync(fd, noise(4096 * 3), 0, 4096 * 3, 4096 * 4);
  fs.closeSync(fd);
  drill(sb);
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /integrity|malformed|corrupt|not a database|disk image/i);
});

test('sqlite: a truncated database fails', async (t) => {
  const sb = sandbox(t);
  const f = makeSqlite(sb.backup('app.db'), { rows: 600 });
  truncate(f, 0.5, 17);
  drill(sb);
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.equal(sb.history()[0].ok, false);
});

test('sqlite: an empty file fails', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('app.db'), '');
  drill(sb);
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /empty/i);
});

test('sqlite: a stale backup fails even when the database is fine', async (t) => {
  const sb = sandbox(t);
  age(makeSqlite(sb.backup('app.db')), 60 * H);
  drill(sb, { max_age: '26h' });
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /too old|max_age/i);
});

test('sqlite: row-count checks pass and fail', async (t) => {
  const sb = sandbox(t);
  makeSqlite(sb.backup('app.db'), { rows: 50 });
  drill(sb, { checks: [{ sql: 'SELECT count(*) FROM users', min: 50 }] });
  let r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);

  drill(sb, { checks: [{ sql: 'SELECT count(*) FROM users', min: 51 }] });
  r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /SELECT count\(\*\) FROM users/);
  assert.match(r.stdout, /50/);
  assert.match(r.stdout, /51/);
});

test('sqlite: a check with a syntax error fails with the sqlite message', async (t) => {
  const sb = sandbox(t);
  makeSqlite(sb.backup('app.db'));
  drill(sb, { checks: [{ sql: 'SELECT count(*) FROM no_such_table', min: 1 }] });
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /no such table/i);
});

test('sqlite: table_exists accepts a name or a list', async (t) => {
  const sb = sandbox(t);
  makeSqlite(sb.backup('app.db'));
  drill(sb, { table_exists: 'users' });
  let r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);

  drill(sb, { table_exists: ['users', 'orders'] });
  r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /orders/);
});

test('sqlite: checks cannot write to the backup', async (t) => {
  const sb = sandbox(t);
  makeSqlite(sb.backup('app.db'), { rows: 10 });
  drill(sb, { checks: [{ sql: "INSERT INTO users (name, bio) VALUES ('x','y') RETURNING 1", min: 1 }] });
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /readonly|read-only/i);
});
