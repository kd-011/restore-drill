import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { recorder, sandbox, writeFile } from '../test-support/helpers.mjs';

const marker = (sb) => sb.path('broken');
const drills = (sb) => [{
  name: 'nightly', type: 'command',
  command: `test ! -f "${marker(sb)}" || { echo "restore blew up" >&2; exit 1; }`,
}];

test('webhook: POSTs JSON on failure with the drill name and the real error', async (t) => {
  const sb = sandbox(t);
  const hook = await recorder(t);
  writeFile(marker(sb), '');
  sb.writeConfig(drills(sb), { notify: { webhook: `${hook.url}/hook/TOKEN-abc-123` } });
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.equal(hook.requests.length, 1);
  const req = hook.requests[0];
  assert.equal(req.method, 'POST');
  assert.match(req.headers['content-type'], /application\/json/);
  const body = JSON.parse(req.body);
  assert.equal(body.event, 'failure');
  assert.equal(body.drill, 'nightly');
  assert.equal(body.ok, false);
  assert.match(body.error, /restore blew up/);
  assert.ok(body.started);
});

test('webhook: stays quiet on a pass with no prior failure', async (t) => {
  const sb = sandbox(t);
  const hook = await recorder(t);
  sb.writeConfig(drills(sb), { notify: { webhook: hook.url } });
  assert.equal((await sb.run()).code, 0);
  assert.equal(hook.requests.length, 0);
});

test('webhook: POSTs a recovery event when a failing drill passes again, once', async (t) => {
  const sb = sandbox(t);
  const hook = await recorder(t);
  writeFile(marker(sb), '');
  sb.writeConfig(drills(sb), { notify: { webhook: hook.url } });
  await sb.run();
  assert.equal(hook.requests.length, 1);

  fs.rmSync(marker(sb));
  assert.equal((await sb.run()).code, 0);
  assert.equal(hook.requests.length, 2);
  const body = JSON.parse(hook.requests[1].body);
  assert.equal(body.event, 'recovery');
  assert.equal(body.drill, 'nightly');
  assert.equal(body.ok, true);

  assert.equal((await sb.run()).code, 0);
  assert.equal(hook.requests.length, 2, 'no repeat recovery notice');
});

test('ping_success is fetched when everything passes, ping_fail when anything fails', async (t) => {
  const sb = sandbox(t);
  const ping = await recorder(t);
  sb.writeConfig(drills(sb), { notify: { ping_success: `${ping.url}/ok`, ping_fail: `${ping.url}/fail` } });
  assert.equal((await sb.run()).code, 0);
  assert.deepEqual(ping.requests.map((r) => [r.method, r.url]), [['GET', '/ok']]);

  writeFile(marker(sb), '');
  assert.equal((await sb.run()).code, 1);
  assert.deepEqual(ping.requests.map((r) => [r.method, r.url]), [['GET', '/ok'], ['GET', '/fail']]);
});

test('ntfy: POSTs a plain-text message to the topic URL on failure', async (t) => {
  const sb = sandbox(t);
  const ntfy = await recorder(t);
  writeFile(marker(sb), '');
  sb.writeConfig(drills(sb), { notify: { ntfy: `${ntfy.url}/my-topic` } });
  await sb.run();
  assert.equal(ntfy.requests.length, 1);
  assert.equal(ntfy.requests[0].method, 'POST');
  assert.equal(ntfy.requests[0].url, '/my-topic');
  assert.match(ntfy.requests[0].body, /nightly/);
  assert.match(ntfy.requests[0].body, /restore blew up/);
  assert.ok(ntfy.requests[0].headers.title);
});

test('notifications: an unreachable endpoint warns on stderr, keeps the exit code, and never prints the URL', async (t) => {
  const sb = sandbox(t);
  writeFile(marker(sb), '');
  const secret = 'hooks.example.invalid/services/T000/B000/XXSECRETXX';
  sb.writeConfig(drills(sb), {
    notify: {
      webhook: 'http://127.0.0.1:9/' + secret,
      ping_fail: 'http://127.0.0.1:9/ping/XXPINGSECRETXX',
      ntfy: 'http://127.0.0.1:9/XXTOPICSECRETXX',
    },
  });
  const r = await sb.run(['--json']);
  assert.equal(r.code, 1, 'a notification failure must not change the exit code');
  assert.match(r.stderr, /webhook/i);
  assert.doesNotMatch(r.stdout + r.stderr, /XXSECRETXX|XXPINGSECRETXX|XXTOPICSECRETXX/);
  assert.doesNotMatch(JSON.stringify(sb.history()), /XX\w*SECRETXX/);
});

test('notifications: an endpoint that returns 500 is a warning, not a crash', async (t) => {
  const sb = sandbox(t);
  const hook = await recorder(t, { status: 500 });
  writeFile(marker(sb), '');
  sb.writeConfig(drills(sb), { notify: { webhook: hook.url } });
  const r = await sb.run();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /webhook.*500/i);
});

test('notifications: a passing run with a passing-only config does not notify failure channels', async (t) => {
  const sb = sandbox(t);
  const hook = await recorder(t);
  const ntfy = await recorder(t);
  sb.writeConfig(drills(sb), { notify: { webhook: hook.url, ntfy: ntfy.url + '/t' } });
  await sb.run();
  assert.equal(hook.requests.length + ntfy.requests.length, 0);
});
