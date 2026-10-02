-- Migration 001: tables the production database had before migrate-002 that schema.sql never defined.
-- The live database already has every table here, so each statement is a no-op there. On a fresh database
-- (api/db/setup.mjs, docker-compose.yml, api/chain/e2e-test.mjs) it fills the gap between schema.sql and migrate-002.
-- Statements are separated by a line containing only "-- ;" (see api/db/migrate.mjs).

-- ---------- Webhooks ----------
create table if not exists webhooks (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  url text not null,
  secret text not null,
  events text[] not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id)
)
-- ;
create table if not exists webhook_deliveries (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  webhook_id text not null,
  event text not null,
  status int,
  attempts int,
  response_ms int,
  payload text,
  created_at timestamptz not null default now()
)
-- ;
create index if not exists webhook_deliveries_recent on webhook_deliveries (workspace_id, created_at desc)
-- ;

-- ---------- Two-person policy changes ----------
create table if not exists policy_changes (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  ticker text not null,
  proposed_by text,
  status text not null default 'draft' check (status in ('draft', 'published', 'rejected')),
  changes jsonb not null default '{}',
  impact jsonb,
  approved_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id)
)
-- ;
create index if not exists policy_changes_recent on policy_changes (workspace_id, created_at desc)
-- ;

-- ---------- Rule drafts from the change agent ----------
create table if not exists rule_drafts (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  source text,
  jurisdiction text,
  draft jsonb not null default '{}',
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  reviewer text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id)
)
-- ;

-- ---------- Fictional screening list (seeded into sanctions_entries as LAISSEZ-TEST by migrate-002) ----------
create table if not exists screening_list (
  name text primary key,
  program text not null,
  note text
)
-- ;
insert into screening_list (name, program, note) values
  ('Blocked Example Trading LLC', 'LAISSEZ-TEST: fictional comprehensive block', 'Fictional entity used in demos. Any order for a party with this name is held for review.'),
  ('Sanctioned Example Holdings Ltd', 'LAISSEZ-TEST: fictional asset freeze', 'Fictional entity used in demos.'),
  ('Example Shell Company FZE', 'LAISSEZ-TEST: fictional sectoral restriction', 'Fictional entity used in demos.'),
  ('Denied Party Example Pte. Ltd.', 'LAISSEZ-TEST: fictional denied party', 'Fictional entity used in demos.')
on conflict (name) do nothing
-- ;

-- ---------- Fixed-window rate limits (owner connection only) ----------
create table if not exists rate_limits (
  key text primary key,
  window_start timestamptz not null,
  count int not null
)
-- ;
create index if not exists rate_limits_window on rate_limits (window_start)
