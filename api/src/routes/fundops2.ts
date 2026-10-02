// Closed-end fund operations: commitments, capital calls with per-investor notices, settlement of a call
// through the ordinary decision and settlement path, and distributions back to investors. Mounted by
// routes/fundops.ts under /v1. Open-ended funds keep dealing through POST /v1/decisions.
import { z } from 'zod';
import { router, need, body, bg, auditQ, audit, type C } from '../http';
import { emit } from '../ctx';
import { ApiError, id as newId, today } from '../util';
import { loadFundRow, type FundRow } from '../fundops-core';
import { createDecision, executeSettlement } from './core';

export const routes = router();

const ticker = (c: C) => c.req.param('ticker')!.toUpperCase();
const dateZ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD format.').refine((s) => !Number.isNaN(Date.parse(s + 'T00:00:00Z')), 'Not a real date.');
const r2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number, ccy: string) => `${ccy === 'EUR' ? '€' : '$'}${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

async function closedEndFund(c: C, t: string): Promise<FundRow & { fundType: string }> {
  const sql = c.get('sql'); const ws = c.get('ws');
  const f = await loadFundRow(sql, ws, t);
  const [row] = await sql`select fund_type from funds where workspace_id = ${ws} and ticker = ${t}`;
  const fundType = row?.fund_type ?? 'open_ended';
  if (fundType !== 'closed_end') throw new ApiError(409, 'not_closed_end', `${f.short} is an open-ended fund. Commitments and capital calls apply to closed-end funds only. Create the fund with fund_type "closed_end".`);
  return { ...f, fundType };
}

async function commitmentRows(c: C, t: string) {
  const sql = c.get('sql'); const ws = c.get('ws');
  return sql`select m.investor_id, i.name as investor, i.residence, m.committed::float8 as committed, m.called::float8 as called, m.distributed::float8 as distributed,
      (m.committed - m.called)::float8 as uncalled, m.committed_on::text as committed_on, m.updated_at,
      coalesce((select sum(n.amount) from call_notices n where n.workspace_id = m.workspace_id and n.ticker = m.ticker and n.investor_id = m.investor_id and n.status = 'settled'), 0)::float8 as paid_in,
      coalesce((select sum(n.amount) from call_notices n where n.workspace_id = m.workspace_id and n.ticker = m.ticker and n.investor_id = m.investor_id and n.status = 'issued'), 0)::float8 as outstanding
    from commitments m join investors i on i.workspace_id = m.workspace_id and i.id = m.investor_id
    where m.workspace_id = ${ws} and m.ticker = ${t} order by m.committed desc, i.name`;
}
const totalsOf = (rows: any[]) => ({
  committed: r2(rows.reduce((s, r) => s + Number(r.committed), 0)), called: r2(rows.reduce((s, r) => s + Number(r.called), 0)),
  paid_in: r2(rows.reduce((s, r) => s + Number(r.paid_in), 0)), outstanding: r2(rows.reduce((s, r) => s + Number(r.outstanding), 0)),
  distributed: r2(rows.reduce((s, r) => s + Number(r.distributed), 0)), uncalled: r2(rows.reduce((s, r) => s + Number(r.uncalled), 0)), investors: rows.length,
});

// ---------- Commitments ----------
/** Commitments to a fund. Works for every fund type so the app can decide what to show: open-ended funds return fund_type and no rows. */
routes.get('/funds/:ticker/commitments', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const t = ticker(c);
  const f = await loadFundRow(sql, ws, t);
  const [row] = await sql`select fund_type from funds where workspace_id = ${ws} and ticker = ${t}`;
  const fundType = row?.fund_type ?? 'open_ended';
  const rows = fundType === 'closed_end' ? await commitmentRows(c, t) : [];
  return c.json({ ticker: t, fund_type: fundType, currency: f.currency, totals: totalsOf(rows), data: rows });
});

routes.post('/funds/:ticker/commitments', async (c) => {
  const actor = need(c, 'funds:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const t = ticker(c);
  const b = await body(c, z.object({ investor_id: z.string().min(1), committed: z.number().positive().max(1e12), committed_on: dateZ.optional() }));
  const f = await closedEndFund(c, t);
  const [inv] = await sql`select id, name from investors where workspace_id = ${ws} and id = ${b.investor_id}`;
  if (!inv) throw new ApiError(404, 'not_found', `No client with id ${b.investor_id} in this organization.`);
  const [cur] = await sql`select committed::float8 as committed, called::float8 as called from commitments where workspace_id = ${ws} and investor_id = ${b.investor_id} and ticker = ${t}`;
  const committed = r2(b.committed);
  if (cur && committed < Number(cur.called)) throw new ApiError(422, 'below_called', `${inv.name} has already been called for ${fmt(Number(cur.called), f.currency)} of ${t}. A commitment cannot be reduced below the amount called.`);
  const on = b.committed_on ?? today();
  await sql.transaction([
    sql`insert into commitments (workspace_id, investor_id, ticker, committed, committed_on) values (${ws}, ${b.investor_id}, ${t}, ${committed}, ${on}::date)
      on conflict (workspace_id, investor_id, ticker) do update set committed = excluded.committed, committed_on = excluded.committed_on, updated_at = now()`,
    auditQ(sql, ws, actor, cur ? 'commitment.updated' : 'commitment.recorded', `${b.investor_id}:${t}`, { investor_id: b.investor_id, ticker: t, committed, previous: cur ? Number(cur.committed) : null, committed_on: on }),
  ]);
  const rows = await commitmentRows(c, t);
  const out = { ticker: t, investor_id: b.investor_id, investor: inv.name, committed, currency: f.currency, committed_on: on, replaced: !!cur, totals: totalsOf(rows),
    note: `${inv.name} ${cur ? 'now commits' : 'commits'} ${fmt(committed, f.currency)} to ${f.short}. Nothing moves until a capital call is issued; each call creates a notice per investor that settles through the usual decision and settlement path.` };
  bg(c, emit(sql, ws, cur ? 'commitment.updated' : 'commitment.recorded', { ticker: t, investor_id: b.investor_id, committed, previous: cur ? Number(cur.committed) : null }));
  return c.json(out, cur ? 200 : 201);
});

routes.delete('/funds/:ticker/commitments/:investorId', async (c) => {
  const actor = need(c, 'funds:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const t = ticker(c); const invId = c.req.param('investorId');
  const f = await loadFundRow(sql, ws, t);
  const [cur] = await sql`select committed::float8 as committed, called::float8 as called from commitments where workspace_id = ${ws} and investor_id = ${invId} and ticker = ${t}`;
  if (!cur) throw new ApiError(404, 'not_found', 'No commitment for that investor and fund.');
  if (Number(cur.called) > 0) throw new ApiError(409, 'already_called', `${fmt(Number(cur.called), f.currency)} has already been called against this commitment. Reduce it to the called amount instead of removing it.`);
  await sql.transaction([
    sql`delete from commitments where workspace_id = ${ws} and investor_id = ${invId} and ticker = ${t}`,
    auditQ(sql, ws, actor, 'commitment.removed', `${invId}:${t}`, { investor_id: invId, ticker: t, committed: Number(cur.committed) }),
  ]);
  return c.json({ ticker: t, investor_id: invId, removed: true });
});

// ---------- Capital calls ----------
async function callOut(c: C, callId: string) {
  const sql = c.get('sql'); const ws = c.get('ws');
  const [call] = await sql`select id, ticker, call_number, pct::float8 as pct, due_on::text as due_on, status, total_called::float8 as total_called, notice_sent_at, issued_by, settled_at, created_at
    from capital_calls where workspace_id = ${ws} and id = ${callId}`;
  if (!call) throw new ApiError(404, 'not_found', `No capital call ${callId} in this organization.`);
  const notices = await sql`select n.id, n.investor_id, i.name as investor, n.amount::float8 as amount, n.due_on::text as due_on, n.status, n.decision_id, n.settlement_id, n.error, n.sent_at, n.settled_at
    from call_notices n join investors i on i.workspace_id = n.workspace_id and i.id = n.investor_id where n.workspace_id = ${ws} and n.capital_call_id = ${callId} order by n.amount desc, i.name`;
  const by = (s: string) => notices.filter((n: any) => n.status === s);
  return {
    ...call, notices,
    summary: { notices: notices.length, issued: by('issued').length, settled: by('settled').length, failed: by('failed').length, cancelled: by('cancelled').length,
      paid_in: r2(by('settled').reduce((s: number, n: any) => s + Number(n.amount), 0)), outstanding: r2(by('issued').reduce((s: number, n: any) => s + Number(n.amount), 0)) },
  };
}

routes.get('/funds/:ticker/capital-calls', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const t = ticker(c);
  const f = await loadFundRow(sql, ws, t);
  const [row] = await sql`select fund_type from funds where workspace_id = ${ws} and ticker = ${t}`;
  const calls = await sql`select k.id, k.ticker, k.call_number, k.pct::float8 as pct, k.due_on::text as due_on, k.status, k.total_called::float8 as total_called, k.notice_sent_at, k.issued_by, k.settled_at, k.created_at,
      (select count(*)::int from call_notices n where n.workspace_id = k.workspace_id and n.capital_call_id = k.id) as notices,
      (select count(*)::int from call_notices n where n.workspace_id = k.workspace_id and n.capital_call_id = k.id and n.status = 'settled') as settled_notices,
      (select count(*)::int from call_notices n where n.workspace_id = k.workspace_id and n.capital_call_id = k.id and n.status = 'failed') as failed_notices,
      coalesce((select sum(n.amount) from call_notices n where n.workspace_id = k.workspace_id and n.capital_call_id = k.id and n.status = 'settled'), 0)::float8 as paid_in
    from capital_calls k where k.workspace_id = ${ws} and k.ticker = ${t} order by k.call_number desc`;
  const rows = row?.fund_type === 'closed_end' ? await commitmentRows(c, t) : [];
  const totals = totalsOf(rows);
  return c.json({ ticker: t, fund_type: row?.fund_type ?? 'open_ended', currency: f.currency, totals, data: calls,
    next_call_number: calls.length ? Number(calls[0].call_number) + 1 : 1,
    note: totals.committed ? `${fmt(totals.uncalled, f.currency)} of ${fmt(totals.committed, f.currency)} committed is still uncalled.` : 'No commitments recorded yet.' });
});

routes.post('/funds/:ticker/capital-calls', async (c) => {
  const actor = need(c, 'funds:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const t = ticker(c);
  const b = await body(c, z.object({ pct: z.number().gt(0).max(100), due_on: dateZ, memo: z.string().trim().max(300).optional() }));
  const f = await closedEndFund(c, t);
  if (b.due_on < today()) throw new ApiError(422, 'past_due_date', `The due date ${b.due_on} is in the past. Give investors a date on or after today.`);
  const rows = await commitmentRows(c, t);
  if (!rows.length) throw new ApiError(409, 'no_commitments', `No commitments recorded for ${t}. Record commitments before issuing a capital call.`);
  const [open] = await sql`select id, call_number from capital_calls where workspace_id = ${ws} and ticker = ${t} and status in ('issued', 'settling') limit 1`;
  if (open) throw new ApiError(409, 'call_open', `Capital call ${open.call_number} (${open.id}) is still open. Settle or cancel it before issuing another.`);
  const [{ n }] = await sql`select coalesce(max(call_number), 0)::int as n from capital_calls where workspace_id = ${ws} and ticker = ${t}`;
  const callNumber = Number(n) + 1;
  const callId = newId('call', 10);
  // Each investor is called pct of their total commitment, never beyond what is still uncalled.
  const lines = rows.map((r: any) => ({ investor_id: r.investor_id, investor: r.investor, amount: r2(Math.min(Number(r.committed) * b.pct / 100, Number(r.uncalled))) })).filter((l) => l.amount > 0);
  if (!lines.length) throw new ApiError(409, 'fully_called', `Every commitment to ${t} has been called in full. Record new commitments before issuing another call.`);
  const total = r2(lines.reduce((s, l) => s + l.amount, 0));
  const now = new Date().toISOString();
  await sql.transaction([
    sql`insert into capital_calls (workspace_id, id, ticker, call_number, pct, due_on, status, total_called, notice_sent_at, issued_by) values (${ws}, ${callId}, ${t}, ${callNumber}, ${b.pct}, ${b.due_on}::date, 'issued', ${total}, ${now}, ${actor.name})`,
    ...lines.map((l) => sql`insert into call_notices (workspace_id, id, capital_call_id, investor_id, ticker, amount, due_on, status, sent_at) values (${ws}, ${newId('cn', 10)}, ${callId}, ${l.investor_id}, ${t}, ${l.amount}, ${b.due_on}::date, 'issued', ${now})`),
    ...lines.map((l) => sql`update commitments set called = called + ${l.amount}, updated_at = now() where workspace_id = ${ws} and investor_id = ${l.investor_id} and ticker = ${t}`),
    auditQ(sql, ws, actor, 'capital_call.issued', callId, { ticker: t, call_number: callNumber, pct: b.pct, due_on: b.due_on, total, investors: lines.length, memo: b.memo ?? null }),
  ]);
  const out = await callOut(c, callId);
  bg(c, emit(sql, ws, 'capital_call.issued', { id: callId, ticker: t, call_number: callNumber, pct: b.pct, due_on: b.due_on, total_called: total, currency: f.currency, notices: out.notices.map((x: any) => ({ id: x.id, investor_id: x.investor_id, amount: x.amount })) }));
  return c.json({ ...out, currency: f.currency, note: `Call ${callNumber} issued: ${b.pct}% of commitments, ${fmt(total, f.currency)} across ${lines.length} investor${lines.length === 1 ? '' : 's'}, due ${b.due_on}. Notices are visible to each investor; settle them with POST /v1/capital-calls/${callId}/settle, which runs a decision and settlement per investor.` }, 201);
});

routes.get('/capital-calls/:id', async (c) => {
  need(c, 'read');
  return c.json(await callOut(c, c.req.param('id')));
});

routes.post('/capital-calls/:id/cancel', async (c) => {
  const actor = need(c, 'funds:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const callId = c.req.param('id');
  const call = await callOut(c, callId);
  if (call.status === 'settled' || call.status === 'cancelled') throw new ApiError(409, 'not_open', `This call is already ${call.status}.`);
  const open = call.notices.filter((n: any) => n.status === 'issued' || n.status === 'failed');
  await sql.transaction([
    sql`update call_notices set status = 'cancelled' where workspace_id = ${ws} and capital_call_id = ${callId} and status in ('issued', 'failed')`,
    ...open.map((n: any) => sql`update commitments set called = greatest(0, called - ${Number(n.amount)}), updated_at = now() where workspace_id = ${ws} and investor_id = ${n.investor_id} and ticker = ${call.ticker}`),
    sql`update capital_calls set status = case when exists (select 1 from call_notices n where n.workspace_id = ${ws} and n.capital_call_id = ${callId} and n.status = 'settled') then 'settled' else 'cancelled' end, settled_at = now() where workspace_id = ${ws} and id = ${callId}`,
    auditQ(sql, ws, actor, 'capital_call.cancelled', callId, { ticker: call.ticker, call_number: call.call_number, notices_cancelled: open.length, released: r2(open.reduce((s: number, n: any) => s + Number(n.amount), 0)) }),
  ]);
  bg(c, emit(sql, ws, 'capital_call.cancelled', { id: callId, ticker: call.ticker, notices_cancelled: open.length }));
  return c.json({ ...(await callOut(c, callId)), note: `${open.length} unpaid notice${open.length === 1 ? '' : 's'} cancelled and the called amounts released back to the commitments. Notices already settled stay settled.` });
});

/**
 * Settles the notices of a capital call: for each investor a subscribe decision for the called amount, then settlement,
 * both through the same code as POST /v1/decisions and POST /v1/settlements. Runs notices sequentially in one chunk
 * per request (default 10) so a large call is settled over several calls; the response says how many remain.
 */
routes.post('/capital-calls/:id/settle', async (c) => {
  const actor = need(c, 'orders:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const callId = c.req.param('id');
  const b = await body(c, z.object({ settle_with: z.string().min(1).max(20).optional(), limit: z.number().int().min(1).max(50).default(10), investor_ids: z.array(z.string()).max(50).optional(), retry_failed: z.boolean().default(false) }));
  const call = await callOut(c, callId);
  if (call.status === 'cancelled' || call.status === 'settled') throw new ApiError(409, 'not_open', `Capital call ${call.call_number} is ${call.status}. Nothing to settle.`);
  const f = await loadFundRow(sql, ws, call.ticker);
  const [fund] = await sql`select assets from funds where workspace_id = ${ws} and ticker = ${call.ticker}`;
  const asset = b.settle_with ?? (fund?.assets?.[0] as string | undefined) ?? (f.currency === 'EUR' ? 'EURC' : 'USDC');
  const pending = call.notices.filter((n: any) => (n.status === 'issued' || (b.retry_failed && n.status === 'failed')) && (!b.investor_ids || b.investor_ids.includes(n.investor_id)));
  if (!pending.length) throw new ApiError(409, 'nothing_pending', `No ${b.retry_failed ? 'issued or failed' : 'issued'} notices left on this call${b.investor_ids ? ' for the investors named' : ''}.`);
  if (call.status === 'issued') await sql`update capital_calls set status = 'settling' where workspace_id = ${ws} and id = ${callId} and status = 'issued'`;
  const chunk = pending.slice(0, b.limit);
  const results: Record<string, unknown>[] = [];
  for (const n of chunk) {
    let decisionId: string | null = null;
    try {
      const d = await createDecision(c, { action: 'subscribe', investor_id: n.investor_id, fund: call.ticker, amount: Number(n.amount), settle_with: asset, capital_call_id: callId, persist: true });
      decisionId = d.id ?? null;
      if (d.outcome !== 'ALLOW') {
        const fail = (d.checks as any[]).find((x) => x.result === 'fail');
        const why = `${d.outcome}: ${fail ? `${fail.label}. ${fail.detail}` : d.headline}`.slice(0, 600);
        await sql`update call_notices set status = 'failed', decision_id = ${decisionId}, error = ${why} where workspace_id = ${ws} and id = ${n.id}`;
        results.push({ notice_id: n.id, investor_id: n.investor_id, investor: n.investor, amount: n.amount, status: 'failed', decision_id: decisionId, outcome: d.outcome, error: why, remedies: d.remedies });
        continue;
      }
      const dec = { id: d.id, action: 'subscribe', investor_id: n.investor_id, counterparty_id: null, ticker: call.ticker, amount: Number(n.amount), asset, outcome: d.outcome, what_ifs: [], units: d.units, inputs_sha256: d.inputs_sha256, created_at: (d as any).created_at ?? new Date().toISOString(), capital_call_id: callId };
      const s = await executeSettlement(c, dec);
      const stl = s.settlement as { id: string; status: string };
      await sql`update call_notices set status = 'settled', decision_id = ${decisionId}, settlement_id = ${stl.id}, error = null, settled_at = now() where workspace_id = ${ws} and id = ${n.id}`;
      results.push({ notice_id: n.id, investor_id: n.investor_id, investor: n.investor, amount: n.amount, status: 'settled', decision_id: decisionId, settlement_id: stl.id, settlement_status: stl.status, http_status: s.httpStatus });
    } catch (e: any) {
      const why = String(e instanceof ApiError ? `${e.code}: ${e.message}` : e?.message ?? e).slice(0, 600);
      await sql`update call_notices set status = 'failed', decision_id = ${decisionId}, error = ${why} where workspace_id = ${ws} and id = ${n.id}`.catch(() => {});
      results.push({ notice_id: n.id, investor_id: n.investor_id, investor: n.investor, amount: n.amount, status: 'failed', decision_id: decisionId, error: why });
    }
  }
  const after = await callOut(c, callId);
  const remaining = after.notices.filter((n: any) => n.status === 'issued').length;
  if (!remaining) {
    await sql`update capital_calls set status = 'settled', settled_at = now() where workspace_id = ${ws} and id = ${callId} and status = 'settling'`;
  }
  const settled = results.filter((r) => r.status === 'settled').length;
  await audit(sql, ws, actor, 'capital_call.settlement_run', callId, { ticker: call.ticker, call_number: call.call_number, processed: results.length, settled, failed: results.length - settled, remaining, asset });
  const final = await callOut(c, callId);
  if (!remaining) bg(c, emit(sql, ws, 'capital_call.settled', { id: callId, ticker: call.ticker, call_number: call.call_number, paid_in: final.summary.paid_in, failed: final.summary.failed }));
  return c.json({ ...final, currency: f.currency, run: { processed: results.length, settled, failed: results.length - settled, remaining, asset, results },
    note: remaining ? `${settled} of ${results.length} notices settled in this run. ${remaining} still to go: call this endpoint again to continue.` : `Call ${call.call_number} is ${final.summary.failed ? `settled with ${final.summary.failed} failed notice${final.summary.failed === 1 ? '' : 's'}. Fix the refusals and retry with retry_failed: true.` : 'fully settled.'}` });
});

// ---------- Distributions back to investors (return of capital or income), pro rata to paid-in capital ----------
routes.post('/funds/:ticker/capital-distributions', async (c) => {
  const actor = need(c, 'funds:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const t = ticker(c);
  const b = await body(c, z.object({ amount: z.number().positive().max(1e12), kind: z.enum(['return_of_capital', 'income']).default('return_of_capital'), paid_on: dateZ.optional(), memo: z.string().trim().max(300).optional() }));
  const f = await closedEndFund(c, t);
  const rows = await commitmentRows(c, t);
  const base = rows.filter((r: any) => Number(r.paid_in) > 0);
  const paidTotal = r2(base.reduce((s: number, r: any) => s + Number(r.paid_in), 0));
  if (!paidTotal) throw new ApiError(409, 'nothing_paid_in', `No capital has been paid in to ${t} yet, so there is nothing to distribute against.`);
  if (b.kind === 'return_of_capital') {
    const already = r2(rows.reduce((s: number, r: any) => s + Number(r.distributed), 0));
    if (b.amount + already > paidTotal + 0.01) throw new ApiError(422, 'exceeds_paid_in', `${fmt(b.amount, f.currency)} plus ${fmt(already, f.currency)} already returned exceeds the ${fmt(paidTotal, f.currency)} paid in. Return at most ${fmt(r2(paidTotal - already), f.currency)}, or record the excess as income.`);
  }
  const paidOn = b.paid_on ?? today();
  const lines = base.map((r: any) => ({ investor_id: r.investor_id, investor: r.investor, paid_in: Number(r.paid_in), amount: r2(b.amount * Number(r.paid_in) / paidTotal) }));
  const total = r2(lines.reduce((s, l) => s + l.amount, 0));
  const dstId = newId('dst', 12);
  await sql.transaction([
    sql`insert into distributions (workspace_id, id, ticker, period_start, period_end, paid_on, total_amount, reinvested_units, holders, kind) values (${ws}, ${dstId}, ${t}, ${paidOn}::date, ${paidOn}::date, ${paidOn}::date, ${total}, 0, ${lines.length}, ${b.kind})`,
    ...(b.kind === 'return_of_capital' ? lines.map((l) => sql`update commitments set distributed = distributed + ${l.amount}, updated_at = now() where workspace_id = ${ws} and investor_id = ${l.investor_id} and ticker = ${t}`) : []),
    auditQ(sql, ws, actor, 'capital_distribution.paid', dstId, { ticker: t, kind: b.kind, paid_on: paidOn, total, investors: lines.length, memo: b.memo ?? null, lines }),
  ]);
  const out = { id: dstId, ticker: t, kind: b.kind, paid_on: paidOn, currency: f.currency, total_amount: total, basis: 'Pro rata to capital paid in', investors: lines.length, lines,
    note: `${fmt(total, f.currency)} ${b.kind === 'return_of_capital' ? 'returned to' : 'of income paid to'} ${lines.length} investor${lines.length === 1 ? '' : 's'} in proportion to the ${fmt(paidTotal, f.currency)} they paid in. Cash moves outside Laissez; this is the register entry.` };
  bg(c, emit(sql, ws, 'capital_distribution.paid', out));
  return c.json(out, 201);
});

routes.get('/funds/:ticker/capital-distributions', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const t = ticker(c);
  const f = await loadFundRow(sql, ws, t);
  const rows = await sql`select id, kind, paid_on::text as paid_on, total_amount::float8 as total_amount, holders as investors, created_at from distributions where workspace_id = ${ws} and ticker = ${t} and kind in ('return_of_capital', 'income') and period_start = period_end order by paid_on desc, created_at desc limit 100`;
  return c.json({ ticker: t, currency: f.currency, data: rows });
});
