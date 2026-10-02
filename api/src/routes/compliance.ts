// Compliance operations: sanctions lists and screening, screening-hit dispositions, the work queue,
// continuous monitoring, the regulatory feed and the rule-drafting agent with human approval.
import { z } from 'zod';
import type { Sql } from '../db';
import { router, need, audit, auditQ, body, bg } from '../http';
import { ApiError, id, rateLimit } from '../util';
import { normName, MATCH_THRESHOLD } from '../sanctions';
import { runMonitor } from '../monitor';
import { regressionFor, thresholdWarnings } from './compliance2';

export const routes = router();

/** Candidates at or above this similarity are shown as near misses; at or above MATCH_THRESHOLD they hold an order. */
const NEAR_MISS = 0.5;
/** A daily list is stale once its last good load is older than this. */
const STALE_HOURS = 36;
/** Guardrail: a relevant regulator publication should reach an approved rule-pack change within this many business days. */
const RULE_LAG_BUSINESS_DAYS = 5;

const DECISION_LABEL: Record<string, string> = { open: 'open', needs_information: 'waiting for information', false_positive: 'a false positive', confirmed: 'a confirmed match' };
const statusParam = (v: string | undefined, allowed: string[], fallback: string) => {
  const s = v ?? fallback;
  if (!allowed.includes(s)) throw new ApiError(400, 'invalid_status', `Status must be one of ${allowed.join(', ')}. You sent "${s}".`);
  return s;
};

// ---------------------------------------------------------------------------
// Sanctions lists and ad hoc screening
// ---------------------------------------------------------------------------

routes.get('/sanctions/sources', async (c) => {
  need(c, 'read');
  const rows = await c.get('sql')`
    select source, name, url, status, error, entries, last_fetched_at, last_published,
      (extract(epoch from now() - last_fetched_at) / 3600)::float8 as age_hours
    from sanctions_sources order by (source = 'LAISSEZ-TEST'), source`;
  const data = rows.map((r: any) => {
    const isStatic = r.source === 'LAISSEZ-TEST';
    const age = r.age_hours == null ? null : Math.round(Number(r.age_hours) * 10) / 10;
    return { ...r, age_hours: age, static: isStatic, fresh: isStatic ? r.status === 'active' : r.status === 'active' && age !== null && age <= STALE_HOURS };
  });
  return c.json({
    data,
    total_entries: data.reduce((n: number, r: any) => n + Number(r.entries ?? 0), 0),
    matching: { method: 'trigram similarity', threshold: MATCH_THRESHOLD, near_miss_floor: NEAR_MISS, stale_after_hours: STALE_HOURS, refresh: 'Daily at 05:20 UTC' },
  });
});

routes.post('/screening', async (c) => {
  const actor = need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const { name } = await body(c, z.object({ name: z.string().trim().min(2).max(200) }));
  const norm = normName(name);
  if (norm.length < 2) throw new ApiError(422, 'invalid_name', 'That name has no letters or digits left after removing company suffixes such as Ltd or LLC. Enter the full legal name.');
  const rows = await sql`
    select x.*, h.status as prior_decision, h.id as prior_hit_id from (
      select distinct on (e.source, e.source_uid) e.source, e.source_uid, e.name, e.primary_name, e.programs, e.entry_type, e.country, e.listed_on, e.is_alias,
        similarity(e.name_norm, ${norm})::float8 as score
      from sanctions_entries e
      where e.name_norm % ${norm} and similarity(e.name_norm, ${norm}) >= ${NEAR_MISS}
      order by e.source, e.source_uid, similarity(e.name_norm, ${norm}) desc
    ) x
    left join screening_hits h on h.workspace_id = ${ws} and h.screened_name = ${name} and h.source = x.source and h.source_uid = x.source_uid
    order by x.score desc limit 5`;
  const candidates = rows.map((r: any) => {
    const score = Math.round(Number(r.score) * 100) / 100;
    return {
      source: r.source, source_uid: r.source_uid, matched_name: r.name, primary_name: r.primary_name, is_alias: r.is_alias,
      programs: r.programs, entry_type: r.entry_type, country: r.country, listed_on: r.listed_on, score,
      would_hold: score >= MATCH_THRESHOLD && r.prior_decision !== 'false_positive',
      prior_decision: r.prior_decision ?? null, prior_hit_id: r.prior_hit_id ?? null,
    };
  });
  const result = candidates.some((x) => x.would_hold) ? 'potential_match' : candidates.length ? 'near_miss' : 'clear';
  const top = candidates[0];
  await audit(sql, ws, actor, 'screening.checked', null, { name, result, top: top ? { source: top.source, source_uid: top.source_uid, name: top.matched_name, score: top.score } : null });
  const hold = candidates.find((x) => x.would_hold);
  return c.json({
    name, normalized: norm, result, threshold: MATCH_THRESHOLD, near_miss_floor: NEAR_MISS, candidates,
    // Earlier clients read a single match.
    match: hold ? { entry: hold.matched_name, program: `${hold.source}${hold.programs ? `: ${hold.programs}` : ''}`, score: hold.score } : null,
  });
});

/** The fictional demo entries, for the sandbox screening page. */
routes.get('/screening-list', async (c) => {
  need(c, 'read');
  const rows = await c.get('sql')`select name, coalesce(programs, '') as program, 'Fictional entry for demos. Not a real designation.' as note
    from sanctions_entries where source = 'LAISSEZ-TEST' order by name`;
  return c.json({ data: rows });
});

// ---------------------------------------------------------------------------
// Screening hits
// ---------------------------------------------------------------------------

routes.get('/screening-hits', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const status = statusParam(c.req.query('status'), ['open', 'needs_information', 'false_positive', 'confirmed', 'all'], 'open');
  const [rows, counts] = await Promise.all([
    sql`select h.*, i.name as investor_name, i.short_name as investor_short,
          (select count(*)::int from hit_notes n where n.workspace_id = h.workspace_id and n.hit_id = h.id) as notes
        from screening_hits h
        left join investors i on i.workspace_id = h.workspace_id and i.id = h.investor_id
        where h.workspace_id = ${ws} and (${status} = 'all' or h.status = ${status})
        order by h.created_at desc limit 200`,
    sql`select status, count(*)::int as n from screening_hits where workspace_id = ${ws} group by status`,
  ]);
  return c.json({ data: rows, counts: Object.fromEntries(counts.map((r: any) => [r.status, r.n])), threshold: MATCH_THRESHOLD });
});

/** One hit with everything a reviewer compares: every listed name under the same source entry and the client record. */
routes.get('/screening-hits/:id', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const hitId = c.req.param('id');
  const [hit] = await sql`select h.*, i.name as investor_name from screening_hits h
    left join investors i on i.workspace_id = h.workspace_id and i.id = h.investor_id where h.workspace_id = ${ws} and h.id = ${hitId}`;
  if (!hit) throw new ApiError(404, 'not_found', 'No screening hit with that id in this organization. Reload the list and try again.');
  const [entries, notes, investor, holdings, otherHits] = await Promise.all([
    sql`select e.name, e.primary_name, e.is_alias, e.programs, e.entry_type, e.country, e.listed_on, similarity(e.name_norm, ${normName(hit.screened_name)})::float8 as score
        from sanctions_entries e where e.source = ${hit.source} and e.source_uid = ${hit.source_uid} order by e.is_alias, score desc, e.name limit 100`,
    sql`select id, author, status, note, created_at from hit_notes where workspace_id = ${ws} and hit_id = ${hitId} order by created_at`,
    hit.investor_id
      ? sql`select i.id, i.name, i.short_name, i.kind, i.residence, i.city, i.booking_center, i.us_person, i.email, i.created_at, j.name as residence_name,
            cr.id as credential_id, cr.issued_on::text as credential_issued_on, cr.expires_on::text as credential_expires_on, cr.issuer_name
          from investors i left join jurisdictions j on j.code = i.residence
          left join lateral (select id, issued_on, expires_on, issuer_name from credentials where workspace_id = i.workspace_id and investor_id = i.id and status = 'active' order by created_at desc limit 1) cr on true
          where i.workspace_id = ${ws} and i.id = ${hit.investor_id}`
      : Promise.resolve([]),
    hit.investor_id ? sql`select h.ticker, h.units::float8 as units, h.since::text as since, f.short_name as fund from holdings h join funds f on f.workspace_id = h.workspace_id and f.ticker = h.ticker where h.workspace_id = ${ws} and h.investor_id = ${hit.investor_id} and h.units > 0 order by h.ticker` : Promise.resolve([]),
    sql`select id, source, source_uid, matched_name, score, status, created_at from screening_hits where workspace_id = ${ws} and screened_name = ${hit.screened_name} and id <> ${hitId} order by created_at desc limit 20`,
  ]);
  const first = entries[0] ?? {};
  return c.json({
    ...hit,
    entry: {
      source: hit.source, source_uid: hit.source_uid, primary_name: first.primary_name ?? hit.primary_name, programs: first.programs ?? hit.programs,
      entry_type: first.entry_type ?? null, country: first.country ?? null, listed_on: first.listed_on ?? null,
      names: entries.map((e: any) => ({ name: e.name, is_alias: e.is_alias, score: Math.round(Number(e.score) * 100) / 100 })),
    },
    investor: investor[0] ?? null, holdings, notes, other_hits: otherHits, threshold: MATCH_THRESHOLD,
    decisions: ['needs_information', 'false_positive', 'confirmed'],
  });
});

routes.post('/screening-hits/:id/notes', async (c) => {
  const actor = need(c, 'compliance:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const hitId = c.req.param('id');
  const { note } = await body(c, z.object({ note: z.string().trim().min(1).max(2000) }));
  const [hit] = await sql`select id, status from screening_hits where workspace_id = ${ws} and id = ${hitId}`;
  if (!hit) throw new ApiError(404, 'not_found', 'No screening hit with that id in this organization.');
  const noteId = id('hn', 10);
  await sql.transaction([
    sql`insert into hit_notes (workspace_id, id, hit_id, author, status, note) values (${ws}, ${noteId}, ${hitId}, ${actor.name}, ${null}, ${note})`,
    auditQ(sql, ws, actor, 'screening_hit.noted', hitId, { note }),
  ]);
  return c.json({ id: noteId, hit_id: hitId, author: actor.name, note, created_at: new Date().toISOString() }, 201);
});

routes.post('/screening-hits/:id/decide', async (c) => {
  const actor = need(c, 'compliance:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const hitId = c.req.param('id');
  const b = await body(c, z.object({ status: z.enum(['needs_information', 'false_positive', 'confirmed']), note: z.string().trim().max(1000).optional() }));
  // needs_information keeps the hit open for review (the holder stays held) and records what is missing.
  const [row] = await sql`update screening_hits set status = ${b.status}, decided_by = ${actor.name}, decided_at = now(), note = ${b.note || null}
    where workspace_id = ${ws} and id = ${hitId} and status in ('open', 'needs_information') returning *`;
  if (!row) {
    const [ex] = await sql`select status, decided_by from screening_hits where workspace_id = ${ws} and id = ${hitId}`;
    if (!ex) throw new ApiError(404, 'not_found', 'No screening hit with that id in this organization. Reload the list and try again.');
    throw new ApiError(409, 'already_decided', `This hit was already marked ${DECISION_LABEL[ex.status] ?? ex.status} by ${ex.decided_by ?? 'another reviewer'}. Decisions are kept for the audit trail; screen the name again if the facts changed.`);
  }
  const queries: any[] = [auditQ(sql, ws, actor, 'screening_hit.decided', hitId, {
    status: b.status, note: b.note || null, screened_name: row.screened_name, matched_name: row.matched_name, source: row.source, source_uid: row.source_uid, score: row.score,
  })];
  if (b.note || b.status === 'needs_information') {
    queries.push(sql`insert into hit_notes (workspace_id, id, hit_id, author, status, note) values (${ws}, ${id('hn', 10)}, ${hitId}, ${actor.name}, ${b.status}, ${b.note || (b.status === 'needs_information' ? 'More information requested before a decision.' : '')})`);
  }
  await sql.transaction(queries);
  if (b.status === 'needs_information') return c.json({ ...row, monitoring: 'not_needed' });
  bg(c, runMonitor(sql, ws, 'screening_decision', { admin: c.get('admin'), requestedBy: actor.name }));
  return c.json({ ...row, monitoring: 'queued' });
});

// ---------------------------------------------------------------------------
// Work queue
// ---------------------------------------------------------------------------

routes.get('/work-items', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const status = statusParam(c.req.query('status'), ['open', 'done', 'dismissed', 'all'], 'open');
  const [rows, counts] = await Promise.all([
    sql`select w.id, w.kind, w.title, w.detail, w.severity, w.investor_id, w.ticker, w.link, w.status, w.due_on::text as due_on,
          w.created_at, w.resolved_at, w.resolved_by, i.name as investor_name
        from work_items w left join investors i on i.workspace_id = w.workspace_id and i.id = w.investor_id
        where w.workspace_id = ${ws} and (${status} = 'all' or w.status = ${status})
        order by (w.status <> 'open'), case w.severity when 'high' then 0 when 'medium' then 1 else 2 end,
          case when w.status = 'open' then w.created_at end asc, w.resolved_at desc nulls last
        limit 500`,
    sql`select severity, count(*)::int as n from work_items where workspace_id = ${ws} and status = 'open' group by severity`,
  ]);
  return c.json({ data: rows, open_counts: Object.fromEntries(counts.map((r: any) => [r.severity, r.n])) });
});

routes.post('/work-items/:id/resolve', async (c) => {
  const actor = need(c, 'work:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const itemId = c.req.param('id');
  const b = await body(c, z.object({ status: z.enum(['done', 'dismissed']), note: z.string().trim().max(1000).optional() }));
  const [row] = await sql`update work_items set status = ${b.status}, resolved_at = now(), resolved_by = ${actor.name}
    where workspace_id = ${ws} and id = ${itemId} and status = 'open' returning id, kind, title, status, resolved_at, resolved_by`;
  if (!row) {
    const [ex] = await sql`select status, resolved_by from work_items where workspace_id = ${ws} and id = ${itemId}`;
    if (!ex) throw new ApiError(404, 'not_found', 'No work item with that id in this organization. Reload the queue and try again.');
    throw new ApiError(409, 'already_resolved', `This item was already marked ${ex.status} by ${ex.resolved_by ?? 'someone else'}. Reload the queue to see its current state.`);
  }
  await audit(sql, ws, actor, 'work_item.resolved', itemId, { status: b.status, note: b.note || null, kind: row.kind, title: row.title });
  return c.json(row);
});

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

routes.post('/monitoring/run', async (c) => {
  const actor = need(c, 'compliance:write');
  const summary = await runMonitor(c.get('sql'), c.get('ws'), 'manual', { admin: c.get('admin'), defer: (p) => bg(c, p), requestedBy: actor.name });
  return c.json(summary);
});

routes.get('/monitoring', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const [runs, statuses] = await Promise.all([
    sql`select id, trigger, started_at, finished_at, holders_checked, changes, items_opened, items_closed,
          (extract(epoch from finished_at - started_at) * 1000)::int as duration_ms
        from monitor_runs where workspace_id = ${ws} order by started_at desc limit 20`,
    sql`select s.investor_id, s.ticker, s.status, s.reason, s.updated_at, i.name as investor_name, i.short_name as investor_short, f.name as fund_name
        from holder_status s
        left join investors i on i.workspace_id = s.workspace_id and i.id = s.investor_id
        left join funds f on f.workspace_id = s.workspace_id and f.ticker = s.ticker
        where s.workspace_id = ${ws}
        order by case s.status when 'frozen' then 0 when 'redemption-only' then 1 else 2 end, i.name, s.ticker`,
  ]);
  const counts: Record<string, number> = { eligible: 0, 'redemption-only': 0, frozen: 0 };
  for (const s of statuses) counts[s.status] = (counts[s.status] ?? 0) + 1;
  return c.json({ runs: runs.map((r: any) => ({ ...r, id: Number(r.id) })), holders: statuses, counts, last_run: runs[0] ? { ...runs[0], id: Number(runs[0].id) } : null });
});

/** One run in detail: every status change and every work item it opened or closed. */
routes.get('/monitoring/runs/:id', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const runId = Number(c.req.param('id'));
  if (!Number.isInteger(runId) || runId <= 0) throw new ApiError(404, 'not_found', 'No monitoring run with that id in this organization.');
  const [[run], items, [aud]] = await Promise.all([
    sql`select id, trigger, started_at, finished_at, holders_checked, changes, items_opened, items_closed,
          (extract(epoch from finished_at - started_at) * 1000)::int as duration_ms
        from monitor_runs where workspace_id = ${ws} and id = ${runId}`,
    sql`select r.id, r.kind, r.investor_id, r.ticker, r.from_status, r.to_status, r.work_item_id, r.created_at,
          i.name as investor_name, f.short_name as fund_name, w.title as work_item_title, w.kind as work_item_kind, w.severity, w.status as work_item_status, w.link
        from monitor_run_items r
        left join investors i on i.workspace_id = r.workspace_id and i.id = r.investor_id
        left join funds f on f.workspace_id = r.workspace_id and f.ticker = r.ticker
        left join work_items w on w.workspace_id = r.workspace_id and w.id = r.work_item_id
        where r.workspace_id = ${ws} and r.run_id = ${runId}
        order by case r.kind when 'status_change' then 0 when 'item_opened' then 1 else 2 end, r.id`,
    sql`select data from audit_events where workspace_id = ${ws} and type = 'monitoring.completed' and subject = ${String(runId)} order by seq desc limit 1`,
  ]);
  if (!run) throw new ApiError(404, 'not_found', 'No monitoring run with that id in this organization.');
  const data = aud?.data ?? {};
  return c.json({
    ...run, id: Number(run.id), statuses: data.statuses ?? null, new_screening_hits: data.new_screening_hits ?? null, requested_by: data.requested_by ?? null,
    status_changes: items.filter((x: any) => x.kind === 'status_change'),
    opened: items.filter((x: any) => x.kind === 'item_opened'),
    closed: items.filter((x: any) => x.kind === 'item_closed'),
    note: run.items_opened + run.items_closed + run.changes > 0 || items.length ? null : 'Nothing changed in this run. Run detail is recorded for runs after migration 009.',
  });
});

// ---------------------------------------------------------------------------
// Regulatory feed and rule drafting
// ---------------------------------------------------------------------------

/** Ask the drafting agent for a structured rule-pack change. Throws ApiError when the agent fails or answers in a shape we cannot read. */
async function draftRule(apiKey: string, sql: Sql, src: { text: string; url?: string | null }) {
  const classes = await sql`select code, jurisdiction, label, rule_ref, threshold from investor_classes order by code`;
  const prompt = `You maintain machine-readable investor-eligibility rule packs for a compliance product. Current classes:\n${JSON.stringify(classes)}\n\nRead the regulator text below and draft a rule-pack change. Respond with JSON only, shaped as {"jurisdiction": string, "source_status": "final" | "proposal" | "guidance", "summary": string, "effective_date": string | null, "changes": [{"class_code": string, "field": string, "from": string | null, "to": string, "citation": string}], "open_questions": string[]}. Quote section numbers in citations. If the text is a proposal or consultation, say so in source_status. If the text does not change any investor-eligibility rule, return an empty changes array and say why in summary. Do not invent figures that are not in the text.\n\nSource${src.url ? ` (${src.url})` : ''}:\n"""${src.text}"""`;
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    });
  } catch {
    throw new ApiError(502, 'agent_failed', 'The drafting agent could not be reached. Nothing was saved; try again in a minute.');
  }
  if (!res.ok) throw new ApiError(502, 'agent_failed', `The drafting agent returned an error (${res.status}). Nothing was saved; try again in a minute.`);
  const msg: any = await res.json();
  const text: string = (msg.content ?? []).map((p: any) => p.text ?? '').join('');
  try {
    const draft = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (!draft || typeof draft !== 'object') throw new Error('not an object');
    return draft;
  } catch {
    throw new ApiError(502, 'agent_unparseable', 'The draft could not be read as structured data. Nothing was saved; try again.');
  }
}

async function draftAllowance(c: any, ws: string) {
  // rate_limits is not granted to the tenant role, so the counter uses the owner connection.
  if (!(await rateLimit(c.get('admin'), `draft:${ws}`, 10, 3600))) throw new ApiError(429, 'rate_limited', 'This organization has used its ten drafts for this hour. Try again later.');
}

const notConfigured = () => new ApiError(501, 'not_configured', 'The rule-drafting agent is not configured. An administrator needs to set the ANTHROPIC_API_KEY secret on the API worker; drafting works as soon as it is set.');

routes.get('/reg-publications', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const rq = c.req.query('relevant');
  const relevant = rq === undefined || rq === '' ? null : rq === 'true';
  const regulator = c.req.query('regulator') || null;
  const [rows, meta] = await Promise.all([
    sql`select p.id, p.regulator, p.jurisdiction, p.title, p.url, p.published_at, p.summary, p.relevant, p.topics, p.fetched_at,
          (p.body_excerpt is not null) as has_excerpt, d.id as draft_id, d.status as draft_status
        from reg_publications p
        left join lateral (select r.id, r.status from rule_drafts r where r.workspace_id = ${ws} and r.publication_id = p.id
          order by (r.status = 'approved') desc, r.created_at desc limit 1) d on true
        where (${relevant}::boolean is null or p.relevant = ${relevant}::boolean) and (${regulator}::text is null or p.regulator = ${regulator}::text)
        order by coalesce(p.published_at, p.fetched_at) desc limit 100`,
    sql`select max(fetched_at) as newest_fetched_at, count(*)::int as total, count(*) filter (where relevant)::int as relevant from reg_publications`,
  ]);
  const enabled = !!c.env.ANTHROPIC_API_KEY;
  return c.json({ data: rows, ...meta[0], agent_enabled: enabled, agent_note: enabled ? null : 'Drafting is off until an administrator sets the ANTHROPIC_API_KEY secret on the API worker.' });
});

routes.post('/reg-publications/:id/draft', async (c) => {
  const actor = need(c, 'compliance:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const pubId = c.req.param('id');
  if (!c.env.ANTHROPIC_API_KEY) throw notConfigured();
  const [pub] = await sql`select id, regulator, jurisdiction, title, url, summary, body_excerpt from reg_publications where id = ${pubId}`;
  if (!pub) throw new ApiError(404, 'not_found', 'No regulator publication with that id. Reload the feed and try again.');
  const [pending] = await sql`select id from rule_drafts where workspace_id = ${ws} and publication_id = ${pubId} and status = 'draft' limit 1`;
  if (pending) throw new ApiError(409, 'draft_exists', `Draft ${pending.id} for this publication is already waiting for review. Approve or reject it before drafting again.`);
  const source = pub.body_excerpt || pub.summary || '';
  if (source.length < 40) throw new ApiError(422, 'no_text', 'Laissez has not read the text of this publication yet. The feed job fetches it every six hours; try again after the next run, or paste the text into a new draft.');
  await draftAllowance(c, ws);
  const draft = await draftRule(c.env.ANTHROPIC_API_KEY, sql, { text: `${pub.regulator}: ${pub.title}\n\n${source}`, url: pub.url });
  const dId = id('rd', 10);
  await sql`insert into rule_drafts (workspace_id, id, source, jurisdiction, draft, publication_id)
    values (${ws}, ${dId}, ${pub.url}, ${draft.jurisdiction ?? pub.jurisdiction ?? null}, ${JSON.stringify(draft)}, ${pubId})`;
  await audit(sql, ws, actor, 'rule_draft.created', dId, { jurisdiction: draft.jurisdiction ?? pub.jurisdiction ?? null, status: draft.source_status ?? null, publication_id: pubId, regulator: pub.regulator });
  return c.json({ id: dId, status: 'draft', publication_id: pubId, draft }, 201);
});

routes.post('/rule-drafts', async (c) => {
  const actor = need(c, 'compliance:write');
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = await body(c, z.object({ source_text: z.string().min(40).max(20_000), source_url: z.string().url().optional(), jurisdiction: z.string().max(10).optional() }));
  if (!c.env.ANTHROPIC_API_KEY) throw notConfigured();
  await draftAllowance(c, ws);
  const draft = await draftRule(c.env.ANTHROPIC_API_KEY, sql, { text: b.source_text, url: b.source_url });
  const dId = id('rd', 10);
  await sql`insert into rule_drafts (workspace_id, id, source, jurisdiction, draft) values (${ws}, ${dId}, ${b.source_url ?? 'pasted text'}, ${draft.jurisdiction ?? b.jurisdiction ?? null}, ${JSON.stringify(draft)})`;
  await audit(sql, ws, actor, 'rule_draft.created', dId, { jurisdiction: draft.jurisdiction ?? b.jurisdiction ?? null, status: draft.source_status ?? null });
  return c.json({ id: dId, status: 'draft', draft }, 201);
});

routes.get('/rule-drafts', async (c) => {
  need(c, 'read');
  const rows = await c.get('sql')`select d.*, p.title as publication_title, p.regulator as publication_regulator from rule_drafts d
    left join reg_publications p on p.id = d.publication_id where d.workspace_id = ${c.get('ws')} order by d.created_at desc`;
  return c.json({ data: rows, agent_enabled: !!c.env.ANTHROPIC_API_KEY });
});

routes.post('/rule-drafts/:id/:decision{approve|reject}', async (c) => {
  const actor = need(c, 'compliance:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const draftId = c.req.param('id');
  const approve = c.req.param('decision') === 'approve';
  if (approve && actor.kind !== 'user') throw new ApiError(403, 'human_required', 'Only a signed-in person can approve a rule draft. API keys can create and reject drafts, not approve them.');
  const b = await body(c, z.object({ note: z.string().trim().max(1000).optional(), force: z.boolean().default(false) }));
  const status = approve ? 'approved' : 'rejected';
  // Approval runs the golden regression cases of the draft's jurisdiction through the engine and stores the result
  // with the draft. A failing suite blocks approval unless the reviewer sends force: true (recorded in the audit log).
  let regression: ReturnType<typeof regressionFor> | null = null;
  let warnings: string[] = [];
  if (approve) {
    const [d] = await sql`select jurisdiction, draft, status from rule_drafts where workspace_id = ${ws} and id = ${draftId}`;
    if (!d) throw new ApiError(404, 'not_found', 'No rule draft with that id in this organization. Reload the drafts and try again.');
    if (d.status === 'draft') {
      regression = regressionFor(d.jurisdiction ?? d.draft?.jurisdiction ?? null);
      warnings = thresholdWarnings(d.draft);
      if (regression.failed > 0 && !b.force) {
        await sql`update rule_drafts set regression = ${JSON.stringify(regression)}, warnings = ${JSON.stringify(warnings)} where workspace_id = ${ws} and id = ${draftId}`;
        throw new ApiError(409, 'regression_failed', `${regression.failed} of ${regression.total} regression cases for ${regression.pack} fail, so the draft was not approved. Fix the engine or send force: true to approve anyway.`, regression.cases.filter((x) => !x.ok));
      }
    }
  }
  const [row] = approve
    ? await sql`update rule_drafts set status = ${status}, reviewer = ${actor.name}, regression = ${regression ? JSON.stringify(regression) : null}, warnings = ${JSON.stringify(warnings)} where workspace_id = ${ws} and id = ${draftId} and status = 'draft' returning id, publication_id`
    : await sql`update rule_drafts set status = ${status}, reviewer = ${actor.name} where workspace_id = ${ws} and id = ${draftId} and status = 'draft' returning id, publication_id`;
  if (!row) {
    const [ex] = await sql`select status, reviewer from rule_drafts where workspace_id = ${ws} and id = ${draftId}`;
    if (!ex) throw new ApiError(404, 'not_found', 'No rule draft with that id in this organization. Reload the drafts and try again.');
    throw new ApiError(409, 'already_decided', `This draft was already ${ex.status} by ${ex.reviewer ?? 'another reviewer'}. Create a new draft if the text changed.`);
  }
  await audit(sql, ws, actor, `rule_draft.${status}`, draftId, {
    reviewer: actor.name, note: b.note || null, publication_id: row.publication_id ?? null,
    ...(regression ? { regression: { pack: regression.pack, passed: regression.passed, failed: regression.failed }, forced: b.force && regression.failed > 0, warnings } : {}),
  });
  return c.json({ id: draftId, status, reviewer: actor.name, regression, warnings });
});

routes.get('/rule-freshness', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const days = Math.min(365, Math.max(7, Number(c.req.query('days') ?? 90) || 90));
  const rows = await sql`
    select p.id, p.regulator, p.jurisdiction, p.title, p.url, p.topics, coalesce(p.published_at, p.fetched_at) as published_at,
      (select count(*) from generate_series(coalesce(p.published_at, p.fetched_at)::date + 1, current_date, interval '1 day') d
        where extract(isodow from d) < 6)::int as business_days,
      d.id as draft_id, d.status as draft_status
    from reg_publications p
    left join lateral (select r.id, r.status from rule_drafts r where r.workspace_id = ${ws} and r.publication_id = p.id
      order by (r.status = 'approved') desc, r.created_at desc limit 1) d on true
    where p.relevant and coalesce(p.published_at, p.fetched_at) > now() - make_interval(days => ${days})
    order by coalesce(p.published_at, p.fetched_at)`;
  const approved = rows.filter((r: any) => r.draft_status === 'approved');
  const overdue = rows.filter((r: any) => r.draft_status !== 'approved' && r.business_days > RULE_LAG_BUSINESS_DAYS).sort((a: any, b: any) => b.business_days - a.business_days);
  const withinWindow = rows.filter((r: any) => r.draft_status !== 'approved' && r.business_days <= RULE_LAG_BUSINESS_DAYS);
  return c.json({
    guardrail: { max_business_days: RULE_LAG_BUSINESS_DAYS, met: overdue.length === 0, window_days: days },
    counts: { relevant: rows.length, approved: approved.length, overdue: overdue.length, within_window: withinWindow.length, drafted_not_approved: rows.filter((r: any) => r.draft_status === 'draft').length },
    data: overdue,
    pending: withinWindow,
  });
});
