-- Migration 008: email outbox, session device details, recovery codes, SCIM, quotas, API key network tracking,
-- sandbox conversion and organization deletion records. Statements are separated by a line containing only "-- ;".
-- Grants and row-level security follow migrate-003: the tenant role laissez_rt sees one organization per query.

-- ---------- Email outbox ----------
create table if not exists email_outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  to_email text not null,
  subject text not null,
  html text not null,
  text text not null,
  kind text not null,
  status text not null default 'outbox' check (status in ('sent', 'outbox', 'failed')),
  provider_id text,
  error text,
  link text,
  created_at timestamptz not null default now()
)
-- ;
create index if not exists email_outbox_ws on email_outbox (workspace_id, created_at desc)
-- ;
grant select on email_outbox to laissez_rt
-- ;
alter table email_outbox enable row level security
-- ;
drop policy if exists tenant on email_outbox
-- ;
create policy tenant on email_outbox using (workspace_id = app_ws())
-- ;

-- ---------- Sessions: where and from what ----------
alter table sessions add column if not exists country text
-- ;
alter table sessions add column if not exists city text
-- ;
alter table sessions add column if not exists browser text
-- ;
alter table sessions add column if not exists os text
-- ;
create index if not exists sessions_user_ip on sessions (user_id, ip_hash)
-- ;

-- ---------- Recovery codes (owner connection only) ----------
create table if not exists recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  code_hash text not null unique,
  created_at timestamptz not null default now(),
  used_at timestamptz
)
-- ;
create index if not exists recovery_codes_user on recovery_codes (user_id)
-- ;

-- ---------- SCIM provisioning and SSO group mapping ----------
alter table workspaces add column if not exists scim_token_hash text
-- ;
alter table workspaces add column if not exists scim_token_created_at timestamptz
-- ;
create unique index if not exists workspaces_scim_token on workspaces (scim_token_hash) where scim_token_hash is not null
-- ;
alter table memberships add column if not exists scim_external_id text
-- ;
alter table memberships add column if not exists provisioned_by text
-- ;

-- ---------- Monthly quota per organization ----------
alter table workspaces add column if not exists monthly_quota int not null default 100000
-- ;
create table if not exists quotas (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  month date not null,
  count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, month)
)
-- ;
grant select on quotas to laissez_rt
-- ;
alter table quotas enable row level security
-- ;
drop policy if exists tenant on quotas
-- ;
create policy tenant on quotas using (workspace_id = app_ws())
-- ;

-- ---------- API keys: where they were last used from ----------
alter table api_keys add column if not exists last_used_ip_hash text
-- ;
alter table api_keys add column if not exists last_used_country text
-- ;
alter table api_keys add column if not exists last_used_ua text
-- ;
alter table api_keys add column if not exists known_ip_hashes text[] not null default '{}'
-- ;

-- ---------- Organization deletions (owner connection only; survives the cascade) ----------
create table if not exists org_deletions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  name text not null,
  kind text not null,
  deleted_by uuid,
  deleted_by_name text,
  deleted_at timestamptz not null default now(),
  export_sha256 text not null,
  counts jsonb not null default '{}'
)
-- ;
grant usage, select on all sequences in schema public to laissez_rt
