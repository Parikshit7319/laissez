-- Migration 012: access requests (design partner leads) from the public site form.
-- Admin-only table: read through the owner connection, never through the tenant role, so no row-level security.
-- Statements are separated by a line containing only "-- ;".

create table if not exists leads (
  id text primary key,
  name text not null,
  email text not null,
  organization text not null,
  role text not null default 'other',
  distributes text,
  message text,
  source text,
  ip_hash text,
  user_agent text,
  status text not null default 'new' check (status in ('new', 'contacted', 'qualified', 'closed', 'spam')),
  notified_email_id uuid,
  created_at timestamptz not null default now()
)
-- ;
create index if not exists leads_created on leads (created_at desc)
-- ;
create index if not exists leads_email on leads (lower(email))
