// Sanctions screening against the OFAC SDN, UN, EU and UK lists (loaded daily by a job),
// plus a fictional test list for demos. Fuzzy matching uses Postgres trigram similarity.
import type { Sql } from './db';
import { id } from './util';

const SUFFIXES = /\b(ltd|llc|inc|pte|gmbh|limited|co|corp|corporation|sa|ag|plc|bv|nv|llp|lp|jsc|ojsc|pjsc|ooo|fze|fzco|company|the)\b/g;
/** Normalize a name for matching. The ingest job uses the same function. */
export function normName(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(SUFFIXES, ' ').replace(/\s+/g, ' ').trim();
}

export type Match = { entry: string; primary: string; program: string; source: string; uid: string; score: number };
/** A score at or above this holds the order for review. */
export const MATCH_THRESHOLD = 0.72;

export async function screenNames(sql: Sql, ws: string, names: string[]): Promise<Record<string, Match | null>> {
  const uniq = [...new Set(names.filter(Boolean))];
  const out: Record<string, Match | null> = Object.fromEntries(uniq.map((n) => [n, null]));
  if (!uniq.length) return out;
  const norms = uniq.map(normName);
  const rows = await sql`
    select q.name as screened, e.source, e.source_uid, e.name, e.primary_name, coalesce(e.programs, '') as programs, similarity(e.name_norm, q.norm)::float8 as score
    from unnest(${uniq}::text[], ${norms}::text[]) as q(name, norm)
    cross join lateral (select * from sanctions_entries e where e.name_norm % q.norm and e.source <> 'OS-PEP' order by similarity(e.name_norm, q.norm) desc limit 3) e
    where similarity(e.name_norm, q.norm) >= ${MATCH_THRESHOLD}
      and not exists (select 1 from screening_hits h where h.workspace_id = ${ws} and h.screened_name = q.name and h.source = e.source and h.source_uid = e.source_uid and h.status = 'false_positive')
    order by score desc`;
  for (const r of rows) {
    if (out[r.screened]) continue;
    out[r.screened] = { entry: r.name, primary: r.primary_name, program: `${r.source}${r.programs ? `: ${r.programs}` : ''}`, source: r.source, uid: r.source_uid, score: Math.round(r.score * 100) / 100 };
  }
  return out;
}

/** Open a review item for each new potential match. Existing decisions on the same pair are kept. */
export async function recordHits(sql: Sql, ws: string, hits: { investorId: string | null; name: string; m: Match }[], context: string) {
  for (const h of hits) {
    await sql`insert into screening_hits (workspace_id, id, investor_id, screened_name, source, source_uid, matched_name, primary_name, programs, score, context)
      values (${ws}, ${id('hit', 10)}, ${h.investorId}, ${h.name}, ${h.m.source}, ${h.m.uid}, ${h.m.entry}, ${h.m.primary}, ${h.m.program}, ${h.m.score}, ${context})
      on conflict (workspace_id, screened_name, source, source_uid) do nothing`;
  }
}

/**
 * Politically exposed persons. Same matcher, PEP rows only. A match is not a sanction: the caller records a review
 * (screening_reviews, kind pep, result pending) and opens enhanced due diligence; nothing is frozen or refused.
 */
export async function screenPeps(sql: Sql, ws: string, names: string[]): Promise<Record<string, Match | null>> {
  const uniq = [...new Set(names.filter(Boolean))];
  const out: Record<string, Match | null> = Object.fromEntries(uniq.map((n) => [n, null]));
  if (!uniq.length) return out;
  const norms = uniq.map(normName);
  const rows = await sql`
    select q.name as screened, e.source, e.source_uid, e.name, e.primary_name, coalesce(e.programs, '') as programs, e.country, similarity(e.name_norm, q.norm)::float8 as score
    from unnest(${uniq}::text[], ${norms}::text[]) as q(name, norm)
    cross join lateral (select * from sanctions_entries e where e.name_norm % q.norm and e.source = 'OS-PEP' order by similarity(e.name_norm, q.norm) desc limit 3) e
    where similarity(e.name_norm, q.norm) >= ${MATCH_THRESHOLD}
      and not exists (select 1 from screening_reviews r where r.workspace_id = ${ws} and r.kind = 'pep' and r.source = e.source || ':' || e.source_uid and r.result = 'clear')
    order by score desc`;
  for (const r of rows) {
    if (out[r.screened]) continue;
    out[r.screened] = { entry: r.name, primary: r.primary_name, program: `${r.programs}${r.country ? ` (${r.country})` : ''}`, source: `${r.source}:${r.source_uid}`, uid: r.source_uid, score: Math.round(r.score * 100) / 100 };
  }
  return out;
}
