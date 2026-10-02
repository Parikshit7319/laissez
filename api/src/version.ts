// API versioning. Clients pin a version with the Laissez-Version header; omitting it means the latest.
import type { MiddlewareHandler } from 'hono';
import type { Env } from './util';
import type { Vars } from './http';
import { ApiError } from './util';

export const VERSIONS = [
  {
    version: '2026-10-02', released: '2026-10-02',
    changes: [
      'Accounts with passkeys and single sign-on, organizations and roles.',
      'Scoped API keys with IP allowlists, expiry and 24-hour rotation.',
      'Idempotency-Key on every authenticated write.',
      'On-chain settlement: POST /v1/settlements may return 202 with status pending. Poll GET /v1/settlements/{id} until it settles.',
      'Decisions record a replayable snapshot, a dealing date and the acting person or key.',
    ],
  },
  {
    version: '2026-10-01', released: '2026-10-01',
    changes: ['Launch API.', 'Settlement is simulated and always returns 201 with status settled.'],
  },
] as const;
export const SUPPORTED_VERSIONS: string[] = VERSIONS.map((v) => v.version);
export const LATEST_VERSION = VERSIONS[0].version;

/** Reads Laissez-Version, rejects unknown versions, and echoes the version used on the response. */
export const versionMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const asked = c.req.header('laissez-version')?.trim();
  const v = asked || LATEST_VERSION;
  if (!SUPPORTED_VERSIONS.includes(v)) {
    throw new ApiError(400, 'unsupported_version', `Laissez-Version ${asked} is not supported. Use one of ${SUPPORTED_VERSIONS.join(', ')}, or leave the header out to get ${LATEST_VERSION}.`);
  }
  c.set('version', v);
  await next();
  try { c.res.headers.set('Laissez-Version', v); }
  catch { c.res = new Response(c.res.body, c.res); c.res.headers.set('Laissez-Version', v); }
};
