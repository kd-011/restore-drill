// This repo is published publicly. Nothing personal may be in the tree or the history.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
const inRepo = git('rev-parse', '--git-dir').status === 0;

// Built from pieces so this file does not trip its own scan.
const FORBIDDEN = [
  ['gma', 'il'], ['/ho', 'me/'],
].map((p) => p.join(''));
const EM_DASH = String.fromCharCode(0x2014);

function trackedTextFiles() {
  const r = git('ls-files', '-z', '--cached', '--others', '--exclude-standard');
  return r.stdout.split('\0').filter(Boolean).filter((f) => {
    if (/\.(png|jpg|jpeg|gif|ico|webp)$/i.test(f)) return false;
    return fs.existsSync(path.join(root, f));
  });
}

test('no personal data or em dashes anywhere in the tree', { skip: !inRepo }, () => {
  const hits = [];
  for (const f of trackedTextFiles()) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    const lower = text.toLowerCase();
    for (const word of FORBIDDEN) if (lower.includes(word)) hits.push(`${f}: ${word}`);
    if (text.includes(EM_DASH)) hits.push(`${f}: em dash`);
  }
  assert.deepEqual(hits, []);
});

test('every commit is authored by the public identity with no AI trailers', { skip: !inRepo }, () => {
  const log = git('log', '--format=%an%x1f%ae%x1f%cn%x1f%B%x1e').stdout;
  for (const entry of log.split('\x1e').map((e) => e.trim()).filter(Boolean)) {
    const [an, ae, cn, body] = entry.split('\x1f');
    assert.equal(an, 'KD011');
    assert.equal(cn, 'KD011');
    assert.match(ae, /@users\.noreply\.github\.com$/);
    assert.doesNotMatch(body, /claude|anthropic|co-authored-by|generated with/i);
    assert.doesNotMatch(body, new RegExp(EM_DASH));
  }
});
