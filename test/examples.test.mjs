import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { EXAMPLE_CONFIG } from '../src/example-config.mjs';

const example = fileURLToPath(new URL('../examples/drills.json', import.meta.url));

test('examples/drills.json is a valid config and matches what init writes', () => {
  const cfg = loadConfig(example);
  assert.ok(cfg.drills.length >= 6);
  assert.deepEqual(JSON.parse(fs.readFileSync(example, 'utf8')), EXAMPLE_CONFIG);
});

test('package.json has a bin entry, no dependencies, and Node 22', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.bin['restore-drill'], 'bin/restore-drill.mjs');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.match(pkg.engines.node, />=\s*22/);
  assert.equal(pkg.license, 'MIT');
});

test('examples/nightly.json is a valid config with alerts and a max_age on every drill', () => {
  const cfg = loadConfig(fileURLToPath(new URL('../examples/nightly.json', import.meta.url)));
  assert.ok(cfg.notify.ntfy && cfg.notify.ping_success && cfg.notify.ping_fail);
  for (const d of cfg.drills) assert.equal(d.max_age, '26h', d.name);
});

test('no tracked file points at the old account name in a URL', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const r = spawnSync('git', ['grep', '-n', '-I', ['github.com/', 'KD011'].join(''), '--', '.'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.stdout, '', 'the old account name is in a URL, the account is kd-011');
});
