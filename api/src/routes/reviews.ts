// PEP and adverse media reviews. Mounted under /v1.
import { z } from 'zod';
import { router, need, body, audit, actorRef } from '../http';
import { ApiError } from '../util';
import { openPepReviews, recordReview } from '../pep';

export const routes = router();

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const reviewIn = z.object({
  kind: z.enum(['pep', 'adverse_media']),
  result: z.enum(['clear', 'hit', 'pending']),
  source: z.string().trim().min(2).max(200),
  summary: z.string().trim().max(2000).nullable().optional(),
  references: z.array(z.object({ title: z.string().trim().max(200), url: z.string().url().max(500).optional(), date: z.string().regex(DATE).optional(), note: z.string().trim().max(500).optional() })).max(20).default([]),
  next_review_on: z.string().regex(DATE).nullable().optional(),
});
const decideIn = reviewIn.pick({ result: true, summary: true, references: true, next_review_on: true });

const present = (r: any) => ({ id: r.id, investor_id: r.investor_id, investor: r.investor ?? null, kind: r.kind, result: r.result, source: r.source, summary: r.summary, references: r.references_json ?? [], reviewed_by: r.reviewed_by, reviewed_at: r.reviewed_at, next_review_on: r.next_review_on });

routes.get('/screening-reviews', async (c) => {
  need(c, 'read');
  const ws = c.get('ws');
  const result = c.req.query('result'); const kind = c.req.query('kind');
  const rows = await c.get('sql').query(
    `select r.*, i.name as investor from screening_reviews r left join investors i on i.workspace_id = r.workspace_id and i.id = r.investor_id
     where r.workspace_id = $1 and ($2::text is null or r.result = $2) and ($3::text is null or r.kind = $3) order by (r.result = 'pending') desc, r.reviewed_at desc limit 200`,
    [ws, result ?? null, kind ?? null]);
  const [{ n }] = await c.get('sql')`select count(*)::int as n from sanctions_entries where source = 'OS-PEP'`;
  return c.json({ data: rows.map(present), pep_list_entries: n });
});

routes.get('/investors/:id/screening-reviews', async (c) => {
  need(c, 'read');
  const rows = await c.get('sql')`select * from screening_reviews where workspace_id = ${c.get('ws')} and investor_id = ${c.req.param('id')} order by reviewed_at desc`;
  return c.json({ data: rows.map(present) });
});

routes.post('/investors/:id/screening-reviews', async (c) => {
  const a = need(c, 'compliance:write');
  const ws = c.get('ws'); const invId = c.req.param('id');
  const [inv] = await c.get('sql')`select id, name from investors where workspace_id = ${ws} and id = ${invId}`;
  if (!inv) throw new ApiError(404, 'not_found', `No investor ${invId} in this organization.`);
  const b = await body(c, reviewIn);
  const id = await recordReview(c.get('sql'), ws, { investorId: invId, kind: b.kind, result: b.result, source: b.source, summary: b.summary ?? null, references: b.references, by: actorRef(a), nextReviewOn: b.next_review_on ?? null });
  await audit(c.get('sql'), ws, a, 'screening.review_recorded', id, { investor: invId, kind: b.kind, result: b.result, source: b.source });
  const [row] = await c.get('sql')`select * from screening_reviews where workspace_id = ${ws} and id = ${id}`;
  return c.json(present(row), 201);
});

routes.post('/screening-reviews/:id/decide', async (c) => {
  const a = need(c, 'compliance:write');
  const ws = c.get('ws');
  const [r] = await c.get('sql')`select * from screening_reviews where workspace_id = ${ws} and id = ${c.req.param('id')}`;
  if (!r) throw new ApiError(404, 'not_found', 'No review with that id in this organization.');
  const b = await body(c, decideIn);
  await recordReview(c.get('sql'), ws, { id: r.id, investorId: r.investor_id, kind: r.kind, result: b.result, source: r.source, summary: b.summary ?? null, references: b.references.length ? b.references : (r.references_json ?? []), by: actorRef(a), nextReviewOn: b.next_review_on ?? null });
  await audit(c.get('sql'), ws, a, 'screening.review_decided', r.id, { investor: r.investor_id, kind: r.kind, result: b.result, was: r.result });
  const [row] = await c.get('sql')`select * from screening_reviews where workspace_id = ${ws} and id = ${r.id}`;
  return c.json(present(row));
});

/** Screens every investor against the PEP list now. The nightly monitoring sweep does the same. */
routes.post('/screening-reviews/pep-sweep', async (c) => {
  const a = need(c, 'compliance:write');
  const ws = c.get('ws');
  const investors = await c.get('sql')`select id, name from investors where workspace_id = ${ws}`;
  const opened = await openPepReviews(c.get('sql'), ws, investors, actorRef(a));
  if (opened.length) await audit(c.get('sql'), ws, a, 'screening.pep_sweep', null, { investors: investors.length, opened: opened.length });
  return c.json({ investors: investors.length, opened: opened.length, review_ids: opened });
});
