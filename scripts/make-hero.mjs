// Regenerates docs/screenshots/terminal.png from a real `restore-drill demo` run.
// Not part of the package. Needs a Chromium-family browser: set BROWSER, or it tries
// chromium, chromium-browser, google-chrome and brave-browser on PATH.
//   node scripts/make-hero.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'docs/screenshots/terminal.png');

const demo = spawnSync(process.execPath, [path.join(root, 'bin/restore-drill.mjs'), 'demo'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
if (demo.status !== 1) throw new Error(`demo should exit 1 (two drills fail on purpose), got ${demo.status}\n${demo.stderr}`);

// The temp dir name changes every run; the rest of the text is untouched.
const text = demo.stdout.replace(/\/tmp\/restore-drill-demo-[A-Za-z0-9]+/g, '...').trimEnd();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const html = text.split('\n').map((line) => {
  const cls = line.startsWith('PASS') ? 'pass' : line.startsWith('FAIL') ? 'fail' : '';
  return `<div class="${cls}">${esc(line) || '&nbsp;'}</div>`;
}).join('');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-hero-'));
const page = path.join(dir, 'hero.html');
fs.writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#0d1117;color:#d6dbe3;font:20px/38px "IBM Plex Mono","DejaVu Sans Mono",monospace;white-space:pre}
.bar{padding:26px 44px 0;height:24px}.bar i{display:inline-block;width:20px;height:20px;border-radius:50%;margin-right:14px}
main{padding:30px 44px 30px}.pass{color:#7ee2a8}.fail{color:#ff7b72}
</style><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div><main>${html}</main>`);

const candidates = [process.env.BROWSER, 'chromium', 'chromium-browser', 'google-chrome', 'brave-browser'].filter(Boolean);
const browser = candidates.find((b) => spawnSync('sh', ['-c', `command -v ${b}`]).status === 0);
if (!browser) throw new Error('no Chromium-family browser found; set BROWSER');
const height = 70 + 30 + 30 + text.split('\n').length * 38;
const shot = spawnSync(browser, ['--headless', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=2100,${height}`, `--screenshot=${out}`, `file://${page}`], { encoding: 'utf8' });
fs.rmSync(dir, { recursive: true, force: true });
if (shot.status !== 0 || !fs.existsSync(out)) throw new Error(`screenshot failed: ${shot.stderr}`);
console.log(`wrote ${path.relative(root, out)}`);
