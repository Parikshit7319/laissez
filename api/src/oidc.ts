// OpenID Connect: a standards-based SSO client (authorization code + PKCE, signed ID tokens
// verified against the provider's JWKS) and a small demo identity provider for the sandbox.
import { Hono } from 'hono';
import type { Env } from './util';
import { ApiError, b64url, fromB64url, enc, randomB64, sha256Bytes } from './util';
import { adminSql } from './db';

type Fetcher = (req: Request) => Promise<Response>;
let selfFetch: Fetcher | null = null;
export const setSelfFetch = (f: Fetcher) => { selfFetch = f; };

/** Fetch that routes requests for this Worker's own URL in-process (a Worker cannot fetch its own hostname). */
export async function ofetch(env: Env, url: string, init?: RequestInit): Promise<Response> {
  if (selfFetch && url.startsWith(env.API_URL)) return selfFetch(new Request(url, init));
  return fetch(url, init);
}

const discoCache = new Map<string, { at: number; doc: any }>();
export async function discover(env: Env, issuer: string) {
  const hit = discoCache.get(issuer);
  if (hit && Date.now() - hit.at < 600_000) return hit.doc;
  const res = await ofetch(env, `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!res.ok) throw new ApiError(502, 'sso_discovery_failed', `Could not read the identity provider configuration from ${issuer}.`);
  const doc: any = await res.json();
  if (doc.issuer?.replace(/\/$/, '') !== issuer.replace(/\/$/, '')) throw new ApiError(502, 'sso_issuer_mismatch', 'The identity provider reported a different issuer.');
  discoCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

export async function pkce() {
  const verifier = randomB64(32);
  const challenge = b64url(await sha256Bytes(enc.encode(verifier)));
  return { verifier, challenge };
}

const jwksCache = new Map<string, { at: number; keys: any[] }>();
async function jwks(env: Env, uri: string, force = false) {
  const hit = jwksCache.get(uri);
  if (!force && hit && Date.now() - hit.at < 600_000) return hit.keys;
  const res = await ofetch(env, uri);
  if (!res.ok) throw new ApiError(502, 'sso_jwks_failed', 'Could not read the identity provider signing keys.');
  const keys = ((await res.json()) as any).keys ?? [];
  jwksCache.set(uri, { at: Date.now(), keys });
  return keys;
}

export async function verifyIdToken(env: Env, token: string, o: { issuer: string; clientId: string; nonce: string; jwksUri: string }) {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw new ApiError(401, 'sso_bad_token', 'The identity provider returned a malformed ID token.');
  const header = JSON.parse(new TextDecoder().decode(fromB64url(h)));
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(p)));
  const findKey = async (force: boolean) => { const ks = await jwks(env, o.jwksUri, force); return ks.find((k: any) => (header.kid ? k.kid === header.kid : true) && (!k.use || k.use === 'sig')); };
  const jwk = (await findKey(false)) ?? (await findKey(true));
  if (!jwk) throw new ApiError(401, 'sso_unknown_key', 'The ID token was signed with a key the provider does not publish.');
  const data = enc.encode(`${h}.${p}`);
  let ok = false;
  if (header.alg === 'ES256') {
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64url(s), data);
  } else if (header.alg === 'RS256') {
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(s), data);
  } else throw new ApiError(401, 'sso_bad_alg', `ID tokens signed with ${header.alg} are not accepted.`);
  if (!ok) throw new ApiError(401, 'sso_bad_signature', 'The ID token signature did not verify.');
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss?.replace(/\/$/, '') !== o.issuer.replace(/\/$/, '')) throw new ApiError(401, 'sso_bad_issuer', 'The ID token came from a different issuer.');
  if (!aud.includes(o.clientId)) throw new ApiError(401, 'sso_bad_audience', 'The ID token was issued for a different application.');
  if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new ApiError(401, 'sso_expired', 'The ID token has expired. Sign in again.');
  if (claims.nonce !== o.nonce) throw new ApiError(401, 'sso_bad_nonce', 'The sign-in response does not match this request.');
  if (!claims.email) throw new ApiError(401, 'sso_no_email', 'The identity provider did not share an email address.');
  if (claims.email_verified === false) throw new ApiError(401, 'sso_unverified', 'The identity provider says this email is not verified.');
  return claims as { sub: string; email: string; name?: string; email_verified?: boolean };
}

export async function exchangeCode(env: Env, tokenEndpoint: string, p: { code: string; redirectUri: string; clientId: string; clientSecret: string; verifier: string }) {
  const res = await ofetch(env, tokenEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, client_id: p.clientId, client_secret: p.clientSecret, code_verifier: p.verifier }).toString(),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.id_token) throw new ApiError(401, 'sso_token_failed', `The identity provider refused the sign-in${j.error ? ` (${j.error})` : ''}.`);
  return j.id_token as string;
}

// ---------- Demo identity provider (fictional people, for trying SSO in the sandbox) ----------
export const DEMO_IDP_CLIENT = { id: 'laissez-sandbox', secret: 'demo-secret-not-for-production', domain: 'astervale.example' };
export const DEMO_PEOPLE = [
  { email: 'aisha.rahman@astervale.example', name: 'Aisha Rahman', title: 'Head of Compliance' },
  { email: 'priya.nair@astervale.example', name: 'Priya Nair', title: 'Onboarding analyst' },
  { email: 'tomas.lindqvist@astervale.example', name: 'Tomas Lindqvist', title: 'Funds platform lead' },
  { email: 'daniel.okafor@astervale.example', name: 'Daniel Okafor', title: 'Platform engineer' },
];

let idpKey: { priv: CryptoKey; pub: JsonWebKey } | null = null;
async function idpKeys(env: Env) {
  if (idpKey) return idpKey;
  if (!env.DEMO_IDP_JWK) throw new ApiError(501, 'not_configured', 'The demo identity provider is not configured.');
  const jwk = JSON.parse(env.DEMO_IDP_JWK);
  const priv = await crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  idpKey = { priv, pub: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid: 'demo-1', use: 'sig', alg: 'ES256' } as JsonWebKey };
  return idpKey;
}
async function signJwt(env: Env, claims: Record<string, unknown>) {
  const { priv } = await idpKeys(env);
  const h = b64url(enc.encode(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'demo-1' })));
  const p = b64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

export const idp = new Hono<{ Bindings: Env }>();
idp.get('/.well-known/openid-configuration', (c) => {
  const iss = `${c.env.API_URL}/idp`;
  return c.json({ issuer: iss, authorization_endpoint: `${iss}/authorize`, token_endpoint: `${iss}/token`, jwks_uri: `${iss}/jwks`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['ES256'], code_challenge_methods_supported: ['S256'], scopes_supported: ['openid', 'email', 'profile'], token_endpoint_auth_methods_supported: ['client_secret_post'] });
});
idp.get('/jwks', async (c) => c.json({ keys: [(await idpKeys(c.env)).pub] }));
idp.get('/authorize', (c) => {
  const q = c.req.query();
  if (q.client_id !== DEMO_IDP_CLIENT.id || !q.redirect_uri?.startsWith(c.env.API_URL) || q.response_type !== 'code' || q.code_challenge_method !== 'S256') return c.text('Invalid authorization request.', 400);
  const hidden = ['redirect_uri', 'state', 'nonce', 'code_challenge', 'client_id'].map((k) => `<input type="hidden" name="${k}" value="${esc(q[k] ?? '')}">`).join('');
  const people = DEMO_PEOPLE.map((p) => `<button name="email" value="${esc(p.email)}"><strong>${esc(p.name)}</strong><span>${esc(p.title)}, ${esc(p.email)}</span></button>`).join('');
  c.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aster &amp; Vale sign-in (demo)</title>
<style>body{margin:0;font:15px/1.5 system-ui,sans-serif;background:#f1eee8;color:#151412;display:grid;place-items:center;min-height:100vh;padding:16px}main{background:#fff;border:1px solid #ddd6c9;border-radius:14px;max-width:440px;width:100%;padding:28px}h1{font-size:20px;margin:0 0 4px}p{color:#6f685d;margin:0 0 18px;font-size:14px}form{display:grid;gap:10px}button{display:grid;text-align:left;gap:2px;padding:12px 14px;border:1px solid #d6cfc2;border-radius:10px;background:#faf8f4;cursor:pointer;font:inherit}button:hover{border-color:#b8975a}button span{font-size:12.5px;color:#7a7368}.note{font-size:12px;color:#8a8377;margin-top:16px}</style></head>
<body><main><h1>Aster &amp; Vale workforce sign-in</h1><p>Demo identity provider for the Laissez sandbox. Everyone listed is fictional. Choose who to sign in as.</p><form method="post" action="${esc(c.env.API_URL)}/idp/authorize">${hidden}${people}</form><p class="note">A real deployment uses your company's provider, such as Okta, Microsoft Entra ID or Google Workspace.</p></main></body></html>`);
});
idp.post('/authorize', async (c) => {
  const f = await c.req.parseBody();
  const person = DEMO_PEOPLE.find((p) => p.email === f.email);
  if (!person || f.client_id !== DEMO_IDP_CLIENT.id || !String(f.redirect_uri).startsWith(c.env.API_URL)) return c.text('Invalid request.', 400);
  const sql = adminSql(c.env.DATABASE_URL);
  const code = randomB64(24);
  await sql`insert into auth_challenges (challenge, purpose, data, expires_at) values (${code}, 'idp_code', ${JSON.stringify({ ...person, nonce: f.nonce, code_challenge: f.code_challenge, redirect_uri: f.redirect_uri })}, now() + interval '2 minutes')`;
  const u = new URL(String(f.redirect_uri));
  u.searchParams.set('code', code); u.searchParams.set('state', String(f.state ?? ''));
  return c.redirect(u.toString(), 302);
});
idp.post('/token', async (c) => {
  const f = await c.req.parseBody();
  if (f.client_id !== DEMO_IDP_CLIENT.id || f.client_secret !== DEMO_IDP_CLIENT.secret) return c.json({ error: 'invalid_client' }, 401);
  const sql = adminSql(c.env.DATABASE_URL);
  const rows = await sql`delete from auth_challenges where challenge = ${String(f.code)} and purpose = 'idp_code' and expires_at > now() returning data`;
  if (!rows.length) return c.json({ error: 'invalid_grant' }, 400);
  const d = rows[0].data;
  const expect = b64url(await sha256Bytes(enc.encode(String(f.code_verifier ?? ''))));
  if (expect !== d.code_challenge || f.redirect_uri !== d.redirect_uri) return c.json({ error: 'invalid_grant' }, 400);
  const now = Math.floor(Date.now() / 1000);
  const idToken = await signJwt(c.env, { iss: `${c.env.API_URL}/idp`, sub: d.email, aud: DEMO_IDP_CLIENT.id, iat: now, exp: now + 300, nonce: d.nonce, email: d.email, email_verified: true, name: d.name });
  return c.json({ token_type: 'Bearer', id_token: idToken, expires_in: 300 });
});
