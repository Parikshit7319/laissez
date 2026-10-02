-- Migration 004: sandbox users may reuse fictional emails across sandboxes; real accounts stay globally unique.
alter table users drop constraint if exists users_email_key
-- ;
create unique index if not exists users_email_global on users (email) where sandbox_workspace is null
-- ;
create unique index if not exists users_email_sandbox on users (email, sandbox_workspace) where sandbox_workspace is not null
-- ;
create index if not exists sessions_user on sessions (user_id)
-- ;
create index if not exists memberships_user on memberships (user_id)
-- ;
create unique index if not exists workspaces_sso_domain on workspaces ((sso->>'email_domain')) where kind = 'org' and (sso->>'enabled')::boolean
