import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { emptyPath, makeSqlite, sandbox, writeFile } from '../test-support/helpers.mjs';

test('command: passes on exit 0 and runs in a private temp dir exposed as RESTORE_DRILL_TMP', async (t) => {
  const sb = sandbox(t);
  const seen = sb.path('seen.txt');
  sb.writeConfig([{
    name: 'cmd', type: 'command',
    command: `printf '%s\\n' "$RESTORE_DRILL_TMP" > "${seen}"; pwd -P >> "${seen}"; stat -c %a "$RESTORE_DRILL_TMP" >> "${seen}"`,
  }]);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const [tmp, cwd, mode] = fs.readFileSync(seen, 'utf8').trim().split('\n');
  assert.ok(tmp.startsWith(fs.realpathSync(sb.tmp)), `temp dir ${tmp} should be under the OS temp dir`);
  assert.equal(path.basename(cwd), path.basename(tmp), 'command runs inside the temp dir');
  assert.equal(mode, '700');
  assert.equal(fs.existsSync(tmp), false, 'temp dir removed after the run');
  assert.deepEqual(sb.leftovers(), []);
});

test('command: a non-zero exit fails and shows the command output', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([{ name: 'cmd', type: 'command', command: 'echo "table users is missing" >&2; exit 3' }]);
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /table users is missing/);
  assert.match(r.stdout, /3/);
  const [rec] = sb.history();
  assert.equal(rec.ok, false);
  assert.match(rec.error, /table users is missing/);
});

test('command: argv array form runs without a shell', async (t) => {
  const sb = sandbox(t);
  const out = sb.path('argv.txt');
  sb.writeConfig([{ name: 'cmd', type: 'command', command: ['/bin/sh', '-c', 'echo "$0 $1" > "$2"', 'a b', 'c;d', out] }]);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(fs.readFileSync(out, 'utf8').trim(), 'a b c;d');
});

test('command: a missing executable is a clear error', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([{ name: 'cmd', type: 'command', command: ['no-such-tool-xyz', '--version'] }]);
  const r = await sb.run([], { env: { PATH: emptyPath(sb) } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /no-such-tool-xyz/);
  assert.match(r.stdout, /not found/i);
});

test('command: with a source, RESTORE_DRILL_FILE is a private copy of the newest backup', async (t) => {
  const sb = sandbox(t);
  const src = makeSqlite(sb.backup('app.db'), { rows: 20 });
  const seen = sb.path('seen.txt');
  sb.writeConfig([{
    name: 'cmd', type: 'command', source: sb.backup('*.db'),
    command: `printf '%s\\n' "$RESTORE_DRILL_FILE" > "${seen}"; cmp "$RESTORE_DRILL_FILE" "${src}"`,
  }]);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const staged = fs.readFileSync(seen, 'utf8').trim();
  assert.notEqual(staged, src, 'the command gets a copy, not the original');
  assert.ok(staged.startsWith(fs.realpathSync(sb.tmp)) || staged.startsWith(sb.tmp));
  assert.equal(sb.history()[0].backup_path, src);
});

test('command: a drill without a source records null backup fields', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([{ name: 'cmd', type: 'command', command: 'true' }]);
  await sb.run();
  const [rec] = sb.history();
  assert.equal(rec.backup_path ?? null, null);
  assert.equal(rec.backup_size ?? null, null);
  assert.equal(rec.backup_mtime ?? null, null);
});

test('retries: a drill that fails once then passes is recorded as a pass', async (t) => {
  const sb = sandbox(t);
  const marker = sb.path('marker');
  sb.writeConfig([{
    name: 'flaky', type: 'command', retries: 1, retry_delay: '0s',
    command: `if [ -f "${marker}" ]; then exit 0; fi; touch "${marker}"; echo first try fails >&2; exit 1`,
  }]);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const rows = sb.history();
  assert.equal(rows.length, 1, 'one history line per drill per run');
  assert.equal(rows[0].ok, true);
});

test('retries: without retries the same drill fails', async (t) => {
  const sb = sandbox(t);
  const marker = sb.path('marker');
  sb.writeConfig([{
    name: 'flaky', type: 'command',
    command: `if [ -f "${marker}" ]; then exit 0; fi; touch "${marker}"; exit 1`,
  }]);
  assert.equal((await sb.run()).code, 1);
});

test('timeout: a hung command is killed, reported, and its temp dir removed', async (t) => {
  const sb = sandbox(t);
  const pidfile = sb.path('pid');
  sb.writeConfig([{
    name: 'hang', type: 'command', timeout: '1s',
    command: `echo $$ > "${pidfile}"; sleep 30`,
  }]);
  const started = Date.now();
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /timed out/i);
  assert.ok(Date.now() - started < 20_000, 'did not wait for the sleep to finish');
  assert.deepEqual(sb.leftovers(), []);
  const pid = Number(fs.readFileSync(pidfile, 'utf8'));
  await new Promise((res) => setTimeout(res, 300));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'child process group was killed');
});
