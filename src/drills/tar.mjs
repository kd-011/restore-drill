import fs from 'node:fs';
import path from 'node:path';
import { prepareBackup } from '../steps.mjs';
import { DrillError, exec, expandGlob, tail, walkFiles } from '../util.mjs';

async function run1(cmd, args, ctx, need) {
  const res = await exec(cmd, args, { cwd: ctx.tmp, env: process.env, signal: ctx.signal, need });
  if (res.code !== 0) {
    throw new DrillError(`${cmd} ${args[0]} failed (exit ${res.code ?? res.signal}): ${tail(res.stderr || res.stdout)}`);
  }
  return res;
}

/** Shared by tar and restic: every expected path (globs allowed) must exist under root. */
export async function requirePaths(root, patterns) {
  const missing = [];
  for (const p of patterns) {
    const rel = p.replace(/^\/+/, '');
    if (!(await expandGlob(rel, root)).length) missing.push(p);
  }
  if (missing.length) throw new DrillError(`expected ${missing.length === 1 ? 'path' : 'paths'} missing from restore: ${missing.join(', ')}`);
}

/** List the newest archive, extract it, and require the expected paths. */
export async function run(drill, ctx) {
  const archive = await prepareBackup(drill, ctx);
  const out = path.join(ctx.tmp, 'restore');
  fs.mkdirSync(out, { mode: 0o700 });

  if (/\.zip$/i.test(archive)) {
    await run1('unzip', ['-Z1', archive], ctx, 'needed for .zip backups');
    await run1('unzip', ['-q', '-o', archive, '-d', out], ctx, 'needed for .zip backups');
  } else {
    await run1('tar', ['-tf', archive], ctx, 'needed for tar backups');
    await run1('tar', ['-xf', archive, '-C', out, '--no-same-owner'], ctx, 'needed for tar backups');
  }

  const count = (await walkFiles(out)).length;
  if (drill.min_files !== undefined && count < drill.min_files) {
    throw new DrillError(`restored ${count} files, min_files is ${drill.min_files}`);
  }
  if (!drill.expect_paths && count === 0) throw new DrillError('archive extracted but contains no files');
  if (drill.expect_paths) await requirePaths(out, drill.expect_paths);
}
