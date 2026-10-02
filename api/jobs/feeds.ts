// Regulator feed reader. Fetches each official feed in feeds-config.ts, flags publications relevant to
// tokenized fund distribution, reads the text of new relevant ones, and upserts everything into reg_publications.
// One failing feed never stops the others. Run from api/: npx tsx jobs/feeds.ts [--dry-run]
import { db, fetchText, log, pool } from './lib';
import { FEEDS, type FeedConfig } from './feeds-config';
import { htmlToText, matchTopics, parseFeed, pubId, type FeedItem } from './parsers';

type Pub = FeedItem & { id: string; regulator: string; jurisdiction: string; relevant: boolean; topics: string[]; body: string | null };

const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5';
const EXCERPT_MAX = 8000;

async function readFeed(feed: FeedConfig): Promise<{ feed: FeedConfig; items: Pub[]; error?: string }> {
  try {
    const res = await fetchText(feed.url, { timeoutMs: 30_000, accept: FEED_ACCEPT });
    const items = parseFeed(res.text, res.url);
    if (!items.length) throw new Error(`no items found (content type ${res.contentType || 'unknown'}). The feed may have moved.`);
    return {
      feed,
      items: items.map((it) => {
        const topics = matchTopics(it.title, it.summary);
        return { ...it, id: pubId(it.url), regulator: feed.regulator, jurisdiction: feed.jurisdiction, relevant: topics.length > 0, topics, body: null };
      }),
    };
  } catch (e: any) {
    return { feed, items: [], error: String(e?.message ?? e) };
  }
}

/** Read a publication page as plain text. PDFs and other binary documents are skipped; the feed summary stays. */
async function readBody(url: string): Promise<string | null> {
  try {
    const res = await fetchText(url, { timeoutMs: 20_000, accept: 'text/html,application/xhtml+xml,text/plain;q=0.8', retries: 0 });
    const type = res.contentType.toLowerCase();
    if (type && !/text\/|xhtml|xml/.test(type)) return null;
    const text = htmlToText(res.text, EXCERPT_MAX);
    return text.length >= 80 ? text : null;
  } catch (e: any) {
    log(`  could not read ${url}: ${e?.message ?? e}`);
    return null;
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const sql = dryRun ? null : db();
  const feeds = FEEDS.filter((f) => f.enabled);
  log(`Regulator feeds${dryRun ? ' (dry run, nothing is written)' : ''}: ${feeds.length} enabled, ${FEEDS.length - feeds.length} disabled`);

  const results = await pool(feeds, 4, readFeed);
  for (const r of results) {
    if (r.error) log(`${r.feed.regulator} ${r.feed.url}: FAILED. ${r.error}`);
    else log(`${r.feed.regulator} ${r.feed.url}: ${r.items.length} items, ${r.items.filter((i) => i.relevant).length} relevant`);
  }

  // The same publication can appear in two feeds (an SFC consultation is also a press release). Merge by id.
  const byId = new Map<string, Pub>();
  for (const it of results.flatMap((r) => r.items)) {
    const seen = byId.get(it.id);
    if (!seen) { byId.set(it.id, it); continue; }
    seen.topics = [...new Set([...seen.topics, ...it.topics])];
    seen.relevant = seen.relevant || it.relevant;
    seen.summary ??= it.summary;
    seen.published ??= it.published;
  }
  const pubs = [...byId.values()];

  // Read the text of relevant publications that are new, or recent and still without an excerpt
  // (a page that failed or was a PDF is retried for two weeks, not forever).
  const known = new Map<string, boolean>();
  if (sql && pubs.length) {
    const rows = await sql`select id, (body_excerpt is not null) as has_body from reg_publications where id = any(${pubs.map((p) => p.id)})`;
    for (const r of rows) known.set(r.id, !!r.has_body);
  }
  const retryAfter = Date.now() - 14 * 86_400_000;
  const toRead = pubs.filter((p) => p.relevant && (!known.has(p.id) || (!known.get(p.id) && (!p.published || Date.parse(p.published) > retryAfter))));
  await pool(toRead, 3, async (p) => { p.body = await readBody(p.url); });
  log(`Read ${toRead.filter((p) => p.body).length} of ${toRead.length} new relevant publications.`);

  if (sql && pubs.length) {
    for (let i = 0; i < pubs.length; i += 200) {
      const b = pubs.slice(i, i + 200);
      await sql.query(
        `insert into reg_publications (id, regulator, jurisdiction, title, url, published_at, summary, body_excerpt, relevant, topics)
         select u.id, u.regulator, u.jur, u.title, u.url, u.published, u.summary, u.body, u.relevant, string_to_array(nullif(u.topics, ''), '|')
         from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[], $7::text[], $8::text[], $9::bool[], $10::text[])
           as u(id, regulator, jur, title, url, published, summary, body, relevant, topics)
         on conflict (id) do update set
           regulator = excluded.regulator, jurisdiction = excluded.jurisdiction, title = excluded.title,
           published_at = coalesce(excluded.published_at, reg_publications.published_at),
           summary = coalesce(excluded.summary, reg_publications.summary),
           body_excerpt = coalesce(excluded.body_excerpt, reg_publications.body_excerpt),
           relevant = excluded.relevant, topics = excluded.topics`,
        [b.map((p) => p.id), b.map((p) => p.regulator), b.map((p) => p.jurisdiction), b.map((p) => p.title), b.map((p) => p.url), b.map((p) => p.published),
          b.map((p) => p.summary), b.map((p) => p.body), b.map((p) => p.relevant), b.map((p) => p.topics.join('|'))],
      );
    }
  }
  const failed = results.filter((r) => r.error);
  log(`Finished: ${pubs.length} publications from ${results.length - failed.length} feeds, ${pubs.filter((p) => p.relevant).length} relevant${failed.length ? `, ${failed.length} feed${failed.length === 1 ? '' : 's'} failed` : ''}.`);
  if (dryRun) for (const p of pubs.filter((x) => x.relevant).slice(0, 20)) log(`  [${p.regulator}] ${p.title} (${p.topics.join(', ')})`);
  // A single broken feed is logged, not fatal. Fail the run only when nothing could be read at all.
  if (feeds.length && failed.length === feeds.length) {
    console.error('Every feed failed. Check network access from the runner and the URLs in jobs/feeds-config.ts.');
    process.exit(1);
  }
}

await main();
