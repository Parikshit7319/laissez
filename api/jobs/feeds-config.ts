// Official regulator feeds read by jobs/feeds.ts every six hours.
// "verified" means the URL was fetched on 2026-10-02 and returned a valid RSS 2.0 document with current items.
// Jurisdiction codes match the rest of Laissez where one exists (GB, AE-DIFC); EU and JP are feed-only codes.

export type FeedConfig = {
  regulator: string;
  name: string;
  jurisdiction: string;
  url: string;
  verified: boolean;
  enabled: boolean;
  note?: string;
  /** Only keep items whose link matches, for aggregator feeds that mix in other sites. */
  linkFilter?: RegExp;
  /** Publishers with their own user-agent rules (the SEC) get a dedicated user agent built by feeds.ts. */
  userAgent?: 'sec';
  /** Skip reading publication pages: the publisher blocks automated fetchers, so the feed summary is the text. */
  skipBody?: boolean;
};

export const FEEDS: FeedConfig[] = [
  {
    regulator: 'MAS', name: 'Monetary Authority of Singapore, news (via Bing News RSS)', jurisdiction: 'SG',
    url: 'https://www.bing.com/news/search?q=site%3Amas.gov.sg%2Fnews&format=RSS', verified: true, enabled: true,
    linkFilter: /^https?:\/\/(www\.)?mas\.gov\.sg\//i, skipBody: true,
    note: 'mas.gov.sg has no public RSS endpoint and answers HTTP 403 to automated fetchers, including page reads. Bing News publishes an RSS 2.0 index of mas.gov.sg/news (media releases, speeches, enforcement actions) with titles, links straight to mas.gov.sg and a description per item. Verified 2026-10-02: 12 items, newest from 2026-09-29. Only mas.gov.sg links are kept, and the description stands in for the page text.',
  },
  { regulator: 'SFC', name: 'Securities and Futures Commission, press releases', jurisdiction: 'HK', url: 'https://www.sfc.hk/en/RSS-Feeds/Press-releases', verified: true, enabled: true },
  { regulator: 'SFC', name: 'Securities and Futures Commission, circulars', jurisdiction: 'HK', url: 'https://www.sfc.hk/en/RSS-Feeds/Circulars', verified: true, enabled: true },
  { regulator: 'SFC', name: 'Securities and Futures Commission, consultations and conclusions', jurisdiction: 'HK', url: 'https://www.sfc.hk/en/RSS-Feeds/Consultations-and-Conclusions', verified: true, enabled: true },
  { regulator: 'FCA', name: 'Financial Conduct Authority, news', jurisdiction: 'GB', url: 'https://www.fca.org.uk/news/rss.xml', verified: true, enabled: true },
  { regulator: 'FINMA', name: 'Swiss Financial Market Supervisory Authority, news', jurisdiction: 'CH', url: 'https://www.finma.ch/en/rss/news/', verified: true, enabled: true },
  { regulator: 'DFSA', name: 'Dubai Financial Services Authority, news', jurisdiction: 'AE-DIFC', url: 'https://www.dfsa.ae/rss', verified: true, enabled: true },
  { regulator: 'ESMA', name: 'European Securities and Markets Authority, news', jurisdiction: 'EU', url: 'https://www.esma.europa.eu/rss.xml', verified: true, enabled: true },
  {
    regulator: 'SEC', name: 'U.S. Securities and Exchange Commission, press releases', jurisdiction: 'US', url: 'https://www.sec.gov/news/pressreleases.rss', verified: true, enabled: true, userAgent: 'sec',
    note: 'sec.gov requires automated clients to identify themselves as "Company Name contact@email" and refuses other user agents with HTTP 403. feeds.ts sends that form, using the FEEDS_CONTACT variable from the workflow as the email. When a press release page still answers 403, the RSS summary is stored as the text instead.',
  },
  { regulator: 'FSA Japan', name: 'Financial Services Agency (English), updated news', jurisdiction: 'JP', url: 'https://www.fsa.go.jp/fsaEnNewsList_rss2.xml', verified: true, enabled: true },
];
