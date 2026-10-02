// Deployment mode. Laissez ships one code base for two very different audiences: the public sandbox, where
// fictional institutions, a demo identity provider and test cash make the product explorable, and production,
// where none of that may exist. LAISSEZ_MODE picks the mode (default sandbox). Everything fictional checks it
// here, in one place, so the production path never depends on a scattered set of per-route conditions.
import type { MiddlewareHandler } from 'hono';
import { ApiError } from './util';

export type Mode = 'sandbox' | 'production';
type ModeEnv = { LAISSEZ_MODE?: string };

/** The current mode. Anything other than the exact string "production" is sandbox. */
export const mode = (env: ModeEnv | undefined | null): Mode => (env?.LAISSEZ_MODE === 'production' ? 'production' : 'sandbox');
export const isProduction = (env: ModeEnv | undefined | null): boolean => mode(env) === 'production';
export const isSandboxMode = (env: ModeEnv | undefined | null): boolean => mode(env) === 'sandbox';

/** Throws the standard 404 for a fictional route that does not exist in production. */
export function fictionalOnly(env: ModeEnv, what: string): void {
  if (isProduction(env)) throw new ApiError(404, 'not_found', `${what} exists only in sandbox mode. This deployment runs in production mode.`);
}

/** Routes that answer 404 in production mode: fictional surfaces only. Method "*" matches every method. */
export const FICTIONAL_ROUTES: { method: string; path: RegExp; what: string }[] = [
  { method: 'POST', path: /^\/v1\/sandboxes$/, what: 'The sandbox' },
  { method: '*', path: /^\/idp(\/.*)?$/, what: 'The demo identity provider' },
  { method: 'GET', path: /^\/v1\/network\/demo-ids$/, what: 'The demo passport list' },
];
/** Routes that answer 403 in production mode: features that only make sense with fictional teammates. */
export const SANDBOX_ONLY_ROUTES: { method: string; path: RegExp; message: string }[] = [
  { method: 'POST', path: /^\/v1\/session\/act-as$/, message: 'Acting as a teammate exists only in sandboxes. This deployment runs in production mode.' },
];

/**
 * App-level guard, mounted before authentication so the production answer never touches the database.
 * In sandbox mode it does nothing. Individual handlers keep their own checks too, so a route that is
 * mounted differently later still cannot run fictional code in production.
 */
export const modeGuard: MiddlewareHandler<{ Bindings: ModeEnv }> = async (c, next) => {
  if (!isProduction(c.env)) return next();
  const path = new URL(c.req.url).pathname;
  const m = c.req.method.toUpperCase();
  if (m === 'OPTIONS') return next();
  for (const r of FICTIONAL_ROUTES) if ((r.method === '*' || r.method === m) && r.path.test(path)) throw new ApiError(404, 'not_found', `${r.what} exists only in sandbox mode. This deployment runs in production mode.`);
  for (const r of SANDBOX_ONLY_ROUTES) if ((r.method === '*' || r.method === m) && r.path.test(path)) throw new ApiError(403, 'sandbox_only', r.message);
  return next();
};

/** What each mode allows, for the runbook and GET /v1/mode style introspection. */
export const MODE_RULES: { rule: string; sandbox: string; production: string }[] = [
  { rule: 'POST /v1/sandboxes', sandbox: 'Creates a 7-day fictional sandbox', production: '404 not_found' },
  { rule: 'Demo identity provider (/idp/*)', sandbox: 'Served', production: '404 not_found' },
  { rule: 'Workspaces of kind sandbox', sandbox: 'Created by the sandbox route', production: 'Never created' },
  { rule: 'Fictional seed data on new organizations', sandbox: 'Opt-in at sign-up (demo_data)', production: 'Never inserted' },
  { rule: 'Test cash auto-mint on settlement', sandbox: 'Per deployment flag', production: 'Disabled' },
  { rule: 'Simulated reconciliation breaks', sandbox: 'Sandboxes only', production: '404 not_found' },
  { rule: 'POST /v1/session/act-as', sandbox: 'Sandboxes only', production: '403 sandbox_only' },
  { rule: 'GET /v1/network/demo-ids', sandbox: 'Sandboxes only', production: '404 not_found' },
  { rule: 'GET /v1/metrics/public', sandbox: 'Served', production: 'Served' },
];
