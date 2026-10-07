// The rule-pack feed: every jurisdiction's eligibility rules as data a compliance team can subscribe to on its own,
// with or without settlement. Each entry carries the classes the law accepts, the threshold test behind each class with
// its citation and primary source, the pack's version history and a changelog. The whole document is signed with the
// receipt key so a reader can prove which version of the rules they relied on.
import { router, need } from '../http';
import { signReceipt, canonical, sha256 } from '../util';
import { TESTS } from '../../../src/proto/thresholds';
import { sources } from '../../../src/data/sources';

export const routes = router();

const sourceById = new Map(sources.map((s) => [s.id, s]));

/** Builds the feed from the database tables that the engine itself reads. */
export async function buildRuleFeed(admin: any) {
  const [packs, classes, jurisdictions] = await Promise.all([
    admin`select id, version, jurisdiction, status, summary, effective_from::text, effective_to::text, approved_by, reviewed_on::text, review_ref, created_at from rule_packs order by id, effective_from asc nulls first, created_at asc`,
    admin`select code, jurisdiction, label, stamp, rule_ref, source_id, threshold, requires_opt_in from investor_classes order by jurisdiction, code`,
    admin`select code, name from jurisdictions order by name`,
  ]);
  const byJur = new Map<string, any>();
  for (const j of jurisdictions) byJur.set(j.code, { jurisdiction: j.code, name: j.name, active_pack: null as any, versions: [] as any[], classes: [] as any[], changelog: [] as any[] });
  for (const p of packs) {
    const j = byJur.get(p.jurisdiction); if (!j) continue;
    const v = { id: p.id, version: p.version, status: p.status, summary: p.summary, effective_from: p.effective_from, effective_to: p.effective_to, approved_by: p.approved_by, reviewed_on: p.reviewed_on, review_ref: p.review_ref };
    j.versions.push(v);
    if (p.status === 'active' && (!j.active_pack || (p.effective_from ?? '') > (j.active_pack.effective_from ?? ''))) j.active_pack = v;
  }
  for (const c of classes) {
    const j = byJur.get(c.jurisdiction); if (!j) continue;
    const src = sourceById.get(c.source_id);
    const tests = TESTS.filter((t) => t.code === c.code).map((t) => ({ subject: t.subject, fields: t.fields.map((f) => ({ key: f.key, label: f.label, kind: f.kind, unit: f.unit ?? null })) }));
    j.classes.push({ code: c.code, label: c.label, stamp: c.stamp, rule_ref: c.rule_ref, threshold: c.threshold, requires_opt_in: c.requires_opt_in, source: src ? { id: src.id, title: src.title, publisher: src.publisher, date: src.date, url: src.url, caution: src.caution ?? null } : { id: c.source_id }, tests });
  }
  for (const j of byJur.values()) {
    // Changelog: one line per version in order; a later version supersedes the one before it.
    const vs = j.versions;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i]; const prev = vs[i - 1];
      j.changelog.push({ version: v.version, effective_from: v.effective_from, change: prev ? `Supersedes ${prev.version}${prev.effective_to ? ` from ${v.effective_from}` : ''}.` : 'First version.', summary: v.summary, status: v.status });
    }
  }
  const data = [...byJur.values()].filter((j) => j.versions.length || j.classes.length);
  const generated_at = new Date().toISOString();
  const body = { format: 'laissez.rule-feed.v1', generated_at, jurisdictions: data.length, data };
  return { ...body, sha256: await sha256(canonical(body)) };
}

routes.get('/rule-packs/feed', async (c) => {
  need(c, 'read');
  const feed = await buildRuleFeed(c.get('admin'));
  let signature: string | null = null;
  try { signature = await signReceipt(c.env, feed as unknown as Record<string, unknown>); } catch { /* signing not configured */ }
  return c.json({ ...feed, signature, verify: 'Check signature over the canonical JSON of every field except signature with the Ed25519 key at GET /v1/signing-key. A reader that stores this document can prove which rules it relied on and when.' });
});
