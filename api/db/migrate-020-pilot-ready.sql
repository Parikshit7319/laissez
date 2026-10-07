-- Migration 020: decide-only mode, step-up confirmation, per-decision pricing, identity verification evidence,
-- PEP and adverse media reviews, audit log export destinations, investor portal accounts.
-- Statements are separated by a line containing only "-- ;". Tenant tables follow migrate-003 (grant plus policy);
-- tables that hold secrets, sealed evidence or cross tenants are owner-only (no grant to laissez_rt).

-- ---------- Organizations: settlement mode ----------
-- full: Laissez decides and settles. decide_only: Laissez decides and keeps the evidence; the customer settles on its
-- own rails, and every settlement and chain route answers 403 decide_only_mode.
alter table workspaces add column if not exists settlement_mode text not null default 'full' check (settlement_mode in ('full', 'decide_only'))
-- ;

-- ---------- Sessions: last fresh passkey assertion ----------
alter table sessions add column if not exists stepped_up_at timestamptz
-- ;

-- ---------- Contracts: a price per allowed decision ----------
alter table contracts add column if not exists decision_fee_cents bigint not null default 0 check (decision_fee_cents >= 0)
-- ;
alter table usage_daily add column if not exists decisions_allowed int not null default 0
-- ;
alter table contracts drop constraint if exists contracts_plan_check
-- ;
alter table contracts add constraint contracts_plan_check check (plan in ('platform', 'enterprise', 'pilot', 'decisions'))
-- ;

-- ---------- Identity verification by a provider (Sumsub), evidence sealed at rest ----------
-- One row per check an investor goes through. The provider's full result is encrypted with EVIDENCE_ENC_KEY before it is
-- stored; reading it writes a row in evidence_access_log. The tenant role cannot select the sealed column.
create table if not exists kyc_checks (
  id text primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  investor_id text not null,
  provider text not null default 'sumsub',
  applicant_id text,
  level_name text,
  status text not null default 'started' check (status in ('started', 'pending', 'approved', 'rejected', 'retry', 'expired')),
  outcome jsonb not null default '{}',
  evidence_enc text,
  evidence_sha256 text,
  created_by text not null,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  last_webhook_at timestamptz
)
-- ;
create index if not exists kyc_checks_ws_inv on kyc_checks (workspace_id, investor_id, created_at desc)
-- ;
create table if not exists evidence_access_log (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  object_kind text not null,
  object_id text not null,
  accessed_by text not null,
  purpose text not null,
  ip_hash text,
  accessed_at timestamptz not null default now()
)
-- ;
create index if not exists evidence_access_ws on evidence_access_log (workspace_id, accessed_at desc)
-- ;

-- ---------- PEP and adverse media reviews ----------
-- A review per investor and kind. PEP hits come from the OpenSanctions PEP list through the same screening path as
-- sanctions (source 'OS-PEP'); adverse media is recorded by a person, or by a provider when one is configured.
create table if not exists screening_reviews (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  investor_id text not null,
  kind text not null check (kind in ('pep', 'adverse_media')),
  result text not null check (result in ('clear', 'hit', 'pending')),
  source text not null,
  summary text,
  references_json jsonb not null default '[]',
  reviewed_by text not null,
  reviewed_at timestamptz not null default now(),
  next_review_on date,
  primary key (workspace_id, id)
)
-- ;
create index if not exists screening_reviews_inv on screening_reviews (workspace_id, investor_id, kind, reviewed_at desc)
-- ;
insert into sanctions_sources (source, name, url) values ('OS-PEP', 'OpenSanctions politically exposed persons', 'https://data.opensanctions.org/datasets/latest/peps/')
on conflict (source) do nothing
-- ;

-- ---------- Audit log export: SIEM destinations and write-once archives ----------
-- Secrets inside config (HEC tokens, signing secrets, cloud credentials) are sealed with SSO_ENC_KEY before storage;
-- the tenant role reads the table through a column-level grant that leaves that column out.
create table if not exists siem_destinations (
  id text primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('splunk_hec', 'https', 's3_worm')),
  name text not null,
  config_enc text not null,
  config_public jsonb not null default '{}',
  enabled boolean not null default true,
  last_seq bigint not null default 0,
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  created_by text not null,
  created_at timestamptz not null default now()
)
-- ;
create index if not exists siem_destinations_ws on siem_destinations (workspace_id)
-- ;
create table if not exists siem_deliveries (
  id bigserial primary key,
  destination_id text not null references siem_destinations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  from_seq bigint not null,
  to_seq bigint not null,
  events int not null,
  status text not null check (status in ('sent', 'failed')),
  detail text,
  object_key text,
  sent_at timestamptz not null default now()
)
-- ;
create index if not exists siem_deliveries_dest on siem_deliveries (destination_id, sent_at desc)
-- ;
-- Column-level grant: the tenant role reads every column except the sealed configuration.
grant select (id, workspace_id, kind, name, config_public, enabled, last_seq, last_run_at, last_ok_at, last_error, created_by, created_at) on siem_destinations to laissez_rt
-- ;
alter table siem_destinations enable row level security
-- ;
drop policy if exists tenant on siem_destinations
-- ;
create policy tenant on siem_destinations using (workspace_id = app_ws())
-- ;
grant select on siem_deliveries to laissez_rt
-- ;
alter table siem_deliveries enable row level security
-- ;
drop policy if exists tenant on siem_deliveries
-- ;
create policy tenant on siem_deliveries using (workspace_id = app_ws())
-- ;

-- ---------- Investor portal accounts: passkeys and an authenticator app for investors ----------
create table if not exists portal_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  investor_id text not null,
  email text not null,
  created_at timestamptz not null default now(),
  created_by text,
  last_login_at timestamptz,
  totp_secret text,
  totp_enabled_at timestamptz,
  totp_last_step bigint,
  disabled_at timestamptz,
  unique (workspace_id, investor_id)
)
-- ;
create table if not exists portal_passkeys (
  id text primary key,
  account_id uuid not null references portal_accounts(id) on delete cascade,
  public_key text not null,
  alg int not null,
  sign_count bigint not null default 0,
  transports text[] not null default '{}',
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
)
-- ;
create table if not exists portal_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  account_id uuid not null references portal_accounts(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  investor_id text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  mfa_at timestamptz
)
-- ;
create table if not exists portal_challenges (
  id uuid primary key default gen_random_uuid(),
  challenge text not null,
  purpose text not null,
  data jsonb not null default '{}',
  expires_at timestamptz not null default now() + interval '10 minutes'
)
-- ;
-- Invites: a distributor sends an investor a one-time link to create the account (the link itself is the existing
-- portal_access token; account creation consumes it).
alter table portal_access add column if not exists purpose text not null default 'view'
-- ;

-- ---------- Grants and row-level security for tenant-readable tables ----------
do $$
declare t text;
begin
  foreach t in array array['screening_reviews'] loop
    execute format('grant select, insert, update, delete on %I to laissez_rt', t);
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant on %I', t);
    execute format('create policy tenant on %I using (workspace_id = app_ws()) with check (workspace_id = app_ws())', t);
  end loop;
end $$
-- ;
-- kyc_checks is readable by the tenant without the sealed evidence column (column-level grant).
grant select (id, workspace_id, investor_id, provider, applicant_id, level_name, status, outcome, evidence_sha256, created_by, created_at, reviewed_at, last_webhook_at) on kyc_checks to laissez_rt
-- ;
alter table kyc_checks enable row level security
-- ;
drop policy if exists tenant on kyc_checks
-- ;
create policy tenant on kyc_checks using (workspace_id = app_ws())
-- ;
grant usage, select on all sequences in schema public to laissez_rt
-- ;
