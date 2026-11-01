import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { emptyPath, sandbox, stubBin, writeFile } from '../test-support/helpers.mjs';

// pg_restore is not assumed to be installed: these tests put small stub
// executables first on PATH and check what restore-drill asks of them.
const PG_RESTORE_LIST = `
for a; do f=$a; done
if [ "$1" = "--list" ]; then
  if grep -q BADDUMP "$f"; then echo "pg_restore: error: input file does not appear to be a valid archive" >&2; exit 1; fi
  echo ";"; echo "; Archive created at 2026-01-01"; echo ";     dbname: app"
  i=0; while [ $i -lt \${STUB_ENTRIES:-6} ]; do echo "$i; 1259 1638$i TABLE public t$i app"; i=$((i+1)); done
  exit 0
fi
echo "pg_restore $*" >> "$STUB_LOG"
echo "PGPASSWORD_SET=\${PGPASSWORD:+yes} PGHOST=$PGHOST PGUSER=$PGUSER" >> "$STUB_LOG"
exit \${STUB_RESTORE_EXIT:-0}
`;

const PSQL = `
echo "psql $*" >> "$STUB_LOG"
case "$*" in *SELECT*) echo "\${STUB_COUNT:-5}";; esac
exit 0
`;

const base = (sb, extra = {}) => sb.writeConfig([{ name: 'pg', type: 'pg_dump', source: sb.backup('*.dump'), ...extra }]);
const withStubs = (sb, env = {}) => {
  const dir = stubBin(sb, { pg_restore: PG_RESTORE_LIST, psql: PSQL });
  return { env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: sb.path('stub.log'), ...env } };
};

test('pg_dump: pg_restore --list succeeds with enough entries', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('app.dump'), 'PGDMP fake');
  base(sb, { min_entries: 5 });
  const r = await sb.run([], withStubs(sb));
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

test('pg_dump: too few entries fails', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('app.dump'), 'PGDMP fake');
  base(sb, { min_entries: 10 });
  const r = await sb.run([], withStubs(sb));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /6 entries|min_entries/i);
});

test('pg_dump: pg_restore errors are reported verbatim', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('app.dump'), 'BADDUMP');
  base(sb);
  const r = await sb.run([], withStubs(sb));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /does not appear to be a valid archive/);
});

test('pg_dump: an empty or missing dump fails before pg_restore runs', async (t) => {
  const sb = sandbox(t);
  base(sb);
  let r = await sb.run([], withStubs(sb));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /no backup found/i);
  writeFile(sb.backup('app.dump'), '');
  r = await sb.run([], withStubs(sb));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /empty/i);
});

test('pg_dump: restore_url restores into a freshly named throwaway database and drops it', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('app.dump'), 'PGDMP fake');
  base(sb, {
    restore_url: 'postgres://scratch:Sup3rSecret@db.example.test:5433/postgres',
    restore_checks: [{ sql: 'SELECT count(*) FROM t0', min: 3 }],
  });
  const r = await sb.run([], withStubs(sb));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const log = fs.readFileSync(sb.path('stub.log'), 'utf8');
  assert.match(log, /CREATE DATABASE "?restore_drill_[a-z0-9_]+/i);
  assert.match(log, /DROP DATABASE .*restore_drill_[a-z0-9_]+/i);
  assert.match(log, /pg_restore .*restore_drill_/);
  assert.match(log, /PGPASSWORD_SET=yes PGHOST=db\.example\.test PGUSER=scratch/);
  assert.doesNotMatch(log, /Sup3rSecret/, 'password must travel in the environment, not argv');
  assert.doesNotMatch(r.stdout + r.stderr, /Sup3rSecret/);
});

test('pg_dump: restore_checks failing drops the database and fails', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('app.dump'), 'PGDMP fake');
  base(sb, {
    restore_url: 'postgres://scratch@127.0.0.1/postgres',
    restore_checks: [{ sql: 'SELECT count(*) FROM t0', min: 3 }],
  });
  const r = await sb.run([], withStubs(sb, { STUB_COUNT: '1' }));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /SELECT count\(\*\) FROM t0/);
  assert.match(fs.readFileSync(sb.path('stub.log'), 'utf8'), /DROP DATABASE/i);
});

test('pg_dump: a failing restore still drops the throwaway database', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('app.dump'), 'PGDMP fake');
  base(sb, { restore_url: 'postgres://scratch@127.0.0.1/postgres' });
  const r = await sb.run([], withStubs(sb, { STUB_RESTORE_EXIT: '1' }));
  assert.equal(r.code, 1);
  assert.match(fs.readFileSync(sb.path('stub.log'), 'utf8'), /DROP DATABASE/i);
});

test('pg_dump: missing pg_restore is a clear error', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('app.dump'), 'PGDMP fake');
  base(sb);
  const r = await sb.run([], { env: { PATH: emptyPath(sb) } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /pg_restore/);
  assert.match(r.stdout, /not found/i);
  assert.doesNotMatch(r.stderr, /at .*\.mjs/);
});

test('pg_dump: missing psql is a clear error when restore_url is set', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('app.dump'), 'PGDMP fake');
  base(sb, { restore_url: 'postgres://scratch@127.0.0.1/postgres' });
  const dir = stubBin(sb, { pg_restore: PG_RESTORE_LIST });
  const r = await sb.run([], { env: { PATH: dir, STUB_LOG: sb.path('stub.log') } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /psql/);
  assert.match(r.stdout, /not found/i);
});
