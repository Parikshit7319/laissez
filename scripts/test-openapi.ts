// Checks the OpenAPI document: the hand-written api/src/openapi.ts merged with the generated parts from
// api/src/openapi-gen.ts (the document GET /v1/openapi.json serves).
// 1. It is a structurally valid OpenAPI 3.1 document.
// 2. Every operation has an operationId, a tag, a summary and an x-laissez-permission annotation.
// 3. Every route the Hono routers register appears in the document, and nothing in the document is unregistered.
// 4. For every route with a zod schema in BODY_SCHEMAS, the hand-written body agrees with the zod-derived one
//    on required fields and does not describe properties zod would never read.
// 5. api/src/openapi.generated.json, when present, matches the current merge (warning only).
// Run with `npm run test:openapi`.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Validator } from '@seriousme/openapi-schema-validator';
import { OPENAPI } from '../api/src/openapi';
import { mergedSpec, BODY_SCHEMAS, zodToSchema, requiredOf, propertiesOf } from '../api/src/openapi-gen';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = join(root, 'api', 'src');
let failures = 0;
const fail = (msg: string) => { failures++; console.error(`FAIL  ${msg}`); };
const pass = (msg: string) => console.log(`ok    ${msg}`);

// ---------- 1. Structure ----------
const doc = JSON.parse(JSON.stringify(mergedSpec()));
const hand = JSON.parse(JSON.stringify(OPENAPI));
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
  'routes/account2.ts': { routes: '/v1', publicRoutes: '/v1' },
  'routes/compliance2.ts': { routes: '/v1' },
  'routes/leads.ts': { publicRoutes: '/v1' },
  'routes/integrations.ts': { routes: '/v1' },
  'routes/workflow.ts': { routes: '/v1' },
  'routes/import.ts': { routes: '/v1' },
  'routes/rules.ts': { routes: '/v1' },
  'routes/security.ts': { routes: '/v1', publicRoutes: '/v1' },
  'routes/billing.ts': { routes: '/v1', publicRoutes: '/v1' },
  // Mounted through routes/fundops.ts and routes/reports.ts, so they share the /v1 prefix.
  'routes/fundops2.ts': { routes: '/v1' },
  'routes/reports2.ts': { routes: '/v1' },
  'routes/brand.ts': { routes: '/v1', publicRoutes: '/v1' },
  'flags.ts': { routes: '/v1' },
  'errors.ts': { publicRoutes: '/v1' },
};
// A router file without an entry follows the convention in index.ts: `routes` and `publicRoutes` both mount on /v1.
for (const f of readdirSync(join(api, 'routes'))) if (f.endsWith('.ts') && !MOUNTS[`routes/${f}`]) { MOUNTS[`routes/${f}`] = { routes: '/v1', publicRoutes: '/v1' }; console.warn(`warn  routes/${f} has no entry in MOUNTS; assuming routes and publicRoutes mount on /v1`); }

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

// ---------- 4. Hand-written bodies against zod ----------
// The hand-written schema is documentation; zod is what runs. They must agree on which fields are required, and
// the documentation may not list properties zod never reads. Extra zod properties only warn: the prose can lag.
let compared = 0;
for (const [key, schema] of Object.entries(BODY_SCHEMAS)) {
  const [method, path] = key.split(' ');
  const op = hand.paths?.[path]?.[method];
  if (!op) continue; // declared next to a router, not in the hand-written spec
  compared++;
  const written = op.requestBody?.content?.['application/json']?.schema;
  const derived = zodToSchema(schema);
  const wr = requiredOf(written); const dr = requiredOf(derived);
  if (!written) { fail(`${key}: the hand-written spec has no request body but the handler parses one with zod`); continue; }
  if (wr === null || dr === null) continue;
  const missing = dr.filter((f) => !wr.includes(f)); const extra = wr.filter((f) => !dr.includes(f));
  if (missing.length) fail(`${key}: zod requires ${missing.join(', ')} but the hand-written body does not mark ${missing.length === 1 ? 'it' : 'them'} required`);
  if (extra.length) fail(`${key}: the hand-written body marks ${extra.join(', ')} required but zod does not`);
  const wp = propertiesOf(written) ?? []; const dp = propertiesOf(derived) ?? [];
  const unknown = wp.filter((f) => !dp.includes(f));
  if (unknown.length && derived.additionalProperties === false) fail(`${key}: the hand-written body documents ${unknown.join(', ')}, which zod rejects`);
  else if (unknown.length) fail(`${key}: the hand-written body documents ${unknown.join(', ')}, which the handler never reads`);
  const undocumented = dp.filter((f) => !wp.includes(f));
  if (undocumented.length) console.warn(`warn  ${key}: zod accepts ${undocumented.join(', ')} but the hand-written body does not describe ${undocumented.length === 1 ? 'it' : 'them'}`);
}
pass(`${compared} hand-written request bodies agree with their zod schemas on required fields`);
for (const [path, item] of Object.entries<Record<string, any>>(doc.paths)) for (const [method, op] of Object.entries(item)) {
  if (op?.['x-laissez-schema-source'] === 'zod' && !BODY_SCHEMAS[`${method} ${path}`]) fail(`${method} ${path} is marked zod-sourced but has no entry in BODY_SCHEMAS`);
}

// ---------- 5. Generated file freshness ----------
const genPath = join(api, 'openapi.generated.json');
if (!existsSync(genPath)) console.warn('warn  api/src/openapi.generated.json is missing. Run `npm run docs:openapi`.');
else if (JSON.stringify(JSON.parse(readFileSync(genPath, 'utf8'))) !== JSON.stringify(doc)) console.warn('warn  api/src/openapi.generated.json is stale. Run `npm run docs:openapi`.');
else pass('api/src/openapi.generated.json matches the current merge');

// ---------- 6. Size ----------
const srcBytes = readFileSync(join(api, 'openapi.ts')).length;
const jsonBytes = JSON.stringify(doc).length;
if (srcBytes > 160 * 1024) fail(`api/src/openapi.ts is ${srcBytes} bytes, over the 160 KB budget`);
else pass(`source ${(srcBytes / 1024).toFixed(1)} KB, merged JSON ${(jsonBytes / 1024).toFixed(1)} KB`);

if (failures) { console.error(`\n${failures} check(s) failed.`); process.exit(1); }
console.log('\nAll OpenAPI checks passed.');
