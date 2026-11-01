import fs from 'node:fs';
import path from 'node:path';

export const historyFile = (stateDir) => path.join(stateDir, 'history.jsonl');

export function readHistory(stateDir) {
  let text;
  try {
    text = fs.readFileSync(historyFile(stateDir), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row.drill === 'string' && typeof row.ok === 'boolean') rows.push(row);
    } catch { /* a torn or hand-edited line should not take the history down */ }
  }
  return rows;
}

export function appendResult(stateDir, record) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(historyFile(stateDir), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/**
 * One summary per drill: latest result, latest pass, and the current streak
 * (how many results in a row share the latest outcome).
 * `names` adds drills that are configured but have no history yet.
 */
export function summarize(rows, names = []) {
  const byDrill = new Map();
  for (const n of names) byDrill.set(n, []);
  for (const r of rows) {
    if (!byDrill.has(r.drill)) byDrill.set(r.drill, []);
    byDrill.get(r.drill).push(r);
  }
  const out = [];
  for (const [name, list] of byDrill) {
    list.sort((a, b) => Date.parse(a.started) - Date.parse(b.started));
    const last = list.at(-1) ?? null;
    const lastPass = [...list].reverse().find((r) => r.ok) ?? null;
    let streak = 0;
    for (let i = list.length - 1; i >= 0 && list[i].ok === last.ok; i--) streak++;
    out.push({ name, last, lastPass, streak: last ? { ok: last.ok, count: streak } : null });
  }
  return out;
}
