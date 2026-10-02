import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { neon } from '@neondatabase/serverless';
import { z } from 'zod';
import { evaluate, holderStatus, inputsHash, WHAT_IFS, type WhatIf, type Decision } from '../../src/proto/engine';
import type { Investor } from '../../src/proto/data';
import { findTest } from '../../src/proto/thresholds';
import { type Env, type Sql, ApiError, id, rand, digits, sha256, today, addDays, signReceipt, publicKey, verifyReceipt, rateLimit } from './util';
import { buildCtx, loadGlobals, loadInvestors, loadFunds, screener, audit, emit } from './ctx';
import { seedQueries, lawDefaults } from './seed';

type Vars = { sql: Sql; ws: string; keyId: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();
const VERSION = '2026-10-02';

// ---------- Middleware ----------
app.use('*', async (c, next) => {
  const allowed = c.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  return cors({ origin: (o) => (allowed.includes(o) ? o : allowed[0]), allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'], allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'], maxAge: 86400 })(c, next);
});
app.use('*', async (c, next) => { c.set('sql', neon(c.env.DATABASE_URL)); await next(); });

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message, detail: err.detail } }, err.status as any);
  if (err instanceof z.ZodError) return c.json({ error: { code: 'invalid_request', message: 'The request body is not valid.', detail: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) } }, 400);
  console.error(err);
  return c.json({ error: { code: 'internal_error', message: 'Something went wrong on our side. The request was not applied.' } }, 500);
});

const auth = async (c: Context<{ Bindings: Env; Variables: Vars }>, next: () => Promise<void>) => {
  const h = c.req.header('authorization') ?? '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!key.startsWith('lz_test_')) throw new ApiError(401, 'unauthorized', 'Send your sandbox key as "Authorization: Bearer lz_test_...". Open a sandbox at /v1/sandboxes to get one.');
  const sql = c.get('sql');
  const rows = await sql`select k.id, k.workspace_id from api_keys k join workspaces w on w.id = k.workspace_id where k.key_hash = ${await sha256(key)} and w.expires_at > now()`;
  if (!rows.length) throw new ApiError(401, 'unauthorized', 'This key is not valid, or its sandbox has expired. Open a new sandbox.');
  if (!(await rateLimit(sql, `key:${rows[0].id}`, 300, 60))) throw new ApiError(429, 'rate_limited', 'More than 300 requests in a minute. Wait a moment and retry.');
  c.set('ws', rows[0].workspace_id); c.set('keyId', rows[0].id);
  c.executionCtx.waitUntil(sql`update api_keys set last_used_at = now() where id = ${rows[0].id}`.then(() => {}));
  await next();
};
const body = async <T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> => schema.parse(await c.req.json().catch(() => ({})));
const bg = (c: Context, p: Promise<unknown>) => c.executionCtx.waitUntil(p.catch((e) => console.error(e)));

// ---------- Public ----------
app.get('/', (c) => c.json({ name: 'Laissez API', version: VERSION, docs: 'https://parikshit7319.github.io/laissez/developers/', sandbox: 'POST /v1/sandboxes' }));
app.get('/v1/health', async (c) => { await c.get('sql')`select 1`; return c.json({ ok: true, version: VERSION }); });

app.post('/v1/sandboxes', async (c) => {
  const sql = c.get('sql');
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  if (!(await rateLimit(sql, `sandbox:${await sha256(ip)}`, 10, 3600))) throw new ApiError(429, 'rate_limited', 'You have opened 10 sandboxes in the last hour. Use an existing one or try again later.');
  const [{ n }] = await sql`select count(*)::int as n from workspaces where expires_at > now()`;
  if (n >= Number(c.env.MAX_ACTIVE_SANDBOXES)) throw new ApiError(503, 'capacity', 'All sandboxes are in use right now. Try again tomorrow.');
  const { name } = await body(c, z.object({ name: z.string().max(80).optional() }));
  const ws = crypto.randomUUID();
  const key = `lz_test_${rand(32)}`;
  await sql.transaction([
    sql`insert into workspaces (id, name) values (${ws}, ${name ?? 'Aster & Vale sandbox'})`,
    sql`insert into api_keys (workspace_id, prefix, key_hash) values (${ws}, ${key.slice(0, 12)}, ${await sha256(key)})`,
    ...seedQueries(sql, ws),
    sql`insert into audit_events (workspace_id, type, subject, data) values (${ws}, 'workspace.created', ${ws}, ${JSON.stringify({ seeded: { investors: 6, funds: 3 } })})`,
  ]);
  const [w] = await sql`select id, name, created_at, expires_at from workspaces where id = ${ws}`;
  return c.json({ workspace: w, api_key: key, note: 'Store this key now. It is shown once. Everything in this sandbox is fictional and is deleted when it expires.' }, 201);
});

app.get('/v1/jurisdictions', async (c) => c.json({ data: await c.get('sql')`select * from jurisdictions order by name` }));
app.get('/v1/investor-classes', async (c) => c.json({ data: await c.get('sql')`select * from investor_classes order by jurisdiction, code` }));
app.get('/v1/booking-centers', async (c) => c.json({ data: await c.get('sql')`select * from booking_centers order by name` }));
app.get('/v1/rule-packs', async (c) => c.json({ data: await c.get('sql')`select id, version, jurisdiction, status, summary, effective_from::text, approved_by, created_at from rule_packs order by id, created_at desc` }));
app.get('/v1/signing-key', async (c) => c.json({ alg: 'Ed25519', key: await publicKey(c.env) }));
app.post('/v1/receipts/verify', async (c) => {
  const { receipt, signature } = await body(c, z.object({ receipt: z.record(z.string(), z.unknown()), signature: z.string().min(10) }));
  let valid = false;
  try { valid = await verifyReceipt(c.env, receipt, signature); } catch { valid = false; }
  return c.json({ valid, message: valid ? 'Signature is valid. This receipt was issued by Laissez and has not been altered.' : 'Signature does not match. The receipt was altered or was not issued by Laissez.' });
});

// ---------- Authenticated ----------
const v1 = new Hono<{ Bindings: Env; Variables: Vars }>();
v1.use('*', auth);

v1.get('/workspace', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const [w] = await sql`select id, name, created_at, expires_at from workspaces where id = ${ws}`;
  const [counts] = await sql`select (select count(*)::int from investors where workspace_id = ${ws}) as investors, (select count(*)::int from funds where workspace_id = ${ws}) as funds, (select count(*)::int from decisions where workspace_id = ${ws}) as decisions, (select count(*)::int from settlements where workspace_id = ${ws}) as settlements`;
  return c.json({ ...w, counts });
});

v1.get('/metrics', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const [daily, totals, reasons, value, reuse, expiring] = await Promise.all([
    sql`select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, outcome, count(*)::int as n from decisions where workspace_id = ${ws} and created_at > now() - interval '14 days' group by 1, 2 order by 1`,
    sql`select count(*)::int as decisions, count(*) filter (where outcome = 'ALLOW')::int as allowed, count(*) filter (where outcome = 'DENY')::int as denied, count(*) filter (where outcome = 'FREEZE')::int as frozen from decisions where workspace_id = ${ws}`,
    sql`select ch->>'label' as label, count(*)::int as n from decisions d, jsonb_array_elements(d.checks) ch where d.workspace_id = ${ws} and ch->>'result' = 'fail' group by 1 order by 2 desc limit 6`,
    sql`select f.currency, coalesce(sum(d.amount), 0)::float8 as value, count(*)::int as n from settlements s join decisions d on d.workspace_id = s.workspace_id and d.id = s.decision_id join funds f on f.workspace_id = d.workspace_id and f.ticker = d.ticker where s.workspace_id = ${ws} and s.status = 'settled' group by 1`,
    sql`select count(*) filter (where funds >= 2)::int as reused, count(*)::int as total from (select investor_id, count(distinct ticker) as funds from decisions where workspace_id = ${ws} and outcome = 'ALLOW' group by 1) t`,
    sql`select count(*)::int as n from credentials where workspace_id = ${ws} and status = 'active' and expires_on between current_date and current_date + 30`,
  ]);
  const t = totals[0];
  return c.json({
    totals: { ...t, allow_rate: t.decisions ? t.allowed / t.decisions : null },
    daily, top_refusal_reasons: reasons, settled_value: value,
    credential_reuse: { investors_with_two_or_more_funds: reuse[0].reused, investors_with_allowed_orders: reuse[0].total, rate: reuse[0].total ? reuse[0].reused / reuse[0].total : null },
    credentials_expiring_30d: expiring[0].n,
  });
});

// Investors
const investorIn = z.object({
  name: z.string().min(2).max(120), kind: z.string().min(2).max(60), residence: z.string().min(2).max(10), city: z.string().min(1).max(80),
  booking_center: z.string().min(2).max(10), us_person: z.boolean().default(false), wallet: z.string().max(80).optional(),
});
v1.get('/investors', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const [invs, g] = await Promise.all([loadInvestors(sql, ws, null), loadGlobals(sql)]);
  const t = today();
  return c.json({ data: Object.values(invs).map((i) => ({ ...i, credential_status: !i.credentialId ? 'none' : i.expires < t ? 'lapsed' : i.classifications.some((x) => x.expires < t) ? 'partly_lapsed' : 'active', residence_name: g.jurName[i.residence] })) });
});
v1.post('/investors', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws'); const g = await loadGlobals(sql);
  const b = await body(c, investorIn);
  if (!g.jurName[b.residence]) throw new ApiError(422, 'unknown_jurisdiction', `Residence ${b.residence} is not a supported jurisdiction.`);
  if (!g.bookingCenters[b.booking_center]) throw new ApiError(422, 'unknown_booking_center', `Booking center ${b.booking_center} does not exist.`);
  const invId = id('inv', 10);
  const wallet = b.wallet || `0x${rand(4, '0123456789abcdef')}…${rand(4, '0123456789abcdef')}`;
  await sql`insert into investors (workspace_id, id, name, short_name, kind, residence, city, booking_center, us_person, wallet) values (${ws}, ${invId}, ${b.name}, ${b.name.split(/\s+/).slice(0, 3).join(' ')}, ${b.kind}, ${b.residence}, ${b.city}, ${b.booking_center}, ${b.us_person || b.residence === 'US'}, ${wallet})`;
  await audit(sql, ws, 'investor.created', invId, { name: b.name, residence: b.residence });
  return c.json((await loadInvestors(sql, ws, [invId]))[invId], 201);
});
v1.get('/investors/:id', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const ctx = await buildCtx(sql, ws, [c.req.param('id')], null);
  const inv = ctx.investors[c.req.param('id')];
  if (!inv) throw new ApiError(404, 'not_found', 'No investor with that id in this sandbox.');
  const holdings = Object.entries(inv.holdings).map(([t, h]) => {
    const f = ctx.funds[t];
    const lock = f?.lockupMonths ? addDays(h!.since, Math.round(f.lockupMonths * 30.44)) : null;
    return { ticker: t, fund: f?.short, units: h!.units, value: f ? +(h!.units * f.nav).toFixed(2) : null, currency: f?.currency, since: h!.since, lockup_ends: lock && lock > ctx.today ? lock : null, ...(f ? holderStatus(inv, f, ctx) : { status: 'unknown', reason: '' }) };
  });
  const decisions = await sql`select id, action, ticker, amount::float8 as amount, outcome, headline, created_at from decisions where workspace_id = ${ws} and (investor_id = ${inv.id} or counterparty_id = ${inv.id}) order by created_at desc limit 20`;
  return c.json({ ...inv, holdings_detail: holdings, recent_decisions: decisions });
});

// Credentials
const credentialIn = z.object({
  investor_id: z.string(),
  valid_months: z.number().int().min(1).max(24).default(12),
  classifications: z.array(z.object({ class_code: z.string(), evidence: z.record(z.string(), z.union([z.number(), z.boolean()])).default({}), evidence_ref: z.string().max(200).optional() })).min(0).max(10),
});
v1.post('/credentials', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws'); const g = await loadGlobals(sql);
  const b = await body(c, credentialIn);
  const inv = (await loadInvestors(sql, ws, [b.investor_id]))[b.investor_id];
  if (!inv) throw new ApiError(404, 'not_found', 'No investor with that id in this sandbox.');
  const results = b.classifications.map((x) => {
    const meta = g.classInfo[x.class_code];
    if (!meta) return { class_code: x.class_code, pass: false, reason: `Unknown classification ${x.class_code}.` };
    const test = findTest(x.class_code, inv.kind);
    if (!test) return { class_code: x.class_code, pass: false, reason: `${meta.label} is not available to a ${inv.kind.toLowerCase()}.` };
    return { class_code: x.class_code, ...test.check(x.evidence), label: meta.label, jurisdiction: meta.jur };
  });
  const failed = results.filter((r) => !r.pass);
  if (failed.length) throw new ApiError(422, 'threshold_not_met', 'One or more classifications do not meet their legal threshold. Nothing was issued.', results);
  const start = today(); const end = addDays(start, Math.round(b.valid_months * 30.44));
  const jur = inv.residence === 'AE-DIFC' ? 'AE' : inv.residence;
  const credId = `LP-${jur}-${digits(4)}-${digits(4)}`;
  await sql.transaction([
    sql`update credentials set status = 'revoked' where workspace_id = ${ws} and investor_id = ${inv.id} and status = 'active'`,
    sql`insert into credentials (workspace_id, id, investor_id, issued_on, expires_on) values (${ws}, ${credId}, ${inv.id}, ${start}, ${end})`,
    ...b.classifications.map((x, i) => sql`insert into classifications (workspace_id, credential_id, class_code, basis, verified_on, expires_on, opt_in_on) values (${ws}, ${credId}, ${x.class_code}, ${x.evidence_ref ? `${results[i].reason} Evidence: ${x.evidence_ref}` : results[i].reason}, ${start}, ${end}, ${x.evidence.opt_in ? start : null})`),
    sql`insert into audit_events (workspace_id, type, subject, data) values (${ws}, 'credential.issued', ${credId}, ${JSON.stringify({ investor: inv.id, classes: b.classifications.map((x) => x.class_code), replaced: inv.credentialId || null })})`,
  ]);
  bg(c, emit(sql, ws, 'credential.issued', { credential: credId, investor: inv.id }));
  return c.json({ credential_id: credId, issued_on: start, expires_on: end, checks: results, investor: (await loadInvestors(sql, ws, [inv.id]))[inv.id] }, 201);
});
v1.get('/credentials', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const within = Number(c.req.query('expiring_within') ?? 0);
  const rows = within
    ? await sql`select c.id, c.investor_id, i.name, c.issued_on::text, c.expires_on::text, c.status from credentials c join investors i on i.workspace_id = c.workspace_id and i.id = c.investor_id where c.workspace_id = ${ws} and c.status = 'active' and c.expires_on <= current_date + ${within}::int order by c.expires_on`
    : await sql`select c.id, c.investor_id, i.name, c.issued_on::text, c.expires_on::text, c.status from credentials c join investors i on i.workspace_id = c.workspace_id and i.id = c.investor_id where c.workspace_id = ${ws} order by c.created_at desc`;
  return c.json({ data: rows });
});
v1.post('/credentials/:id/revoke', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const r = await sql`update credentials set status = 'revoked' where workspace_id = ${ws} and id = ${c.req.param('id')} and status = 'active' returning investor_id`;
  if (!r.length) throw new ApiError(404, 'not_found', 'No active credential with that id.');
  await audit(sql, ws, 'credential.revoked', c.req.param('id'), { investor: r[0].investor_id });
  bg(c, emit(sql, ws, 'holder.status_changed', { investor: r[0].investor_id, reason: 'credential_revoked' }));
  return c.json({ revoked: c.req.param('id') });
});

// Funds and policy
const fundIn = z.object({
  ticker: z.string().regex(/^[A-Z]{3,6}$/), name: z.string().min(3).max(140), domicile: z.string().min(2).max(80), structure: z.string().min(3).max(160),
  currency: z.enum(['USD', 'EUR']), nav: z.number().positive(), reg_s: z.boolean(), min_subscription: z.number().nonnegative(),
  holder_cap: z.number().int().positive().nullable().default(null), lockup_months: z.number().int().positive().nullable().default(null),
  assets: z.array(z.string()).min(1), chains: z.array(z.string()).min(1), issuer: z.string().min(2).max(120),
  distribution: z.array(z.object({ jurisdiction: z.string(), accepts: z.array(z.string()).min(1) })).min(1),
});
v1.get('/funds', async (c) => c.json({ data: Object.values(await loadFunds(c.get('sql'), c.get('ws'), null)) }));
v1.get('/funds/:ticker', async (c) => {
  const f = (await loadFunds(c.get('sql'), c.get('ws'), c.req.param('ticker')))[c.req.param('ticker')];
  if (!f) throw new ApiError(404, 'not_found', 'No fund with that ticker in this sandbox.');
  return c.json(f);
});
v1.post('/funds', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws'); const g = await loadGlobals(sql);
  const b = await body(c, fundIn);
  for (const d of b.distribution) {
    if (!lawDefaults(d.jurisdiction, b.reg_s)) throw new ApiError(422, 'unsupported_jurisdiction', `No launch rule pack covers ${d.jurisdiction} yet.`);
    for (const a of d.accepts) if (!g.classInfo[a]) throw new ApiError(422, 'unknown_class', `Unknown investor class ${a}.`);
  }
  if (b.reg_s && b.distribution.some((d) => d.jurisdiction === 'US')) throw new ApiError(422, 'conflict', 'A Regulation S fund cannot be offered to U.S. investors. Remove US or turn off Regulation S.');
  const exists = await sql`select 1 from funds where workspace_id = ${ws} and ticker = ${b.ticker}`;
  if (exists.length) throw new ApiError(409, 'exists', `A fund with ticker ${b.ticker} already exists.`);
  await sql.transaction([
    sql`insert into funds (workspace_id, ticker, name, short_name, domicile, structure, currency, nav, reg_s, us_accepts, min_subscription, holder_cap, holders, lockup_months, assets, chains, issuer) values (${ws}, ${b.ticker}, ${b.name}, ${b.name.split(',')[0].slice(0, 60)}, ${b.domicile}, ${b.structure}, ${b.currency}, ${b.nav}, ${b.reg_s}, ${b.reg_s ? null : b.distribution.find((d) => d.jurisdiction === 'US')?.accepts ?? null}, ${b.min_subscription}, ${b.holder_cap}, 0, ${b.lockup_months}, ${b.assets}, ${b.chains}, ${b.issuer})`,
    ...b.distribution.map((d) => { const l = lawDefaults(d.jurisdiction, b.reg_s)!; return sql`insert into fund_distribution (workspace_id, ticker, jurisdiction, accepts, basis, law_requires, law_text, law_ref, law_source) values (${ws}, ${b.ticker}, ${d.jurisdiction}, ${d.accepts}, ${l.basis}, ${l.lawRequires}, ${l.lawText}, ${l.lawRef}, ${l.lawSource})`; }),
    sql`insert into audit_events (workspace_id, type, subject, data) values (${ws}, 'fund.created', ${b.ticker}, ${JSON.stringify({ name: b.name })})`,
  ]);
  return c.json((await loadFunds(sql, ws, b.ticker))[b.ticker], 201);
});

async function registerFor(sql: Sql, ws: string, ticker: string) {
  const funds = await loadFunds(sql, ws, ticker);
  const f = funds[ticker];
  if (!f) throw new ApiError(404, 'not_found', 'No fund with that ticker in this sandbox.');
  const holders = await sql`select investor_id from holdings where workspace_id = ${ws} and ticker = ${ticker} and units > 0`;
  const ctx = await buildCtx(sql, ws, holders.map((h) => h.investor_id), ticker);
  return { f, ctx, rows: Object.values(ctx.investors).map((inv) => ({ investor_id: inv.id, name: inv.name, residence: inv.residence, units: inv.holdings[ticker]?.units ?? 0, value: +((inv.holdings[ticker]?.units ?? 0) * f.nav).toFixed(2), since: inv.holdings[ticker]?.since, ...holderStatus(inv, f, ctx) })) };
}
v1.get('/funds/:ticker/register', async (c) => {
  const { f, rows } = await registerFor(c.get('sql'), c.get('ws'), c.req.param('ticker'));
  return c.json({ fund: f.ticker, holder_cap: f.holderCap, total_holders_of_record: f.holders, sandbox_holders: rows.length, data: rows });
});

const policyIn = z.object({
  distribution: z.array(z.object({ jurisdiction: z.string(), accepts: z.array(z.string()).min(1) })).min(1),
  min_subscription: z.number().nonnegative().optional(), holder_cap: z.number().int().positive().nullable().optional(), lockup_months: z.number().int().positive().nullable().optional(),
});
async function previewPolicy(sql: Sql, ws: string, ticker: string, p: z.infer<typeof policyIn>) {
  const { f, ctx, rows } = await registerFor(sql, ws, ticker);
  const next = { ...f, distribution: Object.fromEntries(p.distribution.map((d) => [d.jurisdiction, { ...(f.distribution[d.jurisdiction] ?? lawDefaults(d.jurisdiction, f.regS)), accepts: d.accepts }])) } as typeof f;
  const affected = Object.values(ctx.investors).map((inv) => ({ inv, before: holderStatus(inv, f, ctx), after: holderStatus(inv, next, ctx) })).filter((x) => x.before.status !== x.after.status);
  const removed = Object.keys(f.distribution).filter((j) => !p.distribution.some((d) => d.jurisdiction === j));
  const added = p.distribution.map((d) => d.jurisdiction).filter((j) => !f.distribution[j]);
  return {
    removed, added,
    holders_affected: affected.map((x) => ({ investor_id: x.inv.id, name: x.inv.name, from: x.before.status, to: x.after.status, units: x.inv.holdings[ticker]?.units ?? 0, value: +((x.inv.holdings[ticker]?.units ?? 0) * f.nav).toFixed(2) })),
    value_affected: +affected.reduce((s, x) => s + (x.inv.holdings[ticker]?.units ?? 0) * f.nav, 0).toFixed(2),
    currency: f.currency, sandbox_holders: rows.length,
    note: 'Holders who lose eligibility move to redemption-only. They keep their units and can always redeem. Nobody is force-redeemed.',
  };
}
v1.post('/funds/:ticker/policy/preview', async (c) => c.json(await previewPolicy(c.get('sql'), c.get('ws'), c.req.param('ticker'), await body(c, policyIn))));
v1.post('/funds/:ticker/policy/changes', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws'); const ticker = c.req.param('ticker');
  const b = await body(c, policyIn.extend({ proposed_by: z.string().min(2).max(80) }));
  for (const d of b.distribution) if (!lawDefaults(d.jurisdiction, true) && d.jurisdiction !== 'US') throw new ApiError(422, 'unsupported_jurisdiction', `No launch rule pack covers ${d.jurisdiction} yet.`);
  const impact = await previewPolicy(sql, ws, ticker, b);
  const pcId = id('pc', 10);
  await sql`insert into policy_changes (workspace_id, id, ticker, proposed_by, status, changes, impact) values (${ws}, ${pcId}, ${ticker}, ${b.proposed_by}, 'draft', ${JSON.stringify(b)}, ${JSON.stringify(impact)})`;
  await audit(sql, ws, 'policy.proposed', pcId, { ticker, by: b.proposed_by, removed: impact.removed, added: impact.added });
  return c.json({ id: pcId, status: 'draft', impact }, 201);
});
v1.get('/policy-changes', async (c) => c.json({ data: await c.get('sql')`select * from policy_changes where workspace_id = ${c.get('ws')} order by created_at desc` }));
v1.post('/policy-changes/:id/approve', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const { approved_by } = await body(c, z.object({ approved_by: z.string().min(2).max(80) }));
  const [pc] = await sql`select * from policy_changes where workspace_id = ${ws} and id = ${c.req.param('id')}`;
  if (!pc) throw new ApiError(404, 'not_found', 'No policy change with that id.');
  if (pc.status !== 'draft') throw new ApiError(409, 'not_draft', `This change is already ${pc.status}.`);
  if (approved_by.trim().toLowerCase() === pc.proposed_by.trim().toLowerCase()) throw new ApiError(403, 'same_person', 'The person who proposed a change cannot approve it. A second approver is required.');
  const ch = pc.changes as z.infer<typeof policyIn>;
  const f = (await loadFunds(sql, ws, pc.ticker))[pc.ticker];
  await sql.transaction([
    sql`delete from fund_distribution where workspace_id = ${ws} and ticker = ${pc.ticker}`,
    ...ch.distribution.map((d) => { const l = f.distribution[d.jurisdiction] ?? lawDefaults(d.jurisdiction, f.regS)!; return sql`insert into fund_distribution (workspace_id, ticker, jurisdiction, accepts, basis, law_requires, law_text, law_ref, law_source) values (${ws}, ${pc.ticker}, ${d.jurisdiction}, ${d.accepts}, ${l.basis}, ${l.lawRequires}, ${l.lawText}, ${l.lawRef}, ${l.lawSource})`; }),
    sql`update funds set policy_version = policy_version + 1, min_subscription = coalesce(${ch.min_subscription ?? null}, min_subscription), holder_cap = case when ${ch.holder_cap === undefined} then holder_cap else ${ch.holder_cap ?? null} end, lockup_months = case when ${ch.lockup_months === undefined} then lockup_months else ${ch.lockup_months ?? null} end where workspace_id = ${ws} and ticker = ${pc.ticker}`,
    sql`update policy_changes set status = 'published', approved_by = ${approved_by}, decided_at = now() where workspace_id = ${ws} and id = ${pc.id}`,
    sql`insert into audit_events (workspace_id, type, subject, data) values (${ws}, 'policy.published', ${pc.id}, ${JSON.stringify({ ticker: pc.ticker, proposed_by: pc.proposed_by, approved_by })})`,
  ]);
  bg(c, emit(sql, ws, 'policy.published', { policy_change: pc.id, ticker: pc.ticker, impact: pc.impact }));
  return c.json({ id: pc.id, status: 'published', approved_by });
});
v1.post('/policy-changes/:id/reject', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const { rejected_by } = await body(c, z.object({ rejected_by: z.string().min(2).max(80) }));
  const r = await sql`update policy_changes set status = 'rejected', approved_by = ${rejected_by}, decided_at = now() where workspace_id = ${ws} and id = ${c.req.param('id')} and status = 'draft' returning id`;
  if (!r.length) throw new ApiError(404, 'not_found', 'No draft policy change with that id.');
  await audit(sql, ws, 'policy.rejected', c.req.param('id'), { by: rejected_by });
  return c.json({ id: c.req.param('id'), status: 'rejected' });
});

// Decisions
const decisionIn = z.object({
  action: z.enum(['subscribe', 'transfer', 'redeem']), investor_id: z.string(), fund: z.string(), amount: z.number().positive().max(1e12),
  settle_with: z.string(), counterparty_id: z.string().optional(), what_ifs: z.array(z.string()).max(6).default([]), persist: z.boolean().default(true),
});
function receiptOf(row: any, ws: string) {
  return {
    decision_id: row.id, sandbox: ws.slice(0, 8), outcome: row.outcome, action: row.action, fund: row.ticker, amount: String(row.amount), asset: row.asset,
    binding_rules: (row.resolved as any[]).map((r) => `${r.text} (${r.ruleRef})`), rule_packs: row.rule_packs, inputs_sha256: row.inputs_sha256,
    issued_at: new Date(row.created_at).toISOString(),
  };
}
function travelRule(d: Decision) {
  if (d.order.action !== 'transfer' || !d.counterparty || d.notional < 1000) return null;
  const party = (i: Investor) => ({ name: { nameIdentifier: [{ primaryIdentifier: i.name, nameIdentifierType: i.kind === 'Individual' ? 'LEGL' : 'LEGL' }] }, accountNumber: [i.wallet], geographicAddress: [{ townName: i.city, country: i.residence === 'AE-DIFC' ? 'AE' : i.residence }] });
  return {
    standard: 'IVMS101', threshold: 'USD/EUR 1,000 (FATF R.16)',
    originator: { originatorPersons: [{ [d.investor.kind === 'Individual' ? 'naturalPerson' : 'legalPerson']: party(d.investor) }], accountNumber: [d.investor.wallet] },
    beneficiary: { beneficiaryPersons: [{ [d.counterparty.kind === 'Individual' ? 'naturalPerson' : 'legalPerson']: party(d.counterparty) }], accountNumber: [d.counterparty.wallet] },
    transferredAmount: { amount: String(d.notional), assetType: d.fund.ticker },
  };
}
v1.post('/decisions', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = await body(c, decisionIn);
  if (b.action === 'transfer' && !b.counterparty_id) throw new ApiError(422, 'counterparty_required', 'A transfer needs counterparty_id.');
  const ctx = await buildCtx(sql, ws, [b.investor_id, ...(b.counterparty_id ? [b.counterparty_id] : [])], b.fund);
  if (!ctx.investors[b.investor_id]) throw new ApiError(404, 'not_found', `No investor ${b.investor_id} in this sandbox.`);
  if (b.counterparty_id && !ctx.investors[b.counterparty_id]) throw new ApiError(404, 'not_found', `No investor ${b.counterparty_id} in this sandbox.`);
  if (!ctx.funds[b.fund]) throw new ApiError(404, 'not_found', `No fund ${b.fund} in this sandbox.`);
  const whatIfs = b.what_ifs.filter((w): w is WhatIf => WHAT_IFS.some((x) => x.id === w));
  const d = evaluate({ action: b.action, investorId: b.investor_id, fundId: b.fund, amount: b.amount, asset: b.settle_with, counterpartyId: b.counterparty_id }, whatIfs, ctx);
  const hash = await inputsHash(d);
  const decId = id('dec', 12);
  const out = { id: decId, outcome: d.outcome, headline: d.headline, redemption_only: d.redemptionOnly, units: d.units, checks: d.checks, binding_rules: d.resolved, remedies: [...new Set(d.remedies)], rule_packs: d.rulePacks, inputs_sha256: hash, hypothetical: whatIfs.length > 0, what_ifs: whatIfs, travel_rule: travelRule(d), settle_by: null as string | null };
  if (!b.persist) return c.json({ ...out, id: null, persisted: false });
  const [row] = await sql`insert into decisions (workspace_id, id, action, investor_id, counterparty_id, ticker, amount, asset, outcome, headline, checks, resolved, remedies, rule_packs, what_ifs, units, inputs_sha256)
    values (${ws}, ${decId}, ${b.action}, ${b.investor_id}, ${b.counterparty_id ?? null}, ${b.fund}, ${b.amount}, ${d.order.asset}, ${d.outcome}, ${d.headline}, ${JSON.stringify(d.checks)}, ${JSON.stringify(d.resolved)}, ${JSON.stringify(out.remedies)}, ${d.rulePacks}, ${whatIfs}, ${d.units}, ${hash}) returning *, amount::float8 as amount`;
  if (d.outcome === 'ALLOW' && !whatIfs.length) out.settle_by = new Date(new Date(row.created_at).getTime() + 15 * 60_000).toISOString();
  bg(c, Promise.all([audit(sql, ws, 'decision.created', decId, { outcome: d.outcome, action: b.action, fund: b.fund, investor: b.investor_id }), emit(sql, ws, 'decision.created', { id: decId, outcome: d.outcome, headline: d.headline })]));
  let receipt = null; let signature = null;
  try { receipt = receiptOf(row, ws); signature = await signReceipt(c.env, receipt); } catch { /* signing not configured */ }
  return c.json({ ...out, receipt, signature, created_at: row.created_at }, 201);
});
v1.get('/decisions', async (c) => c.json({ data: await c.get('sql')`select d.id, d.action, d.investor_id, i.name as investor, d.counterparty_id, d.ticker, d.amount::float8 as amount, d.asset, d.outcome, d.headline, d.what_ifs, d.created_at, s.id as settlement_id from decisions d join investors i on i.workspace_id = d.workspace_id and i.id = d.investor_id left join settlements s on s.workspace_id = d.workspace_id and s.decision_id = d.id where d.workspace_id = ${c.get('ws')} order by d.created_at desc limit 100` }));
v1.get('/decisions/:id', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const [row] = await sql`select d.*, d.amount::float8 as amount, d.units::float8 as units, i.name as investor_name, cp.name as counterparty_name, s.id as settlement_id from decisions d join investors i on i.workspace_id = d.workspace_id and i.id = d.investor_id left join investors cp on cp.workspace_id = d.workspace_id and cp.id = d.counterparty_id left join settlements s on s.workspace_id = d.workspace_id and s.decision_id = d.id where d.workspace_id = ${ws} and d.id = ${c.req.param('id')}`;
  if (!row) throw new ApiError(404, 'not_found', 'No decision with that id in this sandbox.');
  let receipt = null; let signature = null;
  try { receipt = receiptOf(row, ws); signature = await signReceipt(c.env, receipt); } catch { /* not configured */ }
  return c.json({ ...row, receipt, signature });
});

// Settlements
v1.post('/settlements', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const { decision_id } = await body(c, z.object({ decision_id: z.string() }));
  const [dec] = await sql`select *, amount::float8 as amount from decisions where workspace_id = ${ws} and id = ${decision_id}`;
  if (!dec) throw new ApiError(404, 'not_found', 'No decision with that id.');
  if (dec.outcome !== 'ALLOW') throw new ApiError(409, 'not_allowed', 'Only allowed decisions can settle. Fix the refusal and request a new decision.');
  if ((dec.what_ifs as string[]).length) throw new ApiError(409, 'hypothetical', 'This decision used what-if scenarios, so it is hypothetical and cannot settle.');
  if (Date.now() - new Date(dec.created_at).getTime() > 15 * 60_000) throw new ApiError(409, 'expired', 'Settlement instructions expire 15 minutes after the decision. Request a new decision.');
  const done = await sql`select id from settlements where workspace_id = ${ws} and decision_id = ${decision_id}`;
  if (done.length) throw new ApiError(409, 'already_settled', `Already settled as ${done[0].id}.`);
  // Re-check against current state: something may have changed since the decision.
  const ctx = await buildCtx(sql, ws, [dec.investor_id, ...(dec.counterparty_id ? [dec.counterparty_id] : [])], dec.ticker);
  const d = evaluate({ action: dec.action, investorId: dec.investor_id, fundId: dec.ticker, amount: dec.amount, asset: dec.asset, counterpartyId: dec.counterparty_id ?? undefined }, [], ctx);
  if (d.outcome !== 'ALLOW') throw new ApiError(409, 'state_changed', `Something changed since the decision. ${d.headline}`, d.checks.filter((x) => x.result === 'fail'));
  const u = d.units; const t = dec.ticker; const inv = ctx.investors[dec.investor_id]; const cp = dec.counterparty_id ? ctx.investors[dec.counterparty_id] : null;
  const q: any[] = []; let holderDelta = 0;
  const now = today();
  const credit = (who: Investor) => { if (!who.holdings[t]) holderDelta++; q.push(sql`insert into holdings (workspace_id, investor_id, ticker, units, since) values (${ws}, ${who.id}, ${t}, ${u}, ${now}) on conflict (workspace_id, investor_id, ticker) do update set units = holdings.units + excluded.units`); };
  const debit = (who: Investor) => { const left = (who.holdings[t]?.units ?? 0) - u; if (left <= 0.0001) { holderDelta--; q.push(sql`delete from holdings where workspace_id = ${ws} and investor_id = ${who.id} and ticker = ${t}`); } else q.push(sql`update holdings set units = units - ${u} where workspace_id = ${ws} and investor_id = ${who.id} and ticker = ${t}`); };
  if (dec.action === 'subscribe') credit(inv);
  if (dec.action === 'redeem') debit(inv);
  if (dec.action === 'transfer' && cp) { debit(inv); credit(cp); }
  if (holderDelta) q.push(sql`update funds set holders = greatest(0, holders + ${holderDelta}) where workspace_id = ${ws} and ticker = ${t}`);
  const base = Date.now();
  const at = (ms: number) => new Date(base + ms).toISOString();
  const steps = dec.action === 'redeem'
    ? [{ step: 'decision_signed', at: at(200) }, { step: 'units_locked', at: at(12_000), block: 1 }, { step: 'atomic_payout', at: at(12_000), block: 1 }, { step: 'final', at: at(780_000) }]
    : [{ step: 'decision_signed', at: at(200) }, { step: 'cash_locked', at: at(12_000), block: 1 }, { step: 'registry_confirmed', at: at(12_000), block: 1 }, { step: 'atomic_swap', at: at(12_000), block: 1 }, { step: 'final', at: at(780_000) }];
  const stlId = id('stl', 12);
  q.push(sql`insert into settlements (workspace_id, id, decision_id, status, steps) values (${ws}, ${stlId}, ${decision_id}, 'settled', ${JSON.stringify({ simulated: true, chain: 'Ethereum', steps })})`);
  q.push(sql`insert into audit_events (workspace_id, type, subject, data) values (${ws}, 'settlement.completed', ${stlId}, ${JSON.stringify({ decision: decision_id, action: dec.action, units: u, fund: t })})`);
  try { await sql.transaction(q); }
  catch (e) {
    await sql`insert into settlements (workspace_id, id, decision_id, status, steps) values (${ws}, ${stlId}, ${decision_id}, 'reverted', ${JSON.stringify({ simulated: true, reason: 'A leg failed, so both legs reverted.' })})`;
    bg(c, emit(sql, ws, 'settlement.reverted', { id: stlId, decision: decision_id }));
    throw new ApiError(409, 'reverted', 'A leg failed, so both legs reverted. Nothing moved.');
  }
  bg(c, emit(sql, ws, 'settlement.completed', { id: stlId, decision: decision_id, units: u, fund: t }));
  return c.json({ id: stlId, decision_id, status: 'settled', units: u, fund: t, steps, simulated: true }, 201);
});
v1.get('/settlements', async (c) => c.json({ data: await c.get('sql')`select s.id, s.decision_id, s.status, s.steps, s.created_at, d.action, d.ticker, d.amount::float8 as amount, d.asset, i.name as investor from settlements s join decisions d on d.workspace_id = s.workspace_id and d.id = s.decision_id join investors i on i.workspace_id = d.workspace_id and i.id = d.investor_id where s.workspace_id = ${c.get('ws')} order by s.created_at desc limit 100` }));
v1.get('/settlements/:id', async (c) => {
  const [row] = await c.get('sql')`select * from settlements where workspace_id = ${c.get('ws')} and id = ${c.req.param('id')}`;
  if (!row) throw new ApiError(404, 'not_found', 'No settlement with that id.');
  return c.json(row);
});

// Bulk eligibility
v1.post('/eligibility/bulk', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = await body(c, z.object({
    rows: z.array(z.object({ name: z.string().min(1).max(120), kind: z.string().default('Corporate'), residence: z.string(), booking_center: z.string(), us_person: z.boolean().default(false), classes: z.array(z.string()).default([]) })).min(1).max(200),
    funds: z.array(z.string()).optional(),
  }));
  const [g, funds] = await Promise.all([loadGlobals(sql), loadFunds(sql, ws, null)]);
  const tickers = (b.funds?.length ? b.funds : Object.keys(funds)).filter((t) => funds[t]);
  const t0 = today(); const exp = addDays(t0, 365);
  const investors: Record<string, Investor> = {};
  b.rows.forEach((r, i) => {
    investors[`row${i}`] = { id: `row${i}`, name: r.name, short: r.name, kind: r.kind, residence: r.residence as any, city: '', booking: r.booking_center as any, usPerson: r.us_person || r.residence === 'US', wallet: '', credentialId: `BULK-${i}`, issued: t0, expires: exp, classifications: r.classes.filter((x) => g.classInfo[x]).map((code) => ({ code: code as any, basis: 'Declared in bulk upload', verified: t0, expires: exp, optIn: code === 'SG_AI' ? t0 : undefined })), holdings: {} };
  });
  const ctx = { ...g, investors, funds, today: t0, screen: screener(g) };
  const data = b.rows.map((r, i) => ({ row: i + 1, name: r.name, residence: r.residence, results: tickers.map((t) => {
    if (!g.jurName[r.residence] || !g.bookingCenters[r.booking_center]) return { fund: t, outcome: 'DENY', reason: 'Unknown residence or booking center.', binding: [] };
    const d = evaluate({ action: 'subscribe', investorId: `row${i}`, fundId: t, amount: funds[t].minSubscription || 1, asset: funds[t].assets[0] }, [], ctx);
    return { fund: t, outcome: d.outcome, reason: d.outcome === 'ALLOW' ? (d.resolved.map((x) => x.text).join('; ') || 'No investor-class restriction') : d.checks.find((x) => x.result === 'fail')?.detail ?? '', binding: d.resolved.map((x) => x.ruleRef) };
  }) }));
  await audit(sql, ws, 'eligibility.bulk_checked', null, { rows: b.rows.length, funds: tickers });
  return c.json({ funds: tickers, data });
});

// Screening
v1.post('/screening', async (c) => {
  const { name } = await body(c, z.object({ name: z.string().min(2).max(160) }));
  const hit = screener(await loadGlobals(c.get('sql')))(name);
  await audit(c.get('sql'), c.get('ws'), 'screening.checked', null, { name, match: hit?.entry ?? null });
  return c.json({ name, match: hit, result: hit ? 'potential_match' : 'clear', note: 'Sandbox screening uses a fictional sample list, not the live OFAC, UN or EU lists.' });
});
v1.get('/screening-list', async (c) => c.json({ data: await c.get('sql')`select * from screening_list order by name` }));

// Rule drafting agent
v1.post('/rule-drafts', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = await body(c, z.object({ source_text: z.string().min(40).max(20_000), source_url: z.string().url().optional(), jurisdiction: z.string().max(10).optional() }));
  if (!c.env.ANTHROPIC_API_KEY) throw new ApiError(501, 'not_configured', 'The rule-drafting agent needs an Anthropic API key, which is not connected yet.');
  if (!(await rateLimit(sql, `draft:${ws}`, 10, 3600))) throw new ApiError(429, 'rate_limited', 'Ten drafts per hour per sandbox.');
  const classes = await sql`select code, jurisdiction, label, rule_ref, threshold from investor_classes`;
  const prompt = `You maintain machine-readable investor-eligibility rule packs for a compliance product. Current classes:\n${JSON.stringify(classes)}\n\nRead the regulator text below and draft a rule-pack change. Respond with JSON only, shaped as {"jurisdiction": string, "source_status": "final" | "proposal" | "guidance", "summary": string, "effective_date": string | null, "changes": [{"class_code": string, "field": string, "from": string | null, "to": string, "citation": string}], "open_questions": string[]}. Quote section numbers in citations. If the text is a proposal or consultation, say so in source_status. Do not invent figures that are not in the text.\n\nSource${b.source_url ? ` (${b.source_url})` : ''}:\n"""${b.source_text}"""`;
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': c.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }) });
  if (!res.ok) throw new ApiError(502, 'agent_failed', 'The drafting agent did not respond. Nothing was saved.');
  const msg: any = await res.json();
  const text = (msg.content ?? []).map((p: any) => p.text ?? '').join('');
  let draft: any;
  try { draft = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { throw new ApiError(502, 'agent_unparseable', 'The draft could not be read as structured data. Nothing was saved.'); }
  const dId = id('rd', 10);
  await sql`insert into rule_drafts (workspace_id, id, source, jurisdiction, draft) values (${ws}, ${dId}, ${b.source_url ?? 'pasted text'}, ${draft.jurisdiction ?? b.jurisdiction ?? null}, ${JSON.stringify(draft)})`;
  await audit(sql, ws, 'rule_draft.created', dId, { jurisdiction: draft.jurisdiction, status: draft.source_status });
  return c.json({ id: dId, status: 'draft', draft }, 201);
});
v1.get('/rule-drafts', async (c) => c.json({ data: await c.get('sql')`select * from rule_drafts where workspace_id = ${c.get('ws')} order by created_at desc`, agent_enabled: !!c.env.ANTHROPIC_API_KEY }));
v1.post('/rule-drafts/:id/:decision{approve|reject}', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const { reviewer } = await body(c, z.object({ reviewer: z.string().min(2).max(80) }));
  const status = c.req.param('decision') === 'approve' ? 'approved' : 'rejected';
  const r = await sql`update rule_drafts set status = ${status}, reviewer = ${reviewer} where workspace_id = ${ws} and id = ${c.req.param('id')} and status = 'draft' returning id`;
  if (!r.length) throw new ApiError(404, 'not_found', 'No open draft with that id.');
  await audit(sql, ws, `rule_draft.${status}`, c.req.param('id'), { reviewer });
  return c.json({ id: c.req.param('id'), status });
});

// Audit log
v1.get('/audit-events', async (c) => {
  const type = c.req.query('type');
  const rows = type
    ? await c.get('sql')`select * from audit_events where workspace_id = ${c.get('ws')} and type like ${type + '%'} order by created_at desc limit 300`
    : await c.get('sql')`select * from audit_events where workspace_id = ${c.get('ws')} order by created_at desc limit 300`;
  return c.json({ data: rows });
});
v1.get('/audit-events.csv', async (c) => {
  const rows = await c.get('sql')`select created_at, type, subject, data from audit_events where workspace_id = ${c.get('ws')} order by created_at desc limit 5000`;
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['created_at,type,subject,data', ...rows.map((r) => [new Date(r.created_at).toISOString(), r.type, r.subject, JSON.stringify(r.data)].map(esc).join(','))].join('\n');
  return c.body(csv, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="laissez-audit-log.csv"' });
});

// Webhooks
v1.get('/webhooks', async (c) => c.json({ data: await c.get('sql')`select id, url, events, created_at from webhooks where workspace_id = ${c.get('ws')} order by created_at` }));
v1.post('/webhooks', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = await body(c, z.object({ url: z.string().url().startsWith('https://'), events: z.array(z.string()).min(1).max(12) }));
  const [{ n }] = await sql`select count(*)::int as n from webhooks where workspace_id = ${ws}`;
  if (n >= 5) throw new ApiError(422, 'limit', 'A sandbox can have up to 5 webhook endpoints.');
  const whId = id('wh', 10); const secret = `whsec_${rand(28)}`;
  await sql`insert into webhooks (workspace_id, id, url, secret, events) values (${ws}, ${whId}, ${b.url}, ${secret}, ${b.events})`;
  await audit(sql, ws, 'webhook.created', whId, { url: b.url, events: b.events });
  return c.json({ id: whId, url: b.url, events: b.events, secret, note: 'Store the signing secret now. It is shown once.' }, 201);
});
v1.delete('/webhooks/:id', async (c) => {
  const r = await c.get('sql')`delete from webhooks where workspace_id = ${c.get('ws')} and id = ${c.req.param('id')} returning id`;
  if (!r.length) throw new ApiError(404, 'not_found', 'No webhook with that id.');
  return c.json({ deleted: c.req.param('id') });
});
v1.post('/webhooks/:id/test', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const r = await sql`select id from webhooks where workspace_id = ${ws} and id = ${c.req.param('id')}`;
  if (!r.length) throw new ApiError(404, 'not_found', 'No webhook with that id.');
  bg(c, emit(sql, ws, 'ping', { message: 'Test event from Laissez' }));
  return c.json({ sent: true });
});
v1.get('/webhook-deliveries', async (c) => c.json({ data: await c.get('sql')`select id, webhook_id, event, status, attempts, response_ms, created_at from webhook_deliveries where workspace_id = ${c.get('ws')} order by created_at desc limit 100` }));

// API keys
v1.get('/api-keys', async (c) => c.json({ data: await c.get('sql')`select id, prefix, created_at, last_used_at from api_keys where workspace_id = ${c.get('ws')} order by created_at` }));
v1.post('/api-keys', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  const [{ n }] = await sql`select count(*)::int as n from api_keys where workspace_id = ${ws}`;
  if (n >= 5) throw new ApiError(422, 'limit', 'A sandbox can have up to 5 keys. Revoke one first.');
  const key = `lz_test_${rand(32)}`;
  const [row] = await sql`insert into api_keys (workspace_id, prefix, key_hash) values (${ws}, ${key.slice(0, 12)}, ${await sha256(key)}) returning id, prefix, created_at`;
  await audit(sql, ws, 'api_key.created', row.id, { prefix: row.prefix });
  return c.json({ ...row, api_key: key, note: 'Store this key now. It is shown once.' }, 201);
});
v1.delete('/api-keys/:id', async (c) => {
  const sql = c.get('sql'); const ws = c.get('ws');
  if (c.req.param('id') === c.get('keyId')) throw new ApiError(422, 'in_use', 'You cannot revoke the key making this request.');
  const r = await sql`delete from api_keys where workspace_id = ${ws} and id = ${c.req.param('id')} returning id`;
  if (!r.length) throw new ApiError(404, 'not_found', 'No key with that id.');
  await audit(sql, ws, 'api_key.revoked', c.req.param('id'));
  return c.json({ revoked: c.req.param('id') });
});

app.route('/v1', v1);
app.notFound((c) => c.json({ error: { code: 'not_found', message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}. See the API overview.` } }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_e: ScheduledEvent, env: Env) {
    const sql = neon(env.DATABASE_URL);
    await sql`delete from workspaces where expires_at < now()`;
    await sql`delete from rate_limits where window_start < now() - interval '1 day'`;
  },
};
