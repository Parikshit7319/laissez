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
};

export const FEEDS: FeedConfig[] = [
  {
    regulator: 'MAS', name: 'Monetary Authority of Singapore, media releases', jurisdiction: 'SG',
    url: 'https://www.mas.gov.sg/rss/news', verified: false, enabled: false,
    note: 'No public RSS endpoint could be confirmed: mas.gov.sg returns HTTP 403 to automated fetchers. Confirm the URL from a browser, then set enabled to true.',
  },
  { regulator: 'SFC', name: 'Securities and Futures Commission, press releases', jurisdiction: 'HK', url: 'https://www.sfc.hk/en/RSS-Feeds/Press-releases', verified: true, enabled: true },
  { regulator: 'SFC', name: 'Securities and Futures Commission, circulars', jurisdiction: 'HK', url: 'https://www.sfc.hk/en/RSS-Feeds/Circulars', verified: true, enabled: true },
  { regulator: 'SFC', name: 'Securities and Futures Commission, consultations and conclusions', jurisdiction: 'HK', url: 'https://www.sfc.hk/en/RSS-Feeds/Consultations-and-Conclusions', verified: true, enabled: true },
  { regulator: 'FCA', name: 'Financial Conduct Authority, news', jurisdiction: 'GB', url: 'https://www.fca.org.uk/news/rss.xml', verified: true, enabled: true },
  { regulator: 'FINMA', name: 'Swiss Financial Market Supervisory Authority, news', jurisdiction: 'CH', url: 'https://www.finma.ch/en/rss/news/', verified: true, enabled: true },
  { regulator: 'DFSA', name: 'Dubai Financial Services Authority, news', jurisdiction: 'AE-DIFC', url: 'https://www.dfsa.ae/rss', verified: true, enabled: true },
  { regulator: 'ESMA', name: 'European Securities and Markets Authority, news', jurisdiction: 'EU', url: 'https://www.esma.europa.eu/rss.xml', verified: true, enabled: true },
  {
    regulator: 'SEC', name: 'U.S. Securities and Exchange Commission, press releases', jurisdiction: 'US', url: 'https://www.sec.gov/news/pressreleases.rss', verified: true, enabled: true,
    note: 'sec.gov asks automated clients to send a user agent with a contact email. Set the FEEDS_CONTACT variable in the workflow so requests are not refused.',
  },
  { regulator: 'FSA Japan', name: 'Financial Services Agency (English), updated news', jurisdiction: 'JP', url: 'https://www.fsa.go.jp/fsaEnNewsList_rss2.xml', verified: true, enabled: true },
];
