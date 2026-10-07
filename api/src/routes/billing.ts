// What a customer sees of billing: the contract to accept, this month's usage, invoices (with a PDF and a Stripe pay
// link when Stripe is on), the billing profile used on invoices, and a way to ask for a quote. Customers never move
// money here; staff routes (api/src/internal.ts) create contracts and mark invoices paid.
import { z } from 'zod';
import { adminSql } from '../db';
import { type C, router, body, need, bg, audit, needStepUp } from '../http';
import { ApiError, today, addDays, sha256, rateLimit, id as mkId } from '../util';
import { isProduction } from '../mode';
import { templates } from '../email';
import { invoicePdf } from '../pdf';
import { usageQuery, stripeOn, usd, verifyStripeSignature, applyStripeEvent, notifyStaff, EUR_USD } from '../billing';

export const routes = router();
export const publicRoutes = router();

const emailZ = z.string().trim().toLowerCase().email().max(160);
export const billingProfileIn = z.object({
  legal_name: z.string().trim().min(2).max(160),
  billing_email: emailZ,
  address: z.string().trim().min(5).max(300),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a two-letter country code such as US'),
  tax_id: z.string().trim().max(40).optional(),
  tax_exempt: z.boolean().default(false),
  po_number: z.string().trim().max(60).optional(),
});
export const acceptContractIn = z.object({
  name: z.string().trim().min(2).max(120),
  title: z.string().trim().min(2).max(120),
  agree: z.literal(true, { message: 'Tick the box to accept the order form' }),
});
export const quoteIn = z.object({
  plan: z.enum(['platform', 'enterprise', 'pilot', 'decisions']),
  expected_value_usd: z.number().min(0).max(1e13).optional(),
  message: z.string().trim().max(1000).optional(),
});

const month = () => today().slice(0, 7);
const contractView = (c: any) => c && ({
  id: c.id, plan: c.plan, status: c.status, currency: c.currency, platform_fee_cents: Number(c.platform_fee_cents), usage_bps: Number(c.usage_bps), decision_fee_cents: Number(c.decision_fee_cents ?? 0), tax_bps: c.tax_bps, net_days: c.net_days,
  starts_on: c.starts_on, ends_on: c.ends_on, auto_renew: c.auto_renew, created_at: c.created_at, accepted_at: c.accepted_at, accepted_by: c.accepted_by, accepted_title: c.accepted_title, terms_sha256: c.terms_sha256,
});
const CONTRACT_COLS = `id, plan, status, currency, platform_fee_cents, usage_bps, decision_fee_cents, tax_bps, net_days, starts_on::text as starts_on, ends_on::text as ends_on, auto_renew, created_at, accepted_at, accepted_by, accepted_title, terms_sha256`;
const invoiceView = (i: any) => ({
  id: i.id, number: i.number, kind: i.kind, status: i.status, currency: i.currency, period_start: i.period_start, period_end: i.period_end, issued_on: i.issued_on, due_on: i.due_on,
  subtotal_cents: Number(i.subtotal_cents), tax_cents: Number(i.tax_cents), total_cents: Number(i.total_cents), lines: i.lines, paid_at: i.paid_at, paid_note: i.paid_note, hosted_invoice_url: i.hosted_invoice_url,
  overdue_days: i.status === 'open' && i.due_on < today() ? Math.round((Date.parse(today()) - Date.parse(i.due_on)) / 86_400_000) : 0,
});
const INVOICE_COLS = `id, number, kind, status, currency, period_start::text as period_start, period_end::text as period_end, issued_on::text as issued_on, due_on::text as due_on, subtotal_cents, tax_cents, total_cents, lines, paid_at, paid_note, hosted_invoice_url`;

// ---------- Overview ----------
routes.get('/billing', async (c) => {
  need(c, 'billing:read');
  const sql = c.get('sql'); const admin = c.get('admin'); const ws = c.get('ws');
  const [w] = await admin`select name, kind, billing_status, billing_profile, verification_status, expires_at from workspaces where id = ${ws}`;
  const [active] = await sql.query(`select ${CONTRACT_COLS} from contracts where workspace_id = $1 and status = 'active'`, [ws]);
  const [pending] = await sql.query(`select ${CONTRACT_COLS} from contracts where workspace_id = $1 and status = 'pending_acceptance' order by created_at desc limit 1`, [ws]);
  const start = `${month()}-01`;
  const rows = await usageQuery(sql, start, today(), ws);
  const value = rows.reduce((s: number, r: any) => s + Number(r.value), 0);
  const settlements = rows.reduce((s: number, r: any) => s + Number(r.settlements), 0);
  const bps = active ? Number(active.usage_bps) : 0;
  const decisionFee = active ? Number(active.decision_fee_cents ?? 0) : 0;
  const [dec] = await sql.query(`select count(*)::int as allowed from decisions where workspace_id = $1 and outcome = 'ALLOW' and cardinality(what_ifs) = 0 and created_at >= ($2::date)::timestamp at time zone 'UTC'`, [ws, start]);
  const [inv] = await sql.query(`select count(*) filter (where status = 'open')::int as open_count, coalesce(sum(total_cents) filter (where status = 'open'), 0)::float8 as open_cents,
      count(*) filter (where status = 'open' and due_on < current_date)::int as overdue_count, coalesce(sum(total_cents) filter (where status = 'open' and due_on < current_date), 0)::float8 as overdue_cents,
      min(due_on) filter (where status = 'open')::text as next_due_on from invoices where workspace_id = $1`, [ws]);
  let nextPlatform: string | null = null;
  if (active && Number(active.platform_fee_cents) > 0) {
    const [l] = await sql.query(`select last_platform_invoice_for::text as last from contracts where id = $1`, [active.id]);
    const base = l?.last ?? null;
    if (base) { const d = new Date(base + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() + 1); nextPlatform = active.auto_renew ? d.toISOString().slice(0, 10) : null; } else nextPlatform = active.starts_on;
  }
  const sandbox = w.kind === 'sandbox';
  return c.json({
    sandbox, plan: sandbox ? 'sandbox' : active?.plan ?? 'none', status: w.billing_status, verification_status: w.verification_status, stripe: stripeOn(c.env),
    contract: contractView(active) ?? null, pending_contract: contractView(pending) ?? null,
    usage: { month: month(), settled_value_usd: Math.round(value * 100) / 100, settlements, usage_bps: bps, projected_usage_fee_cents: Math.round((value * bps) / 10_000 * 100), decisions_allowed: dec.allowed, decision_fee_cents: decisionFee, projected_decision_fee_cents: decisionFee * dec.allowed, eur_usd_rate: EUR_USD },
    invoices: { open_count: inv.open_count, open_cents: Number(inv.open_cents), overdue_count: inv.overdue_count, overdue_cents: Number(inv.overdue_cents), next_due_on: inv.next_due_on },
    next_platform_invoice_on: nextPlatform,
    profile: w.billing_profile ?? {},
    trial: sandbox ? { expires_at: w.expires_at, days_left: Math.max(0, Math.ceil((new Date(w.expires_at).getTime() - Date.now()) / 86_400_000)) } : null,
    suspended: w.billing_status === 'suspended',
  });
});

routes.patch('/billing/profile', async (c) => {
  need(c, 'billing:write');
  const b = await body(c, billingProfileIn);
  const ws = c.get('ws');
  if (c.get('wsKind') === 'sandbox') throw new ApiError(403, 'sandbox_only', 'Sandboxes are free and have no invoices. Create an organization to set a billing profile.');
  await c.get('admin')`update workspaces set billing_profile = ${JSON.stringify(b)} where id = ${ws}`;
  await audit(c.get('sql'), ws, c.get('actor'), 'billing.profile_updated', ws, { legal_name: b.legal_name, country: b.country, tax_exempt: b.tax_exempt });
  return c.json({ profile: b });
});

// ---------- Contracts ----------
routes.get('/billing/contracts', async (c) => {
  need(c, 'billing:read');
  const rows = await c.get('sql').query(`select ${CONTRACT_COLS} from contracts where workspace_id = $1 order by created_at desc limit 20`, [c.get('ws')]);
  return c.json({ data: rows.map(contractView) });
});
routes.get('/billing/contracts/:id', async (c) => {
  need(c, 'billing:read');
  const [row] = await c.get('sql').query(`select ${CONTRACT_COLS}, terms_text from contracts where workspace_id = $1 and id = $2`, [c.get('ws'), c.req.param('id')]);
  if (!row) throw new ApiError(404, 'not_found', 'No contract with that id in this organization.');
  return c.json({ ...contractView(row), terms_text: row.terms_text });
});
routes.post('/billing/contracts/:id/accept', async (c) => {
  need(c, 'billing:write');
  needStepUp(c, 'accept an order form');
  const admin = c.get('admin'); const ws = c.get('ws'); const a = c.get('actor');
  if (a.kind !== 'user') throw new ApiError(403, 'human_required', 'Only a signed-in administrator can accept an order form.');
  const b = await body(c, acceptContractIn);
  const [w] = await admin`select kind, name, verification_status from workspaces where id = ${ws}`;
  if (w.kind !== 'org') throw new ApiError(403, 'sandbox_only', 'Sandboxes have no contract. Create an organization first.');
  if (isProduction(c.env) && w.verification_status !== 'verified') throw new ApiError(403, 'org_not_verified', 'Verify the organization before accepting an order form. See Settings, Verification.', { verification_status: w.verification_status });
  const [ct] = await admin`select * from contracts where id = ${c.req.param('id')} and workspace_id = ${ws}`;
  if (!ct) throw new ApiError(404, 'not_found', 'No contract with that id in this organization.');
  if (ct.status !== 'pending_acceptance') throw new ApiError(409, 'contract_not_pending', ct.status === 'active' ? 'This order form is already accepted.' : 'This order form is no longer open for acceptance.');
  if ((await sha256(ct.terms_text)) !== ct.terms_sha256) throw new ApiError(409, 'terms_changed', 'The text of this order form changed after it was issued. Ask for a new one.');
  const ip = await sha256(c.req.header('cf-connecting-ip') ?? 'unknown');
  await admin.transaction([
    admin`update contracts set status = 'ended', ends_on = least(coalesce(ends_on, current_date), current_date) where workspace_id = ${ws} and status = 'active'`,
    admin`update contracts set status = 'active', accepted_by = ${b.name}, accepted_by_user = ${a.realUserId ?? null}, accepted_title = ${b.title}, accepted_at = now(), accepted_ip_hash = ${ip} where id = ${ct.id}`,
    admin`update workspaces set billing_status = case when billing_status in ('past_due', 'suspended') then billing_status else 'active' end where id = ${ws}`,
  ]);
  await audit(c.get('sql'), ws, a, 'billing.contract_accepted', ct.id, { plan: ct.plan, platform_fee_cents: Number(ct.platform_fee_cents), usage_bps: Number(ct.usage_bps), terms_sha256: ct.terms_sha256, signed_by: b.name, title: b.title });
  bg(c, notifyStaff(c.env, admin, `Order form accepted: ${w.name}`, [`${b.name} (${b.title}) accepted the ${ct.plan} order form for ${w.name}.`, `Platform fee ${usd(Number(ct.platform_fee_cents))} a year, ${Number(ct.usage_bps)} bps of value settled, starting ${new Date(ct.starts_on).toISOString().slice(0, 10)}. The first invoice goes out on the next daily run.`], ws));
  return c.json({ accepted: true, contract_id: ct.id, accepted_at: new Date().toISOString() });
});

// ---------- Usage and invoices ----------
routes.get('/billing/usage', async (c) => {
  need(c, 'billing:read');
  const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(c.req.query());
  const to = q.to ?? today(); const from = q.from ?? addDays(to, -89);
  if (from > to) throw new ApiError(422, 'invalid_range', 'The start date is after the end date.');
  const rows = await c.get('sql').query(`select day::text as day, settled_value_usd::float8 as settled_value_usd, settlements, decisions from usage_daily where workspace_id = $1 and day between $2::date and $3::date order by day`, [c.get('ws'), from, to]);
  return c.json({ from, to, data: rows, totals: { settled_value_usd: Math.round(rows.reduce((s: number, r: any) => s + r.settled_value_usd, 0) * 100) / 100, settlements: rows.reduce((s: number, r: any) => s + r.settlements, 0), decisions: rows.reduce((s: number, r: any) => s + r.decisions, 0) }, note: `Settled value is metered per UTC day, in USD; EUR funds convert at ${EUR_USD}. Today's figure appears after the next daily run; the billing overview shows it live.` });
});
routes.get('/billing/invoices', async (c) => {
  need(c, 'billing:read');
  const rows = await c.get('sql').query(`select ${INVOICE_COLS} from invoices where workspace_id = $1 order by issued_on desc, created_at desc limit 100`, [c.get('ws')]);
  return c.json({ data: rows.map(invoiceView) });
});
routes.get('/billing/invoices/:id', async (c) => {
  need(c, 'billing:read');
  const [row] = await c.get('sql').query(`select ${INVOICE_COLS} from invoices where workspace_id = $1 and id = $2`, [c.get('ws'), c.req.param('id')]);
  if (!row) throw new ApiError(404, 'not_found', 'No invoice with that id in this organization.');
  return c.json(invoiceView(row));
});
routes.get('/billing/invoices/:id/pdf', async (c) => {
  need(c, 'billing:read');
  const [row] = await c.get('sql').query(`select ${INVOICE_COLS} from invoices where workspace_id = $1 and id = $2`, [c.get('ws'), c.req.param('id')]);
  if (!row) throw new ApiError(404, 'not_found', 'No invoice with that id in this organization.');
  const [w] = await c.get('admin')`select name, billing_profile from workspaces where id = ${c.get('ws')}`;
  const p = w.billing_profile ?? {};
  const taxPct = Number(row.subtotal_cents) > 0 ? Math.round((Number(row.tax_cents) / Number(row.subtotal_cents)) * 10_000) / 100 : 0;
  const bytes = invoicePdf({
    number: row.number, status: row.status, kind: row.kind, currency: row.currency, issuedOn: row.issued_on, dueOn: row.due_on, periodStart: row.period_start, periodEnd: row.period_end,
    seller: { name: (c.env as any).SELLER_NAME || 'Laissez', address: (c.env as any).SELLER_ADDRESS ?? null, taxId: (c.env as any).SELLER_TAX_ID ?? null },
    billTo: { name: p.legal_name || w.name, lines: p.address ? [p.address, p.country].filter(Boolean) : [], taxId: p.tax_id ?? null, po: p.po_number ?? null },
    lines: row.lines, subtotalCents: Number(row.subtotal_cents), taxCents: Number(row.tax_cents), totalCents: Number(row.total_cents), taxLabel: Number(row.tax_cents) > 0 ? `Tax (${taxPct}%)` : p.tax_exempt ? 'Tax (exempt)' : 'Tax',
    payUrl: row.hosted_invoice_url, paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
  });
  return new Response(bytes as BodyInit, { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${row.number}.pdf"`, 'cache-control': 'private, no-store' } });
});

// ---------- Quote request ----------
routes.post('/billing/quote-request', async (c) => {
  need(c, 'billing:write');
  const admin = c.get('admin'); const ws = c.get('ws'); const a = c.get('actor');
  if (a.kind !== 'user') throw new ApiError(403, 'human_required', 'Only a signed-in administrator can ask for a quote.');
  const b = await body(c, quoteIn);
  const [me] = await admin`select email, name from users where id = ${a.realUserId}`;
  if (!me || me.email.endsWith('.sandbox') || me.email.endsWith('.example')) throw new ApiError(422, 'real_email_required', 'Set a real email address you can receive mail at first, under Organization, Keep this sandbox. We reply there.');
  if (!(await rateLimit(admin, `quote:${ws}`, 5, 86_400))) throw new ApiError(429, 'rate_limited', 'You have asked for five quotes today. We will be in touch about the earlier ones.');
  const [w] = await admin`select name, kind from workspaces where id = ${ws}`;
  const qid = mkId('quo');
  await admin`insert into quote_requests (id, workspace_id, requested_by, email, plan, expected_value_usd, message) values (${qid}, ${ws}, ${me.name}, ${me.email}, ${b.plan}, ${b.expected_value_usd ?? null}, ${b.message ?? null})`;
  await audit(c.get('sql'), ws, a, 'billing.quote_requested', qid, { plan: b.plan, expected_value_usd: b.expected_value_usd ?? null });
  bg(c, notifyStaff(c.env, admin, `Quote request: ${w.name}`, [`${me.name} (${me.email}) asked for a ${b.plan} quote for ${w.name}${w.kind === 'sandbox' ? ' from a sandbox' : ''}.`, b.expected_value_usd ? `Expected value settled in a year: ${usd(Math.round(b.expected_value_usd * 100))}.` : 'No volume estimate given.', b.message ?? ''].filter(Boolean), ws));
  return c.json({ id: qid, status: 'new', note: `Received. We reply to ${me.email}, usually within one business day.` }, 201);
});

// ---------- Stripe webhook (public; authenticated by its signature) ----------
publicRoutes.post('/billing/stripe/webhook', async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) throw new ApiError(501, 'not_configured', 'Stripe webhooks are not configured on this deployment.');
  const raw = await c.req.text();
  if (!(await verifyStripeSignature(c.env.STRIPE_WEBHOOK_SECRET, c.req.header('stripe-signature'), raw))) throw new ApiError(400, 'stripe_signature_invalid', 'The Stripe signature did not verify.');
  const admin = adminSql(c.env.DATABASE_URL);
  let ev: any;
  try { ev = JSON.parse(raw); } catch { throw new ApiError(400, 'invalid_request', 'The body is not JSON.'); }
  const first = await admin`insert into stripe_events (id, type) values (${String(ev.id)}, ${String(ev.type)}) on conflict (id) do nothing returning id`;
  if (!first.length) return c.json({ received: true, duplicate: true });
  try { return c.json({ received: true, result: await applyStripeEvent(c.env, admin, ev) }); }
  catch (e) { await admin`delete from stripe_events where id = ${String(ev.id)}`; throw e; }
});

// ---------- OpenAPI ----------
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const cents = { type: 'integer', description: 'US cents.' };
export const OPENAPI_SCHEMAS = {
  Contract: { type: 'object', properties: { id: { type: 'string' }, plan: { type: 'string', enum: ['platform', 'enterprise', 'pilot', 'decisions'] }, status: { type: 'string', enum: ['draft', 'pending_acceptance', 'active', 'ended'] }, currency: { type: 'string' }, platform_fee_cents: cents, usage_bps: { type: 'number' }, decision_fee_cents: cents, tax_bps: { type: 'integer' }, net_days: { type: 'integer' }, starts_on: { type: 'string', format: 'date' }, ends_on: { type: ['string', 'null'], format: 'date' }, auto_renew: { type: 'boolean' }, accepted_at: { type: ['string', 'null'] }, accepted_by: { type: ['string', 'null'] }, accepted_title: { type: ['string', 'null'] }, terms_sha256: { type: 'string' }, terms_text: { type: 'string', description: 'Only on the single-contract read.' } } },
  Invoice: { type: 'object', properties: { id: { type: 'string' }, number: { type: 'string', example: 'LZ-2026-1001' }, kind: { type: 'string', enum: ['platform', 'usage'] }, status: { type: 'string', enum: ['draft', 'open', 'paid', 'void', 'uncollectible'] }, currency: { type: 'string' }, period_start: { type: 'string', format: 'date' }, period_end: { type: 'string', format: 'date' }, issued_on: { type: 'string', format: 'date' }, due_on: { type: 'string', format: 'date' }, subtotal_cents: cents, tax_cents: cents, total_cents: cents, lines: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, amount_cents: cents } } }, paid_at: { type: ['string', 'null'] }, paid_note: { type: ['string', 'null'] }, hosted_invoice_url: { type: ['string', 'null'], description: 'Stripe invoice page for ACH and card payment, when Stripe is on.' }, overdue_days: { type: 'integer' } } },
};
export const OPENAPI_OPS = [
  { method: 'get', path: '/v1/billing', tag: 'Billing', id: 'getBilling', sum: 'Billing overview', perm: 'billing:read', human: true,
    desc: 'Plan, billing status (none, active, past_due, suspended), the active and any pending contract, this month\'s usage with the projected usage fee, open and overdue invoices, the next platform invoice date, the billing profile and, for a sandbox, the days left.',
    res: { type: 'object', properties: { sandbox: { type: 'boolean' }, plan: { type: 'string' }, status: { type: 'string', enum: ['none', 'active', 'past_due', 'suspended'] }, verification_status: { type: 'string' }, stripe: { type: 'boolean' }, contract: { anyOf: [ref('Contract'), { type: 'null' }] }, pending_contract: { anyOf: [ref('Contract'), { type: 'null' }] }, usage: { type: 'object' }, invoices: { type: 'object' }, profile: { type: 'object' }, trial: { type: ['object', 'null'] }, suspended: { type: 'boolean' } } } },
  { method: 'patch', path: '/v1/billing/profile', tag: 'Billing', id: 'updateBillingProfile', sum: 'Set the billing profile', perm: 'billing:write', body: billingProfileIn, err: [403], desc: 'The legal name, billing email, address, tax id and purchase order number printed on invoices. Mark the organization tax exempt here when it is.', res: { type: 'object', properties: { profile: { type: 'object' } } } },
  { method: 'get', path: '/v1/billing/contracts', tag: 'Billing', id: 'listContracts', sum: 'List contracts', perm: 'billing:read', human: true, desc: 'Order forms for this organization, newest first.', res: { type: 'object', required: ['data'], properties: { data: { type: 'array', items: ref('Contract') } } } },
  { method: 'get', path: '/v1/billing/contracts/{id}', tag: 'Billing', id: 'getContract', sum: 'Read an order form', perm: 'billing:read', human: true, idd: 'Contract id.', desc: 'One order form with its full text.', res: ref('Contract') },
  { method: 'post', path: '/v1/billing/contracts/{id}/accept', tag: 'Billing', id: 'acceptContract', sum: 'Accept an order form', perm: 'billing:write', idd: 'Contract id.', body: acceptContractIn, err: [403, 409],
    desc: 'Electronic acceptance by an administrator: records the name, title, time, a hash of the network address and the hash of the text, ends any earlier active contract and turns billing on. In production mode the organization must be verified first.', res: { type: 'object', properties: { accepted: { type: 'boolean' }, contract_id: { type: 'string' }, accepted_at: { type: 'string' } } } },
  { method: 'get', path: '/v1/billing/usage', tag: 'Billing', id: 'getBillingUsage', sum: 'Metered usage by day', perm: 'billing:read', human: true, q: [{ name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date' }, description: 'First day, default 89 days before the end.' }, { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date' }, description: 'Last day, default today.' }], err: [422],
    desc: 'Settled value in USD, settlements and decisions per UTC day, with totals. This is what usage invoices are computed from.', res: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, data: { type: 'array', items: { type: 'object', properties: { day: { type: 'string' }, settled_value_usd: { type: 'number' }, settlements: { type: 'integer' }, decisions: { type: 'integer' } } } }, totals: { type: 'object' }, note: { type: 'string' } } } },
  { method: 'get', path: '/v1/billing/invoices', tag: 'Billing', id: 'listInvoices', sum: 'List invoices', perm: 'billing:read', human: true, desc: 'The last 100 invoices with lines, tax, status and, when Stripe is on, the hosted payment page.', res: { type: 'object', required: ['data'], properties: { data: { type: 'array', items: ref('Invoice') } } } },
  { method: 'get', path: '/v1/billing/invoices/{id}', tag: 'Billing', id: 'getInvoice', sum: 'Get an invoice', perm: 'billing:read', human: true, idd: 'Invoice id.', res: ref('Invoice') },
  { method: 'get', path: '/v1/billing/invoices/{id}/pdf', tag: 'Billing', id: 'getInvoicePdf', sum: 'Download an invoice as PDF', perm: 'billing:read', human: true, idd: 'Invoice id.', desc: 'Responds with application/pdf, one page.', res: { type: 'string', format: 'binary' } },
  { method: 'post', path: '/v1/billing/quote-request', tag: 'Billing', id: 'requestQuote', sum: 'Ask for a quote', perm: 'billing:write', body: quoteIn, ok: 201, err: [422, 429], desc: 'From a sandbox or an organization without a contract. Needs a real email address; Laissez replies there.', res: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, note: { type: 'string' } } } },
  { method: 'post', path: '/v1/billing/stripe/webhook', tag: 'Billing', id: 'stripeWebhook', sum: 'Stripe webhook receiver', perm: 'public', err: [501], desc: 'Receives invoice.paid, invoice.payment_failed, invoice.voided and invoice.marked_uncollectible from Stripe. Authenticated by the Stripe-Signature header; each event id is processed once.', res: { type: 'object', properties: { received: { type: 'boolean' }, duplicate: { type: 'boolean' }, result: { type: 'string' } } } },
];
void (null as unknown as C);
