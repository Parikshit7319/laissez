-- Migration 013: approvals workflow, investor maker-checker and revisions, holder-cap waitlist, order batches,
-- concentration limits, suitability assessments, FATCA/CRS tax profiles, and the search indexes the global
-- search uses. Statements are separated by a line containing only "-- ;". Run with:
--   node db/migrate.mjs db/migrate-013-workflow.sql

-- ---------- Approval policies: one row per kind per organization, seeded on first read ----------
create table if not exists approval_policies (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null,
  enabled boolean not null default true,
  threshold jsonb not null default '{}',
  required_approvals int not null default 1 check (required_approvals between 1 and 5),
  roles text[] not null default '{admin,compliance}',
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, kind)
)
-- ;

-- ---------- Approval requests: a stored action waiting for a second person ----------
create table if not exists approval_requests (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  kind text not null,
  subject text,
  title text not null default '',
  payload jsonb not null default '{}',
  requested_by text not null,
  requested_by_user uuid,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  required_approvals int not null default 1,
  approvals jsonb not null default '[]',
  rejection jsonb,
  result jsonb,
  error text,
  locked_at timestamptz,
  decided_at timestamptz,
  expires_at timestamptz not null default now() + interval '72 hours',
  created_at timestamptz not null default now(),
  primary key (workspace_id, id)
)
-- ;
create index if not exists approval_requests_cursor on approval_requests (workspace_id, created_at desc, id)
-- ;
create index if not exists approval_requests_open on approval_requests (workspace_id, status) where status = 'pending'
-- ;

-- ---------- Investor edit history ----------
create table if not exists investor_revisions (
  workspace_id uuid not null,
  investor_id text not null,
  revision int not null,
  changes jsonb not null,
  changed_by text not null,
  changed_at timestamptz not null default now(),
  approved_by text,
  approval_id text,
  primary key (workspace_id, investor_id, revision),
  foreign key (workspace_id, investor_id) references investors(workspace_id, id) on delete cascade
)
-- ;

-- ---------- Holder-cap waitlist ----------
create table if not exists waitlist (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  ticker text not null,
  investor_id text not null,
  amount numeric(20, 2) not null,
  asset text not null,
  status text not null default 'waiting' check (status in ('waiting', 'released', 'cancelled', 'expired')),
  reason text,
  released_decision_id text,
  released_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, investor_id) references investors(workspace_id, id) on delete cascade,
  foreign key (workspace_id, ticker) references funds(workspace_id, ticker) on delete cascade
)
-- ;
create index if not exists waitlist_open on waitlist (workspace_id, ticker, created_at) where status = 'waiting'
-- ;

-- ---------- Order batches at the dealing cut-off ----------
create table if not exists order_batches (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  ticker text not null,
  dealing_date date not null,
  cutoff_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'closed', 'settled')),
  totals jsonb,
  progress jsonb,
  closed_by text,
  closed_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, ticker) references funds(workspace_id, ticker) on delete cascade
)
-- ;
create unique index if not exists order_batches_open on order_batches (workspace_id, ticker, dealing_date) where status = 'open'
-- ;
create index if not exists order_batches_cursor on order_batches (workspace_id, created_at desc, id)
-- ;
alter table decisions add column if not exists batch_id text
-- ;
create index if not exists decisions_batch on decisions (workspace_id, batch_id) where batch_id is not null
-- ;

-- ---------- Concentration limits on the fund policy ----------
alter table funds add column if not exists max_holder_pct numeric(6, 3)
-- ;
alter table funds add column if not exists max_holding_per_investor numeric(20, 2)
-- ;

-- ---------- Suitability assessments ----------
create table if not exists suitability (
  workspace_id uuid not null,
  id text not null,
  investor_id text not null,
  version int not null default 1,
  answers jsonb not null,
  score int not null,
  outcome text not null check (outcome in ('suitable', 'not_suitable', 'advised_only')),
  assessed_by text not null,
  assessed_at timestamptz not null default now(),
  expires_on date not null,
  primary key (workspace_id, id),
  foreign key (workspace_id, investor_id) references investors(workspace_id, id) on delete cascade
)
-- ;
create index if not exists suitability_latest on suitability (workspace_id, investor_id, assessed_at desc)
-- ;
alter table jurisdictions add column if not exists requires_suitability boolean not null default false
-- ;
update jurisdictions set requires_suitability = true where code in ('HK', 'CH', 'DE', 'LU', 'IE', 'GB', 'JP', 'IN')
-- ;

-- ---------- FATCA / CRS tax classification ----------
create table if not exists tax_profiles (
  workspace_id uuid not null,
  investor_id text not null,
  tax_residences text[] not null default '{}',
  tin_provided boolean not null default false,
  fatca_status text not null check (fatca_status in ('us_person', 'non_us_individual', 'ffi', 'nffe_active', 'nffe_passive', 'exempt')),
  crs_status text,
  w8_or_w9 text check (w8_or_w9 in ('W-9', 'W-8BEN', 'W-8BEN-E', 'W-8IMY', 'W-8EXP', 'W-8ECI')),
  self_certified_on date,
  expires_on date,
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, investor_id),
  foreign key (workspace_id, investor_id) references investors(workspace_id, id) on delete cascade
)
-- ;

-- ---------- Global search: trigram indexes (pg_trgm is created by migration 002) ----------
create index if not exists investors_name_trgm on investors using gin (name gin_trgm_ops)
-- ;
create index if not exists funds_name_trgm on funds using gin (name gin_trgm_ops)
-- ;
create index if not exists decisions_headline_trgm on decisions using gin (headline gin_trgm_ops)
-- ;

-- ---------- Grants and row-level security (same shape as migration 003) ----------
do $$
declare t text;
begin
  foreach t in array array['approval_policies', 'approval_requests', 'investor_revisions', 'waitlist', 'order_batches', 'suitability', 'tax_profiles'] loop
    execute format('grant select, insert, update, delete on %I to laissez_rt', t);
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant on %I', t);
    execute format('create policy tenant on %I using (workspace_id = app_ws()) with check (workspace_id = app_ws())', t);
  end loop;
end $$
-- ;
grant usage, select on all sequences in schema public to laissez_rt
