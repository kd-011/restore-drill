#!/usr/bin/env node
// Release logic for .github/workflows/publish.yml, kept in a script so it can be tested without a runner.
//
//   node scripts/release.mjs plan [--version X] [--published a,b] [--release-exists true|false]
//   node scripts/release.mjs notes <version> [--changelog FILE]
//
// plan: compares package.json's version with what npm has, and says what is left to do. With no flags it asks
//   the npm registry and GitHub (through the `gh` CLI), which is what the workflow does. With flags it asks
//   nobody, so `--published 0.1.0,0.2.0 --release-exists false` is a dry run. It prints a JSON object, and when
//   $GITHUB_OUTPUT is set it also writes version=, publish= and release= there.
// notes: prints the body of that version's CHANGELOG section, for the GitHub Release.
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

const die = (message) => {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
};

const parts = (v) => (STABLE.exec(v) ?? []).slice(1).map(Number);
export function compare(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * What is left to do for `version`.
 * @param {string} version  from package.json
 * @param {string[]} published  every version npm has, pre-releases included
 * @param {boolean} releaseExists  whether the v<version> GitHub Release (and so the tag) exists
 */
export function planRelease(version, published, releaseExists) {
  if (!STABLE.test(version)) {
    throw new Error(`version "${version}" is not x.y.z. Pre-release and build versions are not published by this workflow.`);
  }
  const onNpm = published.includes(version);
  if (!onNpm) {
    // `npm publish` moves the "latest" tag to whatever it publishes, so an older number would become what npx installs.
    const newest = published.filter((v) => STABLE.test(v)).sort(compare).at(-1);
    if (newest !== undefined && compare(version, newest) < 0) {
      throw new Error(`version ${version} is not on npm but is older than ${newest}, which is. Publishing it would make it "latest". Raise the version.`);
    }
  }
  const publish = !onNpm;
  const release = !releaseExists;
  const reason = publish
    ? `${version} is not on npm yet`
    : release
      ? `${version} is on npm but has no GitHub Release; finishing the release`
      : `${version} is already published and released; nothing to do`;
  return { version, publish, release, reason };
}

/** The body of `## version` or `## [version]` up to the next `## ` heading or the link references at the end. */
export function changelogSection(text, version) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const heading = (l) => l.startsWith(`## ${version}`) || l.startsWith(`## [${version}]`);
  const start = lines.findIndex(heading);
  if (start < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section. Add one before releasing.`);
  const body = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith('## ') || /^\[[^\]]+\]: \S/.test(l)) break;
    body.push(l);
  }
  const out = body.join('\n').trim();
  if (!out) throw new Error(`The "## ${version}" section of CHANGELOG.md is empty.`);
  return out;
}

function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { (out._ ??= []).push(a); continue; }
    const v = args[++i];
    if (v === undefined) die(`${a} needs a value`);
    out[a.slice(2)] = v;
  }
  return out;
}

async function npmVersions(name) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { headers: { accept: 'application/vnd.npm.install-v1+json' } });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`the npm registry answered HTTP ${res.status}`);
  return Object.keys((await res.json()).versions ?? {});
}

function githubReleaseExists(tag) {
  try {
    execFileSync('gh', ['release', 'view', tag], { stdio: 'ignore', cwd: root });
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('the gh CLI is not installed; pass --release-exists true|false');
    // `gh release view` exits 1 for "release not found" and for other failures alike; the next step would fail loudly on a real one.
    return false;
  }
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  if (cmd === 'plan') {
    const version = f.version ?? pkg.version;
    const published = f.published !== undefined ? f.published.split(',').map((s) => s.trim()).filter(Boolean) : await npmVersions(pkg.name);
    const exists = f['release-exists'] !== undefined ? f['release-exists'] === 'true' : githubReleaseExists(`v${version}`);
    const plan = planRelease(version, published, exists);
    process.stdout.write(JSON.stringify(plan) + '\n');
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `version=${plan.version}\npublish=${plan.publish}\nrelease=${plan.release}\n`);
    }
    return;
  }
  if (cmd === 'notes') {
    const version = f._?.[0];
    if (!version) die('notes needs a version');
    process.stdout.write(changelogSection(readFileSync(f.changelog ?? join(root, 'CHANGELOG.md'), 'utf8'), version) + '\n');
    return;
  }
  die('usage: release.mjs plan [--version X] [--published a,b] [--release-exists true|false] | notes <version> [--changelog FILE]');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => die(e.message));
}
