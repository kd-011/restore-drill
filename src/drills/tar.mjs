import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
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

const END_BLOCKS = 1024;

/** The last END_BLOCKS bytes of the (decompressed) stream, or null when we cannot read it ourselves. */
async function streamTail(archive, signal) {
  if (/\.tar$/i.test(archive)) {
    const fh = await fs.promises.open(archive, 'r');
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, END_BLOCKS);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      return buf;
    } finally {
      await fh.close();
    }
  }
  if (!/\.(tar\.gz|tgz)$/i.test(archive)) return null;
  let last = Buffer.alloc(0);
  const keep = new Writable({
    write(chunk, _enc, cb) {
      last = Buffer.concat([last, chunk]).subarray(-END_BLOCKS);
      cb();
    },
  });
  await pipeline(fs.createReadStream(archive), zlib.createGunzip(), keep, { signal });
  return last;
}

/**
 * tar -t is happy with an archive that stops after any complete entry, so a backup job that
 * died between files (or tar piped into gzip, which closes the gzip stream cleanly either way)
 * lists fine. Every writer ends a finished archive with at least two zero blocks.
 */
async function requireEndMarker(archive, signal) {
  const end = await streamTail(archive, signal);
  if (end === null) return;
  if (end.length < END_BLOCKS || end.some((b) => b !== 0)) {
    throw new DrillError('tar has no end-of-archive marker: the archive was cut short (the job that wrote it probably died partway)');
  }
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
    await requireEndMarker(archive, ctx.signal);
    await run1('tar', ['-xf', archive, '-C', out, '--no-same-owner'], ctx, 'needed for tar backups');
  }

  const count = (await walkFiles(out)).length;
  if (drill.min_files !== undefined && count < drill.min_files) {
    throw new DrillError(`restored ${count} files, min_files is ${drill.min_files}`);
  }
  if (!drill.expect_paths && count === 0) throw new DrillError('archive extracted but contains no files');
  if (drill.expect_paths) await requirePaths(out, drill.expect_paths);
}
