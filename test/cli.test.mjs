import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { H, age, sandbox, writeFile } from '../test-support/helpers.mjs';

const ok = (name, extra = {}) => ({ name, type: 'command', command: 'true', ...extra });
const bad = (name, extra = {}) => ({ name, type: 'command', command: 'echo "it broke" >&2; exit 1', ...extra });

test('run: exit 0 when every drill passes, one line per drill', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([ok('alpha'), ok('beta')]);
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /pass.*alpha/i);
  assert.match(lines[1], /pass.*beta/i);
});

test('run: exit 1 when any drill fails and the failure line carries the real error', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([ok('alpha'), bad('beta'), ok('gamma')]);
  const r = await sb.run();
  assert.equal(r.code, 1);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 3, 'a failure does not stop the remaining drills');
  assert.match(lines[1], /fail.*beta.*it broke/i);
  assert.equal(sb.history().length, 3);
});

test('run: --only runs a single drill', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([bad('alpha'), ok('beta')]);
  const r = await sb.run(['--only', 'beta']);
  assert.equal(r.code, 0);
  assert.deepEqual(sb.history().map((h) => h.drill), ['beta']);
});

test('run: --only with an unknown name is a config error', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([ok('alpha')]);
  const r = await sb.run(['--only', 'nope']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /nope/);
  assert.equal(sb.history().length, 0);
});

test('run: --json prints one parseable document and no per-drill lines', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([ok('alpha'), bad('beta')]);
  const r = await sb.run(['--json']);
  assert.equal(r.code, 1);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.ok, false);
  assert.deepEqual(doc.results.map((x) => [x.drill, x.ok]), [['alpha', true], ['beta', false]]);
  assert.match(doc.results[1].error, /it broke/);
});

test('run: history.jsonl gets one line per result with the documented fields', async (t) => {
  const sb = sandbox(t);
  const f = writeFile(sb.backup('a.dump'), 'abcdef');
  age(f, 3 * H);
  sb.writeConfig([{ name: 'alpha', type: 'file', source: sb.backup('*.dump') }, bad('beta')]);
  await sb.run();
  await sb.run();
  const raw = fs.readFileSync(`${sb.state}/history.jsonl`, 'utf8');
  assert.equal(raw.trim().split('\n').length, 4);
  for (const rec of sb.history()) {
    for (const key of ['drill', 'ok', 'started', 'duration_ms', 'backup_path', 'backup_size', 'backup_mtime', 'error']) {
      assert.ok(key in rec, `missing ${key} in ${JSON.stringify(rec)}`);
    }
  }
  const alpha = sb.history().find((h) => h.drill === 'alpha');
  assert.equal(alpha.error, null);
  assert.equal(alpha.ok, true);
});

test('run: the default state dir is ./.restore-drill and the config default is ./drills.json', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([ok('alpha')]);
  const r = await sb.cli(['run'], { cwd: sb.root });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(sb.path('.restore-drill', 'history.jsonl')));
});

test('run: the state dir can come from the config file', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([ok('alpha')], { state: 'custom-state' });
  const r = await sb.cli(['run', '--config', sb.config]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(sb.path('custom-state', 'history.jsonl')));
});

test('run: defaults in the config apply to every drill', async (t) => {
  const sb = sandbox(t);
  const f = writeFile(sb.backup('a.dump'), 'data');
  age(f, 60 * H);
  sb.writeConfig([{ name: 'alpha', type: 'file', source: sb.backup('*.dump') }], { defaults: { max_age: '26h' } });
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stdout, /too old|max_age/i);
});

test('run: underscore keys are comments and ignored', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([{ _comment: 'hello', ...ok('alpha') }], { _note: 'top level note' });
  const r = await sb.run();
  assert.equal(r.code, 0, r.stderr);
});

test('run: relative paths in the config resolve against the config file, not the cwd', async (t) => {
  const sb = sandbox(t);
  writeFile(sb.backup('a.dump'), 'data');
  sb.writeConfig([{ name: 'alpha', type: 'file', source: 'backups/*.dump' }]);
  const elsewhere = sb.path('elsewhere');
  fs.mkdirSync(elsewhere);
  const r = await sb.run([], { cwd: elsewhere });
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

const configErrors = [
  ['missing config file', null, /drills\.json|config/i],
  ['invalid JSON', '{ not json', /json/i],
  ['no drills array', '{"drills": 5}', /drills/],
  ['drill without a name', '{"drills":[{"type":"file","source":"/x"}]}', /name/],
  ['unknown type', '{"drills":[{"name":"a","type":"floppy","source":"/x"}]}', /floppy|type/],
  ['file drill without a source', '{"drills":[{"name":"a","type":"file"}]}', /source/],
  ['duplicate names', '{"drills":[{"name":"a","type":"command","command":"true"},{"name":"a","type":"command","command":"true"}]}', /duplicate/i],
  ['a misspelt option', '{"drills":[{"name":"a","type":"file","source":"/x","max_ag":"1h"}]}', /max_ag/],
  ['a bad duration', '{"drills":[{"name":"a","type":"file","source":"/x","max_age":"soon"}]}', /max_age/],
  ['a bad size', '{"drills":[{"name":"a","type":"file","source":"/x","min_size":"lots"}]}', /min_size/],
  ['size_drop out of range', '{"drills":[{"name":"a","type":"file","source":"/x","size_drop":150}]}', /size_drop/],
  ['unknown decrypt type', '{"drills":[{"name":"a","type":"file","source":"/x","decrypt":{"type":"rot13"}}]}', /decrypt/],
  ['age without an identity', '{"drills":[{"name":"a","type":"file","source":"/x","decrypt":{"type":"age"}}]}', /identity/],
  ['command drill without a command', '{"drills":[{"name":"a","type":"command"}]}', /command/],
  ['sqlite check without sql', '{"drills":[{"name":"a","type":"sqlite","source":"/x","checks":[{"min":1}]}]}', /sql/],
  ['unknown notify key', '{"notify":{"smoke_signal":"x"},"drills":[]}', /smoke_signal|notify/],
  ['non-http notify url', '{"notify":{"webhook":"ftp://x"},"drills":[]}', /webhook/],
];

for (const [label, content, pattern] of configErrors) {
  test(`config error exits 2: ${label}`, async (t) => {
    const sb = sandbox(t);
    if (content !== null) fs.writeFileSync(sb.config, content);
    const r = await sb.run();
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, pattern);
    assert.equal(r.stdout.trim(), '');
    assert.equal(sb.history().length, 0, 'nothing runs when the config is invalid');
  });
}

test('config errors are all reported together', async (t) => {
  const sb = sandbox(t);
  fs.writeFileSync(sb.config, JSON.stringify({ drills: [
    { name: 'a', type: 'file' },
    { name: 'b', type: 'file', source: '/x', max_age: 'soon' },
  ] }));
  const r = await sb.run();
  assert.equal(r.code, 2);
  assert.match(r.stderr, /source/);
  assert.match(r.stderr, /max_age/);
});

test('usage errors exit 2', async (t) => {
  const sb = sandbox(t);
  for (const args of [[], ['frobnicate'], ['run', '--no-such-flag'], ['report', '--out']]) {
    const r = await sb.cli(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage|unknown|restore-drill/i);
  }
});

test('--help and --version exit 0', async (t) => {
  const sb = sandbox(t);
  let r = await sb.cli(['--help']);
  assert.equal(r.code, 0);
  for (const cmd of ['run', 'status', 'report', 'init', 'demo']) assert.match(r.stdout, new RegExp(cmd));
  r = await sb.cli(['--version']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});

function seedHistory(sb, rows) {
  fs.mkdirSync(sb.state, { recursive: true });
  fs.writeFileSync(`${sb.state}/history.jsonl`, rows.map((r) => JSON.stringify({
    backup_path: null, backup_size: null, backup_mtime: null, error: null, duration_ms: 10, ...r,
    started: new Date(Date.now() - r.ago).toISOString(),
  })).join('\n') + '\n');
}

test('status: last result, age of last pass, and streak per drill', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([ok('steady'), bad('broken'), ok('fresh')]);
  seedHistory(sb, [
    { drill: 'steady', ok: true, ago: 51 * H },
    { drill: 'steady', ok: true, ago: 27 * H },
    { drill: 'steady', ok: true, ago: 3 * H },
    { drill: 'broken', ok: true, ago: 75 * H },
    { drill: 'broken', ok: false, ago: 51 * H, error: 'boom' },
    { drill: 'broken', ok: false, ago: 27 * H, error: 'boom' },
  ]);
  const r = await sb.cli(['status', '--config', sb.config, '--state', sb.state]);
  assert.equal(r.code, 0, r.stderr);
  const row = (name) => r.stdout.split('\n').find((l) => new RegExp(`^\\s*${name}\\b`).test(l));
  assert.match(row('steady'), /pass/i);
  assert.match(row('steady'), /3h ago/);
  assert.match(row('steady'), /3 pass/);
  assert.match(row('broken'), /fail/i);
  assert.match(row('broken'), /3d ago/);
  assert.match(row('broken'), /2 fail/);
  assert.match(row('fresh'), /never/i, 'configured but never run');
  assert.match(r.stdout, /DRILL/i);
});

test('status: works from history alone and with no history', async (t) => {
  const sb = sandbox(t);
  let r = await sb.cli(['status', '--state', sb.state]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no results|nothing/i);

  seedHistory(sb, [{ drill: 'orphan', ok: true, ago: 2 * H }]);
  r = await sb.cli(['status', '--state', sb.state]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /orphan/);
});

test('status: reflects real runs end to end', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([ok('alpha'), bad('beta')]);
  await sb.run();
  await sb.run();
  const r = await sb.cli(['status', '--config', sb.config, '--state', sb.state]);
  assert.match(r.stdout, /alpha.*pass.*2 pass/is);
  assert.match(r.stdout, /beta.*fail.*never.*2 fail/is);
});

test('report: writes a single self-contained HTML file', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([ok('alpha'), bad('beta')]);
  fs.writeFileSync(sb.config, JSON.stringify({ drills: [
    ok('alpha'),
    { name: 'beta', type: 'command', command: 'echo "<b>boom</b> & more" >&2; exit 1' },
  ] }));
  await sb.run();
  const out = sb.path('status.html');
  const r = await sb.cli(['report', '--config', sb.config, '--state', sb.state, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<meta name="viewport"/);
  assert.match(html, /alpha/);
  assert.match(html, /beta/);
  assert.match(html, /<details/, 'failing rows expand');
  assert.match(html, /&lt;b&gt;boom&lt;\/b&gt; &amp; more/, 'error text is escaped');
  assert.doesNotMatch(html, /<b>boom/);
  assert.match(html, /color-scheme/);
  // no external requests of any kind
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /@import|url\(\s*['"]?https?:/i);
  assert.doesNotMatch(html, /(src|href)=["']https?:/i);
  assert.doesNotMatch(html, /<img\b/i);
});

test('report: shows when a drill last restored and the backup age', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([ok('alpha')]);
  seedHistory(sb, [{ drill: 'alpha', ok: true, ago: 3 * H, backup_mtime: new Date(Date.now() - 5 * H).toISOString() }]);
  const out = sb.path('status.html');
  const r = await sb.cli(['report', '--config', sb.config, '--state', sb.state, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /restored 3h ago/);
  assert.match(html, /2h old|2h/);
});

test('report: a drill that never ran, and an empty state dir, still render', async (t) => {
  const sb = sandbox(t);
  sb.writeConfig([ok('alpha')]);
  const out = sb.path('status.html');
  const r = await sb.cli(['report', '--config', sb.config, '--state', sb.state, '--out', out]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /alpha/);
});

test('init: writes a valid, annotated example config and refuses to overwrite it', async (t) => {
  const sb = sandbox(t);
  let r = await sb.cli(['init'], { cwd: sb.root });
  assert.equal(r.code, 0, r.stderr);
  const file = sb.path('drills.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(cfg.drills.length >= 4);
  const types = new Set(cfg.drills.map((d) => d.type));
  for (const type of ['file', 'sqlite', 'tar', 'restic', 'pg_dump', 'command']) assert.ok(types.has(type), type);
  assert.match(fs.readFileSync(file, 'utf8'), /_comment/);

  // The example has to pass config validation: the drills fail (no such backups), but not with exit 2.
  r = await sb.cli(['run', '--config', file, '--state', sb.state], { cwd: sb.root });
  assert.equal(r.code, 1, r.stdout + r.stderr);

  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, before + '\n');
  r = await sb.cli(['init'], { cwd: sb.root });
  assert.equal(r.code, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), before + '\n', 'existing file untouched');
  r = await sb.cli(['init', '--force'], { cwd: sb.root });
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('init: --out chooses the file name', async (t) => {
  const sb = sandbox(t);
  const r = await sb.cli(['init', '--out', sb.path('mine.json')]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(sb.path('mine.json')));
});

test('demo: shows a pass and a fail, exits 1, and leaves nothing behind', async (t) => {
  const sb = sandbox(t);
  const r = await sb.cli(['demo'], { cwd: sb.root });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /pass/i);
  assert.match(r.stdout, /fail/i);
  assert.match(r.stdout, /integrity|unexpected|eof|empty/i, 'failures carry the real error');
  assert.deepEqual(sb.leftovers(), [], 'demo temp dir removed');
  assert.deepEqual(fs.readdirSync(sb.root).sort(), ['backups', 'tmp'], 'demo writes nothing to the cwd');
});

test('demo: --out also writes the HTML status page from the demo data', async (t) => {
  const sb = sandbox(t);
  const out = sb.path('demo.html');
  const r = await sb.cli(['demo', '--out', out]);
  assert.equal(r.code, 1);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /<details/);
  assert.match(html, /<!doctype html>/i);
});
