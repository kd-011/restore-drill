import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { changelogSection, planRelease } from '../scripts/release.mjs';

test('release plan: a version npm has not seen is published and released', () => {
  assert.deepEqual(planRelease('0.2.0', [], false), { version: '0.2.0', publish: true, release: true, reason: '0.2.0 is not on npm yet' });
  assert.equal(planRelease('0.2.0', ['0.1.0'], false).publish, true);
});

test('release plan: finishes a half-done release and does nothing when complete', () => {
  assert.deepEqual([planRelease('0.2.0', ['0.2.0'], false).publish, planRelease('0.2.0', ['0.2.0'], false).release], [false, true]);
  const done = planRelease('0.2.0', ['0.2.0'], true);
  assert.deepEqual([done.publish, done.release], [false, false]);
});

test('release plan: refuses to publish an older number over a newer one, and pre-release versions', () => {
  assert.throws(() => planRelease('0.1.5', ['0.2.0'], false), /older than 0\.2\.0/);
  assert.throws(() => planRelease('1.0.0-rc.1', [], false), /not x\.y\.z/);
});

test('changelog section works with plain and bracketed headings and stops at the next one', () => {
  const text = '# Changelog\n\n## Unreleased\n\n- later\n\n## 0.2.0 - 2026-11-03\n\n- new\n\n## [0.1.0]\n\n- old\n';
  assert.equal(changelogSection(text, '0.2.0'), '- new');
  assert.equal(changelogSection(text, '0.1.0'), '- old');
  assert.throws(() => changelogSection(text, '9.9.9'), /no "## 9\.9\.9" section/);
});

test('the package.json version has a CHANGELOG section release notes can be built from', () => {
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(changelogSection(fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), version).length > 0);
});

test('the publish workflow can be run by hand and ends green when there is no token and no package', () => {
  const y = fs.readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  assert.match(y, /workflow_dispatch:/);
  assert.match(y, /-z "\$NPM_TOKEN"/);
  assert.match(y, /npm view restore-drill version/);
  assert.match(y, /::notice /);
});
