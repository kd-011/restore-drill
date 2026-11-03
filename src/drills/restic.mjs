import fs from 'node:fs';
import path from 'node:path';
import { DrillError, exec, formatSpan, parseDuration, redact, tail } from '../util.mjs';
import { requirePaths } from './tar.mjs';

function passwordEnv(drill) {
  const env = { ...process.env };
  const secrets = [];
  if (drill.password_file) return { env, args: ['--password-file', drill.password_file], secrets };
  if (drill.password_env) {
    const value = process.env[drill.password_env];
    if (!value) throw new DrillError(`restic password: environment variable ${drill.password_env} is not set`);
    env.RESTIC_PASSWORD = value;
    secrets.push(value);
    return { env, args: [], secrets };
  }
  const have = ['RESTIC_PASSWORD', 'RESTIC_PASSWORD_FILE', 'RESTIC_PASSWORD_COMMAND'].some((k) => env[k]);
  if (!have) {
    throw new DrillError('no restic password: set password_env or password_file on the drill, or RESTIC_PASSWORD in the environment');
  }
  if (env.RESTIC_PASSWORD) secrets.push(env.RESTIC_PASSWORD);
  return { env, args: [], secrets };
}

export async function run(drill, ctx) {
  const { env, args: auth, secrets } = passwordEnv(drill);
  const repo = ['-r', drill.source, '--no-lock', ...auth];
  const clean = (t) => redact(t, secrets).replaceAll(drill.source, redact(drill.source));
  ctx.backup = { path: redact(drill.source), size: null, mtime: null };

  const restic = async (sub, args) => {
    let res;
    try {
      res = await exec('restic', [...repo, sub, ...args], { cwd: ctx.tmp, env, signal: ctx.signal, need: 'needed for restic drills' });
    } catch (err) {
      throw new DrillError(clean(err.message));
    }
    if (res.code !== 0) {
      throw new DrillError(`restic ${sub} failed (exit ${res.code ?? res.signal}): ${clean(tail(res.stderr || res.stdout))}`);
    }
    return res;
  };

  const snaps = await restic('snapshots', ['--json', '--latest', '1']);
  let list;
  try { list = JSON.parse(snaps.stdout); } catch { throw new DrillError('restic snapshots returned unreadable output'); }
  if (!Array.isArray(list) || !list.length) throw new DrillError('no snapshots in the restic repository');
  const latest = list.reduce((a, b) => (Date.parse(b.time) > Date.parse(a.time) ? b : a));
  ctx.backup.mtime = new Date(latest.time).toISOString();
  ctx.backup.size = latest.summary?.total_bytes_processed ?? null;

  const maxAge = drill.max_age !== undefined ? parseDuration(drill.max_age) : null;
  const age = ctx.now - Date.parse(latest.time);
  if (maxAge !== null && age > maxAge) {
    throw new DrillError(`latest snapshot is too old: ${formatSpan(age)} old, max_age is ${drill.max_age}`);
  }

  const target = path.join(ctx.tmp, 'restore');
  fs.mkdirSync(target, { mode: 0o700 });
  await restic('restore', ['latest', '--target', target, ...(drill.include ?? []).flatMap((p) => ['--include', p])]);
  await requirePaths(target, drill.expect_paths);
  await restic('check', ['--read-data-subset', drill.read_data_subset ?? '5%']);
}
