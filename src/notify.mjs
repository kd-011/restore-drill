const TIMEOUT_MS = 10_000;

// Failures are reported without the URL: webhook and ping URLs usually carry a token.
async function send(label, url, init, warn) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => {});
    if (!res.ok) warn(`notify ${label} failed: HTTP ${res.status}`);
  } catch (err) {
    const why = err.cause?.code ?? (err.name === 'TimeoutError' ? 'timed out' : err.name === 'AbortError' ? 'aborted' : 'request failed');
    warn(`notify ${label} failed: ${why}`);
  }
}

const asciiHeader = (s) => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 200);

/** event is "failure" or "recovery". */
export async function notifyResult(notify, record, event, warn) {
  if (!notify) return;
  const failed = event === 'failure';
  if (notify.webhook) {
    await send('webhook', notify.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event, ...record }),
    }, warn);
  }
  if (notify.ntfy) {
    const body = failed ? `${record.drill} failed: ${record.error}` : `${record.drill} restores again`;
    await send('ntfy', notify.ntfy, {
      method: 'POST',
      headers: {
        Title: asciiHeader(`restore-drill: ${record.drill} ${failed ? 'failed' : 'recovered'}`),
        Priority: failed ? 'high' : 'default',
        Tags: failed ? 'rotating_light' : 'white_check_mark',
      },
      body,
    }, warn);
  }
}

/** healthchecks.io style: one GET per run, success or fail. */
export async function pingRun(notify, allOk, warn) {
  const url = allOk ? notify?.ping_success : notify?.ping_fail;
  if (url) await send(allOk ? 'ping_success' : 'ping_fail', url, { method: 'GET' }, warn);
}
