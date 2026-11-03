// This repo is published publicly. Nothing personal may be in the tree or the history.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

// Hashed, so the guard does not publish the name it guards against.
const NAME_HASHES = [
  'bb44bf07cf9a2db0554bba63a03d822c927deae77df101874496df5a6a3e896d',
  'c901b5fc9df5467fa2725d5d93d8d148961eab15c01a52ad8048a07ab395f83b',
];
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Checks every 4 and 5 letter run, so a part is found inside a longer word or an address.
export function containsHashed(text, hashes) {
  const wanted = new Set(hashes);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    for (const len of [4, 5]) {
      for (let i = 0; i + len <= word.length; i++) {
        if (wanted.has(sha256(word.slice(i, i + len)))) return true;
      }
    }
  }
  return false;
}

// kd-011 in commits made locally. GitHub writes the profile's display name on web merges.
const OWNER_NAMES = new Set(['kd-011', 'KD011']);

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
    if (containsHashed(text, NAME_HASHES)) hits.push(`${f}: personal name`);
    if (text.includes(EM_DASH)) hits.push(`${f}: em dash`);
  }
  assert.deepEqual(hits, []);
});

// Two kinds of commit are made by GitHub, not by this repo's author: a Dependabot
// update (author dependabot[bot]) and anything merged with the web UI or auto-merge
// (committer GitHub). Both carry no personal address. Dependabot's message body is
// third-party release notes, so only the identity is checked for those.
export function commitProblems({ an, ae, cn, body }) {
  const bot = an === 'dependabot[bot]';
  const problems = [];
  if (!OWNER_NAMES.has(an) && !bot) problems.push(`author ${an}`);
  if (!OWNER_NAMES.has(cn) && cn !== 'GitHub') problems.push(`committer ${cn}`);
  if (!bot && !/@users\.noreply\.github\.com$/.test(ae)) problems.push(`email ${ae}`);
  if (!bot && /claude|anthropic|co-authored-by|generated with/i.test(body)) problems.push('AI trailer');
  if (!bot && body.includes(EM_DASH)) problems.push('em dash');
  if (!bot && containsHashed(body, NAME_HASHES)) problems.push('personal name');
  return problems;
}

test('every commit is authored by the public identity with no AI trailers', { skip: !inRepo }, () => {
  const log = git('log', '--format=%an%x1f%ae%x1f%cn%x1f%B%x1e').stdout;
  for (const entry of log.split('\x1e').map((e) => e.trim()).filter(Boolean)) {
    const [an, ae, cn, body] = entry.split('\x1f');
    assert.deepEqual(commitProblems({ an, ae, cn, body }), [], body.split('\n')[0]);
  }
});

test('commit identity rule: bots and web merges pass, anyone else does not', () => {
  const ok = { an: 'kd-011', ae: '1+kd-011@users.noreply.github.com', cn: 'kd-011', body: 'Fix a thing' };
  assert.deepEqual(commitProblems(ok), []);
  assert.deepEqual(commitProblems({ ...ok, an: 'KD011', cn: 'KD011' }), []);
  assert.deepEqual(commitProblems({ ...ok, cn: 'GitHub' }), []);
  assert.deepEqual(commitProblems({ an: 'dependabot[bot]', ae: 'x@users.noreply.github.com', cn: 'GitHub', body: `notes ${EM_DASH}` }), []);
  assert.notDeepEqual(commitProblems({ ...ok, an: 'Someone Else' }), []);
  assert.notDeepEqual(commitProblems({ ...ok, ae: 'person@example.com' }), []);
  assert.notDeepEqual(commitProblems({ ...ok, cn: 'Someone Else' }), []);
  assert.notDeepEqual(commitProblems({ ...ok, body: 'Co-Authored-By: a bot' }), []);
  assert.notDeepEqual(commitProblems({ ...ok, body: `a ${EM_DASH} b` }), []);
  assert.notDeepEqual(commitProblems({ an: 'dependabot[bot]', ae: 'x@users.noreply.github.com', cn: 'Someone Else', body: '' }), []);
});

test('hashed name check finds a part inside a longer word, and nothing else', () => {
  const hashes = [sha256('abcd'), sha256('efghi')];
  assert.equal(containsHashed('mail XABCDY at example', hashes), true);
  assert.equal(containsHashed('efghi', hashes), true);
  assert.equal(containsHashed('abc efgh', hashes), false);
});
