// Steps shared by every drill that works on a backup file: find the newest one,
// run the cheap checks, then decrypt and decompress a private copy into the temp dir.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { DEFAULT_SIZE_DROP } from './config.mjs';
import { DrillError, exec, findNewest, formatSize, formatSpan, parseDuration, parseSize, tail } from './util.mjs';

/** Locate the newest backup, record it on ctx.backup, and apply the generic checks. */
export async function locateBackup(drill, ctx) {
  const found = await findNewest(drill.source);
  if (!found) throw new DrillError(`no backup found matching ${drill.source}`);
  ctx.backup = { path: found.path, size: found.size, mtime: new Date(found.mtimeMs).toISOString() };

  if (found.size === 0) throw new DrillError(`backup is empty (0 bytes): ${found.path}`);

  const maxAge = drill.max_age !== undefined ? parseDuration(drill.max_age) : null;
  const age = ctx.now - found.mtimeMs;
  if (maxAge !== null && age > maxAge) {
    throw new DrillError(`backup is too old: ${formatSpan(age)} old, max_age is ${drill.max_age} (${found.path})`);
  }

  const minSize = drill.min_size !== undefined ? parseSize(drill.min_size) : null;
  if (minSize !== null && found.size < minSize) {
    throw new DrillError(`backup is too small: ${formatSize(found.size)}, min_size is ${drill.min_size} (${found.path})`);
  }

  const threshold = drill.size_drop ?? DEFAULT_SIZE_DROP;
  const previous = ctx.lastPass?.backup_size;
  if (threshold > 0 && previous > 0 && found.size < (previous * threshold) / 100) {
    const pct = Math.round((found.size / previous) * 100);
    throw new DrillError(
      `backup size dropped: ${formatSize(found.size)} is ${pct}% of the last good run (${formatSize(previous)}), `
      + `below the size_drop threshold of ${threshold}% (${found.path})`,
    );
  }
  return found.path;
}

const ENCRYPTED_EXT = /\.(age|gpg|pgp|asc)$/i;
const COMPRESSED_EXT = { gz: /\.(gz|tgz)$/i, zst: /\.(zst|zstd)$/i, xz: /\.(xz|txz)$/i };

function stageDir(ctx) {
  const dir = path.join(ctx.tmp, 'stage');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function ensureNotEmpty(file, what) {
  const st = await fs.promises.stat(file);
  if (st.size === 0) throw new DrillError(`${what} produced an empty file`);
}

async function decrypt(file, spec, ctx) {
  const base = path.basename(file);
  const out = path.join(stageDir(ctx), ENCRYPTED_EXT.test(base) ? base.replace(ENCRYPTED_EXT, '') : `${base}.decrypted`);
  const env = process.env;
  let res;
  if (spec.type === 'age') {
    res = await exec('age', ['--decrypt', '-i', spec.identity, '-o', out, file], { env, signal: ctx.signal, need: 'needed to decrypt age backups' });
  } else {
    const args = ['--batch', '--yes', '--quiet'];
    if (spec.homedir) args.push('--homedir', spec.homedir);
    if (spec.passphrase_file) args.push('--pinentry-mode', 'loopback', '--passphrase-file', spec.passphrase_file);
    args.push('--output', out, '--decrypt', file);
    res = await exec('gpg', args, { env, signal: ctx.signal, need: 'needed to decrypt gpg backups' });
  }
  if (res.code !== 0) {
    throw new DrillError(`${spec.type} decrypt failed (exit ${res.code}): ${tail(res.stderr || res.stdout)}`);
  }
  await ensureNotEmpty(out, `${spec.type} decrypt`);
  return out;
}

async function decompress(file, mode, ctx) {
  const base = path.basename(file);
  let format = mode === true ? Object.keys(COMPRESSED_EXT).find((f) => COMPRESSED_EXT[f].test(base)) : mode;
  if (!format) {
    throw new DrillError(`cannot decompress ${base}: unsupported extension (expected .gz, .zst or .xz, or set decompress to "gz", "zst" or "xz")`);
  }
  const stem = base.replace(COMPRESSED_EXT[format], (m) => (/^\.t/i.test(m) ? '.tar' : ''));
  const out = path.join(stageDir(ctx), stem === base ? `${base}.out` : stem);

  if (format === 'gz') {
    try {
      await pipeline(fs.createReadStream(file), zlib.createGunzip(), fs.createWriteStream(out, { mode: 0o600 }), { signal: ctx.signal });
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      throw new DrillError(`gzip decompress failed: ${err.message}`);
    }
  } else {
    const tool = format === 'zst' ? 'zstd' : 'xz';
    const res = await exec(tool, ['-d', '-c', '--', file], { env: process.env, signal: ctx.signal, stdoutFile: out, need: `needed for .${format} backups` });
    if (res.code !== 0) throw new DrillError(`${tool} decompress failed (exit ${res.code}): ${tail(res.stderr)}`);
  }
  await ensureNotEmpty(out, 'decompress');
  return out;
}

/**
 * Find the newest backup and return a path to read. With decrypt/decompress the result is
 * a fresh file in the temp dir. With `copy` and no steps, a private copy is made so the
 * check can never touch the original.
 */
export async function prepareBackup(drill, ctx, { copy = false } = {}) {
  const original = await locateBackup(drill, ctx);
  let file = original;
  if (drill.decrypt) file = await decrypt(file, drill.decrypt, ctx);
  if (drill.decompress) file = await decompress(file, drill.decompress, ctx);
  if (copy && file === original) {
    const dest = path.join(stageDir(ctx), path.basename(original));
    await fs.promises.copyFile(original, dest, fs.constants.COPYFILE_FICLONE);
    await fs.promises.chmod(dest, 0o600);
    file = dest;
  }
  return file;
}
