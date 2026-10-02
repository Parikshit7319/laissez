-- Migration 015: closed-end funds (commitments, capital calls, call notices), saved report definitions,
-- and white-label branding fields on workspaces. Idempotent. Statements are separated by a line containing only "-- ;".

-- ---------- Fund type ----------
alter table funds add column if not exists fund_type text not null default 'open_ended'
-- ;
alter table funds drop constraint if exists funds_fund_type_check
-- ;
alter table funds add constraint funds_fund_type_check check (fund_type in ('open_ended', 'closed_end'))
-- ;
-- A decision made for a capital call carries the call id, so settlement and replay re-run the same check.
alter table decisions add column if not exists capital_call_id text
-- ;

-- ---------- Commitments: what each investor has promised to a closed-end fund ----------
create table if not exists commitments (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  investor_id text not null,
  ticker text not null,
  committed numeric(20, 2) not null check (committed > 0),
  called numeric(20, 2) not null default 0,
  distributed numeric(20, 2) not null default 0,
  committed_on date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, investor_id, ticker)
)
-- ;
create table if not exists capital_calls (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  ticker text not null,
  call_number int not null,
  pct numeric(7, 4) not null check (pct > 0 and pct <= 100),
  due_on date not null,
  status text not null default 'issued' check (status in ('issued', 'settling', 'settled', 'cancelled')),
  total_called numeric(20, 2) not null default 0,
  notice_sent_at timestamptz,
  issued_by text,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, ticker, call_number)
)
-- ;
create table if not exists call_notices (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  capital_call_id text not null,
  investor_id text not null,
  ticker text not null,
  amount numeric(20, 2) not null,
  due_on date not null,
  status text not null default 'issued' check (status in ('issued', 'settled', 'failed', 'cancelled')),
  decision_id text,
  settlement_id text,
  error text,
  sent_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, capital_call_id, investor_id)
)
-- ;
create index if not exists call_notices_call on call_notices (workspace_id, capital_call_id)
-- ;
-- Distributions back to closed-end investors reuse the distributions table with a kind.
alter table distributions add column if not exists kind text not null default 'income'
-- ;
alter table distributions drop constraint if exists distributions_kind_check
-- ;
alter table distributions add constraint distributions_kind_check check (kind in ('income', 'return_of_capital'))
-- ;

-- ---------- Report definitions ----------
create table if not exists report_definitions (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  name text not null,
  source text not null check (source in ('investors', 'decisions', 'settlements', 'holdings', 'audit')),
  columns text[] not null,
  filters jsonb not null default '[]'::jsonb,
  group_by text[] not null default '{}',
  sort jsonb not null default '[]'::jsonb,
  schedule text check (schedule in ('daily', 'weekly', 'monthly')),
  recipients text[] not null default '{}',
  created_by text,
  last_run_at timestamptz,
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id)
)
-- ;

-- ---------- Branding ----------
alter table workspaces add column if not exists logo_data_url text
-- ;
alter table workspaces add column if not exists portal_domain text
-- ;
alter table workspaces add column if not exists email_footer text
-- ;
alter table workspaces add column if not exists support_email text
-- ;
alter table workspaces add column if not exists support_phone text
-- ;

-- ---------- Grants and row-level security (same pattern as migrate-003) ----------
do $$
declare t text;
begin
  foreach t in array array['commitments', 'capital_calls', 'call_notices', 'report_definitions'] loop
    execute format('grant select, insert, update, delete on %I to laissez_rt', t);
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant on %I', t);
    execute format('create policy tenant on %I using (workspace_id = app_ws()) with check (workspace_id = app_ws())', t);
  end loop;
end $$
