-- Migration 002: accounts and organizations, tenant isolation, audit chain,
-- compliance engine, network, portal, Travel Rule, chain settlement, platform.
-- Statements are separated by a line containing only "-- ;" so function bodies can hold semicolons.

create extension if not exists pg_trgm
-- ;
create or replace function app_ws() returns uuid language sql stable as $$ select nullif(current_setting('app.ws', true), '')::uuid $$
-- ;

-- ---------- Organizations and people ----------
alter table workspaces add column if not exists kind text not null default 'sandbox'
-- ;
alter table workspaces add column if not exists slug text unique
-- ;
alter table workspaces add column if not exists brand_name text
-- ;
alter table workspaces add column if not exists brand_color text
-- ;
alter table workspaces add column if not exists sso jsonb
-- ;
alter table workspaces add column if not exists created_by uuid
-- ;
alter table workspaces alter column expires_at drop not null
-- ;
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  title text,
  fictional boolean not null default false,
  sandbox_workspace uuid references workspaces(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
)
-- ;
create table if not exists passkeys (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  public_key text not null,
  alg int not null,
  sign_count bigint not null default 0,
  transports text[],
  name text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
)
-- ;
create table if not exists memberships (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('admin', 'ops', 'compliance', 'issuer', 'developer', 'auditor')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
)
-- ;
create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null references users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  acting_as uuid references users(id) on delete set null,
  method text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip_hash text,
  user_agent text
)
-- ;
create table if not exists auth_challenges (
  id uuid primary key default gen_random_uuid(),
  challenge text not null,
  purpose text not null,
  data jsonb not null default '{}',
  expires_at timestamptz not null default now() + interval '10 minutes'
)
-- ;
create table if not exists invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'ops', 'compliance', 'issuer', 'developer', 'auditor')),
  token_hash text not null unique,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references users(id) on delete set null
)
-- ;

-- ---------- API keys ----------
alter table api_keys add column if not exists name text not null default 'Default key'
-- ;
alter table api_keys add column if not exists scopes text[] not null default '{read,orders,clients,funds,developer,admin}'
-- ;
alter table api_keys add column if not exists ip_allowlist text[]
-- ;
alter table api_keys add column if not exists expires_at timestamptz
-- ;
alter table api_keys add column if not exists created_by uuid references users(id) on delete set null
-- ;
alter table api_keys add column if not exists rotated_from uuid
-- ;
create table if not exists idempotency_keys (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  key text not null,
  method text not null,
  path text not null,
  request_hash text not null,
  status int,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (workspace_id, key)
)
-- ;

-- ---------- Tamper-evident audit log ----------
alter table audit_events add column if not exists seq bigint
-- ;
alter table audit_events add column if not exists prev_hash text
-- ;
alter table audit_events add column if not exists hash text
-- ;
alter table audit_events add column if not exists actor text
-- ;
alter table audit_events add column if not exists actor_name text
-- ;
create or replace function audit_hash(p_seq bigint, p_ws uuid, p_type text, p_subject text, p_data jsonb, p_actor text, p_at timestamptz, p_prev text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(concat_ws('|', p_seq::text, p_ws::text, p_type, coalesce(p_subject, ''), p_data::text, coalesce(p_actor, ''),
    to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), p_prev), 'UTF8')), 'hex')
$$
-- ;
do $$
declare w record; e record; s bigint; prev text; h text;
begin
  for w in select distinct workspace_id from audit_events where hash is null loop
    s := 0; prev := repeat('0', 64);
    for e in select * from audit_events where workspace_id = w.workspace_id order by id loop
      s := s + 1;
      h := audit_hash(s, e.workspace_id, e.type, e.subject, e.data, e.actor, e.created_at, prev);
      update audit_events set seq = s, prev_hash = prev, hash = h where id = e.id;
      prev := h;
    end loop;
  end loop;
end $$
-- ;
create or replace function audit_chain() returns trigger language plpgsql as $$
declare last_seq bigint; last_hash text;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id::text, 0));
  select seq, hash into last_seq, last_hash from audit_events where workspace_id = new.workspace_id order by seq desc nulls last limit 1;
  new.seq := coalesce(last_seq, 0) + 1;
  new.prev_hash := coalesce(last_hash, repeat('0', 64));
  new.created_at := coalesce(new.created_at, now());
  new.hash := audit_hash(new.seq, new.workspace_id, new.type, new.subject, new.data, new.actor, new.created_at, new.prev_hash);
  return new;
end $$
-- ;
drop trigger if exists audit_chain on audit_events
-- ;
create trigger audit_chain before insert on audit_events for each row execute function audit_chain()
-- ;
create unique index if not exists audit_seq on audit_events (workspace_id, seq)
-- ;

-- ---------- Credentials, network and point-in-time ----------
alter table credentials add column if not exists lzid text
-- ;
alter table credentials add column if not exists revoked_at timestamptz
-- ;
alter table credentials add column if not exists issuer_name text
-- ;
update credentials set lzid = 'LZ-' || upper(substr(md5(random()::text || id), 1, 4)) || '-' || upper(substr(md5(random()::text), 1, 4)) || '-' || upper(substr(md5(random()::text), 1, 4)) where lzid is null
-- ;
create unique index if not exists credentials_lzid on credentials (lzid)
-- ;
alter table investors add column if not exists relied_share text
-- ;
alter table investors add column if not exists chain_wallet text
-- ;
alter table investors add column if not exists chain_identity text
-- ;
alter table investors add column if not exists chain_onboarded_at timestamptz
-- ;
alter table investors add column if not exists email text
-- ;
create table if not exists credential_shares (
  id text primary key,
  from_workspace uuid not null references workspaces(id) on delete cascade,
  credential_id text not null,
  lzid text not null,
  investor_name text not null,
  to_workspace uuid not null references workspaces(id) on delete cascade,
  to_investor_id text,
  requested_by text,
  purpose text,
  status text not null default 'pending' check (status in ('pending', 'active', 'declined', 'revoked')),
  consent_token_hash text not null unique,
  consent_name text,
  consent_at timestamptz,
  terms jsonb not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text
)
-- ;
alter table rule_packs add column if not exists effective_to date
-- ;
create table if not exists fund_policy_versions (
  workspace_id uuid not null,
  ticker text not null,
  version int not null,
  effective_at timestamptz not null default now(),
  distribution jsonb not null,
  min_subscription numeric,
  holder_cap int,
  lockup_months int,
  published_by text,
  primary key (workspace_id, ticker, version),
  foreign key (workspace_id, ticker) references funds(workspace_id, ticker) on delete cascade
)
-- ;
insert into fund_policy_versions (workspace_id, ticker, version, effective_at, distribution, min_subscription, holder_cap, lockup_months, published_by)
select f.workspace_id, f.ticker, f.policy_version, w.created_at,
  coalesce((select jsonb_object_agg(d.jurisdiction, jsonb_build_object('accepts', d.accepts, 'basis', d.basis, 'lawRequires', d.law_requires, 'lawText', d.law_text, 'lawRef', d.law_ref, 'lawSource', d.law_source)) from fund_distribution d where d.workspace_id = f.workspace_id and d.ticker = f.ticker), '{}'::jsonb),
  f.min_subscription, f.holder_cap, f.lockup_months, 'seed'
from funds f join workspaces w on w.id = f.workspace_id
on conflict do nothing
-- ;
alter table decisions add column if not exists snapshot jsonb
-- ;
alter table decisions add column if not exists dealing_date date
-- ;
alter table decisions add column if not exists actor text
-- ;
alter table policy_changes add column if not exists proposed_by_user uuid
-- ;
alter table policy_changes add column if not exists approved_by_user uuid
-- ;

-- ---------- Monitoring and work queue ----------
create table if not exists holder_status (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  investor_id text not null,
  ticker text not null,
  status text not null,
  reason text not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, investor_id, ticker)
)
-- ;
create table if not exists monitor_runs (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  trigger text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  holders_checked int not null default 0,
  changes int not null default 0,
  items_opened int not null default 0
)
-- ;
create table if not exists work_items (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  kind text not null,
  dedupe_key text not null,
  title text not null,
  detail text not null,
  severity text not null check (severity in ('high', 'medium', 'low')),
  investor_id text,
  ticker text,
  link text,
  status text not null default 'open' check (status in ('open', 'done', 'dismissed')),
  due_on date,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  primary key (workspace_id, id)
)
-- ;
create unique index if not exists work_items_open on work_items (workspace_id, dedupe_key) where status = 'open'
-- ;

-- ---------- Sanctions ----------
create table if not exists sanctions_sources (
  source text primary key,
  name text not null,
  url text not null,
  last_fetched_at timestamptz,
  last_published text,
  entries int not null default 0,
  status text not null default 'pending',
  error text
)
-- ;
create table if not exists sanctions_entries (
  id bigserial primary key,
  source text not null references sanctions_sources(source),
  source_uid text not null,
  name text not null,
  name_norm text not null,
  is_alias boolean not null default false,
  primary_name text not null,
  entry_type text,
  programs text,
  country text,
  listed_on text
)
-- ;
create index if not exists sanctions_trgm on sanctions_entries using gin (name_norm gin_trgm_ops)
-- ;
create index if not exists sanctions_src on sanctions_entries (source)
-- ;
insert into sanctions_sources (source, name, url, status) values
  ('OFAC-SDN', 'OFAC Specially Designated Nationals (U.S. Treasury)', 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV', 'pending'),
  ('UN', 'UN Security Council Consolidated List', 'https://scsanctions.un.org/resources/xml/en/consolidated.xml', 'pending'),
  ('EU', 'EU Consolidated Financial Sanctions List', 'https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw', 'pending'),
  ('UK', 'UK Sanctions List (FCDO)', 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.csv', 'pending'),
  ('LAISSEZ-TEST', 'Laissez test entries (fictional, for demos)', 'https://parikshit7319.github.io/laissez/sources/', 'active')
on conflict (source) do nothing
-- ;
insert into sanctions_entries (source, source_uid, name, name_norm, primary_name, entry_type, programs)
select 'LAISSEZ-TEST', 'T-' || row_number() over (order by name), name,
  trim(regexp_replace(regexp_replace(lower(name), '[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g')), name, 'entity', program
from screening_list
where not exists (select 1 from sanctions_entries where source = 'LAISSEZ-TEST')
-- ;
update sanctions_sources set entries = (select count(*) from sanctions_entries where source = 'LAISSEZ-TEST'), last_fetched_at = now() where source = 'LAISSEZ-TEST'
-- ;
create table if not exists screening_hits (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  investor_id text,
  screened_name text not null,
  source text not null,
  source_uid text not null,
  matched_name text not null,
  primary_name text not null,
  programs text,
  score real not null,
  context text not null,
  status text not null default 'open' check (status in ('open', 'false_positive', 'confirmed')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text,
  note text,
  primary key (workspace_id, id)
)
-- ;
create unique index if not exists screening_hits_pair on screening_hits (workspace_id, screened_name, source, source_uid)
-- ;

-- ---------- Regulatory feed ----------
create table if not exists reg_publications (
  id text primary key,
  regulator text not null,
  jurisdiction text,
  title text not null,
  url text not null,
  published_at timestamptz,
  summary text,
  body_excerpt text,
  relevant boolean not null default false,
  topics text[],
  fetched_at timestamptz not null default now()
)
-- ;
alter table rule_drafts add column if not exists publication_id text
-- ;

-- ---------- Fund lifecycle and documents ----------
alter table funds add column if not exists share_class_type text not null default 'distributing'
-- ;
alter table funds add column if not exists cutoff_time text not null default '16:00'
-- ;
alter table funds add column if not exists cutoff_tz text not null default 'America/New_York'
-- ;
alter table funds add column if not exists dealing_frequency text not null default 'daily'
-- ;
alter table funds add column if not exists notice_days int not null default 0
-- ;
alter table funds add column if not exists gate_pct numeric
-- ;
alter table funds add column if not exists yield_bps numeric
-- ;
alter table funds add column if not exists chain_token text
-- ;
alter table funds add column if not exists treasury_wallet text
-- ;
create table if not exists nav_history (
  workspace_id uuid not null,
  ticker text not null,
  nav_date date not null,
  nav numeric(18, 6) not null,
  daily_yield_bps numeric,
  struck_by text,
  struck_at timestamptz not null default now(),
  primary key (workspace_id, ticker, nav_date),
  foreign key (workspace_id, ticker) references funds(workspace_id, ticker) on delete cascade
)
-- ;
create table if not exists accruals (
  workspace_id uuid not null,
  ticker text not null,
  accrual_date date not null,
  investor_id text not null,
  units numeric(24, 2) not null,
  rate_bps numeric not null,
  amount numeric(20, 6) not null,
  distribution_id text,
  primary key (workspace_id, ticker, accrual_date, investor_id),
  foreign key (workspace_id, ticker) references funds(workspace_id, ticker) on delete cascade
)
-- ;
create table if not exists distributions (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  ticker text not null,
  period_start date not null,
  period_end date not null,
  paid_on date not null,
  total_amount numeric(20, 6) not null,
  reinvested_units numeric(24, 2) not null,
  holders int not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id)
)
-- ;
create table if not exists redemption_notices (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  investor_id text not null,
  ticker text not null,
  units numeric(24, 2) not null,
  notice_date date not null,
  dealing_date date not null,
  status text not null default 'pending' check (status in ('pending', 'executed', 'cancelled')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, id)
)
-- ;
create table if not exists fund_documents (
  workspace_id uuid not null,
  id text not null,
  ticker text not null,
  doc_type text not null,
  title text not null,
  version int not null,
  jurisdiction text,
  audience text not null default 'all',
  content text not null,
  sha256 text not null,
  required boolean not null default true,
  published_at timestamptz not null default now(),
  published_by text,
  superseded_at timestamptz,
  primary key (workspace_id, id),
  foreign key (workspace_id, ticker) references funds(workspace_id, ticker) on delete cascade
)
-- ;
create table if not exists doc_acknowledgments (
  workspace_id uuid not null,
  investor_id text not null,
  document_id text not null,
  sha256 text not null,
  method text not null,
  signed_name text,
  signature text,
  acknowledged_at timestamptz not null default now(),
  primary key (workspace_id, investor_id, document_id),
  foreign key (workspace_id, investor_id) references investors(workspace_id, id) on delete cascade
)
-- ;

-- ---------- Investor portal ----------
create table if not exists portal_access (
  token_hash text primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  investor_id text not null,
  created_by text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  last_used_at timestamptz,
  revoked_at timestamptz
)
-- ;
create table if not exists portal_requests (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  investor_id text not null,
  ticker text not null,
  action text not null,
  amount numeric(20, 2) not null,
  asset text not null,
  signature jsonb not null,
  status text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected')),
  decision_id text,
  note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text,
  primary key (workspace_id, id)
)
-- ;
create table if not exists evidence_submissions (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  investor_id text not null,
  class_code text not null,
  evidence jsonb not null,
  reference text,
  status text not null default 'submitted' check (status in ('submitted', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_by text,
  reviewed_at timestamptz,
  primary key (workspace_id, id)
)
-- ;

-- ---------- Travel Rule ----------
create table if not exists travel_rule_messages (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  decision_id text,
  direction text not null check (direction in ('outbound', 'inbound')),
  originator_vasp text not null,
  beneficiary_vasp text not null,
  travel_address text,
  request_identifier text not null,
  status text not null,
  payload jsonb not null,
  response jsonb,
  beneficiary_address text,
  txid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id)
)
-- ;

-- ---------- Chain settlement and reconciliation ----------
create table if not exists chain_config (key text primary key, value jsonb not null, updated_at timestamptz not null default now())
-- ;
create table if not exists chain_nonces (address text primary key, nonce bigint not null)
-- ;
create table if not exists chain_jobs (
  id text primary key,
  workspace_id uuid references workspaces(id) on delete cascade,
  kind text not null,
  ref text,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'confirmed', 'failed')),
  attempts int not null default 0,
  tx_hashes text[] not null default '{}',
  block bigint,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
-- ;
alter table settlements add column if not exists chain jsonb
-- ;
alter table settlements drop constraint if exists settlements_status_check
-- ;
alter table settlements add constraint settlements_status_check check (status in ('pending', 'settled', 'reverted'))
-- ;
create table if not exists recon_runs (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  positions int not null default 0,
  breaks int not null default 0,
  chain_block bigint,
  trigger text not null default 'manual'
)
-- ;
create table if not exists recon_breaks (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  run_id bigint not null,
  investor_id text not null,
  ticker text not null,
  register_units numeric(24, 2) not null,
  chain_units numeric(24, 2) not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolution text,
  note text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id)
)
-- ;
create table if not exists audit_anchors (
  id bigserial primary key,
  anchor_date date not null unique,
  merkle_root text not null,
  leaves int not null,
  tx_hash text,
  block bigint,
  status text not null default 'pending',
  created_at timestamptz not null default now()
)
-- ;
create table if not exists audit_anchor_leaves (
  anchor_id bigint not null references audit_anchors(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  seq bigint not null,
  head_hash text not null,
  leaf text not null,
  proof jsonb not null,
  primary key (anchor_id, workspace_id)
)
-- ;

-- ---------- Platform ----------
alter table webhook_deliveries add column if not exists replay_of bigint
-- ;
create table if not exists uptime_checks (
  id bigserial primary key,
  checked_at timestamptz not null default now(),
  component text not null,
  ok boolean not null,
  latency_ms int,
  detail text
)
-- ;
create index if not exists uptime_recent on uptime_checks (component, checked_at desc)
-- ;
create table if not exists product_events (
  id bigserial primary key,
  workspace_id uuid references workspaces(id) on delete set null,
  anon_id text,
  event text not null,
  props jsonb not null default '{}',
  created_at timestamptz not null default now()
)
-- ;
create index if not exists product_events_by on product_events (event, created_at)
