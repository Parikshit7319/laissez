// The error catalogue. Codes are compiled from the source by scripts/gen-errors.ts into errors.generated.ts;
// this module shapes them as a lookup (ERRORS) and serves them publicly at GET /v1/errors so SDKs and docs
// can reference one list. Remediation text comes from the second sentence of the thrown message, with a few
// hand-written overrides below for codes whose message alone does not say what to do.
import { ERROR_CATALOGUE, GENERATED_AT, type ErrorEntry } from './errors.generated';
import { router } from './http';

export type ErrorInfo = { status: number; message: string; remediation: string; sites: string[] };

/** Remediation for codes whose thrown message is only a statement of fact. */
const REMEDIATION: Record<string, string> = {
  unauthorized: 'Send a valid session token or API key as "Authorization: Bearer ...". Open a sandbox with POST /v1/sandboxes to get one.',
  session_expired: 'Sign in again.',
  forbidden: 'Ask an administrator to give your role the permission, or use an account that has it.',
  insufficient_scope: 'Create a key with the right scope under Organization, API keys, or use a key that has it.',
  human_required: 'Do this as a signed-in person. API keys can propose but not approve.',
  rate_limited: 'Wait for the Retry-After seconds, then retry. Spread bursts over time or use more than one key.',
  quota_exceeded: 'Wait for the monthly reset or ask for a higher quota.',
  not_found: 'Check the id and the organization you are signed in to.',
  invalid_request: 'Fix the fields listed in detail and send the request again.',
  invalid_cursor: 'Use the next_cursor value returned with the previous page.',
  idempotency_mismatch: 'Use a new Idempotency-Key for a new request; reuse a key only to retry the same request.',
  idempotency_in_progress: 'Wait a few seconds and send the same request again.',
  internal_error: 'Retry. If it keeps failing, contact us with the request_id from the response.',
  sandbox_only: 'This exists for exploring the product in a sandbox. There is no production equivalent.',
  chain_not_configured: 'Settlement runs simulated until an on-chain deployment is configured.',
  threshold_not_met: 'Review the per-class results in detail and issue only the classifications whose evidence meets the legal threshold.',
};

export const ERRORS: Record<string, ErrorInfo> = Object.fromEntries(
  ERROR_CATALOGUE.map((e: ErrorEntry) => [e.code, { status: e.status, message: e.message, remediation: REMEDIATION[e.code] ?? e.remediation ?? '', sites: e.sites }]),
);

export const publicRoutes = router();
publicRoutes.get('/errors', (c) => {
  const data = ERROR_CATALOGUE.map((e) => ({ code: e.code, status: e.status, message: e.message, remediation: REMEDIATION[e.code] ?? e.remediation ?? null }));
  c.header('Cache-Control', 'public, max-age=3600');
  return c.json({ generated: GENERATED_AT, count: data.length, format: { error: { code: 'snake_case, stable', message: 'What happened and how to fix it', detail: 'Optional structured detail' } }, data });
});

// ---------- OpenAPI operation (merged by api/src/openapi-gen.ts) ----------
export const OPENAPI_OPS = [
  { method: 'get', path: '/v1/errors', tag: 'Platform', id: 'listErrorCodes', sum: 'Error catalogue', perm: 'public', desc: 'Every error code the API can return, with its HTTP status, message and what to do. Generated from the source. Cached for an hour.', res: { type: 'object', properties: { generated: { type: 'string', format: 'date' }, count: { type: 'integer' }, data: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, status: { type: 'integer' }, message: { type: 'string' }, remediation: { type: ['string', 'null'] } }, required: ['code', 'status', 'message'] } } }, required: ['data'] } },
];
