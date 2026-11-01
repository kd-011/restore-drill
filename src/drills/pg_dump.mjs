import { randomBytes } from 'node:crypto';
import { prepareBackup } from '../steps.mjs';
import { DrillError, exec, redact, tail } from '../util.mjs';

const NEED = 'needed for pg_dump drills';

function connection(urlText) {
  const u = new URL(urlText);
  const env = { ...process.env };
  if (u.hostname) env.PGHOST = u.hostname;
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const sslmode = u.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return { env, adminDb: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres', password: u.password };
}

/** Restore into a database that restore-drill creates and drops itself. The source DB is never named. */
async function restoreIntoThrowaway(drill, ctx, file) {
  const { env, adminDb, password } = connection(drill.restore_url);
  const clean = (t) => redact(t, [password, decodeURIComponent(password)]);
  const name = `restore_drill_${randomBytes(6).toString('hex')}`;
  const psql = async (db, args, signal = ctx.signal) => {
    let res;
    try {
      res = await exec('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-d', db, ...args], { cwd: ctx.tmp, env, signal, need: 'needed for restore_url' });
    } catch (err) {
      throw new DrillError(clean(err.message));
    }
    return res;
  };
  const fail = (what, res) => new DrillError(`${what} failed (exit ${res.code ?? res.signal}): ${clean(tail(res.stderr || res.stdout))}`);

  let created = false;
  let failure;
  try {
    const create = await psql(adminDb, ['-c', `CREATE DATABASE "${name}"`]);
    if (create.code !== 0) throw fail('CREATE DATABASE on restore_url', create);
    created = true;

    let res;
    try {
      res = await exec('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', name, file],
        { cwd: ctx.tmp, env, signal: ctx.signal, need: NEED });
    } catch (err) {
      throw new DrillError(clean(err.message));
    }
    if (res.code !== 0) throw fail('pg_restore', res);

    for (const c of drill.restore_checks ?? []) {
      const q = await psql(name, ['-tA', '-c', c.sql]);
      if (q.code !== 0) throw fail(`check ${c.sql}`, q);
      const n = Number(q.stdout.trim().split('\n')[0]);
      const min = c.min ?? 1;
      if (Number.isNaN(n)) throw new DrillError(`check failed: ${c.sql} returned ${JSON.stringify(q.stdout.trim())}, expected a number`);
      if (n < min) throw new DrillError(`check failed: ${c.sql} returned ${n}, expected at least ${min}`);
    }
  } catch (err) {
    failure = err;
  }

  if (created) {
    // Runs even after a timeout: it uses its own signal so the drop is not cancelled with the drill.
    const drop = AbortSignal.timeout(30_000);
    let dropErr;
    try {
      const res = await psql(adminDb, ['-c', `DROP DATABASE IF EXISTS "${name}"`], drop);
      if (res.code !== 0) dropErr = fail(`dropping throwaway database ${name}`, res);
    } catch (err) {
      dropErr = err;
    }
    if (dropErr && !failure) failure = dropErr;
  }
  if (failure) throw failure;
}

/** pg_restore must be able to read the newest dump, and optionally restore it somewhere disposable. */
export async function run(drill, ctx) {
  const file = await prepareBackup(drill, ctx);
  const res = await exec('pg_restore', ['--list', file], { cwd: ctx.tmp, env: process.env, signal: ctx.signal, need: NEED });
  if (res.code !== 0) {
    throw new DrillError(`pg_restore --list failed (exit ${res.code ?? res.signal}): ${tail(res.stderr || res.stdout)}`);
  }
  const entries = res.stdout.split('\n').filter((l) => l.trim() && !l.startsWith(';')).length;
  const min = drill.min_entries ?? 1;
  if (entries < min) throw new DrillError(`pg_restore --list shows ${entries} entries, min_entries is ${min}`);
  if (drill.restore_url) await restoreIntoThrowaway(drill, ctx, file);
}
