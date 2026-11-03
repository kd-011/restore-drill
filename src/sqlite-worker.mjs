// Runs in its own process so a hung or crashing SQLite call can be killed on timeout.
// usage: node sqlite-worker.mjs check <file> '<json spec>'
//        node sqlite-worker.mjs make <file> <rows>      (demo fixtures)
import { DatabaseSync } from 'node:sqlite';

const [, , mode, file, arg] = process.argv;

function reply(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function firstValue(row) {
  return row ? Object.values(row)[0] : undefined;
}

function check(spec) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const lines = db.prepare('PRAGMA integrity_check').all().map(firstValue);
    if (!(lines.length === 1 && lines[0] === 'ok')) {
      const shown = lines.slice(0, 5).join('; ');
      return { ok: false, error: `integrity_check failed: ${shown}${lines.length > 5 ? `; and ${lines.length - 5} more` : ''}` };
    }
    const tables = firstValue(db.prepare("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get());
    if (!tables) return { ok: false, error: 'database has no tables: it opens, but nothing was backed up into it' };
    const missing = [];
    for (const table of spec.tables ?? []) {
      const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table);
      if (!row) missing.push(table);
    }
    if (missing.length) return { ok: false, error: `table not found: ${missing.join(', ')}` };

    for (const c of spec.checks ?? []) {
      const value = firstValue(db.prepare(c.sql).get());
      const min = c.min ?? 1;
      const n = typeof value === 'bigint' ? Number(value) : value;
      if (typeof n !== 'number' || Number.isNaN(n)) {
        return { ok: false, error: `check failed: ${c.sql} returned ${n === undefined ? 'no rows' : JSON.stringify(n)}, expected a number` };
      }
      if (n < min) return { ok: false, error: `check failed: ${c.sql} returned ${n}, expected at least ${min}` };
    }
    return { ok: true };
  } finally {
    db.close();
  }
}

function make(rows) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, bio TEXT)');
  const ins = db.prepare('INSERT INTO users (name, bio) VALUES (?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < rows; i++) ins.run(`user${i}`, `bio text for user ${i}`);
  db.exec('COMMIT');
  db.close();
  return { ok: true };
}

try {
  reply(mode === 'make' ? make(Number(arg)) : check(JSON.parse(arg)));
} catch (err) {
  reply({ ok: false, error: err.message });
}
