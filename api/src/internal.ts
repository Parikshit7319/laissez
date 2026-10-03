// Staff routes for running the business: organization verification, contracts, billing runs, marking invoices paid,
// revenue metrics and quote requests. Mounted at /v1/internal before customer authentication and guarded by
// INTERNAL_TOKEN, compared in constant time and rate limited. These routes are not part of the public API reference.
// Drive them with scripts/staff.mjs.
import { z } from 'zod';
import { adminSql } from './db';
import { type C, router, audit } from './http';
import { ApiError, rateLimit, sha256, today, id as mkId } from './util';
import { emailAdmins, templates } from './email';
import { orderFormText, runBilling, markPaid, restoreIfClear, stripeVoid, STAFF, usd } from './billing';

export const staff = router();

const timingSafe = async (a: string, b: string) => {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0 && a.length > 0;
};

staff.use('*', async (c, next) => {
  const token = c.env.INTERNAL_TOKEN;
  if (!token) throw new ApiError(501, 'not_configured', 'Staff routes are off: INTERNAL_TOKEN is not set on this deployment.');
  const admin = adminSql(c.env.DATABASE_URL);
  if (!(await rateLimit(admin, `staff:${await sha256(c.req.header('cf-connecting-ip') ?? 'unknown')}`, 60, 600))) throw new ApiError(429, 'rate_limited', 'Too many staff requests from this address.');
  const h = c.req.header('authorization') ?? '';
  if (!(await timingSafe(h.startsWith('Bearer ') ? h.slice(7).trim() : '', token))) throw new ApiError(401, 'unauthorized', 'A staff token is required.');
  c.set('admin', admin);
  await next();
});

const parse = <T extends z.ZodTypeAny>(schema: T, v: unknown): z.infer<T> => schema.parse(v);
const json = async (c: C) => c.req.json().catch(() => ({}));

// ---------- Organization verification ----------
staff.get('/verifications', async (c) => {
  const status = z.enum(['unverified', 'pending', 'verified', 'rejected']).catch('pending').parse(c.req.query('status'));
  const rows = await c.get('admin')`select id, name, slug, verification_status, verification_profile, verification_note, verification_submitted_at, verified_at, created_at from workspaces where kind = 'org' and verification_status = ${status} order by verification_submitted_at nulls last, created_at limit 100`;
  return c.json({ data: rows });
});
staff.post('/verifications/:ws/decision', async (c) => {
  const b = parse(z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).optional() }), await json(c));
  if (b.decision === 'reject' && !b.note) throw new ApiError(422, 'note_required', 'Say why the organization was rejected; the customer sees it.');
  const admin = c.get('admin'); const ws = c.req.param('ws');
  const [w] = await admin`select name, brand_name, verification_status from workspaces where id = ${ws} and kind = 'org'`;
  if (!w) throw new ApiError(404, 'not_found', 'No organization with that id.');
  if (w.verification_status !== 'pending') throw new ApiError(409, 'not_pending', `This organization is ${w.verification_status}, not pending review.`);
  await admin`update workspaces set verification_status = ${b.decision === 'approve' ? 'verified' : 'rejected'}, verification_note = ${b.note ?? null}, verified_at = ${b.decision === 'approve' ? new Date().toISOString() : null}, verified_by = ${b.decision === 'approve' ? 'staff' : null} where id = ${ws}`;
  await audit(admin, ws, STAFF, b.decision === 'approve' ? 'organization.verified' : 'organization.verification_rejected', ws, { note: b.note ?? null });
  await emailAdmins(c.env, admin, ws, 'security_alert', templates.securityAlert({
    title: b.decision === 'approve' ? `${w.brand_name || w.name} is verified` : `${w.brand_name || w.name} was not verified`,
    lines: b.decision === 'approve' ? ['Settlements, API keys and chain actions are open for your organization. Next, accept your order form under Billing if you have one.'] : [`Reason: ${b.note}`, 'Correct the details under Settings, Verification and submit again.'],
    link: `${c.env.APP_URL}#/settings/verification`, button: 'Open verification', org: w.brand_name || w.name,
  }));
  return c.json({ organization: ws, verification_status: b.decision === 'approve' ? 'verified' : 'rejected' });
});

// ---------- Contracts ----------
const contractIn = z.object({
  workspace_id: z.string().uuid(), plan: z.enum(['platform', 'enterprise', 'pilot']),
  platform_fee_cents: z.number().int().min(0).max(100_000_000_00), usage_bps: z.number().min(0).max(1000), tax_bps: z.number().int().min(0).max(3000).default(0),
  net_days: z.number().int().min(0).max(120).default(30), starts_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), ends_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), auto_renew: z.boolean().default(true),
});
staff.post('/contracts', async (c) => {
  const b = parse(contractIn, await json(c));
  const admin = c.get('admin');
  const [w] = await admin`select name, brand_name, kind from workspaces where id = ${b.workspace_id}`;
  if (!w || w.kind !== 'org') throw new ApiError(404, 'not_found', 'No organization with that id.');
  const startsOn = b.starts_on ?? today();
  if (b.ends_on && b.ends_on <= startsOn) throw new ApiError(422, 'invalid_range', 'The end date must be after the start date.');
  const text = orderFormText({ org: w.brand_name || w.name, plan: b.plan, feeCents: b.platform_fee_cents, bps: b.usage_bps, netDays: b.net_days, taxBps: b.tax_bps, startsOn, endsOn: b.ends_on ?? null, autoRenew: b.auto_renew });
  const cid = mkId('ctr');
  await admin`update contracts set status = 'ended', ends_on = coalesce(ends_on, current_date) where workspace_id = ${b.workspace_id} and status in ('pending_acceptance', 'draft')`;
  await admin`insert into contracts (id, workspace_id, plan, status, platform_fee_cents, usage_bps, net_days, tax_bps, starts_on, ends_on, auto_renew, terms_text, terms_sha256, created_by)
    values (${cid}, ${b.workspace_id}, ${b.plan}, 'pending_acceptance', ${b.platform_fee_cents}, ${b.usage_bps}, ${b.net_days}, ${b.tax_bps}, ${startsOn}, ${b.ends_on ?? null}, ${b.auto_renew}, ${text}, ${await sha256(text)}, 'staff')`;
  await audit(admin, b.workspace_id, STAFF, 'billing.contract_created', cid, { plan: b.plan, platform_fee_cents: b.platform_fee_cents, usage_bps: b.usage_bps, starts_on: startsOn });
  await emailAdmins(c.env, admin, b.workspace_id, 'contract', templates.contractReady({ org: w.brand_name || w.name, plan: b.plan, fee: usd(b.platform_fee_cents), bps: String(b.usage_bps), startsOn, link: `${c.env.APP_URL}#/settings/billing` }));
  return c.json({ id: cid, status: 'pending_acceptance', terms_text: text }, 201);
});
staff.post('/contracts/:id/end', async (c) => {
  const admin = c.get('admin');
  const [r] = await admin`update contracts set status = 'ended', ends_on = least(coalesce(ends_on, current_date), current_date) where id = ${c.req.param('id')} and status = 'active' returning workspace_id`;
  if (!r) throw new ApiError(404, 'not_found', 'No active contract with that id.');
  await audit(admin, r.workspace_id, STAFF, 'billing.contract_ended', c.req.param('id'), {});
  return c.json({ ended: c.req.param('id') });
});

// ---------- Billing run, invoices ----------
staff.post('/billing/run', async (c) => c.json(await runBilling(c.env, c.get('admin'))));
staff.get('/invoices', async (c) => {
  const status = c.req.query('status'); const ws = c.req.query('workspace_id');
  const rows = await c.get('admin')`select i.id, i.number, i.workspace_id, w.name as organization, i.kind, i.status, i.total_cents::float8 as total_cents, i.issued_on::text as issued_on, i.due_on::text as due_on, i.reminder_stage, i.stripe_invoice_id, i.hosted_invoice_url, i.paid_at, i.paid_note
    from invoices i join workspaces w on w.id = i.workspace_id where (${status ?? null}::text is null or i.status = ${status ?? null}) and (${ws ?? null}::uuid is null or i.workspace_id = ${ws ?? null}::uuid) order by i.issued_on desc, i.created_at desc limit 200`;
  return c.json({ data: rows });
});
staff.post('/invoices/:id/paid', async (c) => {
  const b = parse(z.object({ note: z.string().trim().min(2).max(300), paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), await json(c));
  const ok = await markPaid(c.env, c.get('admin'), c.req.param('id'), { note: b.note, paidAt: b.paid_on ? `${b.paid_on}T12:00:00Z` : undefined, actor: STAFF });
  if (!ok) throw new ApiError(409, 'not_open', 'That invoice is not open, so it cannot be marked paid.');
  return c.json({ paid: c.req.param('id') });
});
staff.post('/invoices/:id/void', async (c) => {
  const b = parse(z.object({ reason: z.string().trim().min(2).max(300) }), await json(c));
  const admin = c.get('admin');
  const [inv] = await admin`update invoices set status = 'void', paid_note = ${b.reason} where id = ${c.req.param('id')} and status = 'open' returning workspace_id, number, stripe_invoice_id`;
  if (!inv) throw new ApiError(409, 'not_open', 'That invoice is not open, so it cannot be voided.');
  if (inv.stripe_invoice_id) await stripeVoid(c.env, inv.stripe_invoice_id).catch(() => {});
  await audit(admin, inv.workspace_id, STAFF, 'billing.invoice_voided', c.req.param('id'), { number: inv.number, reason: b.reason });
  await restoreIfClear(c.env, admin, inv.workspace_id);
  return c.json({ voided: c.req.param('id') });
});

// ---------- Revenue ----------
staff.get('/revenue', async (c) => {
  const admin = c.get('admin');
  const [k] = await admin`select count(*)::int as customers, coalesce(sum(platform_fee_cents), 0)::float8 as arr_cents from contracts where status = 'active'`;
  const [u3] = await admin`select coalesce(sum(subtotal_cents), 0)::float8 / 3 as avg_monthly_cents from invoices where kind = 'usage' and status in ('open', 'paid')
    and period_start >= (date_trunc('month', current_date) - interval '3 months')::date and period_start < date_trunc('month', current_date)::date`;
  const [v] = await admin`select coalesce(sum(settled_value_usd) filter (where day > current_date - 30), 0)::float8 as last_30d, coalesce(sum(settled_value_usd) filter (where day >= date_trunc('year', current_date)::date), 0)::float8 as ytd, coalesce(sum(settled_value_usd), 0)::float8 as all_time from usage_daily`;
  const customers = await admin`select w.id, w.name, c.plan, c.platform_fee_cents::float8 as platform_fee_cents, c.usage_bps::float8 as usage_bps, c.starts_on::text as starts_on, w.billing_status,
      (select coalesce(sum(settled_value_usd), 0)::float8 from usage_daily d where d.workspace_id = w.id and d.day > current_date - 30) as value_30d,
      (select coalesce(sum(total_cents), 0)::float8 from invoices i where i.workspace_id = w.id and i.status = 'paid' and i.paid_at > now() - interval '365 days') as paid_12m,
      (select coalesce(sum(total_cents), 0)::float8 from invoices i where i.workspace_id = w.id and i.status = 'open') as open_cents
    from contracts c join workspaces w on w.id = c.workspace_id where c.status = 'active' order by value_30d desc`;
  const [ch] = await admin`select count(*) filter (where status = 'ended' and ends_on >= current_date - 90)::int as churned, count(*) filter (where status = 'active' or (status = 'ended' and ends_on >= current_date - 90))::int as base from contracts where plan <> 'pilot'`;
  const [ar] = await admin`select coalesce(sum(total_cents) filter (where status = 'open'), 0)::float8 as open_cents, coalesce(sum(total_cents) filter (where status = 'open' and due_on < current_date), 0)::float8 as overdue_cents,
      coalesce(sum(total_cents) filter (where status = 'paid' and paid_at > now() - interval '30 days'), 0)::float8 as collected_30d_cents from invoices`;
  const mrr = k.arr_cents / 12 + Number(u3.avg_monthly_cents);
  return c.json({
    customers: k.customers, arr_platform_cents: k.arr_cents, avg_monthly_usage_cents: Math.round(Number(u3.avg_monthly_cents)), mrr_cents: Math.round(mrr), arr_cents: Math.round(mrr * 12),
    value_settled_usd: v, logo_churn_90d: { churned: ch.churned, base: ch.base, rate: ch.base ? Math.round((ch.churned / ch.base) * 1000) / 10 : 0 },
    receivables: ar, per_customer: customers, as_of: today(),
    definitions: { mrr: 'Platform fees of active contracts divided by 12, plus the average usage invoice of the last three full months.', value_settled: 'USD per UTC day from usage_daily; EUR funds convert at the fixed rate in the order form.', logo_churn: 'Paid contracts ended in the last 90 days over contracts active at any time in the window. Pilots are excluded.' },
  });
});

// ---------- Quote requests ----------
staff.get('/quotes', async (c) => c.json({ data: await c.get('admin')`select q.id, q.workspace_id, w.name as organization, q.requested_by, q.email, q.plan, q.expected_value_usd::float8 as expected_value_usd, q.message, q.status, q.created_at from quote_requests q join workspaces w on w.id = q.workspace_id order by q.created_at desc limit 100` }));
staff.post('/quotes/:id', async (c) => {
  const b = parse(z.object({ status: z.enum(['new', 'contacted', 'won', 'lost']) }), await json(c));
  const r = await c.get('admin')`update quote_requests set status = ${b.status} where id = ${c.req.param('id')} returning id`;
  if (!r.length) throw new ApiError(404, 'not_found', 'No quote request with that id.');
  return c.json({ id: c.req.param('id'), status: b.status });
});
