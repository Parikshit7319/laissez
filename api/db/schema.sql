-- Laissez schema: global reference tables hold the rules, workspace tables hold sandbox data.

create table jurisdictions (
  code text primary key,
  name text not null,
  iso3 text not null,
  comprehensive_sanctions text
);

create table investor_classes (
  code text primary key,
  jurisdiction text not null references jurisdictions(code),
  label text not null,
  stamp text not null,
  rule_ref text not null,
  source_id text not null,
  threshold text not null,
  requires_opt_in boolean not null default false
);

create table booking_centers (
  id text primary key,
  name text not null,
  jurisdiction text not null references jurisdictions(code),
  licence text not null,
  requires_class text references investor_classes(code),
  rule_text text not null,
  rule_ref text not null,
  source_id text not null
);

create table rule_packs (
  id text not null,
  version text not null,
  jurisdiction text not null references jurisdictions(code),
  status text not null check (status in ('active', 'draft', 'retired')),
  summary text not null,
  effective_from date,
  approved_by text,
  created_at timestamptz not null default now(),
  primary key (id, version)
);

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days'
);

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  prefix text not null,
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table investors (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  name text not null,
  short_name text not null,
  kind text not null,
  residence text not null references jurisdictions(code),
  city text not null,
  booking_center text not null references booking_centers(id),
  us_person boolean not null default false,
  wallet text not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id)
);

create table credentials (
  workspace_id uuid not null,
  id text not null,
  investor_id text not null,
  issued_on date not null,
  expires_on date not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, investor_id) references investors(workspace_id, id) on delete cascade
);

create table classifications (
  id bigserial primary key,
  workspace_id uuid not null,
  credential_id text not null,
  class_code text not null references investor_classes(code),
  basis text not null,
  verified_on date not null,
  expires_on date not null,
  opt_in_on date,
  foreign key (workspace_id, credential_id) references credentials(workspace_id, id) on delete cascade
);

create table funds (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  ticker text not null,
  name text not null,
  short_name text not null,
  domicile text not null,
  structure text not null,
  currency text not null check (currency in ('USD', 'EUR')),
  nav numeric(18, 6) not null,
  reg_s boolean not null,
  us_accepts text[],
  min_subscription numeric(20, 2) not null,
  holder_cap int,
  holders int not null default 0,
  lockup_months int,
  assets text[] not null,
  chains text[] not null,
  issuer text not null,
  policy_version int not null default 1,
  primary key (workspace_id, ticker)
);

create table fund_distribution (
  workspace_id uuid not null,
  ticker text not null,
  jurisdiction text not null references jurisdictions(code),
  accepts text[] not null,
  basis text not null,
  law_requires text references investor_classes(code),
  law_text text not null,
  law_ref text not null,
  law_source text not null,
  primary key (workspace_id, ticker, jurisdiction),
  foreign key (workspace_id, ticker) references funds(workspace_id, ticker) on delete cascade
);

create table holdings (
  workspace_id uuid not null,
  investor_id text not null,
  ticker text not null,
  units numeric(24, 2) not null check (units >= 0),
  since date not null,
  primary key (workspace_id, investor_id, ticker),
  foreign key (workspace_id, investor_id) references investors(workspace_id, id) on delete cascade,
  foreign key (workspace_id, ticker) references funds(workspace_id, ticker) on delete cascade
);

create table decisions (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  action text not null check (action in ('subscribe', 'transfer', 'redeem')),
  investor_id text not null,
  counterparty_id text,
  ticker text not null,
  amount numeric(20, 2) not null,
  asset text not null,
  outcome text not null check (outcome in ('ALLOW', 'DENY', 'FREEZE')),
  headline text not null,
  checks jsonb not null,
  resolved jsonb not null,
  remedies jsonb not null,
  rule_packs text[] not null,
  what_ifs text[] not null default '{}',
  units numeric(24, 2) not null,
  inputs_sha256 text not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id)
);
create index decisions_recent on decisions (workspace_id, created_at desc);

create table settlements (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  id text not null,
  decision_id text not null,
  status text not null check (status in ('settled', 'reverted')),
  steps jsonb not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  unique (workspace_id, decision_id)
);

create table audit_events (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  type text not null,
  subject text,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_recent on audit_events (workspace_id, created_at desc);
