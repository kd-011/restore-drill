import assert from 'node:assert/strict';
import { test } from 'node:test';
import { have, makeTar, makeZip, noise, sandbox, truncate, writeFile } from '../test-support/helpers.mjs';

const files = () => ({
  'config/app.json': '{"ok":true}',
  'data/blob.bin': noise(200_000),
  'data/readme.txt': 'hello',
});

const drill = (sb, extra = {}) =>
  sb.writeConfig([{ name: 'site', type: 'tar', source: sb.backup('site-*'), ...extra }]);

test('tar: a good tar.gz restores and expected paths exist', async (t) => {
  const sb = sandbox(t);
  makeTar(sb.backup('site-1.tar.gz'), files());
  drill(sb, { expect_paths: ['config/app.json', 'data/readme.txt'], min_files: 3 });
  const r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(sb.history()[0].ok, true);
  assert.deepEqual(sb.leftovers(), []);
});

test('tar: plain .tar and .tgz are accepted', async (t) => {
  const sb = sandbox(t);
  makeTar(sb.backup('site-1.tar'), files(), { compress: 'none' });
  drill(sb, { expect_paths: ['config/app.json'] });
  let r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);

  makeTar(sb.backup('site-2.tgz'), files());
  r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(sb.history().at(-1).backup_path, /site-2\.tgz$/);
});

test('tar: a truncated tar.gz fails with the tool error text', async (t) => {
  const sb = sandbox(t);
  const f = makeTar(sb.backup('site-1.tar.gz'), files());
  truncate(f, 0.5);
  drill(sb, { expect_paths: ['config/app.json'] });
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /unexpected end|unexpected eof|truncated|premature/i);
  assert.match(r.stdout, /tar/i);
  assert.deepEqual(sb.leftovers(), []);
});

test('tar: an empty file fails', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('site-1.tar.gz'), '');
  drill(sb);
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /empty/i);
});

test('tar: a missing expected path fails and names the path', async (t) => {
  const sb = sandbox(t);
  makeTar(sb.backup('site-1.tar.gz'), files());
  drill(sb, { expect_paths: ['config/app.json', 'config/secrets.json'] });
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /config\/secrets\.json/);
});

test('tar: expect_paths accepts a glob', async (t) => {
  const sb = sandbox(t);
  makeTar(sb.backup('site-1.tar.gz'), files());
  drill(sb, { expect_paths: ['data/*.bin'] });
  assert.equal((await sb.run()).code, 0);
  drill(sb, { expect_paths: ['data/*.sql'] });
  assert.equal((await sb.run()).code, 1);
});

test('tar: min_files is enforced', async (t) => {
  const sb = sandbox(t);
  makeTar(sb.backup('site-1.tar.gz'), files());
  drill(sb, { min_files: 4 });
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /3 files|min_files/i);
});

test('tar: expect_paths cannot escape the restore directory', async (t) => {
  const sb = sandbox(t);
  makeTar(sb.backup('site-1.tar.gz'), files());
  drill(sb, { expect_paths: ['../../etc/passwd'] });
  const r = await sb.run();
  assert.equal(r.code, 2);
  assert.match(r.stderr, /expect_paths/);
});

test('tar: zip archives are listed and extracted', { skip: !have('zip') || !have('unzip') }, async (t) => {
  const sb = sandbox(t);
  makeZip(sb.backup('site-1.zip'), files());
  drill(sb, { expect_paths: ['config/app.json'] });
  let r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);

  truncate(sb.backup('site-1.zip'), 0.5);
  r = await sb.run();
  assert.equal(r.code, 1);
});
