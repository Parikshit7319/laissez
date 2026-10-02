// Parser tests with small inline fixtures shaped like the real files (the live lists are not reachable
// from every build environment). Run from api/: npx tsx jobs/__tests__/parsers.test.ts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  parseCsv, isoDate, parseFeedDate, parseOfac, parseUn, parseEu, parseUk, toRows, parseFeed, htmlToText, matchTopics, decodeEntities, pubId,
} from '../parsers';
import { normName } from '../../src/sanctions';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e: any) { failures.push(name); console.log(`  FAIL ${name}\n       ${String(e?.message ?? e).split('\n').join('\n       ')}`); }
}

console.log('CSV');
test('quoted fields with commas, doubled quotes and line breaks', () => {
  const rows = parseCsv('a,"b, with comma","say ""hi""","line\r\nbreak"\r\n1,2,3,4\r\n');
  assert.deepEqual(rows, [['a', 'b, with comma', 'say "hi"', 'line\r\nbreak'], ['1', '2', '3', '4']]);
});
test('semicolon delimiter, BOM, LF and CR endings, empty fields', () => {
  const rows = parseCsv('\uFEFFx;y;z\n1;"a;b";\r2;;3', ';');
  assert.deepEqual(rows, [['x', 'y', 'z'], ['1', 'a;b', ''], ['2', '', '3']]);
});
test('MS-DOS end-of-file byte does not create a phantom row', () => {
  const rows = parseCsv('1,"A"\r\n2,"B"\r\n\u001a');
  assert.deepEqual(rows, [['1', 'A'], ['2', 'B']]);
});
test('blank lines are skipped', () => {
  assert.deepEqual(parseCsv('a,b\n\n\nc,d\n'), [['a', 'b'], ['c', 'd']]);
});

console.log('Dates');
test('list dates normalize to YYYY-MM-DD', () => {
  assert.equal(isoDate('28/01/2026'), '2026-01-28');
  assert.equal(isoDate('2026-01-28T10:00:00Z'), '2026-01-28');
  assert.equal(isoDate('3-Feb-2025'), '2025-02-03');
  assert.equal(isoDate(''), null);
});
test('feed dates in the formats regulators publish', () => {
  assert.equal(parseFeedDate('Mon, 28 Sep 2026 13:46:30 -0400'), '2026-09-28T17:46:30.000Z');
  assert.equal(parseFeedDate('Fri, 02 Oct 2026 16:30:00 JST'), '2026-10-02T07:30:00.000Z');
  assert.equal(parseFeedDate('Wednesday, September 30, 2026 - 17:17'), '2026-09-30T17:17:00.000Z');
  assert.equal(parseFeedDate('10 September 2026'), '2026-09-10T00:00:00.000Z');
  assert.equal(parseFeedDate('2026-09-30T10:00:00+02:00'), '2026-09-30T08:00:00.000Z');
  assert.equal(parseFeedDate('not a date'), null);
});

console.log('OFAC SDN');
const SDN = [
  '36,"AEROCARIBBEAN AIRLINES","-0- ","CUBA","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- "',
  '173,"ABU NIDAL ORGANIZATION","-0- ","SDT] [FTO] [SDGT","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","Remark, with comma; and semicolon."',
  '2674,"HAMADA, Huda Salih Mahdi Ammash","individual","IRAQ2","Former Ba\'th Party official","-0- ","-0- ","-0- ","-0- ","-0- ","-0- ","DOB 1953; POB Baghdad, Iraq; nationality Iraq."',
  '9647,"ADRIATIK","vessel","IRAN] [IFSR","-0- ","9HXX5","Bulk Carrier","-0- ","-0- ","Malta","-0- ","Vessel Registration Identification IMO 9000000."',
].join('\r\n') + '\r\n\u001a';
const ALT = [
  '173,252,"aka","ANO","-0- "',
  '173,253,"aka","BLACK SEPTEMBER","-0- "',
  '2674,1001,"aka","AMMASH, Huda Salih Mahdi","-0- "',
  '2674,1002,"aka","AMMASH, Huda Salih Mahdi","-0- "',
  '99999,1003,"aka","ORPHAN ALIAS","-0- "',
].join('\r\n');
const ADD = [
  '36,25,"-0- ","Havana","Cuba","-0- "',
  '173,129,"-0- ","-0- ","Lebanon","-0- "',
].join('\r\n');
test('parses entries, types, programs, aliases and countries', () => {
  const p = parseOfac(SDN, ALT, ADD);
  assert.equal(p.entries.length, 4);
  const ano = p.entries.find((e) => e.uid === '173')!;
  assert.equal(ano.type, 'entity');
  assert.equal(ano.programs, 'SDT, FTO, SDGT');
  assert.deepEqual(ano.aliases, ['ANO', 'BLACK SEPTEMBER']);
  assert.equal(ano.country, 'Lebanon');
  const person = p.entries.find((e) => e.uid === '2674')!;
  assert.equal(person.type, 'individual');
  assert.equal(person.primary, 'HAMADA, Huda Salih Mahdi Ammash');
  const ship = p.entries.find((e) => e.uid === '9647')!;
  assert.equal(ship.type, 'vessel');
  assert.equal(ship.country, 'Malta');
  assert.ok(p.warnings.some((w) => w.includes('ALT.CSV')), 'orphan alias is reported');
});
test('one row per distinct name, duplicate aliases collapsed, names normalized', () => {
  const rows = toRows(parseOfac(SDN, ALT, ADD).entries);
  assert.equal(rows.length, 4 + 2 + 1);
  const alias = rows.find((r) => r.name === 'BLACK SEPTEMBER')!;
  assert.equal(alias.is_alias, true);
  assert.equal(alias.primary_name, 'ABU NIDAL ORGANIZATION');
  assert.equal(alias.name_norm, 'black september');
  const person = rows.find((r) => r.source_uid === '2674' && !r.is_alias)!;
  assert.equal(person.name_norm, normName('HAMADA, Huda Salih Mahdi Ammash'));
  assert.equal(person.name_norm, 'hamada huda salih mahdi ammash');
});
test('a changed file layout fails loudly instead of loading garbage', () => {
  const broken = Array.from({ length: 20 }, (_, i) => `${i},"NAME ${i}","-0- "`).join('\n');
  assert.throws(() => parseOfac(broken, null), /do not have 12 columns/);
});

console.log('UN');
const UN = `<?xml version="1.0" encoding="UTF-8"?>
<CONSOLIDATED_LIST xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" dateGenerated="2026-09-30T14:00:03.12Z">
  <INDIVIDUALS>
    <INDIVIDUAL>
      <DATAID>6908555</DATAID><VERSIONNUM>1</VERSIONNUM>
      <FIRST_NAME>RI</FIRST_NAME><SECOND_NAME>WON HO</SECOND_NAME>
      <UN_LIST_TYPE>DPRK</UN_LIST_TYPE><REFERENCE_NUMBER>KPi.033</REFERENCE_NUMBER><LISTED_ON>2016-11-30</LISTED_ON>
      <NAME_ORIGINAL_SCRIPT>리원호</NAME_ORIGINAL_SCRIPT>
      <NATIONALITY><VALUE>Democratic People's Republic of Korea</VALUE></NATIONALITY>
      <INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>Ri Won-ho</ALIAS_NAME></INDIVIDUAL_ALIAS>
      <INDIVIDUAL_ALIAS><QUALITY>a.k.a.</QUALITY><ALIAS_NAME>Lee Won Ho</ALIAS_NAME></INDIVIDUAL_ALIAS>
      <INDIVIDUAL_ALIAS><QUALITY>Low</QUALITY><ALIAS_NAME>Ri</ALIAS_NAME></INDIVIDUAL_ALIAS>
    </INDIVIDUAL>
    <INDIVIDUAL>
      <DATAID>110</DATAID><FIRST_NAME>SINGLE</FIRST_NAME><SECOND_NAME>ALIAS &amp; NAME</SECOND_NAME>
      <UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE><REFERENCE_NUMBER>QDi.001</REFERENCE_NUMBER><LISTED_ON>2001-01-25</LISTED_ON>
      <INDIVIDUAL_ALIAS><QUALITY/><ALIAS_NAME/></INDIVIDUAL_ALIAS>
    </INDIVIDUAL>
  </INDIVIDUALS>
  <ENTITIES>
    <ENTITY>
      <DATAID>4553</DATAID><FIRST_NAME>KOREA MINING DEVELOPMENT TRADING CORPORATION</FIRST_NAME>
      <UN_LIST_TYPE>DPRK</UN_LIST_TYPE><REFERENCE_NUMBER>KPe.001</REFERENCE_NUMBER><LISTED_ON>2009-04-24</LISTED_ON>
      <ENTITY_ALIAS><QUALITY>a.k.a.</QUALITY><ALIAS_NAME>KOMID</ALIAS_NAME></ENTITY_ALIAS>
      <ENTITY_ADDRESS><CITY>Pyongyang</CITY><COUNTRY>Democratic People's Republic of Korea</COUNTRY></ENTITY_ADDRESS>
    </ENTITY>
  </ENTITIES>
</CONSOLIDATED_LIST>`;
test('individuals and entities with aliases, nationality and listing date', () => {
  const p = parseUn(UN);
  assert.equal(p.published, '2026-09-30T14:00:03.12Z');
  assert.equal(p.entries.length, 3);
  const ri = p.entries.find((e) => e.uid === 'KPi.033')!;
  assert.equal(ri.primary, 'RI WON HO');
  assert.equal(ri.type, 'individual');
  assert.equal(ri.programs, 'DPRK');
  assert.equal(ri.listedOn, '2016-11-30');
  assert.equal(ri.country, "Democratic People's Republic of Korea");
  assert.ok(ri.aliases.includes('Ri Won-ho'));
  assert.ok(!ri.aliases.includes('Ri'), 'low-quality alias skipped');
  const komid = p.entries.find((e) => e.uid === 'KPe.001')!;
  assert.equal(komid.type, 'entity');
  assert.deepEqual(komid.aliases, ['KOMID']);
  assert.equal(p.entries.find((e) => e.uid === 'QDi.001')!.primary, 'SINGLE ALIAS & NAME');
});
test('non-Latin names and aliases that normalize to the primary are dropped', () => {
  const rows = toRows(parseUn(UN).entries).filter((r) => r.source_uid === 'KPi.033');
  assert.deepEqual(rows.map((r) => [r.name, r.name_norm, r.is_alias]), [['RI WON HO', 'ri won ho', false], ['Lee Won Ho', 'lee won ho', true]]);
});
test('a document without the expected root is rejected', () => {
  assert.throws(() => parseUn('<html><body>Service unavailable</body></html>'), /CONSOLIDATED_LIST/);
});

console.log('EU');
const EU_HEADER = 'fileGenerationDate;Entity_LogicalId;Entity_EU_ReferenceNumber;Entity_UN_ReferenceNumber;Entity_DesignationDate;Entity_DesignationDetails;Entity_Remark;Entity_SubjectType;Entity_SubjectType_ClassificationCode;Entity_Regulation_Type;Entity_Regulation_OrganisationType;Entity_Regulation_PublicationDate;Entity_Regulation_EntryIntoForceDate;Entity_Regulation_NumberTitle;Entity_Regulation_Programme;Entity_Regulation_PublicationUrl;NameAlias_LastName;NameAlias_FirstName;NameAlias_MiddleName;NameAlias_WholeName;NameAlias_NameLanguage;Citizenship_CountryDescription';
const euRow = (id: string, type: string, code: string, prog: string, whole: string, extra: { last?: string; first?: string; cit?: string; designated?: string } = {}) =>
  ['22/09/2026', id, `EU.${id}.1`, '', extra.designated ?? '', '', '', type, code, 'regulation', 'council', '2022-02-25', '2022-02-25', '"2022/261 (OJ L42I); amending"', prog, 'http://eur-lex.europa.eu/x', extra.last ?? '', extra.first ?? '', '', whole, 'EN', extra.cit ?? ''].join(';');
const EU = '\uFEFF' + [
  EU_HEADER,
  euRow('13', 'P', 'person', 'RUS', 'Ivan Petrovich SIDOROV', { cit: 'RUSSIAN FEDERATION', designated: '2022-02-25' }),
  euRow('13', 'P', 'person', 'RUS', 'Иван Петрович Сидоров'),
  euRow('13', 'P', 'person', 'UKR', 'Ivan SIDOROV'),
  euRow('13', 'P', 'person', 'RUS', 'Ivan Petrovich SIDOROV'),
  euRow('24', 'E', 'enterprise', 'IRN', '"Bank ""Example"" PJSC; Tehran branch"'),
  euRow('31', 'E', 'enterprise', 'SYR', '', { last: 'TRADING', first: 'ALPHA' }),
].join('\n');
test('groups rows by entity, merges programmes and aliases', () => {
  const p = parseEu(EU);
  assert.equal(p.published, '2026-09-22');
  assert.equal(p.entries.length, 3);
  const ivan = p.entries.find((e) => e.uid === '13')!;
  assert.equal(ivan.type, 'individual');
  assert.equal(ivan.primary, 'Ivan Petrovich SIDOROV');
  assert.deepEqual(ivan.aliases, ['Иван Петрович Сидоров', 'Ivan SIDOROV']);
  assert.equal(ivan.programs, 'RUS, UKR');
  assert.equal(ivan.country, 'RUSSIAN FEDERATION');
  assert.equal(ivan.listedOn, '2022-02-25');
  const bank = p.entries.find((e) => e.uid === '24')!;
  assert.equal(bank.type, 'entity');
  assert.equal(bank.primary, 'Bank "Example" PJSC; Tehran branch');
  assert.equal(p.entries.find((e) => e.uid === '31')!.primary, 'ALPHA TRADING');
});
test('a header without the key columns is rejected', () => {
  assert.throws(() => parseEu('a;b;c\n1;2;3'), /Entity_LogicalId/);
});

console.log('UK');
const UK = [
  'Report Date: 01/10/2026',
  '"Last Updated","Unique ID","OFSI Group ID","UN Reference Number","Name 6","Name 1","Name 2","Name 3","Name 4","Name 5","Name type","Alias strength","Title","Name non-latin script","Non-latin script type","Non-latin script language","Regime Name","Individual, Entity, Ship","Designation source","Sanctions Imposed","Other Information","Date Designated","Nationality(/ies)","Address Country"',
  '"15/09/2026","RUS0001","14001","","PETROV","Sergei","Ivanovich","","","","Primary Name","","Mr","","","","Russia","Individual","UK","Asset freeze","Note, with comma","16/03/2022","Russia",""',
  '"15/09/2026","RUS0001","14001","","PETROFF","Sergey","","","","","Alias","Strong","","","","","Russia","Individual","UK","Asset freeze","","16/03/2022","Russia",""',
  '"15/09/2026","RUS0001","14001","","SP","","","","","","Alias","Weak","","","","","Russia","Individual","UK","Asset freeze","","16/03/2022","Russia",""',
  '"20/09/2026","RUS0002","14002","","OCEAN STAR","","","","","","Primary Name","","","","","","Russia","Ship","UK","Specification as a ship","","05/05/2023","","Panama"',
  '"02/08/2025","CYB0010","15010","","Example Cyber Group LLC","","","","","","Primary Name Variation","","","","","","Cyber","Entity","UK","Asset freeze","","01/02/2024","",""',
].join('\r\n');
test('primary names, strong aliases, ships and the report date', () => {
  const p = parseUk(UK);
  assert.equal(p.published, '2026-10-01');
  assert.equal(p.entries.length, 3);
  const petrov = p.entries.find((e) => e.uid === 'RUS0001')!;
  assert.equal(petrov.primary, 'Sergei Ivanovich PETROV');
  assert.deepEqual(petrov.aliases, ['Sergey PETROFF']);
  assert.equal(petrov.type, 'individual');
  assert.equal(petrov.listedOn, '2022-03-16');
  assert.equal(petrov.programs, 'Russia');
  const ship = p.entries.find((e) => e.uid === 'RUS0002')!;
  assert.equal(ship.type, 'vessel');
  assert.equal(ship.country, 'Panama');
  assert.equal(p.entries.find((e) => e.uid === 'CYB0010')!.primary, 'Example Cyber Group LLC', 'a variation stands in when no primary name row exists');
  assert.ok(p.warnings[0].includes('weak'));
});
test('falls back to the latest Last Updated date without a report line', () => {
  const p = parseUk(UK.split('\r\n').slice(1).join('\n'));
  assert.equal(p.published, '2026-09-20');
});

console.log('Feeds');
const RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Regulator</title>
  <item><title>Consultation on tokenised money market funds</title><link>/en/news/2026/tokenised-mmf</link>
    <pubDate>Wed, 30 Sep 2026 20:32:14 +0800</pubDate><description><![CDATA[<p>The regulator proposes rules for <b>tokenised</b> funds &amp; stablecoins.</p>]]></description></item>
  <item><title>Board appointments</title><link>https://example.org/board</link><pubDate>Wednesday, September 30, 2026 - 17:17</pubDate>
    <description>&lt;p&gt;New members join the board.&lt;/p&gt;</description></item>
  <item><title>No link here</title></item>
</channel></rss>`;
const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Agency</title>
  <entry><title type="html">Guidance on virtual asset service providers</title>
    <link rel="self" href="https://example.org/self"/><link rel="alternate" href="https://example.org/vasp"/>
    <updated>2026-09-29T09:00:00Z</updated><summary>Travel rule expectations.</summary></entry>
</feed>`;
test('RSS 2.0: CDATA and escaped HTML summaries, relative links, loose dates', () => {
  const items = parseFeed(RSS, 'https://www.regulator.example/en/rss');
  assert.equal(items.length, 2);
  assert.equal(items[0].url, 'https://www.regulator.example/en/news/2026/tokenised-mmf');
  assert.equal(items[0].summary, 'The regulator proposes rules for tokenised funds & stablecoins.');
  assert.equal(items[0].published, '2026-09-30T12:32:14.000Z');
  assert.equal(items[1].summary, 'New members join the board.');
  assert.equal(items[1].published, '2026-09-30T17:17:00.000Z');
});
test('Atom: alternate link, updated date, summary', () => {
  const [it] = parseFeed(ATOM);
  assert.equal(it.url, 'https://example.org/vasp');
  assert.equal(it.title, 'Guidance on virtual asset service providers');
  assert.equal(it.published, '2026-09-29T09:00:00.000Z');
  assert.equal(it.summary, 'Travel rule expectations.');
});
test('relevance topics match whole terms only', () => {
  assert.deepEqual(matchTopics('Consultation on tokenised money market funds', 'stablecoin reserves'), ['tokenization', 'stablecoin', 'fund', 'money market']);
  assert.deepEqual(matchTopics('Refund scheme for funding providers'), []);
  assert.deepEqual(matchTopics('Changes to AIFMD reporting', 'UCITS and private placement'), ['private placement', 'AIF', 'UCITS']);
  assert.deepEqual(matchTopics('FCA opens the gateway to regulated crypto'), ['crypto']);
  assert.deepEqual(matchTopics('Guidance on virtual asset service providers', 'Travel rule expectations.'), ['virtual asset', 'travel rule']);
});
test('page text: scripts, styles and navigation removed, entities decoded, length capped', () => {
  const html = `<html><head><title>T</title><style>.x{}</style></head><body><nav>Menu Home</nav>
    <main><h1>Circular</h1><script>var a = "<p>";</script><p>Professional&nbsp;investors &amp; tokenised&#8209;funds.</p>${'<p>More text here.</p>'.repeat(30)}</main>
    <footer>Contact</footer></body></html>`;
  const t = htmlToText(html, 120);
  assert.ok(t.startsWith('Circular Professional investors & tokenised'), t);
  assert.ok(!t.includes('var a') && !t.includes('Menu') && !t.includes('Contact'));
  assert.equal(t.length, 120);
  assert.equal(decodeEntities('&#x41;&#66;&lt;&unknown;'), 'AB<&unknown;');
});
test('publication id is the first 24 hex characters of sha256(url)', () => {
  const url = 'https://www.fca.org.uk/news/press-releases/fca-opens-gateway-regulated-crypto';
  assert.equal(pubId(url), createHash('sha256').update(url).digest('hex').slice(0, 24));
  assert.equal(pubId(url).length, 24);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
