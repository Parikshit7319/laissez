-- Migration 017: the rule workbench. Customer-authored rules stored as data and evaluated by the engine after its
-- built-in layers, plus the legal reviewer role. Statements are separated by a line containing only "-- ;". Run with:
--   node db/migrate.mjs db/migrate-017-rules.sql

-- ---------- Legal reviewer role: a second person for rule sign-off ----------
alter table memberships drop constraint if exists memberships_role_check
-- ;
alter table memberships add constraint memberships_role_check check (role in ('admin', 'ops', 'compliance', 'legal', 'issuer', 'developer', 'auditor'))
-- ;
alter table invites drop constraint if exists invites_role_check
-- ;
alter table invites add constraint invites_role_check check (role in ('admin', 'ops', 'compliance', 'legal', 'issuer', 'developer', 'auditor'))
-- ;

-- ---------- Custom rules: one row per version. The definition column holds applies_to, condition, outcome and severity ----------
create table if not exists custom_rules (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  version int not null default 1 check (version >= 1),
  name text not null,
  description text not null default '',
  jurisdiction text not null default '*',
  definition jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'scheduled', 'active', 'retired')),
  effective_from date,
  effective_to date,
  template text,
  authored_by text not null,
  authored_by_user uuid,
  reviewed_by text,
  reviewed_by_user uuid,
  review_note text,
  approved_at timestamptz,
  retired_by text,
  retired_at timestamptz,
  -- Result of the last POST /v1/rules/{id}/test for this version, with the definition fingerprint it ran against.
  last_test jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id, version)
)
-- ;
create index if not exists custom_rules_live on custom_rules (workspace_id, status) where status in ('scheduled', 'active')
-- ;
create index if not exists custom_rules_list on custom_rules (workspace_id, id, version desc)
-- ;

-- ---------- Grants and row-level security (same shape as migration 003) ----------
do $$
declare t text;
begin
  foreach t in array array['custom_rules'] loop
    execute format('grant select, insert, update, delete on %I to laissez_rt', t);
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant on %I', t);
    execute format('create policy tenant on %I using (workspace_id = app_ws()) with check (workspace_id = app_ws())', t);
  end loop;
end $$
-- ;
grant usage, select on all sequences in schema public to laissez_rt
