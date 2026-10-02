-- Migration 009: compliance operations. Monitoring run detail, in-app notifications, screening-hit
-- notes and the needs_information decision, inbound Travel Rule manual review, placement-limit work
-- items, rule-draft regression results, and the grants and row-level security for every new table.
-- Run with: node db/migrate.mjs db/migrate-009-compliance.sql

-- ---------- Monitoring run detail ----------
alter table monitor_runs add column if not exists items_closed int not null default 0
-- ;
create table if not exists monitor_run_items (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  run_id bigint not null references monitor_runs(id) on delete cascade,
  kind text not null,
  investor_id text,
  ticker text,
  from_status text,
  to_status text,
  work_item_id text,
  created_at timestamptz not null default now()
)
-- ;
create index if not exists monitor_run_items_run on monitor_run_items (workspace_id, run_id)
-- ;

-- ---------- Notifications ----------
create table if not exists notifications (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  user_id uuid references users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  link text,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  primary key (workspace_id, id)
)
-- ;
create index if not exists notifications_recent on notifications (workspace_id, created_at desc)
-- ;
create index if not exists notifications_unread on notifications (workspace_id, user_id) where read_at is null
-- ;

-- ---------- Screening hits: needs_information and note history ----------
alter table screening_hits drop constraint if exists screening_hits_status_check
-- ;
alter table screening_hits add constraint screening_hits_status_check check (status in ('open', 'needs_information', 'false_positive', 'confirmed'))
-- ;
create table if not exists hit_notes (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  hit_id text not null,
  author text not null,
  status text,
  note text not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id)
)
-- ;
create index if not exists hit_notes_hit on hit_notes (workspace_id, hit_id, created_at)
-- ;

-- ---------- Inbound Travel Rule manual review ----------
alter table travel_rule_messages add column if not exists reviewed_by text
-- ;
alter table travel_rule_messages add column if not exists reviewed_at timestamptz
-- ;
alter table travel_rule_messages add column if not exists review_note text
-- ;
alter table travel_rule_messages add column if not exists account_id text
-- ;

-- ---------- Rule drafts: regression results and threshold warnings ----------
alter table rule_drafts add column if not exists regression jsonb
-- ;
alter table rule_drafts add column if not exists warnings jsonb
-- ;

-- ---------- Grants and row-level security (same shape as migration 003) ----------
do $$
declare t text;
begin
  foreach t in array array['monitor_run_items', 'notifications', 'hit_notes'] loop
    execute format('grant select, insert, update, delete on %I to laissez_rt', t);
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant on %I', t);
    execute format('create policy tenant on %I using (workspace_id = app_ws()) with check (workspace_id = app_ws())', t);
  end loop;
end $$
-- ;
grant usage, select on all sequences in schema public to laissez_rt
