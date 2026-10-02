-- Migration 007: engine metadata. Opt-in labels on investor classes, "any of" law requirements on a fund's
-- distribution list, Regulation S category and offering date on funds, booking centers accepting several classes,
-- the United States and India rule packs (US_QP, US_QIB, US_IAI, IN_AI, IN_LRS, IFSCA_PRO, the GIFT City booking
-- center) and the sanctions pack history. Idempotent: rerunning it changes nothing.
-- Statements are separated by lines containing only "-- ;" (see api/db/migrate.mjs).

-- ---------- Opt-in and notification requirements from class metadata ----------
alter table investor_classes add column if not exists opt_in_label text
-- ;
update investor_classes set opt_in_label = v.label, requires_opt_in = v.required
from (values
  ('SG_AI', 'opt-in', true),
  ('GB_EPRO', 'written opt-up', true),
  ('JP_QII', 'FSA notification', false)
) as v(code, label, required)
where investor_classes.code = v.code and (investor_classes.opt_in_label is distinct from v.label or investor_classes.requires_opt_in is distinct from v.required)
-- ;

-- ---------- A jurisdiction's law may accept more than one class ----------
alter table fund_distribution add column if not exists law_requires_any text[]
-- ;
update fund_distribution set law_requires_any = array[law_requires] where law_requires_any is null and law_requires is not null
-- ;
-- GB: per se (COBS 3.5.2R) or elective professional with a written opt-up (COBS 3.5.3R) both satisfy the UK NPPR.
update fund_distribution set law_requires_any = array['GB_PRO', 'GB_EPRO'],
  law_text = 'Non-UK AIF marketed under the UK national private placement regime after notice to the FCA: professional investors only. A professional investor is a per se professional client (COBS 3.5.2R) or an elective professional client who opted up in writing (COBS 3.5.3R).',
  law_ref = 'AIFM Regs 2013 regs 57-59; COBS 3.5.2R, 3.5.3R'
where jurisdiction = 'GB' and law_requires = 'GB_PRO' and not (law_requires_any @> array['GB_EPRO'])
-- ;

-- ---------- Regulation S category and offering date (distribution compliance period, Rule 903(b)(3)) ----------
alter table funds add column if not exists reg_s_category int
-- ;
alter table funds add column if not exists offering_date date
-- ;

-- ---------- Booking centers may accept several classes ----------
alter table booking_centers add column if not exists requires_any text[]
-- ;

-- ---------- India ----------
insert into jurisdictions (code, name, iso3, comprehensive_sanctions, iso_numeric) values ('IN', 'India', 'IND', null, '356')
on conflict (code) do nothing
-- ;

-- ---------- Investor classes: United States and India ----------
insert into investor_classes (code, jurisdiction, label, stamp, rule_ref, source_id, threshold, requires_opt_in, opt_in_label) values
  ('US_QP', 'US', 'Qualified purchaser', 'Qualified purchaser', 'ICA §2(a)(51)', 'ica-2a51', 'Natural persons and family companies with at least $5M in investments; other entities that own and invest on a discretionary basis at least $25M; entities owned entirely by qualified purchasers.', false, null),
  ('US_QIB', 'US', 'Qualified institutional buyer', 'QIB', 'Rule 144A(a)(1)', 'us-144a', 'Institutions owning and investing on a discretionary basis at least $100M in securities of unaffiliated issuers; registered dealers at $10M; banks also need $25M audited net worth.', false, null),
  ('US_IAI', 'US', 'Institutional accredited investor', 'Institutional AI', 'Reg D Rule 501(a)(1), (2), (3), (7)', 'reg-d-501', 'Banks, broker-dealers, insurers, registered investment companies and other 501(a)(1) institutions; private BDCs; organizations and trusts not formed for the investment with total assets over $5M.', false, null),
  ('IN_AI', 'IN', 'Accredited investor (SEBI)', 'Accredited investor', 'SEBI AIF Master Circular Ch. 12 (circular of Aug 26, 2021)', 'sebi-ai', 'Individual: annual income of at least INR 2 crore; or net worth of at least INR 7.5 crore with INR 3.75 crore in financial assets; or income of at least INR 1 crore plus net worth of at least INR 5 crore with half financial. Body corporate or trust: net worth of at least INR 50 crore.', false, null),
  ('IN_LRS', 'IN', 'Resident individual within the LRS', 'LRS remitter', 'RBI Master Direction No. 7/2015-16', 'rbi-lrs', 'Resident individual with a PAN remitting under the Liberalised Remittance Scheme: USD 250,000 per financial year (April to March) across all purposes. Not available to companies, firms, HUFs or trusts.', false, null),
  ('IFSCA_PRO', 'IN', 'Accredited investor (IFSCA)', 'IFSCA accredited', 'IFSCA circular IFSCA-IF-10PR/1/2023-Capital Markets', 'ifsca-ai', 'Individual: annual gross income of at least US$200,000, or net assets of at least US$1M with US$500,000 in financial assets. Body corporate or trust: net worth of at least US$5M, or every constituent an accredited investor.', false, null)
on conflict (code) do nothing
-- ;

-- ---------- Booking center: GIFT City (fictional IFSCA licensee) ----------
insert into booking_centers (id, name, jurisdiction, licence, requires_class, rule_text, rule_ref, source_id, requires_any) values
  ('GIFT', 'GIFT City (IFSC)', 'IN', 'IFSCA-registered fund management entity (fictional licensee)', 'IFSCA_PRO', 'Foreign fund units distributed from GIFT City: accredited investors only (IFSCA or SEBI accredited).', 'IFSCA (Fund Management) Regulations 2025; IFSCA AI circular', 'ifsca-ai', array['IFSCA_PRO', 'IN_AI'])
on conflict (id) do nothing
-- ;
update booking_centers set requires_any = array['IFSCA_PRO', 'IN_AI'] where id = 'GIFT' and requires_any is null
-- ;

-- ---------- Rule packs: sanctions history, US 2026.10.0, IN 2026.10.0 ----------
insert into rule_packs (id, version, jurisdiction, status, summary, effective_from, effective_to, approved_by) values
  ('global/sanctions', '2024-01-01', 'GLOBAL', 'retired', 'Comprehensive OFAC country programs: Cuba, Iran, North Korea, Syria, occupied regions of Ukraine.', '2024-01-01'::date, '2025-08-25'::date, 'pending counsel review'),
  ('global/sanctions', '2025-08-25', 'GLOBAL', 'retired', 'Comprehensive OFAC country programs: Cuba, Iran, North Korea, occupied regions of Ukraine. Syria program removed Aug 25, 2025 (Executive Order 14312).', '2025-08-25'::date, '2026-10-01'::date, 'pending counsel review'),
  ('US/eligibility', '2026.10.0', 'US', 'active', 'Adds qualified purchasers (ICA 2(a)(51)), qualified institutional buyers (Rule 144A) and institutional accredited investors (Rule 501(a)(1), (2), (3), (7)); Section 3(c)(7) funds carry the Exchange Act 12(g) 2,000 holders of record threshold instead of the 100-owner cap; Regulation S Category 3 distribution compliance period on resales to U.S. persons (Rule 903(b)(3)).', '2026-10-02'::date, null::date, 'pending counsel review'),
  ('IN/eligibility', '2026.10.0', 'IN', 'active', 'SEBI accredited investors (AIF Master Circular Ch. 12); resident individuals within the RBI Liberalised Remittance Scheme (USD 250,000 per financial year); IFSCA accredited investors for GIFT City; overseas portfolio investment under the FEM (Overseas Investment) Rules 2022; Companies Act s42 200-person private placement limit.', '2026-10-02'::date, null::date, 'pending counsel review')
on conflict (id, version) do nothing
-- ;
update rule_packs set status = 'retired', effective_to = '2026-10-02'::date where id = 'US/eligibility' and version = '2026.07.0' and (status <> 'retired' or effective_to is distinct from '2026-10-02'::date)
-- ;
update rule_packs set summary = 'Per se professional clients (COBS 3.5.2R) or elective professional clients with a written opt-up (COBS 3.5.3R); UK national private placement after FCA notification (AIFM Regulations 2013 regs 57 to 59).'
where id = 'GB/eligibility' and version = '2026.10.0' and summary like '%not yet accepted%'
