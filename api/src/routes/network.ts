// Portable credentials. A distributor can rely on another distributor's customer due diligence and
// investor classification: it requests a share by the credential's network passport number, the client
// consents on a Laissez page, and the receiving organization gets a client record whose credential is
// read live from the issuing organization (see loadInvestors). Either side can revoke.
import { z } from 'zod';
import { router, need, body, audit, auditQ, type C, type Actor } from '../http';
import { adminSql, type Sql } from '../db';
import { ApiError, id, rand, sha256, rateLimit, today } from '../util';
import { loadGlobals } from '../ctx';
import { sendEmail, templates, deliverable } from '../email';

export const routes = router();
export const publicRoutes = router();

/** The permanent fictional distributor every sandbox can import clients from (see db/migrate-006-network.sql). */
export const NETWORK_WS = 'a1de0000-0000-4000-8000-000000000001';
const CONSENT_BASE = 'https://parikshit7319.github.io/laissez/consent/#';
const RELIANCE = "The receiving distributor relies on the issuing distributor's customer due diligence and investor classification under a reliance agreement. The issuing distributor keeps the records and must provide them on request. The receiving distributor still screens the client against sanctions lists itself.";
const SHARED_FIELDS = ['Legal name and investor type', 'Country of residence and city', 'Investor classifications and their expiry dates', 'Credential number and validity dates'];
const NOT_SHARED = ['Identity documents and KYC files', 'Financial statements and the evidence behind each classification', 'Holdings and transactions at the issuing distributor'];
const SUGGESTED_BOOKING: Record<string, string> = { SG: 'SG', HK: 'HK', CH: 'ZRH', DE: 'ZRH', 'AE-DIFC': 'DIFC', US: 'NY' };
const hexWallet = () => `0x${rand(4, '0123456789abcdef')}…${rand(4, '0123456789abcdef')}`;
const orgName = (w: { name: string; brand_name?: string | null }) => w.brand_name || w.name;
const networkActor = (org: string): Actor => ({ kind: 'system', id: 'network', name: `${org} (via the Laissez network)` });
const clientActor = (investor: string): Actor => ({ kind: 'system', id: 'consent', name: `${investor} (client consent)` });

function shareView(r: any, ws: string) {
  const outgoing = r.from_workspace === ws;
  const lapsed = r.cred_status && (r.cred_status !== 'active' || (r.cred_expires_on && r.cred_expires_on < today()));
  return {
    id: r.id, direction: outgoing ? 'outgoing' : 'incoming', status: r.status,
    lzid: r.lzid, investor_name: r.investor_name, purpose: r.purpose, booking_center: r.booking_center ?? null,
    issuing_org: r.from_name ?? null, receiving_org: r.to_name ?? null, counterparty_org: outgoing ? r.to_name ?? null : r.from_name ?? null,
    to_investor_id: r.to_investor_id, requested_by: r.requested_by_name ?? null,
    consent_name: r.consent_name, consent_at: r.consent_at, created_at: r.created_at, consent_expires_at: r.consent_expires_at ?? null,
    revoked_at: r.revoked_at, revoked_reason: r.revoked_reason,
    classifications: r.terms?.scope ?? [], credential_expires_on: r.cred_expires_on ?? r.terms?.credential_expires_on ?? null,
    credential_live: r.cred_status ? !lapsed : null, terms: r.terms,
  };
}

// ---------- Requests, list and revoke ----------
routes.post('/credential-shares', async (c) => {
  const actor = need(c, 'clients:write');
  const sql = c.get('sql'); const admin = c.get('admin'); const ws = c.get('ws'); const kind = c.get('wsKind');
  const b = await body(c, z.object({
    lzid: z.string().trim().toUpperCase().regex(/^LZ-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'Passport numbers look like LZ-7K2M-9QX4-PA3D.'),
    purpose: z.string().trim().min(3).max(300),
    booking_center: z.string().trim().min(2).max(10),
  }));
  const g = await loadGlobals(sql);
  if (!g.bookingCenters[b.booking_center]) throw new ApiError(422, 'unknown_booking_center', `Booking center ${b.booking_center} does not exist. Choose one of ${Object.keys(g.bookingCenters).join(', ')}.`);
  const [cred] = await admin`select c.id, c.workspace_id, c.investor_id, c.lzid, c.expires_on::text as expires_on, i.name as investor_name, i.email as investor_email, i.residence, w.name as ws_name, w.brand_name, w.kind as ws_kind,
      (select coalesce(json_agg(class_code order by id), '[]'::json) from classifications x where x.workspace_id = c.workspace_id and x.credential_id = c.id) as classes
    from credentials c join investors i on i.workspace_id = c.workspace_id and i.id = c.investor_id join workspaces w on w.id = c.workspace_id
    where c.lzid = ${b.lzid} and c.status = 'active' and c.workspace_id <> ${ws} and (w.expires_at is null or w.expires_at > now())`;
  const notFound = new ApiError(404, 'passport_not_found', 'No active credential with that passport number is available to you. Check the number with the client or the issuing distributor.');
  if (!cred) throw notFound;
  // Sandboxes reach only the fictional network and other sandboxes; real organizations reach the network and each other.
  const reachable = cred.ws_kind === 'network' || (kind === 'sandbox' && cred.ws_kind === 'sandbox') || (kind === 'org' && cred.ws_kind === 'org');
  if (!reachable) throw notFound;
  if (cred.expires_on < today()) throw new ApiError(409, 'credential_expired', `This credential expired on ${cred.expires_on}. Ask the issuing distributor to renew it before you rely on it.`);
  const existing = await sql`select id, status from credential_shares where to_workspace = ${ws} and from_workspace = ${cred.workspace_id} and credential_id = ${cred.id} and status in ('pending', 'active')`;
  if (existing.length) throw new ApiError(409, 'share_exists', `You already have a ${existing[0].status} share for this client (${existing[0].id}). Revoke it before you request a new one.`);
  const [me] = await sql`select name, brand_name from workspaces where id = ${ws}`;
  const token = `lz_cns_${rand(32)}`;
  const shareId = id('shr', 12);
  const terms = { reliance: RELIANCE, scope: cred.classes as string[], expires_with_credential: true, credential_expires_on: cred.expires_on };
  await sql.transaction([
    sql`insert into credential_shares (id, from_workspace, credential_id, lzid, investor_name, to_workspace, requested_by, requested_by_name, purpose, status, consent_token_hash, terms, booking_center, consent_expires_at)
      values (${shareId}, ${cred.workspace_id}, ${cred.id}, ${cred.lzid}, ${cred.investor_name}, ${ws}, ${`${actor.kind}:${actor.id}`}, ${actor.name}, ${b.purpose}, 'pending', ${await sha256(token)},
      ${JSON.stringify(terms)}, ${b.booking_center}, now() + interval '14 days')`,
    auditQ(sql, ws, actor, 'credential_share.requested', shareId, { lzid: cred.lzid, investor: cred.investor_name, issuing_org: orgName({ name: cred.ws_name, brand_name: cred.brand_name }), purpose: b.purpose, booking_center: b.booking_center }),
  ]);
  await audit(admin, cred.workspace_id, networkActor(orgName(me)), 'credential_share.requested', shareId, { investor: cred.investor_id, credential: cred.id, receiving_org: orgName(me), purpose: b.purpose });
  const showLink = cred.ws_kind === 'network' || cred.ws_kind === 'sandbox';
  const consentUrl = `${CONSENT_BASE}${token}`;
  // When the issuing distributor holds an email for the client, the consent request goes straight to them.
  // The outbox row belongs to the issuing organization, which owns the client relationship.
  let emailStatus: string | null = null;
  if (deliverable(cred.investor_email)) {
    const m = await sendEmail(c.env, admin, { ws: cred.workspace_id, to: cred.investor_email, kind: 'consent_request', ...templates.consentRequest({ investor: cred.investor_name, requester: orgName(me), issuer: orgName({ name: cred.ws_name, brand_name: cred.brand_name }), purpose: b.purpose, link: consentUrl }) });
    emailStatus = m.status;
  }
  const [row] = await sql`select * from credential_shares where id = ${shareId}`;
  return c.json({
    share: shareView({ ...row, from_name: orgName({ name: cred.ws_name, brand_name: cred.brand_name }), to_name: orgName(me), cred_status: 'active', cred_expires_on: cred.expires_on }, ws),
    consent_url: showLink ? consentUrl : null,
    email_status: emailStatus,
    delivery: emailStatus === 'sent'
      ? `Laissez emailed the consent request to the client. ${showLink ? 'In the sandbox you can also open the link yourself to act as the client.' : 'The share activates when the client approves.'}`
      : showLink
        ? 'In production the client receives this link by email. In the sandbox, open it yourself to act as the client, or find the email in the Outbox.'
        : 'Laissez sends the consent request to the client through the issuing distributor. The share activates when the client approves.',
    consent_expires_in_days: 14,
  }, 201);
});

routes.get('/credential-shares', async (c) => {
  need(c, 'read');
  const ws = c.get('ws');
  const rows = await c.get('admin')`select s.*, c.status as cred_status, c.expires_on::text as cred_expires_on,
      coalesce(wf.brand_name, wf.name) as from_name, coalesce(wt.brand_name, wt.name) as to_name
    from credential_shares s
    left join credentials c on c.workspace_id = s.from_workspace and c.id = s.credential_id
    join workspaces wf on wf.id = s.from_workspace join workspaces wt on wt.id = s.to_workspace
    where s.from_workspace = ${ws} or s.to_workspace = ${ws} order by s.created_at desc limit 200`;
  const data = rows.map((r: any) => shareView(r, ws));
  return c.json({ incoming: data.filter((s) => s.direction === 'incoming'), outgoing: data.filter((s) => s.direction === 'outgoing') });
});

routes.post('/credential-shares/:id/revoke', async (c) => {
  const actor = need(c, 'clients:write');
  const sql = c.get('sql'); const admin = c.get('admin'); const ws = c.get('ws');
  const b = await body(c, z.object({ reason: z.string().trim().min(3).max(300), all_recipients: z.boolean().default(false) }));
  const [s] = await sql`select * from credential_shares where id = ${c.req.param('id')}`;
  if (!s) throw new ApiError(404, 'not_found', 'No credential share with that id involves this organization.');
  if (s.status !== 'pending' && s.status !== 'active') throw new ApiError(409, 'not_active', `This share is already ${s.status}.`);
  const issuer = s.from_workspace === ws;
  const reason = `${issuer ? 'Revoked by the issuing distributor' : 'Revoked by the receiving distributor'}: ${b.reason}`;
  const targets = issuer && b.all_recipients
    ? await sql`update credential_shares set status = 'revoked', revoked_at = now(), revoked_reason = ${reason} where from_workspace = ${ws} and credential_id = ${s.credential_id} and status in ('pending', 'active') returning id, to_workspace, from_workspace`
    : await sql`update credential_shares set status = 'revoked', revoked_at = now(), revoked_reason = ${reason} where id = ${s.id} and status in ('pending', 'active') returning id, to_workspace, from_workspace`;
  const [me] = await sql`select name, brand_name from workspaces where id = ${ws}`;
  await audit(sql, ws, actor, 'credential_share.revoked', s.id, { side: issuer ? 'issuing' : 'receiving', reason: b.reason, shares: targets.map((t: any) => t.id) });
  for (const t of targets) {
    const other = issuer ? t.to_workspace : t.from_workspace;
    await audit(admin, other, networkActor(orgName(me)), 'credential_share.revoked', t.id, { side: issuer ? 'issuing' : 'receiving', reason: b.reason, investor: s.investor_name });
  }
  return c.json({
    revoked: targets.map((t: any) => t.id),
    note: issuer
      ? 'Receiving distributors can no longer rely on this credential. Their client records keep holdings but move to redemption-only until they verify the client themselves.'
      : 'You no longer rely on this credential. The client keeps any holdings and can redeem; issue your own credential to restore eligibility.',
  });
});

routes.get('/network/demo-ids', async (c) => {
  need(c, 'read');
  if (c.get('wsKind') !== 'sandbox') return c.json({ data: [], note: 'Demo passport numbers are listed only in sandboxes.' });
  const ws = c.get('ws');
  const rows = await c.get('admin')`select c.lzid, c.expires_on::text as expires_on, i.name, i.kind, i.residence, i.city, coalesce(w.brand_name, w.name) as issuer,
      (select coalesce(json_agg(class_code order by id), '[]'::json) from classifications x where x.workspace_id = c.workspace_id and x.credential_id = c.id) as classes,
      (select s.status from credential_shares s where s.to_workspace = ${ws} and s.credential_id = c.id and s.from_workspace = c.workspace_id order by s.created_at desc limit 1) as share_status
    from credentials c join investors i on i.workspace_id = c.workspace_id and i.id = c.investor_id join workspaces w on w.id = c.workspace_id
    where c.workspace_id = ${NETWORK_WS} and c.status = 'active' order by i.name`;
  return c.json({
    issuer: rows[0]?.issuer ?? 'Halden & Co. Private Bank (fictional)',
    data: rows.map((r: any) => ({ lzid: r.lzid, name: r.name, kind: r.kind, residence: r.residence, city: r.city, classifications: r.classes, expires_on: r.expires_on, suggested_booking_center: SUGGESTED_BOOKING[r.residence] ?? 'SG', share_status: r.share_status ?? null })),
    note: 'Fictional clients of a fictional distributor on the Laissez network. Import one to see reliance and consent end to end.',
  });
});

// ---------- Public consent pages (no sign-in; the token is the secret) ----------
async function consentLimit(c: C, admin: Sql) {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  if (!(await rateLimit(admin, `consent:${(await sha256(ip)).slice(0, 24)}`, 40, 60))) throw new ApiError(429, 'rate_limited', 'Too many requests from this network. Wait a minute and try again.');
}
async function loadConsent(admin: Sql, token: string) {
  if (!/^lz_cns_[a-z0-9]{20,64}$/.test(token)) throw new ApiError(404, 'consent_not_found', 'This consent link is not valid. Ask the distributor that sent it for a new one.');
  const s = await loadShareRow(admin, { tokenHash: await sha256(token) });
  if (!s) throw new ApiError(404, 'consent_not_found', 'This consent link is not valid. Ask the distributor that sent it for a new one.');
  return s;
}
/** The share with everything the consent decision needs. Looked up by consent token hash, or by id for the investor portal inbox. */
export async function loadShareRow(admin: Sql, by: { tokenHash?: string; id?: string }) {
  const tokenHash = by.tokenHash ?? null; const shareId = by.id ?? null;
  const [s] = await admin`select s.*, (s.status = 'pending' and s.consent_expires_at is not null and s.consent_expires_at < now()) as expired,
      coalesce(wf.brand_name, wf.name) as from_name, coalesce(wt.brand_name, wt.name) as to_name, wt.brand_color as to_color, wt.kind as to_kind, wf.kind as from_kind,
      c.issued_on::text as issued_on, c.expires_on::text as cred_expires_on, c.status as cred_status, c.investor_id as from_investor_id,
      i.name as inv_name, i.short_name, i.kind as inv_kind, i.residence, i.city, i.us_person
    from credential_shares s join workspaces wf on wf.id = s.from_workspace join workspaces wt on wt.id = s.to_workspace
    join credentials c on c.workspace_id = s.from_workspace and c.id = s.credential_id
    join investors i on i.workspace_id = c.workspace_id and i.id = c.investor_id
    where (${tokenHash}::text is not null and s.consent_token_hash = ${tokenHash}) or (${shareId}::text is not null and s.id = ${shareId})`;
  return s ?? null;
}

/**
 * Records the client's decision on a pending share: declines it, or activates it and creates the relying
 * organization's client record. Shared by the public consent page and the investor portal inbox.
 */
export async function decideShare(admin: Sql, s: any, decision: 'approve' | 'decline', name: string, via: 'consent_page' | 'portal' = 'consent_page') {
  if (s.expired) throw new ApiError(410, 'consent_expired', 'This consent request expired. Ask the distributor to send a new one.');
  if (s.status !== 'pending') throw new ApiError(409, 'already_decided', `You already ${s.status === 'active' ? 'approved' : s.status === 'declined' ? 'declined' : 'answered'} this request.`);
  const actor = clientActor(s.inv_name);
  if (decision === 'decline') {
    const r = await admin`update credential_shares set status = 'declined', consent_name = ${name}, consent_at = now() where id = ${s.id} and status = 'pending' returning id`;
    if (!r.length) throw new ApiError(409, 'already_decided', 'This request was answered a moment ago. Reload the page.');
    await admin.transaction([
      auditQ(admin, s.to_workspace, actor, 'credential_share.declined', s.id, { signed_by: name, via }),
      auditQ(admin, s.from_workspace, actor, 'credential_share.declined', s.id, { signed_by: name, receiving_org: s.to_name, via }),
    ]);
    return { status: 'declined' as const, message: `Nothing was shared with ${s.to_name}.`, share_id: s.id };
  }
  if (s.cred_status !== 'active' || s.cred_expires_on < today()) throw new ApiError(409, 'credential_not_active', `Your credential with ${s.from_name} is no longer active, so it cannot be shared. Ask ${s.from_name} to renew it.`);
  const invId = id('inv', 10);
  const claimed = await admin`update credential_shares set status = 'active', to_investor_id = ${invId}, consent_name = ${name}, consent_at = now() where id = ${s.id} and status = 'pending' returning id`;
  if (!claimed.length) throw new ApiError(409, 'already_decided', 'This request was answered a moment ago. Reload the page.');
  try {
    await admin.transaction([
      admin`insert into investors (workspace_id, id, name, short_name, kind, residence, city, booking_center, us_person, wallet, relied_share)
        values (${s.to_workspace}, ${invId}, ${s.inv_name}, ${s.short_name}, ${s.inv_kind}, ${s.residence}, ${s.city}, ${s.booking_center}, ${s.us_person}, ${hexWallet()}, ${s.id})`,
      auditQ(admin, s.to_workspace, actor, 'credential_share.approved', s.id, { signed_by: name, investor: invId, relies_on: s.lzid, issuing_org: s.from_name, via }),
      auditQ(admin, s.to_workspace, actor, 'investor.created', invId, { name: s.inv_name, residence: s.residence, via: 'credential_share', share: s.id }),
      auditQ(admin, s.from_workspace, actor, 'credential_share.approved', s.id, { signed_by: name, investor: s.from_investor_id, receiving_org: s.to_name, via }),
    ]);
  } catch (e) {
    await admin`update credential_shares set status = 'pending', to_investor_id = null, consent_name = null, consent_at = null where id = ${s.id}`;
    throw e;
  }
  return { status: 'active' as const, message: `${s.to_name} can now rely on your credential from ${s.from_name}. You can withdraw consent at any time.`, share_id: s.id };
}

/** What a consent request shows the client: who asks, what is shared, and the credential it concerns. */
export async function shareDetail(admin: Sql, s: any) {
  const [g, cls] = await Promise.all([
    loadGlobals(admin),
    admin`select class_code, verified_on::text as verified_on, expires_on::text as expires_on, opt_in_on::text as opt_in_on from classifications where workspace_id = ${s.from_workspace} and credential_id = ${s.credential_id} order by id`,
  ]);
  const bc = g.bookingCenters[s.booking_center];
  return {
    share: { id: s.id, status: s.expired ? 'expired' : s.status, purpose: s.purpose, created_at: s.created_at, consent_name: s.consent_name, consent_at: s.consent_at, revoked_at: s.revoked_at, revoked_reason: s.revoked_reason, expires_at: s.consent_expires_at },
    requester: { name: s.to_name, brand_color: s.to_color ?? '#1f3a33', booking_center: bc ? { id: bc.id, name: bc.name, licence: bc.licence } : { id: s.booking_center, name: s.booking_center }, requested_by: s.requested_by_name },
    issuer: { name: s.from_name },
    investor: { name: s.inv_name, kind: s.inv_kind, residence: s.residence, residence_name: g.jurName[s.residence] ?? s.residence, city: s.city },
    credential: { lzid: s.lzid, issued_on: s.issued_on, expires_on: s.cred_expires_on, status: s.cred_status },
    classifications: cls.map((x: any) => ({ code: x.class_code, label: g.classInfo[x.class_code]?.label ?? x.class_code, jurisdiction: g.classInfo[x.class_code]?.jur ?? null, jurisdiction_name: g.jurName[g.classInfo[x.class_code]?.jur] ?? null, rule: g.classInfo[x.class_code]?.rule ?? null, verified_on: x.verified_on, expires_on: x.expires_on, opt_in: !!x.opt_in_on })),
    terms: s.terms, shared: SHARED_FIELDS, not_shared: NOT_SHARED,
    sandbox: s.to_kind === 'sandbox' || s.from_kind === 'network' || s.from_kind === 'sandbox',
  };
}

publicRoutes.get('/consent/:token', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  await consentLimit(c, admin);
  const s = await loadConsent(admin, c.req.param('token'));
  return c.json(await shareDetail(admin, s));
});

publicRoutes.post('/consent/:token', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  await consentLimit(c, admin);
  const b = await body(c, z.object({ decision: z.enum(['approve', 'decline']), name: z.string().trim().min(2, 'Type your full name to sign.').max(120) }));
  const s = await loadConsent(admin, c.req.param('token'));
  return c.json(await decideShare(admin, s, b.decision, b.name, 'consent_page'));
});

publicRoutes.post('/consent/:token/withdraw', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  await consentLimit(c, admin);
  const b = await body(c, z.object({ name: z.string().trim().max(120).optional() }));
  const s = await loadConsent(admin, c.req.param('token'));
  if (s.status !== 'active' && s.status !== 'pending') throw new ApiError(409, 'not_active', `This share is already ${s.status}.`);
  const reason = 'Consent withdrawn by the client';
  const r = await admin`update credential_shares set status = 'revoked', revoked_at = now(), revoked_reason = ${reason} where id = ${s.id} and status in ('pending', 'active') returning id`;
  if (!r.length) throw new ApiError(409, 'not_active', 'This share changed a moment ago. Reload the page.');
  const actor = clientActor(s.inv_name);
  await admin.transaction([
    auditQ(admin, s.to_workspace, actor, 'credential_share.withdrawn', s.id, { by: b.name ?? null, investor: s.to_investor_id }),
    auditQ(admin, s.from_workspace, actor, 'credential_share.withdrawn', s.id, { by: b.name ?? null, receiving_org: s.to_name }),
  ]);
  return c.json({ status: 'revoked', message: `${s.to_name} can no longer rely on your credential. Any holdings stay yours and can be redeemed.` });
});
