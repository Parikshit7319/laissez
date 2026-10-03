#!/usr/bin/env node
// Dependency audit gate for CI. Fails on any high or critical advisory in production dependencies, except advisories
// listed in .audit-allowlist.json. An allowlist entry needs an advisory id, a reason and a review date; after that date
// it stops working and the build fails again, so an exception can never be forgotten.
//
//   node scripts/audit-gate.mjs [directory]     directory defaults to the current one
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(process.argv[2] ?? '.');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const allowFile = join(root, '.audit-allowlist.json');
const allow = existsSync(allowFile) ? JSON.parse(readFileSync(allowFile, 'utf8')) : [];
const today = new Date().toISOString().slice(0, 10);

let raw;
try {
  raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  raw = e.stdout; // npm audit exits non-zero when it finds anything
  if (!raw) { console.error(`npm audit failed to run in ${dir}: ${e.message}`); process.exit(2); }
}
const report = JSON.parse(raw);
if (report.error) { console.error(`npm audit error: ${report.error.summary ?? JSON.stringify(report.error)}`); process.exit(2); }

const rank = { low: 1, moderate: 2, high: 3, critical: 4 };
const found = new Map();
for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of v.via ?? []) {
    if (typeof via !== 'object' || (rank[via.severity] ?? 0) < rank.high) continue;
    const id = (via.url ?? '').split('/').pop() || via.source;
    if (!found.has(id)) found.set(id, { id, severity: via.severity, title: via.title, range: via.range, packages: new Set(), url: via.url });
    found.get(id).packages.add(pkg);
  }
}

let failed = 0;
for (const a of found.values()) {
  const entry = allow.find((x) => x.id === a.id);
  const pkgs = [...a.packages].join(', ');
  if (entry && entry.review_by >= today) {
    console.log(`ALLOWED  ${a.severity} ${a.id} ${pkgs}: ${a.title}\n         ${entry.reason} Review by ${entry.review_by}.`);
  } else {
    failed++;
    console.log(`FAIL     ${a.severity} ${a.id} ${pkgs}: ${a.title}\n         ${a.url}${entry ? `\n         The exception for this advisory expired on ${entry.review_by}.` : ''}`);
  }
}
console.log(found.size ? `${found.size} high or critical advisory(ies), ${failed} not allowed.` : 'No high or critical advisories in production dependencies.');
process.exit(failed ? 1 : 0);
