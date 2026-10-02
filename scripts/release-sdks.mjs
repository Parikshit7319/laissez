#!/usr/bin/env node
// Bumps the SDK versions in lockstep with the API version and cuts the tag that publishes them.
//
//   node scripts/release-sdks.mjs                   # version derived from the latest API version: 2026-10-02 -> 2026.10.2
//   node scripts/release-sdks.mjs 2026.10.2         # explicit SDK version (semver: year.month.day, or any x.y.z)
//   node scripts/release-sdks.mjs --api 2026-10-02  # also pin DEFAULT_API_VERSION in both SDKs to that API version
//   node scripts/release-sdks.mjs --no-git          # write files only, no commit and no tag
//   node scripts/release-sdks.mjs --check 2026.10.2 # verify every version string equals 2026.10.2 (CI uses this)
//
// Files touched: sdk/typescript/package.json, sdk/typescript/laissez.ts (SDK_VERSION, DEFAULT_API_VERSION),
// sdk/python/pyproject.toml, sdk/python/src/laissez/client.py (SDK_VERSION, DEFAULT_API_VERSION).
// Then: git push --follow-tags. The sdk-v<version> tag triggers .github/workflows/publish-sdks.yml.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = {
  pkg: 'sdk/typescript/package.json',
  ts: 'sdk/typescript/laissez.ts',
  pyproject: 'sdk/python/pyproject.toml',
  py: 'sdk/python/src/laissez/client.py',
  versions: 'api/src/version.ts',
};
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const write = (f, s) => fs.writeFileSync(path.join(ROOT, f), s);
const fail = (m) => { console.error(`error: ${m}`); process.exit(1); };

// ---------- Arguments ----------
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i === -1) return null; const v = args[i + 1]; args.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : true; };
const check = flag('--check');
const apiArg = flag('--api');
const noGit = !!flag('--no-git');
const explicit = args.find((a) => !a.startsWith('--')) ?? null;

// ---------- Current state ----------
const apiVersions = [...read(FILES.versions).matchAll(/version:\s*'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]);
if (!apiVersions.length) fail(`No API versions found in ${FILES.versions}.`);
const latestApi = apiVersions[0];
const apiToSemver = (v) => v.split('-').map((x, i) => (i === 0 ? x : String(Number(x)))).join('.');
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const current = {
  pkg: JSON.parse(read(FILES.pkg)).version,
  ts: read(FILES.ts).match(/export const SDK_VERSION = '([^']+)'/)?.[1],
  pyproject: read(FILES.pyproject).match(/^version = "([^"]+)"/m)?.[1],
  py: read(FILES.py).match(/^SDK_VERSION = "([^"]+)"/m)?.[1],
  tsApi: read(FILES.ts).match(/export const DEFAULT_API_VERSION = '([^']+)'/)?.[1],
  pyApi: read(FILES.py).match(/^DEFAULT_API_VERSION = "([^"]+)"/m)?.[1],
};
for (const [k, v] of Object.entries(current)) if (!v) fail(`Could not read the version from ${FILES[k.replace('Api', '')]} (${k}).`);

// ---------- Check mode ----------
if (check) {
  const want = check === true ? current.pkg : check;
  const bad = ['pkg', 'ts', 'pyproject', 'py'].filter((k) => current[k] !== want);
  if (bad.length) fail(`Version mismatch. Expected ${want}: ${bad.map((k) => `${FILES[k]} has ${current[k]}`).join('; ')}.`);
  if (current.tsApi !== current.pyApi) fail(`The SDKs default to different API versions: ${current.tsApi} (TypeScript) and ${current.pyApi} (Python).`);
  if (!apiVersions.includes(current.tsApi)) fail(`The SDKs default to API version ${current.tsApi}, which ${FILES.versions} does not list. Known: ${apiVersions.join(', ')}.`);
  console.log(`ok  SDK version ${want} in all four files; default API version ${current.tsApi} (latest is ${latestApi}).`);
  process.exit(0);
}

// ---------- Release mode ----------
const api = apiArg === true ? latestApi : (apiArg ?? null);
if (api && !apiVersions.includes(api)) fail(`API version ${api} is not in ${FILES.versions}. Known: ${apiVersions.join(', ')}.`);
const next = explicit ?? apiToSemver(api ?? latestApi);
if (!SEMVER.test(next)) fail(`${next} is not a semver version (x.y.z).`);
if (next === current.pkg && !api) fail(`The SDKs are already at ${next}. Pass a new version, for example ${next.replace(/(\d+)$/, (d) => String(Number(d) + 1))}, or --api to repin the API version.`);

const pyVersion = next.replace(/-([0-9A-Za-z.-]+)$/, (_, pre) => (/^(a|b|rc)/.test(pre) ? pre.replace(/\./g, '') : `.dev${pre.replace(/\D/g, '') || 0}`));

// package.json: keep key order, bump version only.
const pkg = JSON.parse(read(FILES.pkg));
pkg.version = next;
write(FILES.pkg, JSON.stringify(pkg, null, 2) + '\n');
// TypeScript source.
let ts = read(FILES.ts).replace(/export const SDK_VERSION = '[^']+'/, `export const SDK_VERSION = '${next}'`);
if (api) ts = ts.replace(/export const DEFAULT_API_VERSION = '[^']+'/, `export const DEFAULT_API_VERSION = '${api}'`);
write(FILES.ts, ts);
// pyproject and Python source.
write(FILES.pyproject, read(FILES.pyproject).replace(/^version = "[^"]+"/m, `version = "${pyVersion}"`));
let py = read(FILES.py).replace(/^SDK_VERSION = "[^"]+"/m, `SDK_VERSION = "${pyVersion}"`);
if (api) py = py.replace(/^DEFAULT_API_VERSION = "[^"]+"/m, `DEFAULT_API_VERSION = "${api}"`);
write(FILES.py, py);

console.log(`SDK version ${current.pkg} -> ${next}${pyVersion !== next ? ` (PyPI: ${pyVersion})` : ''}${api ? `, default API version ${current.tsApi} -> ${api}` : ''}`);
for (const f of [FILES.pkg, FILES.ts, FILES.pyproject, FILES.py]) console.log(`  updated ${f}`);

if (noGit) { console.log('Skipped git. Commit and tag by hand: git tag -a sdk-v' + next); process.exit(0); }
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
try { git('rev-parse', '--is-inside-work-tree'); } catch { console.log('Not a git repository: files updated, nothing committed.'); process.exit(0); }
const tag = `sdk-v${next}`;
if (git('tag', '--list', tag)) fail(`Tag ${tag} already exists. Choose another version.`);
const dirty = git('status', '--porcelain').split('\n').filter((l) => l && !Object.values(FILES).some((f) => l.endsWith(f)));
if (dirty.length) fail(`The working tree has other uncommitted changes. Commit or stash them first:\n${dirty.join('\n')}`);
git('add', FILES.pkg, FILES.ts, FILES.pyproject, FILES.py);
git('commit', '-m', `Release SDKs ${next}${api ? ` for API ${api}` : ''}`);
git('tag', '-a', tag, '-m', `@laissez/sdk and laissez ${next}`);
console.log(`Committed and tagged ${tag}. Publish with: git push --follow-tags`);
