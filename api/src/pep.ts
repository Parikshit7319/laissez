// Politically exposed persons and adverse media. A PEP match is not a sanctions hit: it opens a review and a work item
// for enhanced due diligence, and a person records the outcome. Adverse media is recorded by a person (or by a provider
// through the same shape once one is connected); Laissez does not fabricate a media check it did not run.
import type { Sql } from './db';
import { id as mkId } from './util';
import { screenPeps } from './sanctions';

export type ReviewKind = 'pep' | 'adverse_media';
export type ReviewResult = 'clear' | 'hit' | 'pending';

/**
 * Screens the given investors against the PEP list and opens a pending review plus a work item for each new match.
 * Returns the ids of the reviews it opened. Safe to call often: an investor with a pending or hit review for the same
 * list entry is not opened twice, and a review marked clear excludes that entry from future matches.
 */
export async function openPepReviews(sql: Sql, ws: string, investors: { id: string; name: string }[], by: string): Promise<string[]> {
  if (!investors.length) return [];
  const matches = await screenPeps(sql, ws, investors.map((i) => i.name));
  const opened: string[] = [];
  for (const inv of investors) {
    const m = matches[inv.name];
    if (!m) continue;
    const [existing] = await sql`select id from screening_reviews where workspace_id = ${ws} and investor_id = ${inv.id} and kind = 'pep' and source = ${m.source} and result in ('pending', 'hit') limit 1`;
    if (existing) continue;
    const rid = mkId('rev');
    const summary = `Name matches ${m.primary} (${m.program}, similarity ${m.score}). Confirm identity, record the position held and the source of wealth, then decide.`;
    await sql`insert into screening_reviews (workspace_id, id, investor_id, kind, result, source, summary, references_json, reviewed_by)
      values (${ws}, ${rid}, ${inv.id}, 'pep', 'pending', ${m.source}, ${summary}, ${JSON.stringify([{ list: 'OpenSanctions', entry: m.primary, matched: m.entry, program: m.program, score: m.score }])}, ${by})`;
    await sql`insert into work_items (workspace_id, id, kind, dedupe_key, title, detail, severity, investor_id, link)
      values (${ws}, ${mkId('wi')}, 'pep_review', ${`pep:${inv.id}:${m.source}`}, ${`Possible politically exposed person: ${inv.name}`}, ${summary}, 'high', ${inv.id}, ${`#/clients/${inv.id}`})
      on conflict (workspace_id, dedupe_key) where status = 'open' do nothing`;
    opened.push(rid);
  }
  return opened;
}

/** A person's decision on a review, or a new adverse media record. Closes the matching work item when the review is decided. */
export async function recordReview(sql: Sql, ws: string, o: { id?: string; investorId: string; kind: ReviewKind; result: ReviewResult; source: string; summary: string | null; references: unknown[]; by: string; nextReviewOn: string | null }): Promise<string> {
  const rid = o.id ?? mkId('rev');
  if (o.id) {
    await sql`update screening_reviews set result = ${o.result}, summary = coalesce(${o.summary}, summary), references_json = ${JSON.stringify(o.references)}, reviewed_by = ${o.by}, reviewed_at = now(), next_review_on = ${o.nextReviewOn}
      where workspace_id = ${ws} and id = ${o.id}`;
  } else {
    await sql`insert into screening_reviews (workspace_id, id, investor_id, kind, result, source, summary, references_json, reviewed_by, next_review_on)
      values (${ws}, ${rid}, ${o.investorId}, ${o.kind}, ${o.result}, ${o.source}, ${o.summary}, ${JSON.stringify(o.references)}, ${o.by}, ${o.nextReviewOn})`;
  }
  if (o.result !== 'pending') {
    await sql`update work_items set status = 'done', resolved_at = now(), resolved_by = ${o.by} where workspace_id = ${ws} and status = 'open' and kind = ${o.kind === 'pep' ? 'pep_review' : 'adverse_media_review'} and investor_id = ${o.investorId}`;
  }
  return rid;
}
