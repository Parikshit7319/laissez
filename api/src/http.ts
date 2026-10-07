import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Sql } from './db';
import { ApiError, type Env } from './util';

export type Role = 'admin' | 'ops' | 'compliance' | 'legal' | 'issuer' | 'developer' | 'auditor';
export type Actor = {
  kind: 'user' | 'key' | 'system' | 'investor';
  id: string;
  name: string;
  role?: Role;
  userId?: string;
  realUserId?: string;
  scopes?: string[];
  sessionId?: string;
  keyId?: string;
};
export type Vars = {
  sql: Sql; admin: Sql; ws: string; wsKind: string; actor: Actor; version: string;
  /** 'full' or 'decide_only' (the customer settles on its own rails). */
  settlementMode?: string;
  /** Set when a suspended organization reaches a route that stays open for redemptions only. */
  suspended?: boolean;
  /** Session id and the time of the last fresh passkey assertion, for step-up checks. Absent for API keys. */
  sessionId?: string; steppedUpAt?: number;
};
export type C = Context<{ Bindings: Env; Variables: Vars }>;
export const router = () => new Hono<{ Bindings: Env; Variables: Vars }>();

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrator', ops: 'Operations analyst', compliance: 'Compliance officer', legal: 'Legal reviewer', issuer: 'Issuer admin', developer: 'Developer', auditor: 'Auditor (read-only)',
};
const ROLE_PERMS: Record<Role, string[]> = {
  admin: ['*'],
  ops: ['read', 'clients:write', 'orders:write', 'work:write'],
  compliance: ['read', 'clients:write', 'compliance:write', 'policy:approve', 'work:write', 'audit:export', 'rules:write', 'rules:approve'],
  legal: ['read', 'compliance:write', 'rules:approve', 'billing:read'],
  issuer: ['read', 'funds:write', 'policy:approve'],
  developer: ['read', 'developer'],
  auditor: ['read', 'audit:export'],
};
export const SCOPES: Record<string, { label: string; perms: string[] }> = {
  read: { label: 'Read everything in the organization', perms: ['read', 'audit:export'] },
  orders: { label: 'Create decisions and settlements', perms: ['orders:write'] },
  clients: { label: 'Manage clients, credentials and shares', perms: ['clients:write'] },
  funds: { label: 'Manage funds, NAV, documents and policy proposals', perms: ['funds:write'] },
  compliance: { label: 'Screening dispositions, monitoring, work items, custom rule drafts', perms: ['compliance:write', 'work:write', 'rules:write'] },
  developer: { label: 'Webhooks', perms: ['developer'] },
  admin: { label: 'Manage API keys', perms: ['keys:admin'] },
};
/** Permissions that only a signed-in person can exercise, never an API key. */
const HUMAN_ONLY = new Set(['policy:approve', 'members:admin', 'rules:approve', 'billing:write']);

const PERM_TEXT: Record<string, string> = {
  'read': 'read this organization', 'clients:write': 'manage clients and credentials', 'orders:write': 'place orders or settle',
  'funds:write': 'change funds', 'policy:approve': 'approve or reject policy changes', 'compliance:write': 'make compliance decisions',
  'work:write': 'resolve work items', 'developer': 'manage webhooks', 'keys:admin': 'manage API keys', 'members:admin': 'manage members and SSO', 'audit:export': 'export the audit log',
  'rules:write': 'author or edit custom rules', 'rules:approve': 'approve custom rules',
  'billing:read': 'view billing, invoices and contracts', 'billing:write': 'accept contracts and manage billing',
};

export function can(actor: Actor, perm: string): boolean {
  if (actor.kind === 'system') return true;
  if (actor.kind === 'user' && actor.role) {
    const p = ROLE_PERMS[actor.role];
    return p.includes('*') || p.includes(perm) || (perm === 'keys:admin' && actor.role === 'developer');
  }
  if (actor.kind === 'key') {
    if (HUMAN_ONLY.has(perm)) return false;
    return (actor.scopes ?? []).some((s) => SCOPES[s]?.perms.includes(perm));
  }
  return false;
}
export function need(c: C, perm: string) {
  const a = c.get('actor');
  if (can(a, perm)) return a;
  if (a.kind === 'key' && HUMAN_ONLY.has(perm)) throw new ApiError(403, 'human_required', `Only a signed-in person can ${PERM_TEXT[perm] ?? perm}. API keys can propose, not approve.`);
  if (a.kind === 'key') throw new ApiError(403, 'insufficient_scope', `This API key is not allowed to ${PERM_TEXT[perm] ?? perm}. Add the right scope or use another key.`);
  throw new ApiError(403, 'forbidden', `Your role (${a.role ? ROLE_LABEL[a.role] : 'none'}) cannot ${PERM_TEXT[perm] ?? perm}. Ask an administrator to change your role.`);
}
export const actorRef = (a: Actor) => `${a.kind}:${a.id}`;

/** How long a fresh passkey assertion covers sensitive actions. */
export const STEP_UP_WINDOW_MS = 10 * 60 * 1000;
/**
 * Sensitive actions need a passkey assertion made in the last ten minutes, not only a live session. API keys cannot
 * reach the actions that call this (they are human-only), so a key here is a programming error, not a policy gap.
 */
export function needStepUp(c: C, what: string) {
  const a = c.get('actor');
  if (a.kind !== 'user') throw new ApiError(403, 'human_required', `Only a signed-in person can ${what}.`);
  if (c.get('wsKind') !== 'org') return; // sandboxes have no passkeys to assert with, and nothing real to protect
  const at = c.get('steppedUpAt') ?? 0;
  if (Date.now() - at > STEP_UP_WINDOW_MS) throw new ApiError(403, 'step_up_required', `Confirm it is you with your passkey to ${what}. The confirmation lasts ten minutes.`, { step_up: '/v1/auth/step-up', window_seconds: STEP_UP_WINDOW_MS / 1000 });
}

export async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  return schema.parse(await c.req.json().catch(() => ({})));
}
export const bg = (c: Context, p: Promise<unknown>) => c.executionCtx.waitUntil(p.catch((e) => console.error(e)));

/** Append to the hash-chained audit log. The database trigger links the event to the previous one. */
export async function audit(sql: Sql, ws: string, actor: Actor | null, type: string, subject: string | null, data: unknown = {}) {
  await sql`insert into audit_events (workspace_id, type, subject, data, actor, actor_name) values (${ws}, ${type}, ${subject}, ${JSON.stringify(data)}, ${actor ? actorRef(actor) : 'system'}, ${actor?.name ?? 'Laissez'})`;
}
export function auditQ(sql: Sql, ws: string, actor: Actor | null, type: string, subject: string | null, data: unknown = {}) {
  return sql`insert into audit_events (workspace_id, type, subject, data, actor, actor_name) values (${ws}, ${type}, ${subject}, ${JSON.stringify(data)}, ${actor ? actorRef(actor) : 'system'}, ${actor?.name ?? 'Laissez'})`;
}
export const SYSTEM: Actor = { kind: 'system', id: 'laissez', name: 'Laissez' };
