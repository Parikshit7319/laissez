-- Migration 006: credential network, investor portal and Travel Rule (TRP) columns, plus the permanent
-- fictional network distributor every sandbox can import clients from. Safe to run more than once.
-- Statements are separated by a line containing only "-- ;".

-- ---------- Columns used by the network, portal and Travel Rule routes ----------
alter table credential_shares add column if not exists booking_center text
-- ;
alter table credential_shares add column if not exists requested_by_name text
-- ;
alter table credential_shares add column if not exists consent_expires_at timestamptz
-- ;
create index if not exists credential_shares_to on credential_shares (to_workspace, status)
-- ;
create index if not exists credential_shares_from on credential_shares (from_workspace, credential_id)
-- ;
alter table evidence_submissions add column if not exists review_note text
-- ;
alter table travel_rule_messages add column if not exists timeline jsonb not null default '[]'::jsonb
-- ;
alter table travel_rule_messages add column if not exists next_url text
-- ;
create index if not exists travel_rule_by_decision on travel_rule_messages (workspace_id, decision_id)
-- ;
create index if not exists travel_rule_by_request on travel_rule_messages (workspace_id, request_identifier)
-- ;
create index if not exists portal_access_investor on portal_access (workspace_id, investor_id)
-- ;
create index if not exists portal_requests_investor on portal_requests (workspace_id, investor_id, status)
-- ;

-- ---------- Halden & Co. Private Bank (fictional): the permanent network distributor ----------
insert into workspaces (id, name, kind, slug, brand_name, brand_color, expires_at)
values ('a1de0000-0000-4000-8000-000000000001', 'Halden & Co. Private Bank (fictional)', 'network', 'halden-network', 'Halden & Co. Private Bank (fictional)', '#2b3a55', null)
on conflict (id) do update set name = excluded.name, kind = 'network', brand_name = excluded.brand_name, brand_color = excluded.brand_color, expires_at = null
-- ;
insert into investors (workspace_id, id, name, short_name, kind, residence, city, booking_center, us_person, wallet, email) values
  ('a1de0000-0000-4000-8000-000000000001', 'hal_orrin', 'Orrin Capital Pte. Ltd.', 'Orrin Capital', 'Investment holding company', 'SG', 'Singapore', 'SG', false, '0x4e0b…a7c2', 'treasury@orrin-capital.example'),
  ('a1de0000-0000-4000-8000-000000000001', 'hal_vasari', 'Vasari Family Trust', 'Vasari Family Trust', 'Family trust', 'CH', 'Geneva', 'ZRH', false, '0x91d4…3b0f', 'trustees@vasari-trust.example'),
  ('a1de0000-0000-4000-8000-000000000001', 'hal_hanami', 'Hanami Asset Holdings Ltd', 'Hanami Asset Holdings', 'Holding company', 'HK', 'Hong Kong', 'HK', false, '0x2c8a…e514', 'operations@hanami-holdings.example'),
  ('a1de0000-0000-4000-8000-000000000001', 'hal_albescu', 'Albescu Treasury GmbH', 'Albescu Treasury', 'Corporate treasury', 'DE', 'Düsseldorf', 'ZRH', false, '0x6f37…09cd', 'treasury@albescu.example')
on conflict (workspace_id, id) do nothing
-- ;
insert into credentials (workspace_id, id, investor_id, issued_on, expires_on, status, lzid, issuer_name) values
  ('a1de0000-0000-4000-8000-000000000001', 'LP-SG-5521-0817', 'hal_orrin', '2026-05-12', '2027-05-12', 'active', 'LZ-7K2M-9QX4-PA3D', 'Halden & Co. Private Bank (fictional)'),
  ('a1de0000-0000-4000-8000-000000000001', 'LP-CH-3308-1146', 'hal_vasari', '2026-06-03', '2027-06-03', 'active', 'LZ-H4VN-2RTB-8WQE', 'Halden & Co. Private Bank (fictional)'),
  ('a1de0000-0000-4000-8000-000000000001', 'LP-HK-7742-2093', 'hal_hanami', '2026-04-21', '2027-04-21', 'active', 'LZ-M9C3-XK7P-4HJA', 'Halden & Co. Private Bank (fictional)'),
  ('a1de0000-0000-4000-8000-000000000001', 'LP-DE-6615-4470', 'hal_albescu', '2026-07-08', '2027-07-08', 'active', 'LZ-R2DF-6YNS-KB5T', 'Halden & Co. Private Bank (fictional)')
on conflict do nothing
-- ;
insert into classifications (workspace_id, credential_id, class_code, basis, verified_on, expires_on, opt_in_on)
select 'a1de0000-0000-4000-8000-000000000001', v.credential_id, v.class_code, v.basis, v.verified_on::date, v.expires_on::date, v.opt_in_on::date
from (values
  ('LP-SG-5521-0817', 'SG_AI', 'Corporation with net assets of S$62.5M (audited accounts, FY2025). Opt-in to accredited investor status signed.', '2026-05-12', '2027-05-12', '2026-05-12'),
  ('LP-CH-3308-1146', 'CH_PRO', 'Private investment structure with professional treasury operations, set up for a high-net-worth family.', '2026-06-03', '2027-06-03', null),
  ('LP-HK-7742-2093', 'HK_PI', 'Corporation with a portfolio of HK$126M (custodian statement, March 2026).', '2026-04-21', '2027-04-21', null),
  ('LP-DE-6615-4470', 'EU_PRO', 'Large undertaking: balance sheet EUR 640M, net turnover EUR 1.2B, own funds EUR 210M.', '2026-07-08', '2027-07-08', null),
  ('LP-DE-6615-4470', 'CH_PRO', 'Large company meeting all three FinSA size thresholds.', '2026-07-08', '2027-07-08', null)
) as v(credential_id, class_code, basis, verified_on, expires_on, opt_in_on)
where not exists (
  select 1 from classifications x where x.workspace_id = 'a1de0000-0000-4000-8000-000000000001' and x.credential_id = v.credential_id and x.class_code = v.class_code
)
-- ;
insert into audit_events (workspace_id, type, subject, data, actor, actor_name)
select 'a1de0000-0000-4000-8000-000000000001', 'organization.created', 'a1de0000-0000-4000-8000-000000000001',
  '{"note": "Permanent fictional network distributor for sandboxes", "investors": 4}'::jsonb, 'system', 'Laissez'
where not exists (select 1 from audit_events where workspace_id = 'a1de0000-0000-4000-8000-000000000001')
