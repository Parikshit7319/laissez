-- Migration 003: row-level security. The API's tenant connection uses role laissez_rt,
-- which has no BYPASSRLS. Every query runs inside a transaction that first sets app.ws,
-- so a query can only ever see rows for the organization that made the request.
-- The role itself is created out of band (its password is a secret):
--   create role laissez_rt login password '...';

grant usage on schema public to laissez_rt
-- ;
grant select on jurisdictions, investor_classes, booking_centers, rule_packs, sanctions_sources, sanctions_entries, reg_publications, chain_config, audit_anchors to laissez_rt
-- ;
grant select, update on workspaces to laissez_rt
-- ;
alter table workspaces enable row level security
-- ;
drop policy if exists tenant on workspaces
-- ;
create policy tenant on workspaces using (id = app_ws()) with check (id = app_ws())
-- ;
grant select on users to laissez_rt
-- ;
alter table users enable row level security
-- ;
drop policy if exists tenant on users
-- ;
create policy tenant on users using (exists (select 1 from memberships m where m.user_id = users.id and m.workspace_id = app_ws()))
-- ;
do $$
declare t text;
begin
  foreach t in array array[
    'api_keys', 'investors', 'credentials', 'classifications', 'funds', 'fund_distribution', 'holdings', 'decisions', 'settlements',
    'webhooks', 'webhook_deliveries', 'policy_changes', 'rule_drafts', 'idempotency_keys', 'memberships', 'invites',
    'fund_policy_versions', 'holder_status', 'monitor_runs', 'work_items', 'screening_hits', 'nav_history', 'accruals', 'distributions',
    'redemption_notices', 'fund_documents', 'doc_acknowledgments', 'portal_requests', 'evidence_submissions', 'travel_rule_messages',
    'recon_runs', 'recon_breaks'
  ] loop
    execute format('grant select, insert, update, delete on %I to laissez_rt', t);
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant on %I', t);
    execute format('create policy tenant on %I using (workspace_id = app_ws()) with check (workspace_id = app_ws())', t);
  end loop;
end $$
-- ;
-- The audit log is append-only for the API: insert and read, never update or delete.
grant select, insert on audit_events to laissez_rt
-- ;
alter table audit_events enable row level security
-- ;
drop policy if exists tenant on audit_events
-- ;
create policy tenant on audit_events using (workspace_id = app_ws()) with check (workspace_id = app_ws())
-- ;
grant select on audit_anchor_leaves to laissez_rt
-- ;
alter table audit_anchor_leaves enable row level security
-- ;
drop policy if exists tenant on audit_anchor_leaves
-- ;
create policy tenant on audit_anchor_leaves using (workspace_id = app_ws())
-- ;
-- Credential shares are visible to both organizations in the share.
grant select, insert, update on credential_shares to laissez_rt
-- ;
alter table credential_shares enable row level security
-- ;
drop policy if exists tenant on credential_shares
-- ;
create policy tenant on credential_shares using (from_workspace = app_ws() or to_workspace = app_ws()) with check (from_workspace = app_ws() or to_workspace = app_ws())
-- ;
grant usage, select on all sequences in schema public to laissez_rt
