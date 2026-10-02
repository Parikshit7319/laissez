-- Migration 010: settlement cancellation and retries, chain job retry fields, portal redemption and transfer
-- requests, and cursor indexes for the paginated list endpoints. Statements are separated by a line containing
-- only "-- ;". Run with: node db/migrate.mjs db/migrate-010-dist.sql

-- ---------- Settlements: a pending settlement whose chain job never went out can be cancelled ----------
alter table settlements drop constraint if exists settlements_status_check
-- ;
alter table settlements add constraint settlements_status_check check (status in ('pending', 'settled', 'reverted', 'cancelled'))
-- ;
alter table settlements add column if not exists updated_at timestamptz not null default now()
-- ;

-- ---------- Chain jobs: retry bookkeeping and a cancelled state ----------
alter table chain_jobs drop constraint if exists chain_jobs_status_check
-- ;
alter table chain_jobs add constraint chain_jobs_status_check check (status in ('queued', 'running', 'confirmed', 'failed', 'cancelled'))
-- ;
alter table chain_jobs add column if not exists retries int not null default 0
-- ;
alter table chain_jobs add column if not exists retried_at timestamptz
-- ;
alter table chain_jobs add column if not exists retried_by text
-- ;
alter table chain_jobs add column if not exists cancelled_at timestamptz
-- ;
alter table chain_jobs add column if not exists cancelled_by text
-- ;
create index if not exists chain_jobs_ws_created on chain_jobs (workspace_id, created_at desc, id)
-- ;
create index if not exists chain_jobs_ref on chain_jobs (kind, ref)
-- ;

-- ---------- Portal requests: subscribe, redeem or transfer ----------
alter table portal_requests add column if not exists counterparty_id text
-- ;
alter table portal_requests drop constraint if exists portal_requests_action_check
-- ;
alter table portal_requests add constraint portal_requests_action_check check (action in ('subscribe', 'redeem', 'transfer'))
-- ;
create index if not exists portal_requests_ws_created on portal_requests (workspace_id, created_at desc, id)
-- ;

-- ---------- Cursor pagination: (workspace_id, created_at desc, id) on every paginated list ----------
create index if not exists investors_cursor on investors (workspace_id, created_at desc, id)
-- ;
create index if not exists decisions_cursor on decisions (workspace_id, created_at desc, id)
-- ;
create index if not exists settlements_cursor on settlements (workspace_id, created_at desc, id)
-- ;
create index if not exists audit_events_cursor on audit_events (workspace_id, created_at desc, id)
-- ;
create index if not exists work_items_cursor on work_items (workspace_id, created_at desc, id)
-- ;
create index if not exists screening_hits_cursor on screening_hits (workspace_id, created_at desc, id)
-- ;
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'webhook_deliveries' and column_name = 'created_at') then
    execute 'create index if not exists webhook_deliveries_cursor on webhook_deliveries (workspace_id, created_at desc, id)';
  end if;
  if exists (select 1 from information_schema.columns where table_name = 'notifications' and column_name = 'created_at') then
    execute 'create index if not exists notifications_cursor on notifications (workspace_id, created_at desc, id)';
  end if;
end $$
-- ;
