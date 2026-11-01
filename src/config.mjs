import fs from 'node:fs';
import path from 'node:path';
import { parseDuration, parseSize } from './util.mjs';

export class ConfigError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.problems = problems;
  }
}

const COMMON = ['name', 'type', 'timeout', 'retries', 'retry_delay'];
const FILE_BASED = [...COMMON, 'source', 'max_age', 'min_size', 'size_drop', 'decrypt', 'decompress'];

export const TYPES = {
  file: { keys: FILE_BASED, required: ['source'] },
  sqlite: { keys: [...FILE_BASED, 'checks', 'table_exists'], required: ['source'] },
  tar: { keys: [...FILE_BASED, 'expect_paths', 'min_files'], required: ['source'] },
  pg_dump: { keys: [...FILE_BASED, 'min_entries', 'restore_url', 'restore_checks'], required: ['source'] },
  restic: {
    keys: [...COMMON, 'source', 'max_age', 'password_env', 'password_file', 'include', 'expect_paths',
      'read_data_subset'],
    required: ['source', 'expect_paths'],
  },
  command: { keys: [...FILE_BASED, 'command'], required: ['command'] },
};

const DEFAULTABLE = ['timeout', 'retries', 'retry_delay', 'max_age', 'min_size', 'size_drop', 'decompress'];
const NOTIFY_KEYS = ['webhook', 'ping_success', 'ping_fail', 'ntfy'];
const TOP_KEYS = ['drills', 'defaults', 'notify', 'state'];

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_SIZE_DROP = 50;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isComment = (k) => k.startsWith('_');

function unknownKeys(obj, allowed, where, problems) {
  for (const k of Object.keys(obj)) {
    if (isComment(k) || allowed.includes(k)) continue;
    problems.push(`${where}: unknown option "${k}"`);
  }
}

function checkPaths(list, where, key, problems, { allowAbsolute = false } = {}) {
  if (!Array.isArray(list) || !list.length || !list.every((p) => typeof p === 'string' && p.length)) {
    problems.push(`${where}: ${key} must be a non-empty list of paths`);
    return;
  }
  for (const p of list) {
    const parts = p.split('/');
    if (parts.includes('..')) problems.push(`${where}: ${key} entry "${p}" must not contain ".."`);
    else if (p.startsWith('/') && !allowAbsolute) {
      problems.push(`${where}: ${key} entry "${p}" must be relative to the restored tree`);
    }
  }
}

function checkChecks(list, where, key, problems) {
  if (!Array.isArray(list)) {
    problems.push(`${where}: ${key} must be a list of { sql, min }`);
    return;
  }
  list.forEach((c, i) => {
    const w = `${where}: ${key}[${i}]`;
    if (!isObject(c)) { problems.push(`${w} must be an object`); return; }
    unknownKeys(c, ['sql', 'min'], w, problems);
    if (typeof c.sql !== 'string' || !c.sql.trim()) problems.push(`${w}: sql is required`);
    if (c.min !== undefined && !(typeof c.min === 'number' && Number.isFinite(c.min))) {
      problems.push(`${w}: min must be a number`);
    }
  });
}

function checkDecrypt(d, where, problems) {
  if (!isObject(d)) { problems.push(`${where}: decrypt must be an object like { "type": "age", "identity": "key.txt" }`); return; }
  if (d.type === 'age') {
    unknownKeys(d, ['type', 'identity'], `${where}: decrypt`, problems);
    if (typeof d.identity !== 'string' || !d.identity) problems.push(`${where}: decrypt.identity (path to an age identity file) is required`);
  } else if (d.type === 'gpg') {
    unknownKeys(d, ['type', 'passphrase_file', 'homedir'], `${where}: decrypt`, problems);
  } else {
    problems.push(`${where}: decrypt.type must be "age" or "gpg"`);
  }
}

function validateDrill(d, where, baseDir, problems) {
  if (!isObject(d)) { problems.push(`${where}: must be an object`); return null; }
  const spec = TYPES[d.type];
  if (!spec) {
    problems.push(`${where}: unknown type ${JSON.stringify(d.type)} (use ${Object.keys(TYPES).join(', ')})`);
    return null;
  }
  unknownKeys(d, spec.keys, where, problems);
  for (const k of spec.required) {
    if (d[k] === undefined) problems.push(`${where}: ${k} is required for ${d.type} drills`);
  }

  if (d.source !== undefined && (typeof d.source !== 'string' || !d.source)) problems.push(`${where}: source must be a non-empty string`);
  for (const k of ['timeout', 'retry_delay', 'max_age']) {
    if (d[k] !== undefined && parseDuration(d[k]) === null) problems.push(`${where}: ${k} "${d[k]}" is not a duration (try "26h", "90m", "30s")`);
  }
  if (d.min_size !== undefined && parseSize(d.min_size) === null) problems.push(`${where}: min_size "${d.min_size}" is not a size (try "10KB", "2MB")`);
  if (d.size_drop !== undefined && !(typeof d.size_drop === 'number' && d.size_drop >= 0 && d.size_drop <= 100)) {
    problems.push(`${where}: size_drop must be a percentage from 0 to 100 (0 turns it off)`);
  }
  if (d.retries !== undefined && !(Number.isInteger(d.retries) && d.retries >= 0 && d.retries <= 10)) problems.push(`${where}: retries must be an integer from 0 to 10`);
  for (const k of ['min_files', 'min_entries']) {
    if (d[k] !== undefined && !(Number.isInteger(d[k]) && d[k] >= 0)) problems.push(`${where}: ${k} must be a whole number`);
  }
  if (d.decrypt !== undefined) checkDecrypt(d.decrypt, where, problems);
  if (d.decompress !== undefined && ![true, false, 'gz', 'zst', 'xz'].includes(d.decompress)) {
    problems.push(`${where}: decompress must be true, "gz", "zst" or "xz"`);
  }
  if (d.checks !== undefined) checkChecks(d.checks, where, 'checks', problems);
  if (d.restore_checks !== undefined) checkChecks(d.restore_checks, where, 'restore_checks', problems);
  if (d.restore_checks !== undefined && d.restore_url === undefined) problems.push(`${where}: restore_checks needs restore_url`);
  if (d.table_exists !== undefined) {
    const ok = typeof d.table_exists === 'string' || (Array.isArray(d.table_exists) && d.table_exists.every((t) => typeof t === 'string'));
    if (!ok) problems.push(`${where}: table_exists must be a table name or a list of names`);
  }
  if (d.expect_paths !== undefined) checkPaths(d.expect_paths, where, 'expect_paths', problems, { allowAbsolute: d.type === 'restic' });
  if (d.include !== undefined && !(Array.isArray(d.include) && d.include.every((p) => typeof p === 'string'))) problems.push(`${where}: include must be a list of paths`);
  if (d.restore_url !== undefined) {
    let u;
    try { u = new URL(d.restore_url); } catch { u = null; }
    if (!u || !/^postgres(ql)?:$/.test(u.protocol)) problems.push(`${where}: restore_url must be a postgres:// URL`);
  }
  if (d.command !== undefined) {
    const ok = (typeof d.command === 'string' && d.command.trim())
      || (Array.isArray(d.command) && d.command.length && d.command.every((a) => typeof a === 'string'));
    if (!ok) problems.push(`${where}: command must be a shell string or a list like ["sh", "-c", "..."]`);
  }

  // Paths that live on disk are relative to the config file.
  const out = { ...d };
  for (const k of Object.keys(out)) if (isComment(k)) delete out[k];
  const abs = (p) => (typeof p === 'string' && !path.isAbsolute(p) ? path.resolve(baseDir, p) : p);
  if (typeof out.source === 'string' && !(d.type === 'restic' && /^[a-z0-9+.-]+:/i.test(out.source))) out.source = abs(out.source);
  if (out.password_file) out.password_file = abs(out.password_file);
  if (isObject(out.decrypt)) {
    out.decrypt = { ...out.decrypt };
    for (const k of ['identity', 'passphrase_file', 'homedir']) if (out.decrypt[k]) out.decrypt[k] = abs(out.decrypt[k]);
  }
  return out;
}

/** Validate an already-parsed config object. Throws ConfigError listing every problem. */
export function normalizeConfig(raw, { baseDir = process.cwd(), label = 'config' } = {}) {
  const problems = [];
  if (!isObject(raw)) throw new ConfigError([`${label}: top level must be a JSON object`]);
  unknownKeys(raw, TOP_KEYS, label, problems);

  if (!Array.isArray(raw.drills)) problems.push(`${label}: "drills" must be a list`);
  const defaults = raw.defaults ?? {};
  if (!isObject(defaults)) problems.push(`${label}: "defaults" must be an object`);
  else unknownKeys(defaults, DEFAULTABLE, `${label}: defaults`, problems);

  const notify = raw.notify ?? {};
  if (!isObject(notify)) problems.push(`${label}: "notify" must be an object`);
  else {
    unknownKeys(notify, NOTIFY_KEYS, `${label}: notify`, problems);
    for (const k of NOTIFY_KEYS) {
      if (notify[k] === undefined) continue;
      let u;
      try { u = new URL(notify[k]); } catch { u = null; }
      if (!u || !/^https?:$/.test(u.protocol)) problems.push(`${label}: notify.${k} must be an http(s) URL`);
    }
  }
  if (raw.state !== undefined && (typeof raw.state !== 'string' || !raw.state)) problems.push(`${label}: "state" must be a directory path`);

  const drills = [];
  const seen = new Set();
  (Array.isArray(raw.drills) ? raw.drills : []).forEach((d, i) => {
    let where = `drills[${i}]`;
    if (isObject(d) && typeof d.name === 'string' && d.name) where += ` "${d.name}"`;
    if (!isObject(d) || typeof d.name !== 'string' || !d.name.trim() || /[\u0000-\u001f]/.test(d.name)) {
      problems.push(`${where}: name is required (a short plain string)`);
    } else if (seen.has(d.name)) {
      problems.push(`${where}: duplicate drill name`);
    } else seen.add(d.name);

    let merged = d;
    if (isObject(d) && TYPES[d.type] && isObject(defaults)) {
      merged = { ...d };
      for (const k of DEFAULTABLE) {
        if (defaults[k] !== undefined && merged[k] === undefined && TYPES[d.type].keys.includes(k)) merged[k] = defaults[k];
      }
    }
    const v = validateDrill(merged, where, baseDir, problems);
    if (v) drills.push(v);
  });

  if (problems.length) throw new ConfigError(problems);
  const state = typeof raw.state === 'string' ? path.resolve(baseDir, raw.state) : null;
  return { drills, notify, state };
}

export function loadConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const why = err.code === 'ENOENT' ? 'file not found (run "restore-drill init" to create one)' : err.message;
    throw new ConfigError([`${file}: ${why}`]);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError([`${file}: invalid JSON: ${err.message}`]);
  }
  const cfg = normalizeConfig(raw, { baseDir: path.dirname(path.resolve(file)), label: path.basename(file) });
  return { ...cfg, file: path.resolve(file) };
}
