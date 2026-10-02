import type { Ctx, ClassMeta } from '../../src/proto/engine';
import type { Investor, Fund, BookingCenter, Jur } from '../../src/proto/data';
import { type Sql, today, hmac, id as newId } from './util';

type Globals = Pick<Ctx, 'classInfo' | 'bookingCenters' | 'jurName' | 'sanctioned'> & { screening: { name: string; program: string; norm: string }[] };
let globals: Globals | null = null;
let globalsAt = 0;

export const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').replace(/\b(ltd|llc|inc|pte|gmbh|limited|co|sa|ag)\b/g, ' ').replace(/\s+/g, ' ').trim();

export async function loadGlobals(sql: Sql): Promise<Globals> {
  if (globals && Date.now() - globalsAt < 60_000) return globals;
  const [cls, bcs, jurs, scr] = await Promise.all([
    sql`select * from investor_classes`,
    sql`select * from booking_centers`,
    sql`select * from jurisdictions`,
    sql`select * from screening_list`,
  ]);
  const classInfo: Record<string, ClassMeta> = {};
  for (const c of cls) classInfo[c.code] = { label: c.label, stamp: c.stamp, jur: c.jurisdiction as Jur, rule: c.rule_ref, source: c.source_id, threshold: c.threshold };
  const bookingCenters: Record<string, BookingCenter> = {};
  for (const b of bcs) bookingCenters[b.id] = { id: b.id, name: b.name, jur: b.jurisdiction as Jur, licence: b.licence, requires: b.requires_class, ruleText: b.rule_text, ruleRef: b.rule_ref, source: b.source_id };
  const jurName: Record<string, string> = {};
  const sanctioned: Record<string, string> = {};
  for (const j of jurs) { jurName[j.code] = j.name; if (j.comprehensive_sanctions) sanctioned[j.code] = j.comprehensive_sanctions; }
  globals = { classInfo, bookingCenters, jurName, sanctioned, screening: scr.map((s) => ({ name: s.name, program: s.program, norm: norm(s.name) })) };
  globalsAt = Date.now();
  return globals;
}

export function screener(g: Globals) {
  return (name: string) => {
    const n = norm(name);
    const hit = g.screening.find((s) => s.norm === n || (s.norm.length > 6 && n.includes(s.norm)));
    return hit ? { entry: hit.name, program: hit.program } : null;
  };
}

export async function loadInvestors(sql: Sql, ws: string, ids: string[] | null): Promise<Record<string, Investor>> {
  const rows = ids
    ? await sql`select i.*, c.id as cred_id, c.issued_on::text as issued_on, c.expires_on::text as expires_on from investors i
        left join credentials c on c.workspace_id = i.workspace_id and c.investor_id = i.id and c.status = 'active'
        where i.workspace_id = ${ws} and i.id = any(${ids})`
    : await sql`select i.*, c.id as cred_id, c.issued_on::text as issued_on, c.expires_on::text as expires_on from investors i
        left join credentials c on c.workspace_id = i.workspace_id and c.investor_id = i.id and c.status = 'active'
        where i.workspace_id = ${ws} order by i.created_at`;
  const credIds = rows.map((r) => r.cred_id).filter(Boolean);
  const invIds = rows.map((r) => r.id);
  const [cls, hold] = await Promise.all([
    credIds.length ? sql`select credential_id, class_code, basis, verified_on::text as verified_on, expires_on::text as expires_on, opt_in_on::text as opt_in_on from classifications where workspace_id = ${ws} and credential_id = any(${credIds}) order by id` : Promise.resolve([] as any[]),
    invIds.length ? sql`select investor_id, ticker, units::float8 as units, since::text as since from holdings where workspace_id = ${ws} and investor_id = any(${invIds})` : Promise.resolve([] as any[]),
  ]);
  const out: Record<string, Investor> = {};
  for (const r of rows) {
    out[r.id] = {
      id: r.id, name: r.name, short: r.short_name, kind: r.kind, residence: r.residence as Jur, city: r.city, booking: r.booking_center,
      usPerson: r.us_person, wallet: r.wallet, credentialId: r.cred_id ?? '', issued: r.issued_on ?? '', expires: r.expires_on ?? '0000-00-00',
      classifications: cls.filter((c: any) => c.credential_id === r.cred_id).map((c: any) => ({ code: c.class_code, basis: c.basis, verified: c.verified_on, expires: c.expires_on, optIn: c.opt_in_on ?? undefined })),
      holdings: Object.fromEntries(hold.filter((h: any) => h.investor_id === r.id).map((h: any) => [h.ticker, { units: Number(h.units), since: h.since }])),
      issuer: 'Aster & Vale',
    };
  }
  return out;
}

export async function loadFunds(sql: Sql, ws: string, ticker: string | null): Promise<Record<string, Fund>> {
  const [rows, dist] = await Promise.all([
    ticker ? sql`select *, nav::float8 as navf, min_subscription::float8 as minf from funds where workspace_id = ${ws} and ticker = ${ticker}` : sql`select *, nav::float8 as navf, min_subscription::float8 as minf from funds where workspace_id = ${ws} order by ticker`,
    ticker ? sql`select * from fund_distribution where workspace_id = ${ws} and ticker = ${ticker}` : sql`select * from fund_distribution where workspace_id = ${ws}`,
  ]);
  const out: Record<string, Fund> = {};
  for (const f of rows) {
    out[f.ticker] = {
      id: f.ticker, name: f.name, short: f.short_name, ticker: f.ticker, domicile: f.domicile, structure: f.structure, currency: f.currency,
      nav: Number(f.navf), regS: f.reg_s, usAccepts: f.us_accepts, minSubscription: Number(f.minf), holderCap: f.holder_cap, holders: f.holders,
      lockupMonths: f.lockup_months, assets: f.assets, chains: f.chains, issuer: f.issuer,
      distribution: Object.fromEntries(dist.filter((d) => d.ticker === f.ticker).map((d) => [d.jurisdiction, { accepts: d.accepts, basis: d.basis, lawRequires: d.law_requires, lawText: d.law_text, lawRef: d.law_ref, lawSource: d.law_source }])),
    } as Fund;
  }
  return out;
}

export async function buildCtx(sql: Sql, ws: string, investorIds: string[], ticker: string | null): Promise<Ctx> {
  const [g, investors, funds] = await Promise.all([loadGlobals(sql), loadInvestors(sql, ws, investorIds), loadFunds(sql, ws, ticker)]);
  return { ...g, investors, funds, today: today(), screen: screener(g) };
}

export async function audit(sql: Sql, ws: string, type: string, subject: string | null, data: unknown = {}) {
  await sql`insert into audit_events (workspace_id, type, subject, data) values (${ws}, ${type}, ${subject}, ${JSON.stringify(data)})`;
}

/** Deliver an event to every subscribed webhook. Runs after the response via waitUntil. */
export async function emit(sql: Sql, ws: string, event: string, payload: unknown) {
  const hooks = await sql`select * from webhooks where workspace_id = ${ws} and (${event} = any(events) or '*' = any(events))`;
  for (const h of hooks) {
    const body = JSON.stringify({ id: newId('evt'), type: event, created: new Date().toISOString(), data: payload });
    const t = Math.floor(Date.now() / 1000);
    const sig = await hmac(h.secret, `${t}.${body}`);
    let status = 0; let attempts = 0; let ms = 0;
    for (const wait of [0, 1000, 3000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      attempts++;
      const start = Date.now();
      try {
        const res = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'laissez-signature': `t=${t},v1=${sig}`, 'user-agent': 'Laissez-Webhooks/1' }, body });
        status = res.status; ms = Date.now() - start;
        if (res.ok) break;
      } catch { status = 0; ms = Date.now() - start; }
    }
    await sql`insert into webhook_deliveries (workspace_id, webhook_id, event, status, attempts, response_ms, payload) values (${ws}, ${h.id}, ${event}, ${status}, ${attempts}, ${ms}, ${body})`;
  }
}
