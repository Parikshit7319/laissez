// Checks the OpenAPI document in api/src/openapi.ts.
// 1. It is a structurally valid OpenAPI 3.1 document.
// 2. Every operation has an operationId, a tag, a summary and an x-laissez-permission annotation.
// 3. Every route the Hono routers register appears in the document, and nothing in the document is unregistered.
// Run with `npm run test:openapi`.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Validator } from '@seriousme/openapi-schema-validator';
import { OPENAPI } from '../api/src/openapi';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = join(root, 'api', 'src');
let failures = 0;
const fail = (msg: string) => { failures++; console.error(`FAIL  ${msg}`); };
const pass = (msg: string) => console.log(`ok    ${msg}`);

// ---------- 1. Structure ----------
const doc = JSON.parse(JSON.stringify(OPENAPI));
const validator = new Validator();
const result = await validator.validate(doc);
if (result.valid) pass(`valid OpenAPI ${doc.openapi} document`);
else {
  fail('document does not validate against the OpenAPI 3.1 schema');
  console.error(JSON.stringify(result.errors, null, 2).slice(0, 4000));
}

// ---------- 2. Operation annotations ----------
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const tagNames = new Set((doc.tags ?? []).map((t: { name: string }) => t.name));
const ids = new Map<string, string>();
const specOps = new Set<string>();
let opCount = 0;
for (const [path, item] of Object.entries<Record<string, any>>(doc.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!METHODS.has(method)) continue;
    opCount++;
    const key = `${method} ${path}`;
    specOps.add(key);
    if (!op.operationId) fail(`${key} has no operationId`);
    else if (ids.has(op.operationId)) fail(`${key} reuses operationId ${op.operationId} (also ${ids.get(op.operationId)})`);
    else ids.set(op.operationId, key);
    if (!op.summary) fail(`${key} has no summary`);
    if (!Array.isArray(op.tags) || op.tags.length !== 1) fail(`${key} must have exactly one tag`);
    else if (!tagNames.has(op.tags[0])) fail(`${key} uses undeclared tag ${op.tags[0]}`);
    if (typeof op['x-laissez-permission'] !== 'string' || !op['x-laissez-permission']) fail(`${key} has no x-laissez-permission`);
    if (!Array.isArray(op['x-laissez-api-key-scopes'])) fail(`${key} has no x-laissez-api-key-scopes`);
    if (!Array.isArray(op['x-laissez-roles'])) fail(`${key} has no x-laissez-roles`);
    if (!op.responses || !Object.keys(op.responses).length) fail(`${key} has no responses`);
    if (!Array.isArray(op.security)) fail(`${key} has no security array`);
    for (const p of op.parameters ?? []) if (p.in === 'path' && !path.includes(`{${p.name}}`)) fail(`${key} declares path parameter ${p.name} that is not in the path`);
    for (const m of path.matchAll(/\{([^}]+)\}/g)) if (!(op.parameters ?? []).some((p: any) => p.in === 'path' && p.name === m[1])) fail(`${key} does not declare path parameter ${m[1]}`);
  }
}
let webhookCount = 0;
for (const [name, item] of Object.entries<Record<string, any>>(doc.webhooks ?? {})) {
  webhookCount++;
  const op = item.post;
  if (!op?.operationId) fail(`webhook ${name} has no operationId`);
  if (!op?.summary) fail(`webhook ${name} has no summary`);
  if (!op?.requestBody) fail(`webhook ${name} has no request body`);
}
const unusedTags = [...tagNames].filter((t) => ![...Object.values<Record<string, any>>(doc.paths)].some((item) => Object.values(item).some((op: any) => op?.tags?.[0] === t)) && !Object.values<Record<string, any>>(doc.webhooks ?? {}).some((w) => w.post?.tags?.[0] === t));
if (unusedTags.length) fail(`tags with no operations: ${unusedTags.join(', ')}`);
pass(`${opCount} operations and ${webhookCount} webhook events annotated`);

// ---------- 3. Routers ----------
// Mount prefixes mirror api/src/index.ts.
const MOUNTS: Record<string, Record<string, string>> = {
  'index.ts': { app: '' },
  'auth.ts': { pub: '/v1', acct: '/v1' },
  'oidc.ts': { idp: '/idp' },
  'routes/core.ts': { routes: '/v1', publicRoutes: '/v1' },
  'routes/platform.ts': { routes: '/v1', publicRoutes: '/v1' },
  'routes/compliance.ts': { routes: '/v1', publicRoutes: '/v1' },
  'routes/fundops.ts': { routes: '/v1', publicRoutes: '/v1' },
  'routes/network.ts': { routes: '/v1', publicRoutes: '/v1' },
  'routes/reports.ts': { routes: '/v1', publicRoutes: '/v1' },
  'routes/chain.ts': { routes: '/v1', publicRoutes: '/v1' },
  'routes/portal.ts': { routes: '/v1', publicRoutes: '/v1/portal' },
  'routes/travel.ts': { routes: '/v1', publicRoutes: '/trp', trpRoutes: '/trp' },
};
for (const f of readdirSync(join(api, 'routes'))) if (f.endsWith('.ts') && !MOUNTS[`routes/${f}`]) fail(`routes/${f} has no mount prefix in scripts/test-openapi.ts`);

/** Hono path to OpenAPI paths. `:id` becomes `{id}`; `:x{a|b}` expands to one path per literal. */
function expand(honoPath: string): string[] {
  let out = [''];
  for (const seg of honoPath.split('/').filter(Boolean)) {
    const m = seg.match(/^:(\w+)(?:\{(.+)\})?$/);
    if (!m) { out = out.map((p) => `${p}/${seg}`); continue; }
    const [, name, pattern] = m;
    const literals = pattern && /^[\w|-]+$/.test(pattern) ? pattern.split('|') : null;
    out = out.flatMap((p) => literals ? literals.map((l) => `${p}/${l}`) : [`${p}/{${name}}`]);
  }
  return out.map((p) => p || '/');
}

const registered = new Map<string, string>();
for (const [file, routers] of Object.entries(MOUNTS)) {
  const src = readFileSync(join(api, file), 'utf8');
  for (const m of src.matchAll(/^\s*(\w+)\.(get|post|put|patch|delete)\(\s*'([^']+)'/gm)) {
    const [, router, method, p] = m;
    if (router === 'c') continue; // c.get('admin') reads a context variable, not a route
    const base = routers[router];
    if (base === undefined) { fail(`${file}: router "${router}" has no mount prefix`); continue; }
    for (const e of expand(p)) registered.set(`${method} ${base}${e}`.replace(/\/\/+/g, '/'), file);
  }
}
const missing = [...registered.keys()].filter((k) => !specOps.has(k));
const extra = [...specOps].filter((k) => !registered.has(k));
for (const k of missing) fail(`route ${k} (${registered.get(k)}) is not in the OpenAPI document`);
for (const k of extra) fail(`document describes ${k} but no router registers it`);
if (!missing.length && !extra.length) pass(`${registered.size} registered routes all described, nothing extra`);

// ---------- 4. Size ----------
const srcBytes = readFileSync(join(api, 'openapi.ts')).length;
const jsonBytes = JSON.stringify(doc).length;
if (srcBytes > 120 * 1024) fail(`api/src/openapi.ts is ${srcBytes} bytes, over the 120 KB budget`);
else pass(`source ${(srcBytes / 1024).toFixed(1)} KB, JSON ${(jsonBytes / 1024).toFixed(1)} KB`);

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll OpenAPI checks passed.');
