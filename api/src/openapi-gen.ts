// Generated parts of the OpenAPI document. The hand-written spec in openapi.ts stays the source of prose,
// examples and response shapes; this module layers on top of it:
//   1. request body schemas derived from the zod schemas the routers actually parse (z.toJSONSchema), so the
//      document cannot drift from validation for the routes listed in BODY_SCHEMAS;
//   2. operations declared next to newer routers (flags, errors, notification channels), each exporting
//      OPENAPI_OPS and optional OPENAPI_SCHEMAS;
//   3. the cursor pagination contract (limit, cursor, next_cursor) on every paginated list.
// mergedSpec() is what GET /v1/openapi.json serves; scripts/gen-openapi.ts writes it to openapi.generated.json
// and scripts/test-openapi.ts checks the hand-written bodies agree with the zod-derived ones on required fields.
import { z } from 'zod';
import { OPENAPI } from './openapi';
import * as auth from './auth';
import * as core from './routes/core';
import * as platform from './routes/platform';
import * as flags from './flags';
import * as errors from './errors';
import * as integrations from './routes/integrations';

type S = Record<string, unknown>;

/** "method /path" to the zod schema the handler parses the body with. Paths use OpenAPI {param} form. */
export const BODY_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'post /v1/sandboxes': auth.sandboxIn,
  'post /v1/auth/register/options': auth.registerOptionsIn,
  'post /v1/auth/register/verify': auth.registerVerifyIn,
  'post /v1/auth/login/verify': auth.loginVerifyIn,
  'post /v1/auth/sso/exchange': auth.ssoExchangeIn,
  'post /v1/session/act-as': auth.actAsIn,
  'post /v1/session/switch': auth.switchIn,
  'post /v1/passkeys/verify': auth.passkeyVerifyIn,
  'patch /v1/members/{id}': auth.memberRoleIn,
  'post /v1/invites': auth.inviteIn,
  'patch /v1/organization': auth.organizationIn,
  'put /v1/sso': auth.ssoIn,
  'post /v1/investors': core.investorIn,
  'post /v1/credentials': core.credentialIn,
  'post /v1/funds': core.fundIn,
  'post /v1/funds/{ticker}/policy/preview': core.policyIn,
  'post /v1/funds/{ticker}/policy/changes': core.policyIn,
  'post /v1/decisions': core.decisionIn,
  'post /v1/evaluate/as-of': core.asOfIn,
  'post /v1/api-keys': platform.apiKeyIn,
  'post /v1/webhooks': platform.webhookIn,
  'post /v1/events': platform.eventIn,
  'put /v1/flags/{key}': flags.flagIn,
  'post /v1/notification-channels': integrations.channelIn,
};

/** JSON Schema (2020-12, the dialect OpenAPI 3.1 uses) for a zod schema's input side: defaults make fields optional. */
export function zodToSchema(schema: z.ZodTypeAny): S {
  const js = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }) as S;
  delete js.$schema;
  stripZodFormats(js);
  return js;
}
/** zod labels checks such as startsWith as JSON Schema formats; only the registered formats are kept. */
const KNOWN_FORMATS = new Set(['date-time', 'date', 'time', 'duration', 'email', 'idn-email', 'hostname', 'idn-hostname', 'ipv4', 'ipv6', 'uri', 'uri-reference', 'iri', 'uuid', 'regex', 'json-pointer', 'binary']);
function stripZodFormats(node: unknown): void {
  if (Array.isArray(node)) { node.forEach(stripZodFormats); return; }
  if (!node || typeof node !== 'object') return;
  const o = node as S;
  if (typeof o.format === 'string' && !KNOWN_FORMATS.has(o.format)) delete o.format;
  for (const v of Object.values(o)) stripZodFormats(v);
}

/** Required property names of an object schema; null when the schema is not an object. */
export const requiredOf = (s: S | undefined): string[] | null => (s && s.type === 'object' ? [...((s.required as string[] | undefined) ?? [])].sort() : null);
export const propertiesOf = (s: S | undefined): string[] | null => (s && s.type === 'object' && s.properties ? Object.keys(s.properties as object).sort() : null);

// ---------- Operations declared next to routers ----------
export type ExtraOp = {
  method: string; path: string; tag: string; id: string; sum: string; desc?: string; perm: string;
  body?: z.ZodTypeAny | S; ex?: unknown; ok?: number; res?: S; err?: number[]; idd?: string; pathParam?: [string, string, string?];
};
const SCOPE_PERMS: Record<string, string[]> = { read: ['read', 'audit:export'], orders: ['orders:write'], clients: ['clients:write'], funds: ['funds:write'], compliance: ['compliance:write', 'work:write'], developer: ['developer'], admin: ['keys:admin'] };
const ROLE_PERMS: Record<string, string[]> = { admin: ['*'], ops: ['read', 'clients:write', 'orders:write', 'work:write'], compliance: ['read', 'clients:write', 'compliance:write', 'policy:approve', 'work:write', 'audit:export'], issuer: ['read', 'funds:write', 'policy:approve'], developer: ['read', 'developer', 'keys:admin'], auditor: ['read', 'audit:export'] };
const HUMAN_ONLY = ['policy:approve', 'members:admin'];
const ERR_NAME: Record<number, string> = { 400: 'BadRequest', 401: 'Unauthorized', 403: 'Forbidden', 404: 'NotFound', 409: 'Conflict', 410: 'Gone', 422: 'Unprocessable', 429: 'RateLimited', 501: 'NotConfigured', 502: 'BadGateway', 503: 'Unavailable' };
const isZod = (x: unknown): x is z.ZodTypeAny => !!x && typeof x === 'object' && '_zod' in (x as object);

function buildOp(op: ExtraOp): S {
  const write = op.method !== 'get';
  const bearer = op.perm !== 'public';
  const human = HUMAN_ONLY.includes(op.perm);
  const scopes = !bearer || human ? [] : Object.keys(SCOPE_PERMS).filter((s) => SCOPE_PERMS[s].includes(op.perm));
  const roles = !bearer ? [] : Object.keys(ROLE_PERMS).filter((r) => ROLE_PERMS[r].includes('*') || ROLE_PERMS[r].includes(op.perm));
  const params: S[] = [...op.path.matchAll(/\{([^}]+)\}/g)].map(([, n]) => {
    const [desc, ex] = op.pathParam && op.pathParam[0] === n ? [op.pathParam[1], op.pathParam[2]] : [op.idd ?? 'Resource id.', undefined];
    return { name: n, in: 'path', required: true, description: desc, schema: { type: 'string' }, ...(ex ? { example: ex } : {}) };
  });
  params.push({ $ref: '#/components/parameters/LaissezVersion' });
  if (bearer && write) params.push({ $ref: '#/components/parameters/IdempotencyKey' });
  const ok = op.ok ?? 200;
  const headers: S = { 'Laissez-Version': { $ref: '#/components/headers/LaissezVersion' }, ...(bearer && write ? { 'Idempotent-Replayed': { $ref: '#/components/headers/IdempotentReplayed' } } : {}) };
  const responses: S = { [String(ok)]: { description: ok === 201 ? 'Created.' : 'OK.', headers, content: { 'application/json': { schema: op.res ?? { description: 'JSON object.' } } } } };
  const codes = new Set<number>([400, ...(bearer ? [401, 403] : []), ...(params.some((p) => p.in === 'path') ? [404] : []), ...(op.err ?? []), ...(bearer ? [429] : [])]);
  for (const c of [...codes].sort()) if (!responses[String(c)]) responses[String(c)] = { $ref: `#/components/responses/${ERR_NAME[c]}` };
  const bodySchema = op.body ? (isZod(op.body) ? zodToSchema(op.body) : op.body) : null;
  return {
    tags: [op.tag], operationId: op.id, summary: op.sum, ...(op.desc ? { description: op.desc } : {}),
    security: !bearer ? [] : human ? [{ sessionToken: [] }] : [{ sessionToken: [] }, { apiKey: [] }], parameters: params,
    ...(bodySchema ? { requestBody: { required: true, content: { 'application/json': { schema: bodySchema, ...(op.ex !== undefined ? { example: op.ex } : {}) } } } } : {}),
    responses, 'x-laissez-permission': op.perm, 'x-laissez-api-key-scopes': scopes, 'x-laissez-roles': roles, ...(human ? { 'x-laissez-human-only': true } : {}), 'x-laissez-generated': true,
  };
}

const EXTRA_MODULES: { OPENAPI_OPS: ExtraOp[]; OPENAPI_SCHEMAS?: Record<string, S> }[] = [flags as any, errors as any, integrations as any];

// ---------- Cursor pagination contract ----------
/** Lists that page with limit and cursor and answer { data, next_cursor, limit }. */
export const PAGINATED: string[] = [
  'get /v1/investors', 'get /v1/decisions', 'get /v1/settlements', 'get /v1/chain/jobs',
  'get /v1/audit-events', 'get /v1/work-items', 'get /v1/screening-hits', 'get /v1/webhook-deliveries', 'get /v1/notifications', 'get /v1/credential-shares',
];
const CURSOR_PARAM: S = { name: 'cursor', in: 'query', required: false, description: 'Opaque cursor from next_cursor of the previous page. Omit for the first page.', schema: { type: 'string' } };
const LIMIT_PARAM = (max: number, def: number): S => ({ name: 'limit', in: 'query', required: false, description: `Rows per page, 1 to ${max}.`, schema: { type: 'integer', minimum: 1, maximum: max, default: def } });

function patchPaginated(op: S) {
  const params = (op.parameters as S[]) ?? [];
  if (!params.some((p) => p.name === 'cursor')) params.push(CURSOR_PARAM);
  if (!params.some((p) => p.name === 'limit')) params.push(LIMIT_PARAM(200, 50));
  op.parameters = params;
  const okRes = (op.responses as Record<string, S>)['200'];
  const content = (okRes?.content as Record<string, S> | undefined)?.['application/json'];
  const schema = content?.schema as S | undefined;
  if (schema && schema.type === 'object') {
    const props = (schema.properties as Record<string, S>) ?? {};
    props.next_cursor = props.next_cursor ?? { type: ['string', 'null'], description: 'Cursor for the next page, or null on the last page.' };
    props.limit = props.limit ?? { type: 'integer', description: 'The page size that was applied.' };
    schema.properties = props;
  }
  op['x-laissez-paginated'] = true;
}

// ---------- The merged document ----------
let merged: S | null = null;
/** The hand-written document with zod-derived request bodies, router-declared operations and pagination merged in. */
export function mergedSpec(): S {
  if (merged) return merged;
  const doc = JSON.parse(JSON.stringify(OPENAPI)) as S & { paths: Record<string, Record<string, S>>; components: { schemas: Record<string, S> } };
  for (const key of Object.keys(BODY_SCHEMAS)) {
    const [method, path] = key.split(' ');
    const op = doc.paths[path]?.[method];
    if (!op) continue;
    const rb = (op.requestBody as S | undefined) ?? {};
    const content = (rb.content as Record<string, S> | undefined) ?? {};
    const json = content['application/json'] ?? {};
    const generated = zodToSchema(BODY_SCHEMAS[key]);
    // Keep hand-written field descriptions when the generated schema has none for the same property.
    const handProps = ((json.schema as S | undefined)?.properties as Record<string, S> | undefined) ?? {};
    for (const [name, prop] of Object.entries((generated.properties as Record<string, S> | undefined) ?? {})) {
      if (!prop.description && handProps[name]?.description) prop.description = handProps[name].description;
    }
    if ((json.schema as S | undefined)?.description && !generated.description) generated.description = (json.schema as S).description;
    content['application/json'] = { ...json, schema: generated };
    op.requestBody = { ...rb, required: rb.required ?? true, content };
    op['x-laissez-schema-source'] = 'zod';
  }
  for (const m of EXTRA_MODULES) {
    for (const x of m.OPENAPI_OPS ?? []) (doc.paths[x.path] ??= {})[x.method] = buildOp(x);
    Object.assign(doc.components.schemas, m.OPENAPI_SCHEMAS ?? {});
  }
  for (const key of PAGINATED) {
    const [method, path] = key.split(' ');
    const op = doc.paths[path]?.[method];
    if (op) patchPaginated(op);
  }
  (doc.info as S)['x-laissez-generated-parts'] = { zod_request_bodies: Object.keys(BODY_SCHEMAS).length, router_operations: EXTRA_MODULES.reduce((n, m) => n + (m.OPENAPI_OPS?.length ?? 0), 0), paginated_lists: PAGINATED.length };
  merged = doc;
  return doc;
}
