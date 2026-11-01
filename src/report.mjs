import { formatAgo, formatSpan } from './util.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSS = `
:root{color-scheme:dark;--bg:#0d0e11;--card:#15171c;--card-hi:#1b1e24;--text:#eceef2;--muted:#9096a3;--pass:#47c98b;--fail:#ff6f61;--idle:#5b606c;--ease:cubic-bezier(.23,1,.32,1)}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;min-height:100dvh;background:var(--bg);color:var(--text);font:16px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%;padding:max(28px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(32px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
main{max-width:720px;margin:0 auto}
h1{text-wrap:balance;margin:0 0 20px;font-size:28px;line-height:1.15;font-weight:650;letter-spacing:-.02em}
h1.bad{color:var(--fail)}
ul{list-style:none;margin:0;padding:0;display:grid;gap:8px}
li{animation:in .38s var(--ease) both;animation-delay:calc(var(--i)*40ms)}
.row{display:grid;grid-template-columns:12px 1fr auto 16px;column-gap:14px;align-items:center;min-height:64px;padding:12px 16px;background:var(--card);border-radius:14px;color:inherit;transition:background-color .15s ease,transform .16s var(--ease);touch-action:manipulation;-webkit-tap-highlight-color:transparent}
summary.row{cursor:pointer;list-style:none}
summary.row::-webkit-details-marker{display:none}
.dot{width:12px;height:12px;border-radius:50%;background:var(--idle)}
.pass .dot{background:var(--pass)}
.fail .dot{background:var(--fail)}
.row>span:nth-child(2){min-width:0}
.name{font-weight:600;font-size:17px;overflow-wrap:anywhere}
.sub{display:block;font-variant-numeric:tabular-nums;margin-top:2px;font-size:14px;color:var(--muted)}
.fail .sub{color:var(--fail)}
.age{font-size:14px;color:var(--muted);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.chev{width:16px;height:16px;color:var(--muted);transition:transform .2s var(--ease)}
details[open] .chev{transform:rotate(90deg)}
details[open]>.row{border-bottom-left-radius:0;border-bottom-right-radius:0}
pre{margin:0;padding:14px 16px 16px 42px;background:var(--card-hi);border-radius:0 0 14px 14px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--text);animation:in .18s var(--ease) both}
:focus-visible{outline:2px solid var(--text);outline-offset:2px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
footer{margin-top:20px;font-size:12px;color:var(--muted)}
.row:active{transform:scale(.985)}
@media (hover:hover) and (pointer:fine){summary.row:hover{background:var(--card-hi)}}
@media (min-width:720px){body{padding-top:72px}h1{font-size:34px;margin-bottom:28px}.row{padding:14px 20px;min-height:72px}.name{font-size:18px}pre{padding-left:46px}}
@media (max-width:420px){.age{font-size:13px}.row{column-gap:12px;padding-inline:14px}pre{padding-left:38px}}
@keyframes in{from{opacity:0;transform:translateY(6px)}}
@media (prefers-reduced-motion:reduce){li,pre{animation:none}.row,.chev{transition:none}.row:active{transform:none}}
`;

const SCRIPT = `
(function(){
  function ago(ms){var s=ms/1000;if(s<60)return'just now';if(s<3600)return Math.floor(s/60)+'m ago';
    if(s<259200)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';}
  function tick(){var n=Date.now();document.querySelectorAll('[data-at]').forEach(function(e){
    e.textContent=(e.dataset.pre||'')+ago(Math.max(0,n-Number(e.dataset.at)));});}
  tick();setInterval(tick,60000);
})();
`;

const CHEVRON = '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>';

function ago(ts, now, prefix = '') {
  return `<span data-at="${ts}" data-pre="${esc(prefix)}">${esc(prefix + formatAgo(now - ts))}</span>`;
}

function row(s, now) {
  const { last, lastPass } = s;
  const state = last ? (last.ok ? 'pass' : 'fail') : 'idle';
  const sub = lastPass
    ? ago(Date.parse(lastPass.started), now, 'last restored ')
    : last ? 'never restored' : 'not run yet';
  const backupAge = last?.backup_mtime
    ? `backup ${formatSpan(Date.parse(last.started) - Date.parse(last.backup_mtime))} old`
    : '';
  const label = state === 'pass' ? 'passing' : state === 'fail' ? 'failing' : 'not run';
  const body = `<span class="dot"><span class="sr">${label}</span></span>
<span><span class="name" translate="no">${esc(s.name)}</span><span class="sub">${sub}</span></span>
<span class="age">${esc(backupAge)}</span>`;
  if (state !== 'fail') return `<div class="row ${state}">${body}<span></span></div>`;
  return `<details><summary class="row fail">${body}${CHEVRON}</summary><pre>${esc(last.error || 'failed with no error text')}</pre></details>`;
}

function headline(summary) {
  const failing = summary.filter((s) => s.last && !s.last.ok).length;
  if (failing) return { text: `${failing} failing`, bad: true };
  if (!summary.some((s) => s.last)) return { text: 'Nothing run yet', bad: false };
  return { text: 'All passing', bad: false };
}

/** A single self-contained page. No external requests, no framework. */
export function renderReport(summary, { now = Date.now() } = {}) {
  const rank = (s) => (s.last && !s.last.ok ? 0 : s.last ? 2 : 1);
  const sorted = [...summary].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const h = headline(summary);
  const items = sorted.map((s, i) => `<li style="--i:${i}">${row(s, now)}</li>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0d0e11">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>restore-drill</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1${h.bad ? ' class="bad"' : ''}>${esc(h.text)}</h1>
<ul>
${items}
</ul>
<footer>${ago(now, now, 'updated ')}</footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
