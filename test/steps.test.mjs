import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { test } from 'node:test';
import { emptyPath, have, makeSqlite, makeTar, noise, sandbox, sh, writeFile } from '../test-support/helpers.mjs';

function gz(src, dest) {
  fs.writeFileSync(dest, zlib.gzipSync(fs.readFileSync(src)));
}

test('decompress: a .db.gz is gunzipped before the sqlite check', async (t) => {
  const sb = sandbox(t);
  makeSqlite(sb.path('plain.db'));
  gz(sb.path('plain.db'), sb.backup('app.db.gz'));
  sb.writeConfig([{ name: 'db', type: 'sqlite', source: sb.backup('*.db.gz'), decompress: true, table_exists: 'users' }]);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(sb.leftovers(), []);
});

test('decompress: a corrupt gzip fails with the error text', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('app.db.gz'), noise(5000));
  sb.writeConfig([{ name: 'db', type: 'sqlite', source: sb.backup('*.gz'), decompress: true }]);
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /gzip|incorrect header|decompress/i);
});

test('decompress: zstd', { skip: !have('zstd') }, async (t) => {
  const sb = sandbox(t);
  makeSqlite(sb.path('plain.db'));
  sh('zstd', ['-q', '-o', sb.backup('app.db.zst'), sb.path('plain.db')]);
  sb.writeConfig([{ name: 'db', type: 'sqlite', source: sb.backup('*.zst'), decompress: true }]);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

test('decompress: xz', { skip: !have('xz') }, async (t) => {
  const sb = sandbox(t);
  makeSqlite(sb.path('plain.db'));
  sh('xz', ['-k', '-q', '-c', sb.path('plain.db')], { stdio: ['ignore', fs.openSync(sb.backup('app.db.xz'), 'w'), 'pipe'] });
  sb.writeConfig([{ name: 'db', type: 'sqlite', source: sb.backup('*.xz'), decompress: true }]);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

test('decompress: a missing zstd binary is a clear error, not a crash', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('app.db.zst'), 'not really zstd');
  sb.writeConfig([{ name: 'db', type: 'sqlite', source: sb.backup('*.zst'), decompress: true }]);
  const r = await sb.run([], { env: { PATH: emptyPath(sb) } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /zstd/);
  assert.match(r.stdout, /not found/i);
  assert.doesNotMatch(r.stderr, /at .*\.mjs/);
});

test('decompress: an unknown extension is a clear error', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('app.db.rar'), 'data');
  sb.writeConfig([{ name: 'db', type: 'sqlite', source: sb.backup('*.rar'), decompress: true }]);
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /\.rar|extension|unsupported/i);
});

test('decrypt: age with an identity file, then sqlite check', { skip: !have('age') || !have('age-keygen') }, async (t) => {
  const sb = sandbox(t);
  const key = sb.path('key.txt');
  sh('age-keygen', ['-o', key]);
  const pub = /public key: (age1\w+)/.exec(fs.readFileSync(key, 'utf8'))[1];
  makeSqlite(sb.path('plain.db'));
  sh('age', ['-r', pub, '-o', sb.backup('app.db.age'), sb.path('plain.db')]);
  sb.writeConfig([{
    name: 'db', type: 'sqlite', source: sb.backup('*.age'),
    decrypt: { type: 'age', identity: key }, table_exists: 'users',
  }]);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(sb.leftovers(), []);
});

test('decrypt: age then decompress then tar', { skip: !have('age') || !have('age-keygen') }, async (t) => {
  const sb = sandbox(t);
  const key = sb.path('key.txt');
  sh('age-keygen', ['-o', key]);
  const pub = /public key: (age1\w+)/.exec(fs.readFileSync(key, 'utf8'))[1];
  makeTar(sb.path('plain.tar'), { 'a/b.txt': 'hi there' }, { compress: 'none' });
  gz(sb.path('plain.tar'), sb.path('site.tar.gz'));
  sh('age', ['-r', pub, '-o', sb.backup('site.tar.gz.age'), sb.path('site.tar.gz')]);
  sb.writeConfig([{
    name: 'site', type: 'tar', source: sb.backup('*.age'),
    decrypt: { type: 'age', identity: key }, decompress: true, expect_paths: ['a/b.txt'],
  }]);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

test('decrypt: the wrong age identity fails with the age error', { skip: !have('age') || !have('age-keygen') }, async (t) => {
  const sb = sandbox(t);
  const key = sb.path('key.txt');
  const other = sb.path('other.txt');
  sh('age-keygen', ['-o', key]);
  sh('age-keygen', ['-o', other]);
  const pub = /public key: (age1\w+)/.exec(fs.readFileSync(key, 'utf8'))[1];
  makeSqlite(sb.path('plain.db'));
  sh('age', ['-r', pub, '-o', sb.backup('app.db.age'), sb.path('plain.db')]);
  sb.writeConfig([{
    name: 'db', type: 'sqlite', source: sb.backup('*.age'), decrypt: { type: 'age', identity: other },
  }]);
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /age/i);
  assert.match(r.stdout, /no identity matched|decrypt/i);
  assert.deepEqual(sb.leftovers(), []);
});

test('decrypt: gpg with a passphrase file', { skip: !have('gpg') }, async (t) => {
  const sb = sandbox(t);
  const pass = sb.path('pass.txt');
  writeFile(pass, 'correct horse battery staple\n');
  makeSqlite(sb.path('plain.db'));
  const home = fs.mkdtempSync('/tmp/rdg-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.chmodSync(home, 0o700);
  const env = { ...process.env, GNUPGHOME: home };
  sh('gpg', ['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase-file', pass,
    '--symmetric', '--output', sb.backup('app.db.gpg'), sb.path('plain.db')], { env });
  sb.writeConfig([{
    name: 'db', type: 'sqlite', source: sb.backup('*.gpg'),
    decrypt: { type: 'gpg', passphrase_file: pass, homedir: home }, table_exists: 'users',
  }]);
  const r = await sb.run([], { env: { GNUPGHOME: home } });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  sh('gpgconf', ['--kill', 'gpg-agent'], { env });
});

test('decrypt: missing age and gpg binaries are clear errors', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('a.age'), 'x');
  writeFile(sb.backup('b.gpg'), 'x');
  sb.writeConfig([
    { name: 'a', type: 'file', source: sb.backup('*.age'), decrypt: { type: 'age', identity: sb.path('k') } },
    { name: 'b', type: 'file', source: sb.backup('*.gpg'), decrypt: { type: 'gpg' } },
  ]);
  const r = await sb.run([], { env: { PATH: emptyPath(sb) } });
  assert.equal(r.code, 1);
  const lines = r.stdout.split('\n');
  assert.ok(lines.some((l) => /\ba\b/.test(l) && /age/.test(l) && /not found/i.test(l)), r.stdout);
  assert.ok(lines.some((l) => /\bb\b/.test(l) && /gpg/.test(l) && /not found/i.test(l)), r.stdout);
});
