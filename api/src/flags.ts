// Feature flags. A flag has a default (feature_flags.default_on) and an optional per-organization override
// (workspace_flags). flag(c, key) answers from a 60-second in-memory cache per organization, so a hot path
// pays one query per minute at most. Administrators flip overrides from the Organization settings page or
// PUT /v1/flags/:key; every change is audited.
import { z } from 'zod';
import { adminSql, type Sql } from './db';
import { ApiError, type Env } from './util';
import { type C, router, body, need, audit } from './http';

export const FLAG_KEYS = ['chain_settlement', 'approvals_workflow', 'order_batching', 'portal_transfers', 'regulatory_agent'] as const;
export type FlagKey = (typeof FLAG_KEYS)[number];

/** Built-in definitions. The migration seeds the same rows; this copy answers when the table is missing or empty. */
export const FLAG_DEFS: Record<FlagKey, { description: string; default_on: boolean }> = {
  chain_settlement: { description: 'Settle allowed orders on-chain when a deployment is configured. Off means simulated settlement only.', default_on: true },
  approvals_workflow: { description: 'Two-person approval for policy changes and rule drafts.', default_on: true },
  order_batching: { description: 'Group orders into dealing-cutoff batches instead of settling each one on its own.', default_on: false },
  portal_transfers: { description: 'Let investors request transfers to another holder from the investor portal.', default_on: false },
  regulatory_agent: { description: 'The rule-drafting agent on the regulatory feed. Needs an Anthropic API key.', default_on: true },
};

export type FlagRow = { key: string; description: string; default_on: boolean; on: boolean; overridden: boolean };

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; flags: Record<string, boolean> }>();
/** Drops the cached flags for one organization (or all of them). */
export const invalidateFlags = (ws?: string) => { if (ws) cache.delete(ws); else cache.clear(); };

async function loadFlags(sql: Sql, ws: string): Promise<FlagRow[]> {
  let rows: any[] = [];
  try {
    rows = await sql`select f.key, f.description, f.default_on, w.enabled from feature_flags f
      left join workspace_flags w on w.key = f.key and w.workspace_id = ${ws} order by f.key`;
  } catch (e) {
    // Before migration 014 the tables do not exist: fall back to the built-in defaults.
    console.error('feature_flags unavailable, using defaults', String((e as any)?.message ?? e).slice(0, 120));
  }
  const byKey = new Map<string, any>(rows.map((r) => [r.key, r]));
  const keys = [...new Set([...FLAG_KEYS, ...rows.map((r) => r.key as string)])];
  return keys.map((key) => {
    const r = byKey.get(key); const def = FLAG_DEFS[key as FlagKey];
    const default_on = r ? !!r.default_on : !!def?.default_on;
    const overridden = !!r && r.enabled !== null && r.enabled !== undefined;
    return { key, description: r?.description ?? def?.description ?? '', default_on, on: overridden ? !!r.enabled : default_on, overridden };
  });
}

const sqlOf = (c: any): Sql | null => {
  try { const a = c.get('admin'); if (a) return a; } catch { /* no context variable */ }
  return c?.env?.DATABASE_URL ? adminSql(c.env.DATABASE_URL) : null;
};
const wsOf = (c: any): string | null => { try { return c.get('ws') ?? null; } catch { return null; } };

/** All flags for an organization as key -> on, from the cache when it is fresh. */
export async function flagsFor(sql: Sql, ws: string): Promise<Record<string, boolean>> {
  const hit = cache.get(ws);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.flags;
  const flags = Object.fromEntries((await loadFlags(sql, ws)).map((f) => [f.key, f.on]));
  cache.set(ws, { at: Date.now(), flags });
  return flags;
}

/**
 * Is the flag on for the organization of this request? Without an organization or a database (a job without
 * context) the built-in default answers, so a flag read can never fail the request it guards.
 */
export async function flag(c: C | any, key: FlagKey | string): Promise<boolean> {
  const def = FLAG_DEFS[key as FlagKey]?.default_on ?? false;
  const ws = wsOf(c); const sql = sqlOf(c);
  if (!ws || !sql) return def;
  try { const f = await flagsFor(sql, ws); return key in f ? f[key] : def; }
  catch { return def; }
}

// ---------- Routes ----------
export const routes = router();

routes.get('/flags', async (c) => {
  need(c, 'read');
  const ws = c.get('ws');
  const data = await loadFlags(c.get('admin'), ws);
  cache.set(ws, { at: Date.now(), flags: Object.fromEntries(data.map((f) => [f.key, f.on])) });
  return c.json({ data, cache_seconds: TTL_MS / 1000, note: 'Changes apply within 60 seconds to requests already in flight; new requests see them at once.' });
});

export const flagIn = z.object({ on: z.boolean().nullable() });
routes.put('/flags/:key', async (c) => {
  const a = need(c, 'members:admin');
  const ws = c.get('ws'); const key = c.req.param('key');
  const admin = c.get('admin');
  const b = await body(c, flagIn);
  const known = (await loadFlags(admin, ws)).find((f) => f.key === key);
  if (!known) throw new ApiError(404, 'unknown_flag', `No feature flag named ${key}. See GET /v1/flags for the list.`);
  if (b.on === null) await admin`delete from workspace_flags where workspace_id = ${ws} and key = ${key}`;
  else await admin`insert into workspace_flags (workspace_id, key, enabled) values (${ws}, ${key}, ${b.on}) on conflict (workspace_id, key) do update set enabled = excluded.enabled, updated_at = now()`;
  invalidateFlags(ws);
  const [row] = (await loadFlags(admin, ws)).filter((f) => f.key === key);
  await audit(c.get('sql'), ws, a, 'flag.updated', key, { on: row.on, overridden: row.overridden, default_on: row.default_on });
  return c.json(row);
});

// ---------- OpenAPI operations for these routes (merged by api/src/openapi-gen.ts) ----------
export const OPENAPI_OPS = [
  { method: 'get', path: '/v1/flags', tag: 'Organization', id: 'listFlags', sum: 'List feature flags', perm: 'read', desc: 'Every feature flag with its default, the organization override if any, and the effective value. Reads are cached for 60 seconds.', res: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/FeatureFlag' } }, cache_seconds: { type: 'integer' }, note: { type: 'string' } }, required: ['data'] } },
  { method: 'put', path: '/v1/flags/{key}', tag: 'Organization', id: 'setFlag', sum: 'Set a feature flag', perm: 'members:admin', desc: 'Overrides a flag for this organization. Send on: null to remove the override and return to the default. Audited as flag.updated.', pathParam: ['key', 'Flag key, for example chain_settlement.', 'chain_settlement'], body: flagIn, ex: { on: false }, res: { $ref: '#/components/schemas/FeatureFlag' }, err: [404] },
];
export const OPENAPI_SCHEMAS = {
  FeatureFlag: { type: 'object', properties: { key: { type: 'string' }, description: { type: 'string' }, default_on: { type: 'boolean' }, on: { type: 'boolean' }, overridden: { type: 'boolean' } }, required: ['key', 'on', 'default_on'] },
};
