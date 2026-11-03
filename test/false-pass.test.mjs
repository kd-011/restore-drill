// A backup check that says "pass" for a backup that cannot be restored is the worst
// failure this tool can have. Each test here is a case that used to pass and should not.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { H, age, have, makeSqlite, makeTar, noise, recorder, sandbox, stubBin, truncate, writeFile } from '../test-support/helpers.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/items.dump', import.meta.url));

// ---- tar -------------------------------------------------------------------------------

/** Keep every complete entry but drop the end-of-archive blocks, as if tar was killed after its last file. */
function dropEndMarker(buf) {
  let last = buf.length - 1;
  while (last >= 0 && buf[last] === 0) last--;
  return buf.subarray(0, Math.ceil((last + 1) / 512) * 512);
}

const files = () => ({ 'config/app.json': '{"ok":true}', 'a.txt': 'one', 'b.txt': 'two', 'c.txt': 'three' });
const tarDrill = (sb, extra = {}) => sb.writeConfig([{ name: 'site', type: 'tar', source: sb.backup('site-*'), ...extra }]);

test('tar: a plain .tar that lost its end-of-archive marker fails', async (t) => {
  const sb = sandbox(t);
  const f = makeTar(sb.backup('site-1.tar'), files(), { compress: 'none' });
  fs.writeFileSync(f, dropEndMarker(fs.readFileSync(f)));
  tarDrill(sb);
  const r = await sb.run();
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /end-of-archive|cut short/i);
});

test('tar: a .tar.gz whose tar stream was cut short before gzip closed it fails', async (t) => {
  const sb = sandbox(t);
  const plain = makeTar(sb.path('plain.tar'), files(), { compress: 'none' });
  writeFile(sb.backup('site-1.tar.gz'), zlib.gzipSync(dropEndMarker(fs.readFileSync(plain))));
  tarDrill(sb);
  const r = await sb.run();
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /end-of-archive|cut short/i);
});

test('tar: a .tar.zst with decompress passes when whole and fails when cut short', { skip: !have('zstd') }, async (t) => {
  const sb = sandbox(t);
  const plain = makeTar(sb.path('plain.tar'), files(), { compress: 'none' });
  fs.copyFileSync(plain, sb.path('whole.tar'));
  assert.equal(spawnSync('zstd', ['-q', sb.path('whole.tar'), '-o', sb.backup('site-1.tar.zst')]).status, 0);
  tarDrill(sb, { decompress: true });
  let r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);

  fs.writeFileSync(sb.path('cut.tar'), dropEndMarker(fs.readFileSync(plain)));
  assert.equal(spawnSync('zstd', ['-q', '-f', sb.path('cut.tar'), '-o', sb.backup('site-2.tar.zst')]).status, 0);
  r = await sb.run();
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /end-of-archive|cut short/i);
});

// ---- sqlite ----------------------------------------------------------------------------

test('sqlite: a valid database with no tables fails even with no checks configured', async (t) => {
  const sb = sandbox(t);
  const f = sb.backup('app.db');
  fs.mkdirSync(sb.backups, { recursive: true });
  const db = new DatabaseSync(f);
  db.exec('PRAGMA user_version = 3');
  db.close();
  assert.ok(fs.statSync(f).size > 0);
  sb.writeConfig([{ name: 'db', type: 'sqlite', source: sb.backup('*.db') }]);
  const r = await sb.run();
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /no tables/i);
});

// ---- pg_dump ---------------------------------------------------------------------------

// pg_restore --list only reads the table of contents at the front of a custom-format
// dump, so a dump cut in half or with damaged data still lists fine. Reading all of it
// (pg_restore -f /dev/null) is what notices.
const PG_STUB = `
for a; do f=$a; done
if [ "$1" = "--list" ]; then echo "; Archive"; echo "1; 1259 1 TABLE public t app"; exit 0; fi
if [ "$1" = "-f" ]; then
  if grep -q CUTSHORT "$f"; then echo "pg_restore: error: could not read from input file: end of file" >&2; exit 1; fi
  exit 0
fi
exit 0
`;

test('pg_dump: a dump that lists fine but cannot be read to the end fails', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('app.dump'), 'PGDMP CUTSHORT');
  sb.writeConfig([{ name: 'pg', type: 'pg_dump', source: sb.backup('*.dump') }]);
  const dir = stubBin(sb, { pg_restore: PG_STUB });
  const r = await sb.run([], { env: { PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /could not read from input file/);
});

const real = { skip: !have('pg_restore') && 'pg_restore is not installed' };

test('pg_dump (real pg_restore): the fixture dump passes', real, async (t) => {
  const sb = sandbox(t);
  fs.copyFileSync(FIXTURE, sb.backup('items.dump'));
  sb.writeConfig([{ name: 'pg', type: 'pg_dump', source: sb.backup('*.dump'), min_entries: 5 }]);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

test('pg_dump (real pg_restore): a dump cut in half fails', real, async (t) => {
  const sb = sandbox(t);
  fs.copyFileSync(FIXTURE, sb.backup('items.dump'));
  truncate(sb.backup('items.dump'), 0.5);
  sb.writeConfig([{ name: 'pg', type: 'pg_dump', source: sb.backup('*.dump') }]);
  const r = await sb.run();
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /pg_restore/);
});

test('pg_dump (real pg_restore): a dump with damaged data fails', real, async (t) => {
  const sb = sandbox(t);
  const f = sb.backup('items.dump');
  fs.copyFileSync(FIXTURE, f);
  const fd = fs.openSync(f, 'r+');
  const at = Math.floor(fs.statSync(f).size / 2);
  fs.writeSync(fd, noise(64), 0, 64, at);
  fs.closeSync(fd);
  sb.writeConfig([{ name: 'pg', type: 'pg_dump', source: sb.backup('*.dump') }]);
  const r = await sb.run();
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /pg_restore/);
});

// ---- monitoring ------------------------------------------------------------------------

test('a partial run (--only) never sends ping_success, so it cannot hide a dead nightly job', async (t) => {
  const sb = sandbox(t);
  makeSqlite(sb.backup('a.db'));
  writeFile(sb.backup('b.db'), noise(4096));
  const ping = await recorder(t);
  sb.writeConfig([
    { name: 'a', type: 'sqlite', source: sb.backup('a.db') },
    { name: 'b', type: 'sqlite', source: sb.backup('b.db') },
  ], { notify: { ping_success: `${ping.url}/ok`, ping_fail: `${ping.url}/fail` } });

  let r = await sb.run(['--only', 'a']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(ping.requests.map((q) => q.url), []);

  r = await sb.run(['--only', 'b']);
  assert.equal(r.code, 1);
  assert.deepEqual(ping.requests.map((q) => q.url), ['/fail']);
});

test('a full run still sends ping_success', async (t) => {
  const sb = sandbox(t);
  makeSqlite(sb.backup('a.db'));
  const ping = await recorder(t);
  sb.writeConfig([{ name: 'a', type: 'sqlite', source: sb.backup('a.db') }], { notify: { ping_success: `${ping.url}/ok` } });
  const r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(ping.requests.map((q) => q.url), ['/ok']);
});

// ---- stale backups ---------------------------------------------------------------------

test('a passing backup that is days old and has no max_age prints a warning', async (t) => {
  const sb = sandbox(t);
  age(makeSqlite(sb.backup('app.db')), 10 * 24 * H);
  sb.writeConfig([{ name: 'db', type: 'sqlite', source: sb.backup('*.db') }]);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /db: .*10d old.*no max_age/i);
});

test('no stale warning for a fresh backup, or when max_age is set', async (t) => {
  const sb = sandbox(t);
  makeSqlite(sb.backup('app.db'));
  sb.writeConfig([{ name: 'db', type: 'sqlite', source: sb.backup('*.db') }]);
  let r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /max_age/);

  age(sb.backup('app.db'), 10 * 24 * H);
  sb.writeConfig([{ name: 'db', type: 'sqlite', source: sb.backup('*.db') }], { defaults: { max_age: '26h' } });
  r = await sb.run();
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.stderr, /no max_age/);
});

test('a config error sends no ping at all, so the missed ping_success is what alerts you', async (t) => {
  const sb = sandbox(t);
  const ping = await recorder(t);
  sb.writeConfig([{ name: 'a', type: 'sqlite' }], { notify: { ping_success: `${ping.url}/ok`, ping_fail: `${ping.url}/fail` } });
  const r = await sb.run();
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.deepEqual(ping.requests, []);
});
