// Build-time model of the OpenAPI document for the reference pages. Shared by index.astro and [tag].astro.
// Underscore-prefixed so Astro does not treat it as a page.
import { OPENAPI } from '../../../../api/src/openapi';

export type S = Record<string, any>;
export const doc = OPENAPI as unknown as S;
export const SERVER = doc.servers[0].url as string;

/** URL segment for a tag: "Fund operations" -> "fund-operations". */
export const tagSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** The anchor the single-page reference used for a tag heading: "Fund operations" -> "tag-Fund-operations". */
export const legacyTagAnchor = (name: string) => `tag-${name.replace(/\s+/g, '-')}`;
export const eventAnchor = (name: string) => `event-${name.replace(/\./g, '-')}`;

export const PERM_TEXT: Record<string, string> = {
  public: 'No authentication', trp: 'Travel Rule Protocol (VASP to VASP, no bearer token)', investor: 'Investor portal token (lz_inv_)',
  session: 'Any signed-in person', any: 'Any session or API key', webhook: 'Sent by Laissez to your endpoint',
};

// ---------- $ref resolution ----------
function resolve(ref: string): S {
  let cur: S = doc;
  for (const p of ref.replace(/^#\//, '').split('/')) cur = cur[p];
  return cur;
}
export const refName = (s: S | undefined) => (s?.$ref ? String(s.$ref).split('/').pop()! : null);
export const deref = (s: S | undefined): S => (s?.$ref ? deref(resolve(s.$ref)) : s ?? {});

/** Merges allOf into one object schema (one level, enough for this document). */
function merged(s: S): S {
  s = deref(s);
  if (!Array.isArray(s.allOf)) return s;
  const out: S = { type: 'object', properties: {}, required: [] as string[] };
  for (const part of s.allOf) {
    const p = merged(part);
    Object.assign(out.properties, p.properties ?? {});
    out.required.push(...(p.required ?? []));
    if (p.description && !out.description) out.description = p.description;
  }
  return out;
}

/** Links to named schemas point at the schemas page, which lives beside the tag pages. */
const schemaHref = (name: string) => `../schemas/#schema-${name}`;

/** Short type label with a link target when the schema is a named component. */
export function typeLabel(s: S | undefined): { text: string; link: string | null } {
  if (!s) return { text: 'any', link: null };
  const name = refName(s);
  if (name) return { text: name, link: schemaHref(name) };
  if (s.anyOf) {
    const parts = (s.anyOf as S[]).map((x) => typeLabel(x));
    return { text: parts.map((p) => p.text).join(' | '), link: parts.find((p) => p.link)?.link ?? null };
  }
  if (s.allOf) return { text: 'object', link: null };
  if (s.const !== undefined) return { text: JSON.stringify(s.const), link: null };
  let t = Array.isArray(s.type) ? (s.type as string[]).join(' | ') : (s.type as string | undefined);
  if (!t) return { text: s.enum ? 'enum' : 'any', link: null };
  if (t === 'array' || t === 'array | null') {
    const inner = typeLabel(s.items);
    return { text: `array of ${inner.text}${t.endsWith('null') ? ' | null' : ''}`, link: inner.link };
  }
  if (s.format && (t === 'string' || t.startsWith('string'))) t = t.replace('string', s.format === 'date-time' ? 'datetime' : s.format);
  return { text: t, link: null };
}

export function constraints(s: S): string[] {
  const out: string[] = [];
  const en = s.enum ?? (s.anyOf?.find((x: S) => x.enum)?.enum);
  if (en) out.push(`one of ${(en as unknown[]).filter((v) => v !== null).map((v) => JSON.stringify(v)).join(', ')}`);
  if (s.const !== undefined) out.push(`always ${JSON.stringify(s.const)}`);
  if (s.minLength !== undefined && s.maxLength !== undefined) out.push(`${s.minLength} to ${s.maxLength} chars`);
  else if (s.minLength !== undefined) out.push(`at least ${s.minLength} chars`);
  else if (s.maxLength !== undefined) out.push(`up to ${s.maxLength} chars`);
  if (s.minimum !== undefined) out.push(`min ${s.minimum}`);
  if (s.exclusiveMinimum !== undefined) out.push(`greater than ${s.exclusiveMinimum}`);
  if (s.maximum !== undefined) out.push(`max ${s.maximum}`);
  if (s.minItems !== undefined) out.push(`at least ${s.minItems} item${s.minItems === 1 ? '' : 's'}`);
  if (s.maxItems !== undefined) out.push(`up to ${s.maxItems} items`);
  if (s.pattern) out.push(`pattern ${s.pattern}`);
  if (s.items) { const it = deref(s.items); if (it.enum) out.push(`items one of ${(it.enum as unknown[]).map((v) => JSON.stringify(v)).join(', ')}`); else if (it.pattern) out.push(`item pattern ${it.pattern}`); }
  if (s.default !== undefined) out.push(`default ${JSON.stringify(s.default)}`);
  return out;
}

export type Field = { name: string; type: string; link: string | null; required: boolean; description: string; constraints: string[]; depth: number };
/** Flattens an object schema into rows. Nested objects and arrays of objects are expanded one level with dotted names. */
export function fields(schema: S | undefined, depth = 0, prefix = ''): Field[] {
  const s = merged(schema ?? {});
  const props: Record<string, S> = s.properties ?? {};
  const req = new Set<string>(s.required ?? []);
  const rows: Field[] = [];
  for (const [name, raw] of Object.entries(props)) {
    const d = deref(raw);
    const label = typeLabel(raw);
    rows.push({ name: prefix + name, type: label.text, link: label.link, required: req.has(name), description: d.description ?? raw.description ?? '', constraints: constraints(d), depth });
    if (depth < 1 && !refName(raw)) {
      const inner = d.type === 'array' || (Array.isArray(d.type) && d.type.includes('array')) ? deref(d.items) : d;
      const innerIsRef = d.type === 'array' ? !!refName(d.items) : false;
      if (!innerIsRef && (inner.properties || inner.allOf)) rows.push(...fields(inner, depth + 1, `${prefix}${name}${inner === d ? '.' : '[].'}`));
    }
  }
  return rows;
}

// ---------- Examples ----------
function exampleOf(schema: S | undefined, depth = 0): unknown {
  const s = deref(schema);
  if (s.example !== undefined) return s.example;
  if (s.const !== undefined) return s.const;
  if (s.default !== undefined) return s.default;
  if (s.enum) return (s.enum as unknown[]).find((v) => v !== null);
  if (s.allOf) return exampleOf(merged(s), depth);
  if (s.anyOf) return exampleOf((s.anyOf as S[]).find((x) => x.type !== 'null') ?? s.anyOf[0], depth);
  const t = Array.isArray(s.type) ? (s.type as string[]).find((x) => x !== 'null') : s.type;
  switch (t) {
    case 'string': return s.format === 'email' ? 'ops@astervale.example' : s.format === 'uuid' ? '5f0c2a91-7d3e-4b8a-9c11-2e6f4a8b0d17' : s.format === 'date' ? '2026-10-02' : s.format === 'date-time' ? '2026-10-02T06:22:07Z' : s.format === 'uri' ? 'https://ops.astervale.example/hooks' : 'string';
    case 'integer': return s.minimum ?? 1;
    case 'number': return s.minimum ?? 100000;
    case 'boolean': return true;
    case 'array': return depth > 3 ? [] : [exampleOf(s.items, depth + 1)];
    case 'object': {
      const out: Record<string, unknown> = {};
      const req = new Set<string>(s.required ?? []);
      for (const [k, v] of Object.entries<S>(s.properties ?? {})) if (req.has(k) || depth === 0) out[k] = exampleOf(v, depth + 1);
      return out;
    }
    default: return depth === 0 ? {} : null;
  }
}

function curlFor(method: string, path: string, op: S): string {
  const params: S[] = (op.parameters ?? []).map((p: S) => deref(p));
  let p = path;
  for (const prm of params) if (prm.in === 'path') p = p.replace(`{${prm.name}}`, String(prm.example ?? `{${prm.name}}`));
  const q = params.filter((x) => x.in === 'query' && x.required).map((x) => `${x.name}=${encodeURIComponent(String(x.example ?? x.schema?.default ?? 'value'))}`);
  const lines = [`curl -X ${method.toUpperCase()} ${SERVER}${p}${q.length ? `?${q.join('&')}` : ''}`];
  const sec: S[] = op.security ?? [];
  const scheme = sec[0] ? Object.keys(sec[0])[0] : null;
  if (scheme === 'portalToken') lines.push(`-H 'Authorization: Bearer lz_inv_…'`);
  else if (scheme === 'sessionToken' && sec.length === 1) lines.push(`-H 'Authorization: Bearer lz_sess_…'`);
  else if (scheme) lines.push(`-H 'Authorization: Bearer lz_test_…'`);
  if (p.startsWith('/v1')) lines.push(`-H 'Laissez-Version: ${doc.info.version}'`);
  if (params.some((x) => x.name === 'Idempotency-Key')) lines.push(`-H 'Idempotency-Key: ${op.operationId}-0001'`);
  for (const prm of params) if (prm.in === 'header' && prm.required && !['Idempotency-Key', 'Laissez-Version'].includes(prm.name)) lines.push(`-H '${prm.name}: ${prm.example ?? '…'}'`);
  const body = op.requestBody?.content;
  if (body?.['application/json']) {
    const c = body['application/json'];
    const ex = c.example ?? exampleOf(c.schema);
    lines.push(`-H 'Content-Type: application/json'`);
    lines.push(`-d '${JSON.stringify(ex)}'`);
  } else if (body?.['application/x-www-form-urlencoded']) {
    const ex = exampleOf(body['application/x-www-form-urlencoded'].schema) as Record<string, unknown>;
    for (const [k, v] of Object.entries(ex)) lines.push(`--data-urlencode '${k}=${v}'`);
  }
  return lines.join(' \\\n  ');
}

// ---------- Operations grouped by tag ----------
export type Op = {
  method: string; path: string; op: S; id: string; tag: string; curl: string; example?: unknown; exampleCode?: string; params: S[];
  body: { fields: Field[]; schemaName: string | null; form: boolean; description: string } | null;
  responses: { code: string; description: string; type: string; link: string | null; fields: Field[] }[];
};
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
export const tags: S[] = doc.tags;
export const byTag = new Map<string, Op[]>();
for (const t of tags) byTag.set(t.name, []);
for (const [path, item] of Object.entries<S>(doc.paths)) {
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    const params = (op.parameters ?? []).map((p: S) => deref(p));
    const rb = op.requestBody?.content;
    const jsonBody = rb?.['application/json'] ?? rb?.['application/x-www-form-urlencoded'];
    const body = jsonBody ? { fields: fields(jsonBody.schema), schemaName: refName(jsonBody.schema), form: !rb?.['application/json'], description: deref(jsonBody.schema).description ?? '' } : null;
    const responses = Object.entries<S>(op.responses).map(([code, r]) => {
      const res = deref(r);
      const content = res.content?.['application/json'] ?? res.content?.['text/csv'];
      const label = content ? typeLabel(content.schema) : { text: code === '204' ? '' : code === '302' ? 'redirect' : '', link: null };
      const ok = code.startsWith('2');
      return { code, description: res.description ?? '', type: res.content?.['text/csv'] ? 'text/csv' : label.text, link: label.link, fields: ok && content?.schema && !refName(content.schema) ? fields(content.schema) : [] };
    });
    const exCode = Object.keys(op.responses).find((c) => c.startsWith('2') && op.responses[c]?.content?.['application/json']?.example !== undefined);
    const tag = op.tags[0];
    if (!byTag.has(tag)) { byTag.set(tag, []); tags.push({ name: tag, description: '' }); }
    byTag.get(tag)!.push({ method, path, op, id: op.operationId, tag, curl: curlFor(method, path, op), params, body, responses, example: exCode ? op.responses[exCode].content['application/json'].example : undefined, exampleCode: exCode });
  }
}
export const allOps: Op[] = [...byTag.values()].flat();
export const opCount = allOps.length;

export const webhookEvents = Object.entries<S>(doc.webhooks ?? {}).map(([name, w]) => {
  const schema = w.post.requestBody.content['application/json'].schema;
  const dataSchema = (schema.allOf ?? []).map((x: S) => merged(x)).reverse().find((x: S) => x.properties?.data)?.properties?.data;
  return { name, description: w.post.description as string, dataType: typeLabel(dataSchema), fields: dataSchema && !refName(dataSchema) ? fields(dataSchema) : [] };
});
export const schemas = Object.entries<S>(doc.components.schemas).map(([name, s]) => ({ name, description: deref(s).description ?? '', fields: fields(s) }));

/** Which page each anchor from the single-page reference now lives on. Drives the redirect on the index. */
export function anchorMap(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const t of tags) m[legacyTagAnchor(t.name)] = tagSlug(t.name);
  for (const o of allOps) m[o.id] = tagSlug(o.tag);
  for (const e of webhookEvents) m[eventAnchor(e.name)] = 'webhooks-events';
  m['webhook-events'] = 'webhooks-events';
  for (const s of schemas) m[`schema-${s.name}`] = 'schemas';
  m['schemas'] = 'schemas';
  return m;
}

/** Pages rendered by [tag].astro: one per tag, plus webhook events and schemas. */
export type RefPage = { slug: string; kind: 'tag' | 'events' | 'schemas'; name: string; description: string; count: number };
export const pages: RefPage[] = [
  ...tags.map((t) => ({ slug: tagSlug(t.name), kind: 'tag' as const, name: t.name as string, description: (t.description ?? '') as string, count: byTag.get(t.name)!.length })),
  { slug: 'webhooks-events', kind: 'events', name: 'Webhook events', description: 'Every event type Laissez can deliver to a subscribed endpoint, with the shape of its data.', count: webhookEvents.length },
  { slug: 'schemas', kind: 'schemas', name: 'Schemas', description: 'Named objects referenced across the operations.', count: schemas.length },
];
