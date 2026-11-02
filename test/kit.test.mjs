// Acceptance tests for the maintenance kit: Dependabot config, the auto-merge
// gate, CI shape, the weekly upkeep job, hygiene files and the self-dossier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const WORKFLOWS = readdirSync(join(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml'));
const GATE = join(ROOT, '.github/scripts/automerge-eligible.mjs');

test('dependabot: weekly, grouped minor and patch, with a cooldown', () => {
  const y = read('.github/dependabot.yml');
  assert.match(y, /package-ecosystem: github-actions/);
  assert.match(y, /interval: weekly/);
  assert.doesNotMatch(y, /interval: (daily|monthly)/);
  assert.match(y, /cooldown:\s*\n\s+default-days: 7/);
  assert.match(y, /groups:[\s\S]*update-types:[\s\S]*- minor[\s\S]*- patch/);
});

test('automerge workflow: pull_request only, dependabot author, same-repo head', () => {
  const y = read('.github/workflows/dependabot-automerge.yml').replace(/^\s*#.*$/gm, '');
  assert.match(y, /^on:\s*\n\s+pull_request:/m);
  assert.doesNotMatch(y, /pull_request_target/);
  assert.match(y, /github\.event\.pull_request\.user\.login == 'dependabot\[bot\]'/);
  assert.match(y, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(y, /gh pr merge --auto --squash/);
  assert.match(y, /^permissions: \{\}/m, 'top-level permissions must be empty');
});

test('no workflow expands attacker-controlled PR or issue text', () => {
  const UNTRUSTED = /\$\{\{\s*github\.(head_ref|event\.(pull_request\.(title|body|head\.(ref|label))|issue\.(title|body)|comment\.body|review\.body))/;
  for (const f of WORKFLOWS) assert.doesNotMatch(read(`.github/workflows/${f}`), UNTRUSTED, f);
});

test('every third-party action is pinned by full SHA', () => {
  for (const f of WORKFLOWS) {
    for (const m of read(`.github/workflows/${f}`).matchAll(/uses:\s*([^\s#]+)/g)) {
      const ref = m[1];
      if (ref.startsWith('actions/') || ref.startsWith('./')) continue;
      assert.match(ref, /@[0-9a-f]{40}$/, `${f}: ${ref}`);
    }
  }
});

test('every job in every workflow declares least-privilege permissions', () => {
  for (const f of WORKFLOWS) {
    const y = read(`.github/workflows/${f}`);
    assert.match(y, /^permissions:/m, `${f} needs top-level permissions`);
    assert.doesNotMatch(y, /permissions:\s*write-all/);
  }
});

const gate = (deps) => spawnSync(process.execPath, [GATE], { env: { ...process.env, DEPS: JSON.stringify(deps) }, encoding: 'utf8' });
const dep = (packageEcosystem, dependencyName, updateType) => ({ packageEcosystem, dependencyName, updateType });

test('gate: npm and go patch and minor merge, majors wait for a human', () => {
  assert.equal(gate([dep('npm_and_yarn', 'left-pad', 'version-update:semver-patch')]).status, 0);
  assert.equal(gate([dep('npm_and_yarn', 'left-pad', 'version-update:semver-minor')]).status, 0);
  assert.equal(gate([dep('go_modules', 'golang.org/x/text', 'version-update:semver-minor')]).status, 0);
  assert.notEqual(gate([dep('npm_and_yarn', 'left-pad', 'version-update:semver-major')]).status, 0);
  assert.notEqual(gate([dep('go_modules', 'golang.org/x/text', 'version-update:semver-major')]).status, 0);
});

test('gate: github-actions merge only from the actions/ org, majors included', () => {
  assert.equal(gate([dep('github_actions', 'actions/checkout', 'version-update:semver-major')]).status, 0);
  assert.equal(gate([dep('github_actions', 'actions/setup-node', 'version-update:semver-minor')]).status, 0);
  assert.notEqual(gate([dep('github_actions', 'someone/else', 'version-update:semver-patch')]).status, 0);
  assert.notEqual(gate([dep('github_actions', 'actions-evil/checkout', 'version-update:semver-major')]).status, 0);
  assert.notEqual(gate([dep('github_actions', 'dependabot/fetch-metadata', 'version-update:semver-major')]).status, 0);
});

test('gate: one ineligible dependency in a group blocks the whole PR', () => {
  const mixed = [dep('npm_and_yarn', 'a', 'version-update:semver-patch'), dep('npm_and_yarn', 'b', 'version-update:semver-major')];
  assert.notEqual(gate(mixed).status, 0);
});

test('gate: empty, malformed or missing metadata never merges', () => {
  assert.notEqual(gate([]).status, 0);
  assert.notEqual(spawnSync(process.execPath, [GATE], { env: { ...process.env, DEPS: 'not json' }, encoding: 'utf8' }).status, 0);
  const noEnv = { ...process.env };
  delete noEnv.DEPS;
  assert.notEqual(spawnSync(process.execPath, [GATE], { env: noEnv, encoding: 'utf8' }).status, 0);
  assert.notEqual(gate([dep('npm_and_yarn', 'a', '')]).status, 0);
  assert.notEqual(gate([{ packageEcosystem: 'docker', dependencyName: 'node', updateType: 'version-update:semver-patch' }]).status, 0);
});

test('ci: runs on a weekly schedule and the matrix names match the ruleset', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /schedule:\s*\n\s+- cron:/);
  assert.match(ci, /name: node --test \(\$\{\{ matrix\.os \}\}, node \$\{\{ matrix\.node \}\}\)/);
  const os = [...ci.match(/os: \[([^\]]+)\]/)[1].split(',')].map((s) => s.trim());
  const node = [...ci.match(/node: \[([^\]]+)\]/)[1].split(',')].map((s) => s.trim());
  const names = os.flatMap((o) => node.map((n) => `node --test (${o}, node ${n})`)).sort();
  const ruleset = JSON.parse(read('.github/rulesets/main.json'));
  const rule = ruleset.rules.find((r) => r.type === 'required_status_checks');
  assert.deepEqual(rule.parameters.required_status_checks.map((c) => c.context).sort(), names);
  assert.deepEqual(ruleset.bypass_actors, [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }]);
  assert.equal(ruleset.target, 'branch');
  assert.deepEqual(ruleset.conditions.ref_name.include, ['refs/heads/main']);
  assert.match(read('README.md'), /actions\/workflows\/ci\.yml\/badge\.svg/);
});

test('upkeep: weekly, link check plus drift, pinned install, one issue each', () => {
  const y = read('.github/workflows/upkeep.yml');
  assert.match(y, /schedule:\s*\n\s+- cron: "[^"]+ \* \* \d"/);
  assert.match(y, /lycheeverse\/lychee-action@[0-9a-f]{40}/);
  assert.match(y, /--max-retries/);
  assert.match(y, /npm install -g github:kd-011\/dossier-scribe#v\d+\.\d+\.\d+\b/);
  assert.doesNotMatch(y, /dossier-scribe#(main|master)\b/);
  assert.match(y, /sync-issue\.sh link-rot/);
  assert.match(y, /sync-issue\.sh dossier-drift/);
  assert.ok(existsSync(join(ROOT, '.github/scripts/sync-issue.sh')));
});

test('hygiene files and templates exist', () => {
  for (const f of ['CODE_OF_CONDUCT.md', 'SECURITY.md', 'CHANGELOG.md', '.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/config.yml']) {
    assert.ok(existsSync(join(ROOT, f)), f);
  }
  const sec = read('SECURITY.md');
  assert.match(sec, /private vulnerability reporting/i);
  assert.doesNotMatch(sec, /[\w.+-]+@[\w-]+\.[\w.]+/, 'no email address in SECURITY.md');
});

test('social preview is a 1280x640 PNG', () => {
  const b = readFileSync(join(ROOT, '.github/social-preview.png'));
  assert.equal(b.subarray(1, 4).toString(), 'PNG');
  assert.equal(b.readUInt32BE(16), 1280);
  assert.equal(b.readUInt32BE(20), 640);
});

test('self dossier: 5 to 15 cited claims and a lock entry for every one', () => {
  const doc = read('dossiers/restore-drill.md');
  assert.match(doc, /^slug: restore-drill$/m);
  const claims = doc.split('\n').filter((l) => /^- .*<!-- src: [^>]+-->/.test(l));
  assert.ok(claims.length >= 5 && claims.length <= 15, `claims: ${claims.length}`);
  const lock = JSON.parse(read('dossiers/.dossier-lock.json'));
  assert.equal(Object.keys(lock.docs['restore-drill'].claims).length, claims.length);
  assert.deepEqual(JSON.parse(read('dossier-scribe.json')).collectors, ['package']);
});

test('release: CHANGELOG has an entry for the package.json version', () => {
  const { version } = JSON.parse(read('package.json'));
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${version.replaceAll('.', '\\.')}\\b`, 'm'));
});

// sync-issue.sh against a stub `gh`: the stub reports one existing open issue (or none)
// and records every call it receives.
function runSync({ existing, existingBody = '', args }) {
  const dir = tmp('sync-issue-');
  const log = join(dir, 'calls.log');
  const stub = `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "label create") exit 0 ;;
  "issue list") echo '${JSON.stringify(existing ? [{ number: 7, title: 'T' }] : [])}' ;;
  "issue view") printf '%s' '${existingBody}' ;;
esac
`;
  writeFileSync(join(dir, 'gh'), stub, { mode: 0o755 });
  writeFileSync(join(dir, 'body.md'), 'problem text\n');
  const r = spawnSync('sh', [join(ROOT, '.github/scripts/sync-issue.sh'), 'lbl', 'T', ...args.map((a) => (a === 'BODY' ? join(dir, 'body.md') : a))], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => /^issue (create|edit|close)/.test(l)) : [];
  return { status: r.status, calls };
}

const HAS_JQ = spawnSync('jq', ['--version']).status === 0;

test('sync-issue: opens one issue for a problem, never duplicates, closes when clean', { skip: !HAS_JQ && 'jq not installed' }, () => {
  assert.deepEqual(runSync({ existing: false, args: ['BODY'] }).calls.map((c) => c.split(' ').slice(0, 2).join(' ')), ['issue create']);
  assert.deepEqual(runSync({ existing: true, existingBody: 'old', args: ['BODY'] }).calls.map((c) => c.split(' ').slice(0, 3).join(' ')), ['issue edit 7']);
  assert.deepEqual(runSync({ existing: true, existingBody: 'problem text', args: ['BODY'] }).calls, [], 'unchanged body is left alone');
  assert.deepEqual(runSync({ existing: true, args: [] }).calls.map((c) => c.split(' ').slice(0, 3).join(' ')), ['issue close 7']);
  assert.deepEqual(runSync({ existing: false, args: [] }).calls, [], 'a clean run with no issue does nothing');
});
