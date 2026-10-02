-- Migration 014: feature flags and notification channels.
-- feature_flags is global reference data (read-only for the tenant role). workspace_flags holds per-organization
-- overrides and notification_channels the Slack, Teams and JSON endpoints that receive notifications; both are
-- tenant tables with row-level security in the shape of migration 003.
-- Statements are separated by a line containing only "-- ;".

create table if not exists feature_flags (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  description text not null default '',
  default_on boolean not null default false,
  created_at timestamptz not null default now()
)
-- ;
insert into feature_flags (key, description, default_on) values
  ('chain_settlement', 'Settle allowed orders on-chain when a deployment is configured. Off means simulated settlement only.', true),
  ('approvals_workflow', 'Two-person approval for policy changes and rule drafts.', true),
  ('order_batching', 'Group orders into dealing-cutoff batches instead of settling each one on its own.', false),
  ('portal_transfers', 'Let investors request transfers to another holder from the investor portal.', false),
  ('regulatory_agent', 'The rule-drafting agent on the regulatory feed. Needs an Anthropic API key.', true)
on conflict (key) do update set description = excluded.description
-- ;
create table if not exists workspace_flags (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  key text not null references feature_flags (key) on delete cascade,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, key)
)
-- ;
create table if not exists notification_channels (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  id text not null,
  name text,
  kind text not null check (kind in ('slack', 'teams', 'webhook')),
  url text not null,
  events text[] not null default array['*'],
  secret text,
  created_by uuid,
  created_at timestamptz not null default now(),
  last_sent_at timestamptz,
  last_status int,
  last_error text,
  primary key (workspace_id, id)
)
-- ;
grant select on feature_flags to laissez_rt
-- ;
do $$
declare t text;
begin
  foreach t in array array['workspace_flags', 'notification_channels'] loop
    execute format('grant select, insert, update, delete on %I to laissez_rt', t);
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant on %I', t);
    execute format('create policy tenant on %I using (workspace_id = app_ws()) with check (workspace_id = app_ws())', t);
  end loop;
end $$
