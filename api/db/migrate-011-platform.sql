-- Migration 011: sampled request log for the public status page (p95 latency and error budget).
-- api/src/logging.ts writes 1 in 20 requests here from waitUntil over the owner connection. No tenant data:
-- only the route path, status and duration. Rows older than 30 days are removed by the daily cleanup.
-- Statements are separated by a line containing only "-- ;" (see api/db/migrate.mjs).

create table if not exists request_log_samples (
  id bigserial primary key,
  ts timestamptz not null default now(),
  path text not null,
  status int not null,
  ms int not null
)
-- ;
create index if not exists request_log_samples_ts on request_log_samples (ts desc)
