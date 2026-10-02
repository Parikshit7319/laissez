-- Migration 018: bulk import (clients, credentials, holdings), the client external id it matches on, and the
-- counsel-review columns on rule packs. Statements are separated by a line containing only "-- ;". Run with:
--   node db/migrate.mjs db/migrate-018-import.sql

-- ---------- Client external id: the organization's own identifier, used to match later imports ----------
alter table investors add column if not exists external_id text
-- ;
create unique index if not exists investors_external_id on investors (workspace_id, external_id) where external_id is not null
-- ;

-- ---------- Imports: one row per uploaded file, with every parsed row and its outcome ----------
create table if not exists imports (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  type text not null check (type in ('clients', 'credentials', 'holdings')),
  format text not null check (format in ('csv', 'json')),
  status text not null default 'previewed' check (status in ('previewed', 'applying', 'applied', 'failed')),
  file_name text,
  source_sha256 text,
  totals jsonb not null default '{}',
  rows jsonb not null default '[]',
  warnings jsonb not null default '[]',
  cursor int not null default 0,
  result jsonb,
  error text,
  locked_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  applied_by text,
  applied_at timestamptz,
  primary key (workspace_id, id)
)
-- ;
create index if not exists imports_recent on imports (workspace_id, created_at desc)
-- ;

-- ---------- Rule packs: when counsel reviewed the pack and where the opinion lives ----------
alter table rule_packs add column if not exists reviewed_on date
-- ;
alter table rule_packs add column if not exists review_ref text
-- ;

-- ---------- Grants and row-level security (same shape as migration 003) ----------
do $$
declare t text;
begin
  foreach t in array array['imports'] loop
    execute format('grant select, insert, update, delete on %I to laissez_rt', t);
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant on %I', t);
    execute format('create policy tenant on %I using (workspace_id = app_ws()) with check (workspace_id = app_ws())', t);
  end loop;
end $$
-- ;
grant usage, select on all sequences in schema public to laissez_rt
