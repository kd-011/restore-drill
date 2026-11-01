import { fileURLToPath } from 'node:url';
import { prepareBackup } from '../steps.mjs';
import { DrillError, exec, tail } from '../util.mjs';

const WORKER = fileURLToPath(new URL('../sqlite-worker.mjs', import.meta.url));

/** Check a copy of the newest database: integrity_check, tables, and row-count style queries. */
export async function run(drill, ctx) {
  const copy = await prepareBackup(drill, ctx, { copy: true });
  const spec = {
    tables: [drill.table_exists ?? []].flat(),
    checks: drill.checks ?? [],
  };
  const res = await exec(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', WORKER, 'check', copy, JSON.stringify(spec)],
    { cwd: ctx.tmp, env: process.env, signal: ctx.signal },
  );
  let out;
  try {
    out = JSON.parse(res.stdout.trim().split('\n').pop());
  } catch {
    throw new DrillError(`sqlite check crashed (exit ${res.code ?? res.signal}): ${tail(res.stderr)}`);
  }
  if (!out.ok) throw new DrillError(out.error);
}
