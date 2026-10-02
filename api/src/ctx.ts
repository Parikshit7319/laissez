import type { Ctx, ClassMeta } from '../../src/proto/engine';
import type { Investor, Fund, BookingCenter } from '../../src/proto/data';
import type { Sql } from './db';
import { today, hmac, id as newId } from './util';

export type Globals = Pick<Ctx, 'classInfo' | 'bookingCenters' | 'jurName' | 'sanctioned'> & { rulePacks: { id: string; version: string; jurisdiction: string; effective_from: string | null; effective_to: string | null; status: string }[] };
let globals: Globals | null = null;
let globalsAt = 0;

export const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export async function loadGlobals(sql: Sql): Promise<Globals> {
  if (globals && Date.now() - globalsAt < 60_000) return globals;
  const [cls, bcs, jurs, packs] = await Promise.all([
    sql`select * from investor_classes`,
    sql`select * from booking_centers`,
    sql`select * from jurisdictions`,
    sql`select id, version, jurisdiction, status, effective_from::text, effective_to::text from rule_packs`,
  ]);
  const classInfo: Record<string, ClassMeta> = {};
  for (const c of cls) classInfo[c.code] = { label: c.label, stamp: c.stamp, jur: c.jurisdiction, rule: c.rule_ref, source: c.source_id, threshold: c.threshold, requiresOptIn: !!c.requires_opt_in, optInLabel: c.opt_in_label ?? undefined };
  const bookingCenters: Record<string, BookingCenter> = {};
  for (const b of bcs) bookingCenters[b.id] = { id: b.id, name: b.name, jur: b.jurisdiction, licence: b.licence, requires: b.requires_class, requiresAny: Array.isArray(b.requires_any) && b.requires_any.length ? b.requires_any : undefined, ruleText: b.rule_text, ruleRef: b.rule_ref, source: b.source_id } as BookingCenter;
  const jurName: Record<string, string> = {};
  const sanctioned: Record<string, string> = {};
  for (const j of jurs) { jurName[j.code] = j.name; if (j.comprehensive_sanctions) sanctioned[j.code] = j.comprehensive_sanctions; }
  globals = { classInfo, bookingCenters, jurName, sanctioned, rulePacks: packs as any };
  globalsAt = Date.now();
  return globals;
}

/** Rule-pack versions in force on a date, keyed by pack id (e.g. "SG/eligibility"). */
export function packsAsOf(g: Globals, date: string): Record<string, string> {
  const out: Record<string, string> = {};
  const best: Record<string, string> = {};
  for (const p of g.rulePacks) {
    if (p.status === 'draft') continue;
    if (p.effective_from && p.effective_from > date) continue;
    if (p.effective_to && p.effective_to <= date) continue;
    if (!best[p.id] || (p.effective_from ?? '') > best[p.id]) { best[p.id] = p.effective_from ?? ''; out[p.id] = p.version; }
  }
  return out;
}

export async function loadInvestors(sql: Sql, ws: string, ids: string[] | null, admin?: Sql): Promise<Record<string, Investor>> {
  const rows = ids
    ? await sql`select i.*, c.id as cred_id, c.issued_on::text as issued_on, c.expires_on::text as expires_on, c.lzid, c.issuer_name from investors i
        left join credentials c on c.workspace_id = i.workspace_id and c.investor_id = i.id and c.status = 'active'
        where i.workspace_id = ${ws} and i.id = any(${ids})`
    : await sql`select i.*, c.id as cred_id, c.issued_on::text as issued_on, c.expires_on::text as expires_on, c.lzid, c.issuer_name from investors i
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
      id: r.id, name: r.name, short: r.short_name, kind: r.kind, residence: r.residence, city: r.city, booking: r.booking_center,
      usPerson: r.us_person, wallet: r.chain_wallet ?? r.wallet, credentialId: r.cred_id ?? '', issued: r.issued_on ?? '', expires: r.expires_on ?? '0000-00-00',
      classifications: cls.filter((c: any) => c.credential_id === r.cred_id).map((c: any) => ({ code: c.class_code, basis: c.basis, verified: c.verified_on, expires: c.expires_on, optIn: c.opt_in_on ?? undefined })),
      holdings: Object.fromEntries(hold.filter((h: any) => h.investor_id === r.id).map((h: any) => [h.ticker, { units: Number(h.units), since: h.since }])),
      issuer: r.issuer_name ?? 'Aster & Vale Private Bank',
      lzid: r.lzid ?? undefined,
      reliedShare: r.relied_share ?? undefined,
      external_id: r.external_id ?? null,
    } as Investor;
  }
  // Credentials relied on from another organization are read live from the issuing organization.
  const relied = rows.filter((r) => r.relied_share);
  if (relied.length && admin) {
    const shares = await admin`select s.id, s.from_workspace, s.credential_id, s.status, c.issued_on::text as issued_on, c.expires_on::text as expires_on, c.status as cred_status, c.lzid, c.issuer_name
      from credential_shares s join credentials c on c.workspace_id = s.from_workspace and c.id = s.credential_id where s.id = any(${relied.map((r) => r.relied_share)})`;
    for (const s of shares) {
      const inv = Object.values(out).find((i) => (i as any).reliedShare === s.id);
      if (!inv) continue;
      const live = s.status === 'active' && s.cred_status === 'active';
      const scls = live ? await admin`select class_code, basis, verified_on::text as verified_on, expires_on::text as expires_on, opt_in_on::text as opt_in_on from classifications where workspace_id = ${s.from_workspace} and credential_id = ${s.credential_id} order by id` : [];
      Object.assign(inv, {
        credentialId: live ? s.credential_id : '', issued: live ? s.issued_on : '', expires: live ? s.expires_on : '0000-00-00', lzid: s.lzid,
        issuer: `${s.issuer_name ?? 'another distributor'} (relied on under share ${s.id})`,
        classifications: scls.map((c: any) => ({ code: c.class_code, basis: c.basis, verified: c.verified_on, expires: c.expires_on, optIn: c.opt_in_on ?? undefined })),
        shareStatus: live ? 'active' : s.status !== 'active' ? s.status : 'credential_revoked',
      });
    }
  }
  return out;
}

export async function loadFunds(sql: Sql, ws: string, ticker: string | null): Promise<Record<string, Fund>> {
  const [rows, dist] = await Promise.all([
    ticker ? sql`select *, nav::float8 as navf, min_subscription::float8 as minf, gate_pct::float8 as gatef, yield_bps::float8 as yieldf from funds where workspace_id = ${ws} and ticker = ${ticker}` : sql`select *, nav::float8 as navf, min_subscription::float8 as minf, gate_pct::float8 as gatef, yield_bps::float8 as yieldf from funds where workspace_id = ${ws} order by ticker`,
    ticker ? sql`select * from fund_distribution where workspace_id = ${ws} and ticker = ${ticker}` : sql`select * from fund_distribution where workspace_id = ${ws}`,
  ]);
  const out: Record<string, Fund> = {};
  for (const f of rows) {
    out[f.ticker] = {
      id: f.ticker, name: f.name, short: f.short_name, ticker: f.ticker, domicile: f.domicile, structure: f.structure, currency: f.currency,
      nav: Number(f.navf), regS: f.reg_s, usAccepts: f.us_accepts, minSubscription: Number(f.minf), holderCap: f.holder_cap, holders: f.holders,
      lockupMonths: f.lockup_months, assets: f.assets, chains: f.chains, issuer: f.issuer, policyVersion: f.policy_version,
      shareClassType: f.share_class_type, cutoffTime: f.cutoff_time, cutoffTz: f.cutoff_tz, dealingFrequency: f.dealing_frequency, noticeDays: f.notice_days, gatePct: f.gatef, yieldBps: f.yieldf,
      chainToken: f.chain_token, regSCategory: f.reg_s_category ?? null, offeringDate: f.offering_date ? String(f.offering_date).slice(0, 10) : null,
      distribution: Object.fromEntries(dist.filter((d) => d.ticker === f.ticker).map((d) => [d.jurisdiction, { accepts: d.accepts, basis: d.basis, lawRequires: d.law_requires, lawRequiresAny: Array.isArray(d.law_requires_any) && d.law_requires_any.length ? d.law_requires_any : null, lawText: d.law_text, lawRef: d.law_ref, lawSource: d.law_source }])),
    } as Fund;
  }
  return out;
}

export async function buildCtx(sql: Sql, ws: string, investorIds: string[], ticker: string | null, admin?: Sql, extra: Partial<Ctx> = {}): Promise<Ctx> {
  const [g, investors, funds] = await Promise.all([loadGlobals(sql), loadInvestors(sql, ws, investorIds, admin), loadFunds(sql, ws, ticker)]);
  const t = today();
  return { ...g, investors, funds, today: t, rulePacks: packsAsOf(g, t), ...extra } as Ctx;
}

/** Deliver an event to every subscribed webhook. Runs after the response via waitUntil. */
export async function emit(sql: Sql, ws: string, event: string, payload: unknown) {
  const hooks = await sql`select * from webhooks where workspace_id = ${ws} and (${event} = any(events) or '*' = any(events))`;
  for (const h of hooks) {
    const body = JSON.stringify({ id: newId('evt'), type: event, created: new Date().toISOString(), data: payload });
    await deliver(sql, ws, h, event, body, null);
  }
}
export async function deliver(sql: Sql, ws: string, h: any, event: string, body: string, replayOf: number | null) {
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
  const [row] = await sql`insert into webhook_deliveries (workspace_id, webhook_id, event, status, attempts, response_ms, payload, replay_of) values (${ws}, ${h.id}, ${event}, ${status}, ${attempts}, ${ms}, ${body}, ${replayOf}) returning id`;
  return { id: row.id, status, attempts, ms };
}
