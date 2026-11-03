import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from './config.mjs';
import { runDemo } from './demo.mjs';
import { EXAMPLE_CONFIG } from './example-config.mjs';
import { readHistory, summarize } from './history.mjs';
import { renderReport } from './report.mjs';
import { runDrills } from './runner.mjs';
import { formatAgo, formatElapsed, formatSize, formatSpan } from './util.mjs';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `restore-drill ${VERSION}
Prove your backups restore: restore the newest one into a temp dir, check it, record pass or fail.

Usage:
  restore-drill run [--config drills.json] [--only name] [--json] [--state dir]
  restore-drill status [--config drills.json] [--state dir]
  restore-drill report [--out status.html] [--config drills.json] [--state dir]
  restore-drill init [--out drills.json] [--force]
  restore-drill demo [--out status.html]

Exit codes: 0 all drills passed, 1 a drill failed, 2 config or usage error.
Docs: https://github.com/kd-011/restore-drill#readme
`;

class UsageError extends Error {}

const SHARED = {
  config: { type: 'string', short: 'c' },
  state: { type: 'string', short: 's' },
};

const COMMANDS = {
  run: { options: { ...SHARED, only: { type: 'string', multiple: true }, json: { type: 'boolean' } }, handler: cmdRun },
  status: { options: { ...SHARED }, handler: cmdStatus },
  report: { options: { ...SHARED, out: { type: 'string', short: 'o' } }, handler: cmdReport },
  init: { options: { out: { type: 'string', short: 'o' }, force: { type: 'boolean' } }, handler: cmdInit },
  demo: { options: { out: { type: 'string', short: 'o' } }, handler: cmdDemo },
};

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);

function resolveStateDir(values, config) {
  if (values.state) return path.resolve(values.state);
  if (config?.state) return config.state;
  return path.resolve('.restore-drill');
}

/** Load the config. With `optional`, a missing default drills.json is not an error. */
function getConfig(values, { optional = false } = {}) {
  const file = values.config ?? 'drills.json';
  if (optional && !values.config && !fs.existsSync(file)) return null;
  return loadConfig(file);
}

function oneLine(text) {
  return String(text).replace(/\s*\n\s*/g, ' / ').trim();
}

export function formatResultLine(rec, width = 0) {
  const name = rec.drill.padEnd(width);
  const took = formatElapsed(rec.duration_ms).padStart(6);
  if (rec.ok) {
    const age = rec.backup_mtime ? `  backup ${formatSpan(Date.parse(rec.started) - Date.parse(rec.backup_mtime))} old` : '';
    return `${paint('32', 'PASS')}  ${name}  ${took}${age}`;
  }
  return `${paint('31', 'FAIL')}  ${name}  ${took}  ${oneLine(rec.error)}`;
}

// ---- run ----------------------------------------------------------------------------------

async function cmdRun({ values }) {
  const config = getConfig(values);
  let drills = config.drills;
  if (!drills.length) throw new ConfigError([`${path.basename(config.file)}: no drills configured`]);
  if (values.only?.length) {
    const unknown = values.only.filter((n) => !drills.some((d) => d.name === n));
    if (unknown.length) {
      throw new ConfigError([`no drill named ${unknown.map((n) => `"${n}"`).join(', ')} (have: ${drills.map((d) => d.name).join(', ')})`]);
    }
    drills = drills.filter((d) => values.only.includes(d.name));
  }

  const width = Math.max(...drills.map((d) => d.name.length));
  const results = await runDrills(drills, {
    stateDir: resolveStateDir(values, config),
    notify: config.notify,
    partial: Boolean(values.only?.length),
    warn: (msg) => process.stderr.write(`restore-drill: warning: ${msg}\n`),
    onResult: values.json ? undefined : (rec) => console.log(formatResultLine(rec, width)),
  });
  const ok = results.every((r) => r.ok);
  if (values.json) console.log(JSON.stringify({ ok, results }, null, 2));
  return ok ? 0 : 1;
}

// ---- status -------------------------------------------------------------------------------

function statusRows(values) {
  const config = getConfig(values, { optional: true });
  const rows = readHistory(resolveStateDir(values, config));
  return summarize(rows, config?.drills.map((d) => d.name) ?? []);
}

async function cmdStatus({ values }) {
  const summary = statusRows(values);
  if (!summary.length) {
    console.log('No results yet. Run "restore-drill run" first.');
    return 0;
  }
  const now = Date.now();
  const table = summary.map((s) => [
    s.name,
    s.last ? (s.last.ok ? 'pass' : 'fail') : 'never run',
    s.lastPass ? formatAgo(now - Date.parse(s.lastPass.started)) : 'never',
    s.streak ? `${s.streak.count} ${s.streak.ok ? 'pass' : 'fail'}` : '-',
  ]);
  table.unshift(['DRILL', 'LAST', 'LAST PASS', 'STREAK']);
  const widths = table[0].map((_, i) => Math.max(...table.map((r) => r[i].length)));
  for (const [i, row] of table.entries()) {
    const line = row.map((c, j) => c.padEnd(widths[j])).join('  ').trimEnd();
    console.log(i && row[1] === 'fail' ? paint('31', line) : line);
  }
  return 0;
}

// ---- report -------------------------------------------------------------------------------

async function cmdReport({ values }) {
  const summary = statusRows(values);
  const out = path.resolve(values.out ?? 'status.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderReport(summary, { now: Date.now() }));
  console.log(`wrote ${out}`);
  return 0;
}

// ---- init ---------------------------------------------------------------------------------

async function cmdInit({ values }) {
  const target = path.resolve(values.out ?? 'drills.json');
  if (fs.existsSync(target) && !values.force) {
    throw new ConfigError([`${target} already exists (use --force to overwrite)`]);
  }
  fs.writeFileSync(target, `${JSON.stringify(EXAMPLE_CONFIG, null, 2)}\n`);
  console.log(`wrote ${target}\nEdit the paths, then run: restore-drill run --config ${path.relative(process.cwd(), target) || target}`);
  return 0;
}

// ---- demo ---------------------------------------------------------------------------------

async function cmdDemo({ values }) {
  return runDemo({ out: values.out ? path.resolve(values.out) : null, line: formatResultLine });
}

// ---- entry --------------------------------------------------------------------------------

export async function main(argv) {
  try {
    const [name, ...rest] = argv;
    if (!name || name === '-h' || name === '--help' || name === 'help') {
      if (!name) throw new UsageError('missing command');
      process.stdout.write(HELP);
      return 0;
    }
    if (name === '--version' || name === '-v') {
      console.log(VERSION);
      return 0;
    }
    const cmd = COMMANDS[name];
    if (!cmd) throw new UsageError(`unknown command "${name}"`);
    let parsed;
    try {
      parsed = parseArgs({ args: rest, options: { ...cmd.options, help: { type: 'boolean', short: 'h' } }, allowPositionals: false, strict: true });
    } catch (err) {
      throw new UsageError(err.message.replace(/\. To specify a positional.*$/, ''));
    }
    if (parsed.values.help) {
      process.stdout.write(HELP);
      return 0;
    }
    return await cmd.handler(parsed);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`restore-drill: ${err.message}\nUsage: restore-drill <run|status|report|init|demo> [options]. Try "restore-drill --help".\n`);
      return 2;
    }
    if (err instanceof ConfigError) {
      for (const p of err.problems) process.stderr.write(`restore-drill: ${p}\n`);
      return 2;
    }
    process.stderr.write(`restore-drill: internal error: ${err?.stack ?? err}\n`);
    return 1;
  }
}
