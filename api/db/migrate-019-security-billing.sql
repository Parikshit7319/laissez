-- Migration 019: email verification, terms acceptance, authenticator app (TOTP), email recovery, organization
-- verification, per-organization security policy, contracts, metered usage, invoices and billing state.
-- Statements are separated by a line containing only "-- ;". Tables that hold secrets or cross tenants are owner-only
-- (no grant to laissez_rt). Billing tables the customer reads follow migrate-003: select-only grant plus a tenant policy.

-- ---------- Users: verified email, terms, authenticator app ----------
alter table users add column if not exists email_verified_at timestamptz
-- ;
alter table users add column if not exists terms_accepted_at timestamptz
-- ;
alter table users add column if not exists terms_version text
-- ;
alter table users add column if not exists totp_secret text
-- ;
alter table users add column if not exists totp_enabled_at timestamptz
-- ;
alter table users add column if not exists totp_last_step bigint
-- ;
-- Everyone who already has an account signed up before verification existed. They keep working; new accounts verify.
update users set email_verified_at = coalesce(last_login_at, created_at) where email_verified_at is null and sandbox_workspace is null and not fictional
-- ;

-- ---------- Email tokens: verify an address, or recover access ----------
create table if not exists email_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null references users(id) on delete cascade,
  email text not null,
  purpose text not null check (purpose in ('verify', 'recovery')),
  created_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  cancelled_at timestamptz,
  ip_hash text
)
-- ;
create index if not exists email_tokens_user on email_tokens (user_id, purpose, created_at desc)
-- ;

-- ---------- Organizations: verification and security policy ----------
alter table workspaces add column if not exists verification_status text not null default 'unverified' check (verification_status in ('unverified', 'pending', 'verified', 'rejected'))
-- ;
alter table workspaces add column if not exists verification_profile jsonb
-- ;
alter table workspaces add column if not exists verification_note text
-- ;
alter table workspaces add column if not exists verification_submitted_at timestamptz
-- ;
alter table workspaces add column if not exists verified_at timestamptz
-- ;
alter table workspaces add column if not exists verified_by text
-- ;
alter table workspaces add column if not exists security_policy jsonb not null default '{}'
-- ;
-- Existing organizations were created before verification existed; they stay usable and are marked verified by migration.
update workspaces set verification_status = 'verified', verified_at = now(), verified_by = 'migration 019' where kind = 'org' and verification_status = 'unverified'
-- ;

-- ---------- Billing state on the organization ----------
alter table workspaces add column if not exists billing_status text not null default 'none' check (billing_status in ('none', 'active', 'past_due', 'suspended'))
-- ;
alter table workspaces add column if not exists billing_profile jsonb not null default '{}'
-- ;
alter table workspaces add column if not exists stripe_customer_id text
-- ;

-- ---------- Contracts ----------
create table if not exists contracts (
  id text primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  plan text not null default 'platform' check (plan in ('platform', 'enterprise', 'pilot')),
  status text not null default 'pending_acceptance' check (status in ('draft', 'pending_acceptance', 'active', 'ended')),
  currency text not null default 'USD',
  platform_fee_cents bigint not null default 0 check (platform_fee_cents >= 0),
  usage_bps numeric(8, 3) not null default 0 check (usage_bps >= 0),
  net_days int not null default 30 check (net_days between 0 and 120),
  tax_bps int not null default 0 check (tax_bps between 0 and 3000),
  starts_on date not null,
  ends_on date,
  auto_renew boolean not null default true,
  terms_text text not null,
  terms_sha256 text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  accepted_by text,
  accepted_by_user uuid,
  accepted_title text,
  accepted_at timestamptz,
  accepted_ip_hash text,
  last_platform_invoice_for date
)
-- ;
create index if not exists contracts_ws on contracts (workspace_id, created_at desc)
-- ;
create unique index if not exists contracts_one_active on contracts (workspace_id) where status = 'active'
-- ;
grant select on contracts to laissez_rt
-- ;
alter table contracts enable row level security
-- ;
drop policy if exists tenant on contracts
-- ;
create policy tenant on contracts using (workspace_id = app_ws())
-- ;

-- ---------- Metered usage, one row per organization per day ----------
create table if not exists usage_daily (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  day date not null,
  settled_value_usd numeric(20, 2) not null default 0,
  settlements int not null default 0,
  decisions int not null default 0,
  computed_at timestamptz not null default now(),
  primary key (workspace_id, day)
)
-- ;
grant select on usage_daily to laissez_rt
-- ;
alter table usage_daily enable row level security
-- ;
drop policy if exists tenant on usage_daily
-- ;
create policy tenant on usage_daily using (workspace_id = app_ws())
-- ;

-- ---------- Invoices ----------
create sequence if not exists invoice_number_seq start 1001
-- ;
create table if not exists invoices (
  id text primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  contract_id text references contracts(id) on delete set null,
  number text not null unique,
  kind text not null check (kind in ('platform', 'usage')),
  period_start date not null,
  period_end date not null,
  status text not null default 'open' check (status in ('draft', 'open', 'paid', 'void', 'uncollectible')),
  currency text not null default 'USD',
  lines jsonb not null default '[]',
  subtotal_cents bigint not null,
  tax_cents bigint not null default 0,
  total_cents bigint not null,
  issued_on date not null,
  due_on date not null,
  paid_at timestamptz,
  paid_note text,
  stripe_invoice_id text,
  hosted_invoice_url text,
  reminder_stage int not null default 0,
  created_at timestamptz not null default now(),
  unique (workspace_id, kind, period_start)
)
-- ;
create index if not exists invoices_ws on invoices (workspace_id, issued_on desc)
-- ;
create index if not exists invoices_open on invoices (status, due_on) where status = 'open'
-- ;
grant select on invoices to laissez_rt
-- ;
alter table invoices enable row level security
-- ;
drop policy if exists tenant on invoices
-- ;
create policy tenant on invoices using (workspace_id = app_ws())
-- ;

-- ---------- Billing events: every state change, for support and for the audit of the audit ----------
create table if not exists billing_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  invoice_id text,
  kind text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
)
-- ;
create index if not exists billing_events_ws on billing_events (workspace_id, created_at desc)
-- ;

-- ---------- Stripe webhook deliveries already processed (idempotency) ----------
create table if not exists stripe_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
)
-- ;

-- ---------- Quote requests from sandboxes and organizations without a contract ----------
create table if not exists quote_requests (
  id text primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  requested_by text not null,
  email text not null,
  plan text not null,
  expected_value_usd numeric(20, 2),
  message text,
  status text not null default 'new' check (status in ('new', 'contacted', 'won', 'lost')),
  created_at timestamptz not null default now()
)
-- ;
