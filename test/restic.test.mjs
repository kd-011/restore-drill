import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyPath, have, noise, sandbox, sh, stubBin, writeFile } from '../test-support/helpers.mjs';

const skip = !have('restic');

function repo(sb) {
  const env = { ...process.env, RESTIC_PASSWORD: 'hunter2-test-pw', RESTIC_CACHE_DIR: sb.path('cache') };
  const dir = sb.path('repo');
  const data = sb.path('data');
  writeFile(sb.path('data', 'config', 'app.json'), '{"a":1}');
  writeFile(sb.path('data', 'blob.bin'), noise(50_000));
  sh('restic', ['init', '--repo', dir, '-q'], { env });
  sh('restic', ['backup', '--repo', dir, '-q', data], { env });
  return { dir, data, rel: data.replace(/^\//, '') };
}

const runEnv = (sb) => ({ env: { TEST_PW: 'hunter2-test-pw', RESTIC_CACHE_DIR: sb.path('cache') } });

test('restic: restores the latest snapshot and finds expected paths', { skip }, async (t) => {
  const sb = sandbox(t);
  const r0 = repo(sb);
  sb.writeConfig([{
    name: 'nas', type: 'restic', source: r0.dir, password_env: 'TEST_PW',
    expect_paths: [`${r0.rel}/config/app.json`], read_data_subset: '100%',
  }]);
  const r = await sb.run([], runEnv(sb));
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const [rec] = sb.history();
  assert.equal(rec.ok, true);
  assert.ok(Number.isFinite(Date.parse(rec.backup_mtime)), 'snapshot time recorded as backup_mtime');
  assert.deepEqual(sb.leftovers(), []);
});

test('restic: include limits the restore, missing expected path fails', { skip }, async (t) => {
  const sb = sandbox(t);
  const r0 = repo(sb);
  sb.writeConfig([{
    name: 'nas', type: 'restic', source: r0.dir, password_env: 'TEST_PW',
    include: [`${r0.data}/config`], expect_paths: [`${r0.rel}/blob.bin`],
  }]);
  const r = await sb.run([], runEnv(sb));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /blob\.bin/);
});

test('restic: a wrong password fails with the restic error and never prints the password', { skip }, async (t) => {
  const sb = sandbox(t);
  const r0 = repo(sb);
  sb.writeConfig([{
    name: 'nas', type: 'restic', source: r0.dir, password_env: 'TEST_PW', expect_paths: [r0.rel],
  }]);
  const r = await sb.run([], { env: { TEST_PW: 'definitely-wrong-pw', RESTIC_CACHE_DIR: sb.path('cache') } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /password|key/i);
  assert.doesNotMatch(r.stdout + r.stderr, /definitely-wrong-pw|hunter2-test-pw/);
});

test('restic: password_file works', { skip }, async (t) => {
  const sb = sandbox(t);
  const r0 = repo(sb);
  writeFile(sb.path('pw'), 'hunter2-test-pw\n');
  sb.writeConfig([{
    name: 'nas', type: 'restic', source: r0.dir, password_file: sb.path('pw'), expect_paths: [r0.rel],
  }]);
  const r = await sb.run([], { env: { RESTIC_CACHE_DIR: sb.path('cache') } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

test('restic: no password configured is a clear error', { skip }, async (t) => {
  const sb = sandbox(t);
  const r0 = repo(sb);
  sb.writeConfig([{ name: 'nas', type: 'restic', source: r0.dir, expect_paths: [r0.rel] }]);
  const env = { RESTIC_PASSWORD: '', RESTIC_PASSWORD_FILE: '', RESTIC_PASSWORD_COMMAND: '' };
  const r = await sb.run([], { env });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /password/i);
});

test('restic: a secret in the repository URL is redacted from output and history', async (t) => {
  const sb = sandbox(t);
  const stub = stubBin(sb, {
    restic: 'echo "Fatal: unable to open repo at $RESTIC_REPOSITORY $*" >&2\nexit 1',
  });
  sb.writeConfig([{
    name: 'nas', type: 'restic', source: 'rest:http://user:s3cr3tpass@127.0.0.1:9/repo',
    password_env: 'TEST_PW', expect_paths: ['x'],
  }]);
  const r = await sb.run([], { env: { PATH: `${stub}:${process.env.PATH}`, TEST_PW: 'pw' } });
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.stdout + r.stderr, /s3cr3tpass/);
  assert.doesNotMatch(JSON.stringify(sb.history()), /s3cr3tpass/);
});

test('restic: a missing restic binary is a clear error', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([{
    name: 'nas', type: 'restic', source: sb.path('repo'), password_env: 'TEST_PW', expect_paths: ['x'],
  }]);
  const r = await sb.run([], { env: { PATH: emptyPath(sb), TEST_PW: 'pw' } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /restic/);
  assert.match(r.stdout, /not found/i);
  assert.doesNotMatch(r.stderr, /at .*\.mjs/);
});

test('restic: expect_paths is required', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([{ name: 'nas', type: 'restic', source: sb.path('repo'), password_env: 'TEST_PW' }]);
  const r = await sb.run();
  assert.equal(r.code, 2);
  assert.match(r.stderr, /expect_paths/);
});
