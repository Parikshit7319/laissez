// Builds the error catalogue from the source: every `new ApiError(status, 'code', 'message')` across api/src.
// Writes api/src/errors.generated.ts (served at GET /v1/errors) and docs/errors.md, and fails when a code is
// not snake_case or is thrown with two different statuses, because codes are a contract the SDKs rely on.
// Run with `npm run docs:errors`.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = join(root, 'api', 'src');

/** Codes thrown with two statuses on purpose, each listed with the owner's reason. Anything else is a failure. */
const ALLOWED_STATUS_CONFLICTS: Record<string, string> = {
  sso_not_configured: 'auth.ts answers 404 when single sign-on is not set up at all; account2.ts answers 409 when group mapping is saved before a provider is connected. The owner of account2.ts should rename its code.',
};

type Site = { code: string; status: number; message: string; file: string; line: number };

function* files(dir: string): Generator<string> {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (f.endsWith('.ts') && !f.endsWith('.generated.ts') && f !== 'index.old.ts') yield p;
  }
}

// Message is a single- or back-quoted literal; template expressions are kept as "{...}" placeholders.
const CALL = /new ApiError\(\s*(\d{3})\s*,\s*'([^']+)'\s*,\s*('((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
const DYNAMIC = /new ApiError\((?!\s*\d{3}\s*,\s*')/g;
const sites: Site[] = [];
let dynamic = 0;
for (const file of files(api)) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(root, file).replace(/\\/g, '/');
  for (const m of src.matchAll(CALL)) {
    const line = src.slice(0, m.index).split('\n').length;
    const raw = (m[4] ?? m[5] ?? '').replace(/\\'/g, "'").replace(/\$\{[^}]*\}/g, (x) => `{${x.slice(2, -1).replace(/[^a-zA-Z0-9_.]/g, '').split('.').pop() || 'value'}}`);
    sites.push({ code: m[2], status: Number(m[1]), message: raw, file: rel, line });
  }
  dynamic += [...src.matchAll(DYNAMIC)].length;
}

let failures = 0;
const fail = (msg: string) => { failures++; console.error(`FAIL  ${msg}`); };
const byCode = new Map<string, Site[]>();
for (const s of sites) (byCode.get(s.code) ?? byCode.set(s.code, []).get(s.code)!).push(s);
for (const [code, list] of byCode) {
  if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(code)) fail(`code ${code} is not snake_case (${list[0].file}:${list[0].line})`);
  const statuses = [...new Set(list.map((s) => s.status))].sort();
  if (statuses.length > 1) {
    const where = statuses.map((st) => `${st} at ${list.filter((s) => s.status === st).map((s) => `${s.file}:${s.line}`).join(', ')}`).join('; ');
    if (ALLOWED_STATUS_CONFLICTS[code]) console.warn(`warn  code ${code} is thrown with statuses ${statuses.join(' and ')} (${where}). Allowed: ${ALLOWED_STATUS_CONFLICTS[code]}`);
    else fail(`code ${code} is thrown with different statuses: ${where}. One code means one thing; rename one of them.`);
  }
}
// Framework codes the error handler in index.ts produces without an ApiError.
const BUILT_IN: Site[] = [
  { code: 'invalid_request', status: 400, message: 'The request body is not valid. Fix the fields listed in detail and retry.', file: 'api/src/index.ts', line: 60 },
  { code: 'http_error', status: 400, message: 'The request could not be processed.', file: 'api/src/index.ts', line: 62 },
  { code: 'internal_error', status: 500, message: 'Something went wrong on our side. The request was not applied. Retry, and contact us if it keeps failing.', file: 'api/src/index.ts', line: 65 },
  { code: 'not_found', status: 404, message: 'No route for {method} {path}. See the API overview at GET /.', file: 'api/src/index.ts', line: 67 },
];
for (const b of BUILT_IN) if (!byCode.has(b.code)) byCode.set(b.code, [b]); else if (b.code === 'not_found') byCode.get(b.code)!.push(b);

/** Splits a message into what happened (first sentence) and what to do (the rest). */
function split(message: string): { message: string; remediation: string | null } {
  const i = message.search(/[.!?]\s+(?=[A-Z])/);
  if (i < 0) return { message, remediation: null };
  return { message: message.slice(0, i + 1), remediation: message.slice(i + 1).trim() || null };
}

const codes = [...byCode.keys()].sort();
const catalogue = codes.map((code) => {
  const list = byCode.get(code)!;
  const first = list[0];
  const status = Math.min(...list.map((s) => s.status));
  const { message, remediation } = split(first.message);
  return { code, status, message, remediation, sites: list.map((s) => ({ file: s.file, line: s.line, status: s.status, message: s.message })) };
});
/** The served module keeps the catalogue small: one line per code, throw sites as file:line. */
const served = catalogue.map((e) => ({ code: e.code, status: e.status, message: e.message, remediation: e.remediation, sites: [...new Set(e.sites.map((s) => `${s.file}:${s.line}`))] }));

const header = `// Generated by scripts/gen-errors.ts from every ApiError thrown in api/src. Do not edit: run \`npm run docs:errors\`.\n`;
const ts = `${header}export type ErrorEntry = { code: string; status: number; message: string; remediation: string | null; /** file:line of every throw site. */ sites: string[] };\nexport const GENERATED_AT = ${JSON.stringify(new Date().toISOString().slice(0, 10))};\nexport const ERROR_CATALOGUE: ErrorEntry[] = [\n${served.map((e) => `  ${JSON.stringify(e)},`).join('\n')}\n];\n`;
writeFileSync(join(api, 'errors.generated.ts'), ts);

const byStatus = new Map<number, typeof catalogue>();
for (const e of catalogue) (byStatus.get(e.status) ?? byStatus.set(e.status, []).get(e.status)!).push(e);
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const md = [
  '# API error codes',
  '',
  `Generated from the source by \`npm run docs:errors\` on ${new Date().toISOString().slice(0, 10)}. ${codes.length} codes across ${sites.length} throw sites${dynamic ? `, plus ${dynamic} call${dynamic === 1 ? '' : 's'} that ${dynamic === 1 ? 'passes' : 'pass'} a computed code and ${dynamic === 1 ? 'is' : 'are'} not listed` : ''}.`,
  '',
  'Every error response is `{"error": {"code", "message", "detail"}}`. The code is stable and snake_case; the message says what happened and, where there is something to do, how to fix it. The same list is served at `GET /v1/errors`.',
  '',
  ...[...byStatus.keys()].sort((a, b) => a - b).flatMap((status) => [
    `## ${status}`,
    '',
    '| Code | Message | What to do | Thrown from |',
    '| --- | --- | --- | --- |',
    ...byStatus.get(status)!.map((e) => `| \`${e.code}\` | ${esc(e.message)} | ${esc(e.remediation ?? '')} | ${[...new Set(e.sites.map((s) => `${s.file}:${s.line}`))].slice(0, 6).map((s) => `\`${s}\``).join(', ')}${e.sites.length > 6 ? ` and ${e.sites.length - 6} more` : ''} |`),
    '',
  ]),
].join('\n');
writeFileSync(join(root, 'docs', 'errors.md'), md);

console.log(`ok    ${codes.length} codes, ${sites.length} throw sites, ${dynamic} dynamic calls skipped`);
console.log('ok    wrote api/src/errors.generated.ts and docs/errors.md');
if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
