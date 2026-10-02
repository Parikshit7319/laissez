// Continuous monitoring of existing holders. Runs in the Worker (manual runs, after screening decisions)
// and in Node (nightly sweep, after each sanctions list refresh). Re-screens every investor, recomputes each
// holder's standing, records changes, opens and closes work items, and emits holder.status_changed webhooks.
// Budget: one parallel read round, one screening query, one write transaction. No per-holder queries.
import type { Sql } from './db';
import { loadGlobals, loadInvestors, loadFunds, packsAsOf, emit } from './ctx';
import { screenNames, recordHits } from './sanctions';
import { holderStatus, type Ctx } from '../../src/proto/engine';
import type { Investor } from '../../src/proto/data';
import { actorRef, SYSTEM } from './http';
import { id, today, addDays, daysBetween } from './util';

export type MonitorSummary = { run_id: number; holders_checked: number; changes: number; items_opened: number; items_closed: number };
export type MonitorOpts = {
  /** Owner connection, needed to read credentials relied on from another organization. */
  admin?: Sql;
  /** Limit the run to these investors. Work items for other investors are left alone. */
  investorIds?: string[];
  /** Where to hand webhook deliveries so the caller does not wait for retries (the Worker passes waitUntil). */
  defer?: (p: Promise<unknown>) => void;
  /** Who asked for the run, recorded in the audit event. */
  requestedBy?: string;
};

type Status = 'eligible' | 'redemption-only' | 'frozen';
type PrevStatus = { investor_id: string; ticker: string; status: string; reason: string };
type OpenItem = { id: string; kind: string; dedupe_key: string; investor_id: string | null };
type Hit = { id: string; investor_id: string | null; screened_name: string; source: string; source_uid: string; matched_name: string; programs: string | null; score: number; status: string };
type NewItem = { kind: string; key: string; title: string; detail: string; severity: 'high' | 'medium' | 'low'; investor: string | null; ticker: string | null; link: string; due: string | null };

/** How long before expiry a credential renewal item opens. */
export const RENEWAL_WINDOW_DAYS = 30;
const STICKY = new Set(['credential_expiring', 'credential_lapsed', 'screening_hit']);

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const hitKey = (name: string, source: string, uid: string) => `hit:${source}:${uid}:${name}`;
const validDate = (d: string | undefined) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d !== '0000-00-00';
const label = (inv: Investor) => inv.short || inv.name;

async function loadState(sql: Sql, ws: string, ids: string[] | null) {
  const [row] = await sql`
    select
      coalesce((select json_agg(json_build_object('investor_id', investor_id, 'ticker', ticker, 'status', status, 'reason', reason))
        from holder_status where workspace_id = ${ws} and (${ids}::text[] is null or investor_id = any(${ids}::text[]))), '[]'::json) as statuses,
      coalesce((select json_agg(json_build_object('id', id, 'kind', kind, 'dedupe_key', dedupe_key, 'investor_id', investor_id))
        from work_items where workspace_id = ${ws} and status = 'open'), '[]'::json) as items,
      coalesce((select json_agg(distinct dedupe_key) from work_items where workspace_id = ${ws} and status = 'dismissed'), '[]'::json) as dismissed,
      coalesce((select json_agg(json_build_object('id', id, 'investor_id', investor_id, 'screened_name', screened_name, 'source', source, 'source_uid', source_uid,
        'matched_name', matched_name, 'programs', programs, 'score', score, 'status', status)) from screening_hits where workspace_id = ${ws}), '[]'::json) as hits,
      exists (select 1 from webhooks where workspace_id = ${ws} and ('holder.status_changed' = any(events) or '*' = any(events))) as hooked`;
  return {
    statuses: (row?.statuses ?? []) as PrevStatus[],
    items: (row?.items ?? []) as OpenItem[],
    dismissed: new Set<string>((row?.dismissed ?? []) as string[]),
    hits: (row?.hits ?? []) as Hit[],
    hooked: !!row?.hooked,
  };
}

export async function runMonitor(sql: Sql, ws: string, trigger: string, opts: MonitorOpts = {}): Promise<MonitorSummary> {
  const startedAt = new Date().toISOString();
  const t0 = today();
  const ids = opts.investorIds?.length ? [...new Set(opts.investorIds)] : null;

  // 1. Read everything in one parallel round.
  const [g, investors, funds, state] = await Promise.all([
    loadGlobals(sql),
    loadInvestors(sql, ws, ids, opts.admin),
    loadFunds(sql, ws, null),
    loadState(sql, ws, ids),
  ]);
  const invList = Object.values(investors);

  // 2. Re-screen every name against the loaded lists. Decided false positives are excluded by screenNames.
  const matches = await screenNames(sql, ws, invList.map((i) => i.name));
  const known = new Map(state.hits.map((h) => [hitKey(h.screened_name, h.source, h.source_uid), h]));
  const fresh = invList
    .filter((i) => { const m = matches[i.name]; return m && !known.has(hitKey(i.name, m.source, m.uid)); })
    .map((i) => ({ investorId: i.id, name: i.name, m: matches[i.name]! }));
  if (fresh.length) await recordHits(sql, ws, fresh, 'monitoring');

  // 3. Recompute the standing of every holding.
  const screen = (name: string) => {
    const m = matches[name];
    if (!m) return null;
    const hit = { entry: m.entry, program: m.program, score: m.score, source: m.source };
    return hit;
  };
  const ctx: Ctx = { classInfo: g.classInfo, bookingCenters: g.bookingCenters, jurName: g.jurName, sanctioned: g.sanctioned, investors, funds, today: t0, rulePacks: packsAsOf(g, t0), screen };
  const prev = new Map(state.statuses.map((s) => [`${s.investor_id}|${s.ticker}`, s]));
  const current: { inv: Investor; ticker: string; status: Status; reason: string; prev: PrevStatus | null }[] = [];
  for (const inv of invList) {
    for (const [ticker, h] of Object.entries(inv.holdings)) {
      const fund = funds[ticker];
      if (!h || !(h.units > 0) || !fund) continue;
      const st = holderStatus(inv, fund, ctx);
      current.push({ inv, ticker, status: st.status, reason: st.reason, prev: prev.get(`${inv.id}|${ticker}`) ?? null });
    }
  }
  const currentKey = new Map(current.map((c) => [`${c.inv.id}|${c.ticker}`, c]));
  const changed = current.filter((c) => (c.prev ? c.prev.status !== c.status : c.status !== 'eligible'));
  const upserts = current.filter((c) => !c.prev || c.prev.status !== c.status || c.prev.reason !== c.reason);
  const stale = state.statuses.filter((s) => !currentKey.has(`${s.investor_id}|${s.ticker}`));

  // 4. Work items to open. The database ignores any whose dedupe key already has an open item.
  const open: NewItem[] = [];
  for (const c of changed) {
    if (c.status === 'eligible') continue;
    const name = label(c.inv);
    open.push({
      kind: 'holder_status', key: `status:${c.inv.id}:${c.ticker}:${c.status}`, severity: 'high', investor: c.inv.id, ticker: c.ticker, link: `#/clients/${c.inv.id}`, due: null,
      title: `${name} is ${c.status} in ${c.ticker}`,
      detail: `${sentence(c.reason)} ${c.status === 'frozen' ? 'All movements of these units are blocked until compliance clears the case.' : 'New subscriptions and incoming transfers are blocked. Redemptions stay open.'}`,
    });
  }
  const horizon = addDays(t0, RENEWAL_WINDOW_DAYS);
  for (const inv of invList) {
    const name = label(inv);
    const hasCred = !!inv.credentialId && validDate(inv.expires);
    const held = Object.entries(inv.holdings).filter(([t, h]) => h && h.units > 0 && funds[t]).map(([t]) => t);
    if (hasCred && inv.expires >= t0 && inv.expires <= horizon) {
      const days = daysBetween(t0, inv.expires);
      open.push({
        kind: 'credential_expiring', key: `renew:${inv.id}:${inv.expires}`, severity: 'medium', investor: inv.id, ticker: null, link: `#/clients/${inv.id}/credential`, due: inv.expires,
        title: `Renew the credential for ${name}`,
        detail: `Credential ${inv.credentialId} expires on ${inv.expires}, ${days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}. After that ${name} becomes redemption-only in funds that need a current classification.`,
      });
    }
    if (held.length && !(hasCred && inv.expires >= t0)) {
      open.push({
        kind: 'credential_lapsed', key: `lapsed:${inv.id}:${validDate(inv.expires) ? inv.expires : 'none'}`, severity: 'high', investor: inv.id, ticker: null, link: `#/clients/${inv.id}/credential`, due: null,
        title: `Credential lapsed for ${name}`,
        detail: `${name} holds units in ${held.join(', ')} but has no current credential${validDate(inv.expires) ? ` (the last one expired on ${inv.expires})` : ''}. Issue a new credential to restore subscriptions and transfers.`,
      });
    }
  }
  const openHits: Hit[] = [
    ...state.hits.filter((h) => h.status === 'open'),
    ...fresh.map((f) => ({ id: '', investor_id: f.investorId, screened_name: f.name, source: f.m.source, source_uid: f.m.uid, matched_name: f.m.entry, programs: f.m.program, score: f.m.score, status: 'open' })),
  ];
  for (const h of openHits) {
    open.push({
      kind: 'screening_hit', key: hitKey(h.screened_name, h.source, h.source_uid), severity: 'high', investor: h.investor_id, ticker: null, link: '#/screening-hits', due: null,
      title: `Review screening match for ${h.screened_name}`,
      detail: `${h.screened_name} matched ${h.matched_name} (${h.programs || h.source}) at ${Math.round(Number(h.score) * 100)}% similarity. Confirm the match or mark it a false positive.`,
    });
  }
  const seenKeys = new Set<string>();
  const toOpen = open.filter((o) => {
    if (seenKeys.has(o.key) || (STICKY.has(o.kind) && state.dismissed.has(o.key))) return false;
    seenKeys.add(o.key);
    return true;
  });

  // 5. Work items to close because the condition behind them is gone.
  const inScope = (investorId: string | null) => !ids || (!!investorId && ids.includes(investorId));
  const close: string[] = [];
  for (const it of state.items) {
    const inv = it.investor_id ? investors[it.investor_id] : undefined;
    const validCred = !!inv && !!inv.credentialId && validDate(inv.expires) && inv.expires >= t0;
    if (it.kind === 'screening_hit') {
      const h = state.hits.find((x) => hitKey(x.screened_name, x.source, x.source_uid) === it.dedupe_key);
      const stillOpen = (h && h.status === 'open') || fresh.some((f) => hitKey(f.name, f.m.source, f.m.uid) === it.dedupe_key);
      if (!stillOpen) close.push(it.id);
      continue;
    }
    if (!inScope(it.investor_id)) continue;
    if (it.kind === 'credential_expiring') {
      const exp = it.dedupe_key.split(':')[2];
      if (!inv || (validCred && inv.expires !== exp)) close.push(it.id);
    } else if (it.kind === 'credential_lapsed') {
      const holds = !!inv && Object.entries(inv.holdings).some(([t, h]) => h && h.units > 0 && funds[t]);
      if (!inv || validCred || !holds) close.push(it.id);
    } else if (it.kind === 'holder_status') {
      const [, invId, ticker, status] = it.dedupe_key.split(':');
      const now = currentKey.get(`${invId}|${ticker}`);
      if (!now || now.status !== status) close.push(it.id);
    }
  }

  // 6. One write transaction: statuses, item changes, the run record and the audit event.
  const statusCounts = { eligible: 0, 'redemption-only': 0, frozen: 0 } as Record<Status, number>;
  for (const c of current) statusCounts[c.status]++;
  const queries: any[] = [];
  if (upserts.length) {
    queries.push(sql.query(
      `insert into holder_status (workspace_id, investor_id, ticker, status, reason, updated_at)
       select $1, u.i, u.t, u.s, u.r, now() from unnest($2::text[], $3::text[], $4::text[], $5::text[]) as u(i, t, s, r)
       on conflict (workspace_id, investor_id, ticker) do update set status = excluded.status, reason = excluded.reason, updated_at = now()`,
      [ws, upserts.map((c) => c.inv.id), upserts.map((c) => c.ticker), upserts.map((c) => c.status), upserts.map((c) => c.reason)],
    ));
  }
  if (stale.length) {
    queries.push(sql.query(
      `delete from holder_status where workspace_id = $1 and (investor_id, ticker) in (select * from unnest($2::text[], $3::text[]))`,
      [ws, stale.map((s) => s.investor_id), stale.map((s) => s.ticker)],
    ));
  }
  // Closing and opening items never touch the same dedupe key (each close rule is the negation of its open rule),
  // so both can run as data-modifying CTEs in one statement with the run record and its audit event.
  const auditData = {
    trigger, holders_checked: current.length, changes: changed.length, new_screening_hits: fresh.length,
    statuses: statusCounts, ...(opts.requestedBy ? { requested_by: opts.requestedBy } : {}),
  };
  const runAt = queries.length;
  queries.push(sql.query(
    `with closed as (
       update work_items set status = 'done', resolved_at = now(), resolved_by = 'Laissez'
       where workspace_id = $1 and status = 'open' and id = any($16::text[])
       returning id
     ), ins as (
       insert into work_items (workspace_id, id, kind, dedupe_key, title, detail, severity, investor_id, ticker, link, due_on)
       select $1, u.id, u.kind, u.key, u.title, u.detail, u.sev, u.inv, u.tkr, u.link, u.due
       from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::date[]) as u(id, kind, key, title, detail, sev, inv, tkr, link, due)
       on conflict (workspace_id, dedupe_key) where status = 'open' do nothing
       returning id
     ), run as (
       insert into monitor_runs (workspace_id, trigger, started_at, finished_at, holders_checked, changes, items_opened)
       select $1, $12, $13::timestamptz, now(), $14, $15, (select count(*) from ins)
       returning id, items_opened
     ), aud as (
       insert into audit_events (workspace_id, type, subject, data, actor, actor_name)
       select $1, 'monitoring.completed', run.id::text,
         $17::jsonb || jsonb_build_object('run_id', run.id, 'items_opened', run.items_opened, 'items_closed', (select count(*) from closed)), $18, $19
       from run
     )
     select run.id, run.items_opened, (select count(*) from closed)::int as items_closed from run`,
    [ws, toOpen.map(() => id('wi', 10)), toOpen.map((o) => o.kind), toOpen.map((o) => o.key), toOpen.map((o) => o.title), toOpen.map((o) => o.detail),
      toOpen.map((o) => o.severity), toOpen.map((o) => o.investor), toOpen.map((o) => o.ticker), toOpen.map((o) => o.link), toOpen.map((o) => o.due),
      trigger, startedAt, current.length, changed.length, close, JSON.stringify(auditData), actorRef(SYSTEM), SYSTEM.name],
  ));
  const results = await sql.transaction(queries);
  const run = results[runAt]?.[0] ?? {};
  const summary: MonitorSummary = {
    run_id: Number(run.id),
    holders_checked: current.length,
    changes: changed.length,
    items_opened: Number(run.items_opened ?? 0),
    items_closed: Number(run.items_closed ?? 0),
  };

  // 7. Webhooks for each status change, after the data is committed.
  if (state.hooked && changed.length) {
    const deliveries = Promise.all(changed.map((c) => emit(sql, ws, 'holder.status_changed', {
      investor_id: c.inv.id, investor_name: c.inv.name, ticker: c.ticker, fund_name: funds[c.ticker]?.name ?? c.ticker,
      from: c.prev?.status ?? null, to: c.status, reason: c.reason, run_id: summary.run_id, trigger, checked_at: new Date().toISOString(),
    }).catch((e) => console.error('holder.status_changed delivery failed', e))));
    if (opts.defer) opts.defer(deliveries); else await deliveries;
  }
  return summary;
}
