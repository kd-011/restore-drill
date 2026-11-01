import assert from 'node:assert/strict';
import fs from 'node:fs';
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
