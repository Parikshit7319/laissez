// In-app notifications. A notification belongs to an organization and, optionally, to one member of it;
// one without a user is shown to everyone in the organization. Writers never wait on delivery: this is a
// single insert, and failures are logged, not raised, so a notification can never fail the action behind it.
import type { Sql } from './db';
import { id } from './util';

export type Notice = {
  /** Machine kind, for example 'monitor.item', 'monitor.run', 'policy.proposed', 'screening.hit', 'travel_rule.review'. */
  kind: string;
  title: string;
  body?: string;
  /** App link, for example '#/work' or '#/screening-hits/hit_abc'. */
  link?: string | null;
  /** A member's user id, or null for the whole organization. */
  user_id?: string | null;
};

/** Roles that may approve a fund policy change (policy:approve in http.ts). */
export const APPROVER_ROLES = ['admin', 'compliance', 'issuer'];
/** Roles that make compliance decisions (compliance:write in http.ts). */
export const COMPLIANCE_ROLES = ['admin', 'compliance'];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Insert one or more notifications in a single statement. Returns the number written. */
export async function notify(sql: Sql, ws: string, notices: Notice | Notice[]): Promise<number> {
  const list = (Array.isArray(notices) ? notices : [notices]).filter((n) => n && n.title);
  if (!list.length) return 0;
  try {
    await sql.query(
      `insert into notifications (workspace_id, id, user_id, kind, title, body, link)
       select $1, u.id, u.uid::uuid, u.kind, u.title, u.body, u.link
       from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) as u(id, uid, kind, title, body, link)`,
      [ws, list.map(() => id('ntf', 12)), list.map((n) => n.user_id ?? null), list.map((n) => n.kind), list.map((n) => clip(n.title, 200)), list.map((n) => clip(n.body ?? '', 1000)), list.map((n) => n.link ?? null)],
    );
    return list.length;
  } catch (e) {
    console.error('notify failed', e);
    return 0;
  }
}

/** The query for one notification, to include in a caller's transaction. */
export function notifyQ(sql: Sql, ws: string, n: Notice) {
  return sql`insert into notifications (workspace_id, id, user_id, kind, title, body, link)
    values (${ws}, ${id('ntf', 12)}, ${n.user_id ?? null}, ${n.kind}, ${clip(n.title, 200)}, ${clip(n.body ?? '', 1000)}, ${n.link ?? null})`;
}

/**
 * Notify every member holding one of the roles, except the person who caused it (they already know).
 * Falls back to one organization-wide notification when nobody with the role is a member yet.
 */
export async function notifyRoles(sql: Sql, ws: string, roles: string[], n: Notice, exceptUserId?: string | null): Promise<number> {
  let users: { user_id: string }[] = [];
  try {
    users = await sql`select user_id::text as user_id from memberships where workspace_id = ${ws} and role = any(${roles}) and (${exceptUserId ?? null}::uuid is null or user_id <> ${exceptUserId ?? null}::uuid)`;
  } catch (e) {
    console.error('notifyRoles lookup failed', e);
  }
  if (!users.length) return notify(sql, ws, { ...n, user_id: null });
  return notify(sql, ws, users.map((u) => ({ ...n, user_id: u.user_id })));
}

/** The notification bell: unread count for this member (their own plus organization-wide ones). */
export async function unreadCount(sql: Sql, ws: string, userId: string | null): Promise<number> {
  const [r] = await sql`select count(*)::int as n from notifications where workspace_id = ${ws} and read_at is null and (user_id is null or user_id = ${userId}::uuid)`;
  return r?.n ?? 0;
}
