// Identity verification through a provider. The first provider is Sumsub (document and liveness checks, with its own
// sanctions and PEP screening). Laissez never sees the documents: the provider's SDK runs in the person's browser, the
// provider reviews, and the result comes back by webhook. The full result is sealed with EVIDENCE_ENC_KEY before it is
// stored; every read of it is written to evidence_access_log. Self-attested evidence (the numbers typed into the
// credential form) keeps working; a verified check gives a credential an evidence reference a bank can rely on.
//
// Secrets: SUMSUB_APP_TOKEN, SUMSUB_SECRET_KEY, SUMSUB_WEBHOOK_SECRET (webhook digest), SUMSUB_LEVEL (default
// basic-kyc-level), SUMSUB_API_BASE (default https://api.sumsub.com; a local mock in tests), EVIDENCE_ENC_KEY (falls
// back to SSO_ENC_KEY). Without the first two, every KYC route answers 501 not_configured.
import type { Sql } from './db';
import { type Env, ApiError, sha256, id as mkId } from './util';

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export type KycEnv = Env;

export const kycConfigured = (env: KycEnv) => !!(env.SUMSUB_APP_TOKEN && env.SUMSUB_SECRET_KEY);
export const kycLevel = (env: KycEnv) => env.SUMSUB_LEVEL || 'basic-kyc-level';
const apiBase = (env: KycEnv) => (env.SUMSUB_API_BASE || 'https://api.sumsub.com').replace(/\/$/, '');

export function requireKyc(env: KycEnv) {
  if (!kycConfigured(env)) throw new ApiError(501, 'not_configured', 'Identity verification is not switched on for this deployment. Set SUMSUB_APP_TOKEN and SUMSUB_SECRET_KEY on the API (docs/runbook.md, Switching on identity verification).');
}

// ---------- Evidence sealing (AES-GCM under a key kept for evidence only) ----------
async function evidenceKey(env: KycEnv) {
  const raw = env.EVIDENCE_ENC_KEY || env.SSO_ENC_KEY;
  if (!raw) throw new ApiError(501, 'not_configured', 'EVIDENCE_ENC_KEY is not set, so verification evidence cannot be stored.');
  return crypto.subtle.importKey('raw', fromB64url(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealEvidence(env: KycEnv, plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await evidenceKey(env), enc.encode(plain));
  return `${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}
export async function unsealEvidence(env: KycEnv, sealed: string) {
  const [iv, ct] = sealed.split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(iv) }, await evidenceKey(env), fromB64url(ct)));
}

// ---------- Sumsub client ----------
/** Sumsub request signing: HMAC-SHA256 over "<ts><METHOD><path+query><body>" with the secret key, hex. */
export async function sumsubSignature(secret: string, ts: number, method: string, pathWithQuery: string, body: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}${method.toUpperCase()}${pathWithQuery}${body}`)));
}

async function sumsub(env: KycEnv, method: string, pathWithQuery: string, body?: unknown) {
  requireKyc(env);
  const ts = Math.floor(Date.now() / 1000);
  const raw = body === undefined ? '' : JSON.stringify(body);
  const sig = await sumsubSignature(env.SUMSUB_SECRET_KEY!, ts, method, pathWithQuery, raw);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20_000);
  try {
    const r = await fetch(`${apiBase(env)}${pathWithQuery}`, {
      method, body: raw || undefined, signal: ctl.signal,
      headers: { accept: 'application/json', ...(raw ? { 'content-type': 'application/json' } : {}), 'x-app-token': env.SUMSUB_APP_TOKEN!, 'x-app-access-ts': String(ts), 'x-app-access-sig': sig },
    });
    const text = await r.text();
    let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!r.ok) throw new ApiError(502, 'kyc_provider_error', `The identity provider answered ${r.status}. ${data?.description ?? data?.message ?? ''}`.trim(), { status: r.status, code: data?.code ?? null });
    return data;
  } finally { clearTimeout(t); }
}

export const externalUserId = (ws: string, investorId: string) => `${ws}:${investorId}`;

/** Creates (or reuses) the applicant for an investor and returns a short-lived token for the provider's web SDK. */
export async function startCheck(env: KycEnv, sql: Sql, admin: Sql, ws: string, inv: { id: string; name: string; email?: string | null; residence?: string | null; kind?: string }, by: string) {
  requireKyc(env);
  const level = kycLevel(env);
  const ext = externalUserId(ws, inv.id);
  const [open] = await sql`select id, applicant_id from kyc_checks where workspace_id = ${ws} and investor_id = ${inv.id} and status in ('started', 'pending', 'retry') order by created_at desc limit 1`;
  let applicantId: string | null = open?.applicant_id ?? null;
  if (!applicantId) {
    const [first, ...rest] = inv.name.trim().split(/\s+/);
    const created = await sumsub(env, 'POST', `/resources/applicants?levelName=${encodeURIComponent(level)}`, {
      externalUserId: ext, ...(inv.email ? { email: inv.email } : {}),
      fixedInfo: { firstName: first, lastName: rest.join(' ') || undefined, country: inv.residence ? iso3(inv.residence) : undefined },
      type: inv.kind && inv.kind.toLowerCase() !== 'individual' ? 'company' : 'individual',
    }).catch(async (e: any) => {
      // An applicant for this external id may exist from an earlier attempt: look it up instead of failing.
      if (e?.detail?.status === 409) return sumsub(env, 'GET', `/resources/applicants/-;externalUserId=${encodeURIComponent(ext)}/one`);
      throw e;
    });
    applicantId = created?.id ?? null;
  }
  const token = await sumsub(env, 'POST', `/resources/accessTokens?userId=${encodeURIComponent(ext)}&levelName=${encodeURIComponent(level)}&ttlInSecs=1200`);
  const id = open?.id ?? mkId('kyc');
  if (!open) {
    // The tenant role reads this table without the sealed column; writes go through the owner connection.
    await admin`insert into kyc_checks (id, workspace_id, investor_id, provider, applicant_id, level_name, status, created_by) values (${id}, ${ws}, ${inv.id}, 'sumsub', ${applicantId}, ${level}, 'started', ${by})`;
  }
  return { check_id: id, applicant_id: applicantId, level, sdk_token: token?.token ?? null, external_user_id: ext };
}

/** Pulls the applicant's status and data from the provider, records the outcome and seals the evidence. */
export async function refreshCheck(env: KycEnv, admin: Sql, ws: string, checkId: string) {
  const [chk] = await admin`select * from kyc_checks where workspace_id = ${ws} and id = ${checkId}`;
  if (!chk) throw new ApiError(404, 'not_found', 'No verification check with that id in this organization.');
  if (!chk.applicant_id) throw new ApiError(409, 'kyc_not_started', 'This check has no applicant at the provider yet.');
  const status = await sumsub(env, 'GET', `/resources/applicants/${encodeURIComponent(chk.applicant_id)}/status`);
  const data = await sumsub(env, 'GET', `/resources/applicants/${encodeURIComponent(chk.applicant_id)}/one`).catch(() => null);
  return applyResult(env, admin, chk, status, data, 'refresh');
}

const mapStatus = (reviewStatus: string | undefined, answer: string | undefined, rejectType: string | undefined): 'started' | 'pending' | 'approved' | 'rejected' | 'retry' => {
  if (reviewStatus === 'completed') return answer === 'GREEN' ? 'approved' : rejectType === 'RETRY' ? 'retry' : 'rejected';
  if (reviewStatus === 'pending' || reviewStatus === 'queued' || reviewStatus === 'onHold' || reviewStatus === 'prechecked') return 'pending';
  return 'started';
};

/** Shared by refresh and the webhook. Keeps only what a reviewer needs in the clear; everything else is sealed. */
export async function applyResult(env: KycEnv, admin: Sql, chk: any, status: any, data: any, via: 'refresh' | 'webhook') {
  const result = status?.reviewResult ?? {};
  const next = mapStatus(status?.reviewStatus, result.reviewAnswer, result.reviewRejectType);
  const outcome = {
    review_status: status?.reviewStatus ?? null, answer: result.reviewAnswer ?? null, reject_type: result.reviewRejectType ?? null, reject_labels: result.rejectLabels ?? [],
    moderation_comment: result.moderationComment ?? null, level: status?.levelName ?? chk.level_name, checked_via: via, at: new Date().toISOString(),
    document_types: Array.isArray(data?.requiredIdDocs?.docSets) ? data.requiredIdDocs.docSets.flatMap((d: any) => d.types ?? []) : [],
  };
  const evidenceText = JSON.stringify({ status, applicant: data });
  const sealed = await sealEvidence(env, evidenceText);
  const digest = await sha256(evidenceText);
  await admin`update kyc_checks set status = ${next}, outcome = ${JSON.stringify(outcome)}, evidence_enc = ${sealed}, evidence_sha256 = ${digest}, reviewed_at = ${next === 'approved' || next === 'rejected' ? new Date() : null}, last_webhook_at = ${via === 'webhook' ? new Date() : chk.last_webhook_at} where id = ${chk.id}`;
  if (next === 'rejected' || next === 'retry') {
    await admin`insert into work_items (workspace_id, id, kind, dedupe_key, title, detail, severity, investor_id, link)
      values (${chk.workspace_id}, ${mkId('wi')}, 'kyc_review', ${`kyc:${chk.investor_id}:${chk.id}`}, ${next === 'retry' ? 'Identity check needs another attempt' : 'Identity check rejected'}, ${`${(outcome.reject_labels as string[]).join(', ') || 'The provider did not approve the applicant.'}${outcome.moderation_comment ? ` ${outcome.moderation_comment}` : ''}`}, ${next === 'rejected' ? 'high' : 'medium'}, ${chk.investor_id}, ${`#/clients/${chk.investor_id}`})
      on conflict (workspace_id, dedupe_key) where status = 'open' do nothing`;
  }
  return { id: chk.id, status: next, outcome, evidence_sha256: digest };
}

/** Verifies a Sumsub webhook digest: x-payload-digest over the raw body with the webhook secret, algorithm in x-payload-digest-alg. */
export async function verifyWebhookDigest(env: KycEnv, rawBody: string, digest: string | null, alg: string | null): Promise<boolean> {
  const secret = env.SUMSUB_WEBHOOK_SECRET;
  if (!secret) return false;
  const hash = /512/.test(alg ?? '') ? 'SHA-512' : /1\b/.test(alg ?? '') && !/256/.test(alg ?? '') ? 'SHA-1' : 'SHA-256';
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
  if (!digest || digest.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ digest.charCodeAt(i);
  return diff === 0;
}

/** Reads sealed evidence and writes the access log in the same breath. */
export async function readEvidence(env: KycEnv, admin: Sql, ws: string, checkId: string, by: string, purpose: string, ipHash: string | null) {
  const [chk] = await admin`select id, investor_id, evidence_enc, evidence_sha256 from kyc_checks where workspace_id = ${ws} and id = ${checkId}`;
  if (!chk) throw new ApiError(404, 'not_found', 'No verification check with that id in this organization.');
  if (!chk.evidence_enc) throw new ApiError(404, 'no_evidence', 'No result has been stored for this check yet. Refresh it, or wait for the provider webhook.');
  await admin`insert into evidence_access_log (workspace_id, object_kind, object_id, accessed_by, purpose, ip_hash) values (${ws}, 'kyc_check', ${checkId}, ${by}, ${purpose}, ${ipHash})`;
  const text = await unsealEvidence(env, chk.evidence_enc);
  return { check_id: chk.id, investor_id: chk.investor_id, sha256: chk.evidence_sha256, evidence: JSON.parse(text) };
}

// ISO 3166-1 alpha-2 to alpha-3 for the jurisdictions Laissez supports; the provider wants alpha-3.
const ISO3: Record<string, string> = { SG: 'SGP', HK: 'HKG', CH: 'CHE', DE: 'DEU', AE: 'ARE', 'AE-DIFC': 'ARE', 'AE-ADGM': 'ARE', US: 'USA', GB: 'GBR', JP: 'JPN', LU: 'LUX', IE: 'IRL', IN: 'IND', AU: 'AUS', CA: 'CAN', BR: 'BRA', KR: 'KOR', IR: 'IRN', CU: 'CUB', KP: 'PRK' };
const iso3 = (code: string) => ISO3[code] ?? undefined;
