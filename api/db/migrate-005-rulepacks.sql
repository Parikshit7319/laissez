-- Migration 005: rule packs for GB, JP, AE-ADGM, LU and IE, and the version history of every pack.
-- Generated from src/proto/rulepacks.ts. Insert-only and idempotent: rerunning it changes nothing.
-- Statements are separated by lines containing only "-- ;" (see api/db/migrate.mjs).
-- Adds a nullable ISO 3166-1 numeric code to jurisdictions.
alter table jurisdictions add column if not exists iso_numeric text
-- ;
-- New jurisdictions. GB already exists from the launch seed and is left as it is.
-- GLOBAL holds cross-jurisdiction packs (sanctions, Travel Rule). It is not a residence.
insert into jurisdictions (code, name, iso3, comprehensive_sanctions, iso_numeric) values
  ('GB', 'United Kingdom', 'GBR', null, '826'),
  ('JP', 'Japan', 'JPN', null, '392'),
  ('AE-ADGM', 'UAE (ADGM)', 'ARE', null, '784'),
  ('LU', 'Luxembourg', 'LUX', null, '442'),
  ('IE', 'Ireland', 'IRL', null, '372'),
  ('GLOBAL', 'Global (cross-jurisdiction rule packs)', 'XGL', null, null)
on conflict (code) do nothing
-- ;
-- Backfill ISO numeric codes where missing.
update jurisdictions j set iso_numeric = v.iso_numeric
from (values
  ('SG', '702'),
  ('HK', '344'),
  ('CH', '756'),
  ('DE', '276'),
  ('AE-DIFC', '784'),
  ('US', '840'),
  ('IR', '364'),
  ('CU', '192'),
  ('KP', '408'),
  ('GB', '826'),
  ('JP', '392'),
  ('AE-ADGM', '784'),
  ('LU', '442'),
  ('IE', '372')
) as v(code, iso_numeric)
where j.code = v.code and j.iso_numeric is null
-- ;
-- New investor classes. Luxembourg and Ireland reuse EU_PRO.
insert into investor_classes (code, jurisdiction, label, stamp, rule_ref, source_id, threshold, requires_opt_in) values
  ('GB_PRO', 'GB', 'Professional client (per se)', 'Professional client', 'COBS 3.5.2R', 'fca-cobs35', 'Authorised or regulated entity, or a large undertaking meeting 2 of 3: balance sheet EUR 20M, net turnover EUR 40M, own funds EUR 2M.', false),
  ('GB_EPRO', 'GB', 'Elective professional client', 'Elective professional', 'COBS 3.5.3R', 'fca-cobs35', 'Qualitative assessment plus 2 of 3: 10 significant trades per quarter over four quarters, a portfolio over EUR 500K, one year in a professional finance role. The client opts up in writing after a written warning.', true),
  ('JP_QII', 'JP', 'Qualified institutional investor', 'QII', 'Definitions Ordinance Art. 10(1)', 'jp-qii', 'Listed financial institutions, or a corporation or individual with securities of JPY 1 billion or more that has notified the FSA. Individuals also need a securities account open for a year. Notified status lasts two years.', false),
  ('ADGM_PRO', 'AE-ADGM', 'Professional client', 'Professional client', 'FSRA COBS 2.4', 'adgm-cobs', 'Individual: net assets of at least US$1M excluding primary residence, plus experience. Undertaking: own funds of at least US$1M plus experience, or 2 of 3: US$20M balance sheet, US$40M turnover, US$2M own funds.', false)
on conflict (code) do nothing
-- ;
-- New booking centers (fictional licensees).
insert into booking_centers (id, name, jurisdiction, licence, requires_class, rule_text, rule_ref, source_id) values
  ('LDN', 'London', 'GB', 'FCA-authorised investment firm (fictional licensee)', 'GB_PRO', 'Promoting an unregulated collective investment scheme from the UK: professional clients only.', 'FSMA s238; COBS 4.12B', 'fca-cobs412b'),
  ('TYO', 'Tokyo', 'JP', 'Type II financial instruments business operator (fictional licensee)', 'JP_QII', 'Handling a QII-only private placement from Japan: qualified institutional investors only.', 'FIEA Art. 2(3)(ii)(a)', 'jp-fiea'),
  ('ADGM', 'Abu Dhabi (ADGM)', 'AE-ADGM', 'FSRA financial services permission, Professional Clients only (fictional licensee)', 'ADGM_PRO', 'Firm permitted to deal with Professional Clients only.', 'FSRA COBS 2.4', 'adgm-cobs')
on conflict (id) do nothing
-- ;
-- Global packs were filed under US for want of a global row.
update rule_packs set jurisdiction = 'GLOBAL' where id like 'global/%' and jurisdiction <> 'GLOBAL'
-- ;
-- Every pack version. Existing rows are kept as they are.
insert into rule_packs (id, version, jurisdiction, status, summary, effective_from, effective_to, approved_by) values
  ('SG/eligibility', '2026.03.0', 'SG', 'retired', 'Earlier Singapore pack: accredited investor (SFA s4A) with opt-in; restricted scheme offers (SFA s305). Kept so decisions made before Sep 1, 2026 replay against the pack then in force.', '2026-03-01'::date, '2026-09-01'::date, 'pending counsel review'),
  ('SG/eligibility', '2026.09.0', 'SG', 'active', 'Accredited investor (SFA s4A) with opt-in; restricted scheme offers (SFA s305).', '2026-09-01'::date, null::date, 'pending counsel review'),
  ('HK/eligibility', '2026.04.2', 'HK', 'active', 'Professional investor thresholds (Cap. 571D); funds not authorized by the SFC.', '2026-04-20'::date, null::date, 'pending counsel review'),
  ('CH/eligibility', '2026.07.0', 'CH', 'active', 'Per-se professional clients (FinSA Art. 4); foreign funds not approved for retail.', '2026-07-01'::date, null::date, 'pending counsel review'),
  ('DE/eligibility', '2026.07.0', 'DE', 'active', 'MiFID II professional clients; UCITS retail passport; AIFMD Art. 42 private placement.', '2026-07-01'::date, null::date, 'pending counsel review'),
  ('AE-DIFC/eligibility', '2026.07.0', 'AE-DIFC', 'active', 'DFSA professional clients (COB 2.3).', '2026-07-01'::date, null::date, 'pending counsel review'),
  ('US/eligibility', '2026.07.0', 'US', 'active', 'Accredited investors (Reg D 501(a)); Regulation S offshore restrictions; Section 3(c)(1) holder limit.', '2026-07-01'::date, null::date, 'pending counsel review'),
  ('GB/eligibility', 'draft-cp2536', 'GB', 'draft', 'Drafted against FCA CP25/36: proposed GBP 10M investable-assets route. Inactive until final rules.', null::date, null::date, null),
  ('GB/eligibility', '2026.10.0', 'GB', 'active', 'Per se professional clients (COBS 3.5.2R); UK national private placement after FCA notification (AIFM Regulations 2013 regs 57 to 59). Elective professionals (COBS 3.5.3R) are recorded but not yet accepted.', '2026-10-01'::date, null::date, 'pending counsel review'),
  ('JP/eligibility', '2026.10.0', 'JP', 'active', 'Qualified institutional investors (Definitions Ordinance Art. 10): JPY 1 billion securities test with FSA notification; QII-only private placement (FIEA Art. 2(3)(ii)(a)).', '2026-10-01'::date, null::date, 'pending counsel review'),
  ('AE-ADGM/eligibility', '2026.10.0', 'AE-ADGM', 'active', 'FSRA Professional Clients (COBS 2.4); foreign funds offered to Professional Clients with FSRA notification within 30 days (FUNDS 10.1).', '2026-10-01'::date, null::date, 'pending counsel review'),
  ('LU/eligibility', '2026.10.0', 'LU', 'active', 'MiFID II per se professional clients; non-EU AIF marketing under Art. 45 of the Law of 12 July 2013 after the CSSF information form.', '2026-10-01'::date, null::date, 'pending counsel review'),
  ('IE/eligibility', '2026.10.0', 'IE', 'active', 'MiFID II per se professional clients; non-EU AIF marketing under Reg. 43 of S.I. No. 257 of 2013 after Central Bank notification.', '2026-10-01'::date, null::date, 'pending counsel review'),
  ('global/sanctions', '2026-10-01', 'GLOBAL', 'active', 'Comprehensive OFAC country programs: Cuba, Iran, North Korea, occupied regions of Ukraine. Syria removed Aug 25, 2025.', '2026-10-01'::date, null::date, 'pending counsel review'),
  ('global/travel-rule', '2026.07', 'GLOBAL', 'active', 'FATF Recommendation 16: originator and beneficiary data for transfers of USD/EUR 1,000 or more.', '2026-07-16'::date, null::date, 'pending counsel review')
on conflict (id, version) do nothing
-- ;
-- Effective dates on every version, including rows that existed before this migration.
update rule_packs r set effective_from = v.effective_from, effective_to = v.effective_to
from (values
  ('SG/eligibility', '2026.03.0', '2026-03-01'::date, '2026-09-01'::date),
  ('SG/eligibility', '2026.09.0', '2026-09-01'::date, null::date),
  ('HK/eligibility', '2026.04.2', '2026-04-20'::date, null::date),
  ('CH/eligibility', '2026.07.0', '2026-07-01'::date, null::date),
  ('DE/eligibility', '2026.07.0', '2026-07-01'::date, null::date),
  ('AE-DIFC/eligibility', '2026.07.0', '2026-07-01'::date, null::date),
  ('US/eligibility', '2026.07.0', '2026-07-01'::date, null::date),
  ('GB/eligibility', 'draft-cp2536', null::date, null::date),
  ('GB/eligibility', '2026.10.0', '2026-10-01'::date, null::date),
  ('JP/eligibility', '2026.10.0', '2026-10-01'::date, null::date),
  ('AE-ADGM/eligibility', '2026.10.0', '2026-10-01'::date, null::date),
  ('LU/eligibility', '2026.10.0', '2026-10-01'::date, null::date),
  ('IE/eligibility', '2026.10.0', '2026-10-01'::date, null::date),
  ('global/sanctions', '2026-10-01', '2026-10-01'::date, null::date),
  ('global/travel-rule', '2026.07', '2026-07-16'::date, null::date)
) as v(id, version, effective_from, effective_to)
where r.id = v.id and r.version = v.version
  and (r.effective_from is distinct from v.effective_from or r.effective_to is distinct from v.effective_to)
