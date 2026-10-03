// Billing: metering, invoices, dunning and Stripe Invoicing. Laissez sells a platform fee and basis points of value
// settled. Everything here runs from the daily cron (runBilling) and from staff routes; customers only read.
//
//   usage_daily   one row per organization per UTC day: settled value in USD, settlements, decisions
//   contracts     the order form an administrator accepts electronically
//   invoices      issued in USD, with lines, tax, due date and a reminder stage
//
// Stripe is optional. With STRIPE_SECRET_KEY every invoice is mirrored into Stripe Invoicing (hosted payment page, ACH
// and card, Stripe never touches our servers' card data because we never see it). Without it invoices stay internal and
// staff mark them paid.
import type { Sql } from './db';
import { ApiError, today, addDays, daysBetween, hmac, sha256, type Env } from './util';
import { sendEmail, emailAdmins, templates, deliverable } from './email';
import { audit, SYSTEM } from './http';
import { TERMS_VERSION } from './account-security';

/** Fixed rate used to put EUR funds on one USD basis. Printed on every usage invoice line so nothing is hidden. */
export const EUR_USD = 1.08;
export const DUNNING_DAYS = [1, 14, 30] as const;
export const STAFF = { kind: 'system' as const, id: 'staff', name: 'Laissez staff' };

export const usd = (cents: number) => `USD ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const centsOf = (n: unknown) => Math.round(Number(n));
const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const addMonths = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
const addYears = (d: string, n: number) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCFullYear(x.getUTCFullYear() + n); return x.toISOString().slice(0, 10); };

export type InvoiceLine = { description: string; amount_cents: number };

// ---------- Order form ----------
export function orderFormText(o: { org: string; plan: string; feeCents: number; bps: number; netDays: number; taxBps: number; startsOn: string; endsOn: string | null; autoRenew: boolean }): string {
  const plan = o.plan === 'pilot' ? 'Design partner pilot' : o.plan === 'enterprise' ? 'Enterprise' : 'Platform';
  return [
    `LAISSEZ ORDER FORM`,
    `Customer: ${o.org}`,
    `Plan: ${plan}`,
    `Term: starts ${o.startsOn}${o.endsOn ? ` and ends ${o.endsOn}` : o.autoRenew ? ' and renews each year until either party gives 30 days written notice' : ''}.`,
    '',
    `Platform fee: ${o.feeCents > 0 ? `${usd(o.feeCents)} a year, invoiced annually in advance on the start date and each anniversary` : 'none'}.`,
    `Usage fee: ${o.bps > 0 ? `${o.bps} basis points of the value of orders Laissez records as settled, counted per UTC day. Funds in EUR convert at ${EUR_USD} USD to the euro. Settlements later reverted are not counted. Invoiced monthly in arrears` : 'none'}.`,
    `Tax: ${o.taxBps > 0 ? `${(o.taxBps / 100).toFixed(2)}% is added to each invoice unless the customer is tax exempt and has said so in Billing` : 'fees exclude taxes; any tax that applies is added to the invoice'}.`,
    `Payment: net ${o.netDays} days from the invoice date, by ACH, card or wire. An invoice unpaid one day after its due date marks the organization past due. Unpaid fourteen days after, the administrators receive a final warning. Unpaid thirty days after, the organization becomes read-only until the invoice is paid; reads, exports and payment keep working.`,
    '',
    `Services and data: the service is described on the Laissez website and the API reference. Terms of Service (version ${TERMS_VERSION}) and the Privacy Policy apply to this order form. The customer's data stays the customer's; it can be exported at any time from Settings.`,
    `Acceptance: by accepting this order form electronically, the signatory confirms that they may bind the customer, and Laissez records their name, title, time and a hash of this text.`,
  ].join('\n');
}

// ---------- Metering ----------
/** Settled value per organization per UTC day over a range, already in USD. The one definition both metering and the live view use. */
export const usageQuery = (sql: Sql, from: string, to: string, ws: string | null) => sql`
  select s.workspace_id, (s.created_at at time zone 'UTC')::date::text as day, count(*)::int as settlements,
    coalesce(sum(d.amount * case f.currency when 'EUR' then ${EUR_USD}::numeric else 1 end), 0)::numeric(20, 2)::float8 as value
  from settlements s
  join decisions d on d.workspace_id = s.workspace_id and d.id = s.decision_id
  join funds f on f.workspace_id = d.workspace_id and f.ticker = d.ticker
  join workspaces w on w.id = s.workspace_id
  where s.status = 'settled' and w.kind = 'org' and s.created_at >= (${from}::date)::timestamp at time zone 'UTC' and s.created_at < ((${to}::date + 1)::timestamp at time zone 'UTC')
    and (${ws}::uuid is null or s.workspace_id = ${ws}::uuid)
  group by 1, 2 order by 1, 2`;

/** Recomputes usage_daily for a range. Safe to run repeatedly: rows in the range are zeroed first so reverted settlements fall out. */
export async function meterUsage(admin: Sql, from: string, to: string): Promise<{ days: number }> {
  const rows = await usageQuery(admin, from, to, null);
  const decs = await admin`select d.workspace_id, (d.created_at at time zone 'UTC')::date::text as day, count(*)::int as n from decisions d join workspaces w on w.id = d.workspace_id
    where w.kind = 'org' and d.created_at >= (${from}::date)::timestamp at time zone 'UTC' and d.created_at < ((${to}::date + 1)::timestamp at time zone 'UTC') group by 1, 2`;
  const byKey = new Map<string, { ws: string; day: string; value: number; settlements: number; decisions: number }>();
  for (const r of rows) byKey.set(`${r.workspace_id}|${r.day}`, { ws: r.workspace_id, day: r.day, value: Number(r.value), settlements: r.settlements, decisions: 0 });
  for (const d of decs) {
    const k = `${d.workspace_id}|${d.day}`;
    const cur = byKey.get(k) ?? { ws: d.workspace_id, day: d.day, value: 0, settlements: 0, decisions: 0 };
    cur.decisions = d.n; byKey.set(k, cur);
  }
  await admin`update usage_daily set settled_value_usd = 0, settlements = 0, decisions = 0, computed_at = now() where day >= ${from}::date and day <= ${to}::date`;
  for (const v of byKey.values()) {
    await admin`insert into usage_daily (workspace_id, day, settled_value_usd, settlements, decisions) values (${v.ws}, ${v.day}::date, ${v.value}, ${v.settlements}, ${v.decisions})
      on conflict (workspace_id, day) do update set settled_value_usd = excluded.settled_value_usd, settlements = excluded.settlements, decisions = excluded.decisions, computed_at = now()`;
  }
  return { days: byKey.size };
}

// ---------- Stripe ----------
export const stripeOn = (env: Env) => !!env.STRIPE_SECRET_KEY;
async function stripe(env: Env, method: 'GET' | 'POST', path: string, params?: Record<string, string>, idem?: string): Promise<any> {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(params ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), ...(idem ? { 'idempotency-key': idem } : {}) },
    body: params ? new URLSearchParams(params).toString() : undefined, signal: AbortSignal.timeout(12_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message ?? `Stripe returned ${res.status}`);
  return j;
}

/** Verifies a Stripe-Signature header (t=...,v1=...) against the raw body. Five minutes of tolerance. */
export async function verifyStripeSignature(secret: string, header: string | undefined, raw: string, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t); const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(nowSec - t) > 300) return false;
  const expect = await hmac(secret, `${t}.${raw}`);
  return sigs.some((s) => s.length === expect.length && [...s].reduce((d, ch, i) => d | (ch.charCodeAt(0) ^ expect.charCodeAt(i)), 0) === 0);
}

async function stripeCustomer(env: Env, admin: Sql, w: { id: string; name: string; stripe_customer_id: string | null; billing_profile: any }): Promise<string> {
  if (w.stripe_customer_id) return w.stripe_customer_id;
  const p = w.billing_profile ?? {};
  const params: Record<string, string> = { name: p.legal_name || w.name, 'metadata[workspace_id]': w.id };
  if (p.billing_email) params.email = p.billing_email;
  if (p.country) params['address[country]'] = p.country;
  const cust = await stripe(env, 'POST', '/customers', params, `lz-cust-${w.id}`);
  await admin`update workspaces set stripe_customer_id = ${cust.id} where id = ${w.id}`;
  return cust.id;
}

/** Mirrors one invoice into Stripe Invoicing and stores the hosted page. Failures are recorded and retried by the next run. */
export async function syncInvoiceToStripe(env: Env, admin: Sql, invoiceId: string): Promise<boolean> {
  if (!stripeOn(env)) return false;
  const [inv] = await admin`select i.*, i.due_on::text as due_text, w.name as org, w.stripe_customer_id, w.billing_profile, c.net_days from invoices i join workspaces w on w.id = i.workspace_id left join contracts c on c.id = i.contract_id where i.id = ${invoiceId}`;
  if (!inv || inv.stripe_invoice_id || inv.status !== 'open') return false;
  try {
    const customer = await stripeCustomer(env, admin, { id: inv.workspace_id, name: inv.org, stripe_customer_id: inv.stripe_customer_id, billing_profile: inv.billing_profile });
    const lines: InvoiceLine[] = [...inv.lines, ...(Number(inv.tax_cents) > 0 ? [{ description: 'Tax', amount_cents: Number(inv.tax_cents) }] : [])];
    for (const [i, l] of lines.entries()) await stripe(env, 'POST', '/invoiceitems', { customer, amount: String(l.amount_cents), currency: inv.currency.toLowerCase(), description: l.description.slice(0, 500), 'metadata[laissez_invoice]': inv.id }, `lz-item-${inv.id}-${i}`);
    const created = await stripe(env, 'POST', '/invoices', { customer, collection_method: 'send_invoice', days_until_due: String(Math.max(1, daysBetween(today(), inv.due_text))), auto_advance: 'false', pending_invoice_items_behavior: 'include', description: `Laissez invoice ${inv.number}`, 'metadata[laissez_invoice]': inv.id, 'metadata[number]': inv.number }, `lz-inv-${inv.id}`);
    const fin = await stripe(env, 'POST', `/invoices/${created.id}/finalize`, {}, `lz-fin-${inv.id}`);
    await admin`update invoices set stripe_invoice_id = ${fin.id}, hosted_invoice_url = ${fin.hosted_invoice_url ?? null} where id = ${inv.id}`;
    await admin`insert into billing_events (workspace_id, invoice_id, kind, detail) values (${inv.workspace_id}, ${inv.id}, 'stripe.synced', ${JSON.stringify({ stripe_invoice_id: fin.id })})`;
    return true;
  } catch (e: any) {
    await admin`insert into billing_events (workspace_id, invoice_id, kind, detail) values (${inv.workspace_id}, ${inv.id}, 'stripe.sync_failed', ${JSON.stringify({ error: String(e?.message ?? e).slice(0, 300) })})`;
    return false;
  }
}

// ---------- Invoices ----------
type Contract = { id: string; workspace_id: string; plan: string; platform_fee_cents: string | number; usage_bps: string | number; net_days: number; tax_bps: number; starts_on: string; ends_on: string | null; auto_renew: boolean; last_platform_invoice_for: string | null };

async function nextNumber(admin: Sql): Promise<string> {
  const [{ n }] = await admin`select nextval('invoice_number_seq')::int as n`;
  return `LZ-${new Date().getUTCFullYear()}-${n}`;
}

/** Creates one invoice, once per (organization, kind, period start). Returns its id or null when it already exists. */
export async function createInvoice(env: Env, admin: Sql, c: Contract, kind: 'platform' | 'usage', periodStart: string, periodEnd: string, lines: InvoiceLine[]): Promise<string | null> {
  const subtotal = lines.reduce((s, l) => s + l.amount_cents, 0);
  if (subtotal <= 0) return null;
  const [w] = await admin`select name, brand_name, billing_profile from workspaces where id = ${c.workspace_id}`;
  const exempt = !!w?.billing_profile?.tax_exempt;
  const tax = exempt ? 0 : Math.round((subtotal * c.tax_bps) / 10_000);
  const id = `inv_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const issued = today(); const due = addDays(issued, c.net_days);
  const number = await nextNumber(admin);
  const [row] = await admin`insert into invoices (id, workspace_id, contract_id, number, kind, period_start, period_end, status, lines, subtotal_cents, tax_cents, total_cents, issued_on, due_on)
    values (${id}, ${c.workspace_id}, ${c.id}, ${number}, ${kind}, ${periodStart}, ${periodEnd}, 'open', ${JSON.stringify(lines)}, ${subtotal}, ${tax}, ${subtotal + tax}, ${issued}, ${due})
    on conflict (workspace_id, kind, period_start) do nothing returning id`;
  if (!row) return null;
  await admin`insert into billing_events (workspace_id, invoice_id, kind, detail) values (${c.workspace_id}, ${id}, 'invoice.issued', ${JSON.stringify({ number, kind, total_cents: subtotal + tax })})`;
  await audit(admin, c.workspace_id, SYSTEM, 'billing.invoice_issued', id, { number, kind, period: `${periodStart}..${periodEnd}`, total_cents: subtotal + tax });
  await syncInvoiceToStripe(env, admin, id);
  const [inv] = await admin`select hosted_invoice_url from invoices where id = ${id}`;
  await emailAdmins(env, admin, c.workspace_id, 'billing', templates.invoiceIssued({ org: w?.brand_name || w?.name, number, total: usd(subtotal + tax), dueOn: due, link: `${env.APP_URL}#/settings/billing`, payLink: inv?.hosted_invoice_url }));
  return id;
}

/** Marks an invoice paid and lifts a past-due or suspended state when nothing overdue remains. */
export async function markPaid(env: Env, admin: Sql, invoiceId: string, o: { note: string; paidAt?: string; actor?: typeof STAFF | typeof SYSTEM }): Promise<boolean> {
  const [inv] = await admin`update invoices set status = 'paid', paid_at = coalesce(${o.paidAt ?? null}::timestamptz, now()), paid_note = ${o.note} where id = ${invoiceId} and status in ('open', 'uncollectible') returning workspace_id, number, total_cents`;
  if (!inv) return false;
  await admin`insert into billing_events (workspace_id, invoice_id, kind, detail) values (${inv.workspace_id}, ${invoiceId}, 'invoice.paid', ${JSON.stringify({ note: o.note })})`;
  await audit(admin, inv.workspace_id, o.actor ?? SYSTEM, 'billing.invoice_paid', invoiceId, { number: inv.number, note: o.note });
  await restoreIfClear(env, admin, inv.workspace_id);
  return true;
}

/** Back to active once no invoice is a day or more overdue. */
export async function restoreIfClear(env: Env, admin: Sql, ws: string): Promise<boolean> {
  const r = await admin`update workspaces set billing_status = 'active' where id = ${ws} and billing_status in ('past_due', 'suspended')
    and not exists (select 1 from invoices i where i.workspace_id = ${ws} and i.status = 'open' and i.due_on < current_date) returning id`;
  if (r.length) {
    await audit(admin, ws, SYSTEM, 'billing.restored', ws, {});
    await admin`insert into billing_events (workspace_id, kind, detail) values (${ws}, 'billing.restored', '{}')`;
  }
  return r.length > 0;
}

// ---------- The daily run ----------
export type BillingRun = { metered_days: number; invoices: string[]; reminders: number; past_due: number; suspended: number; restored: number; stripe_synced: number };

export async function runBilling(env: Env, admin: Sql): Promise<BillingRun> {
  const out: BillingRun = { metered_days: 0, invoices: [], reminders: 0, past_due: 0, suspended: 0, restored: 0, stripe_synced: 0 };
  const now = today();
  out.metered_days = (await meterUsage(admin, addDays(now, -75), now)).days;

  const contracts: Contract[] = await admin`select c.id, c.workspace_id, c.plan, c.platform_fee_cents, c.usage_bps, c.net_days, c.tax_bps, c.starts_on::text as starts_on, c.ends_on::text as ends_on, c.auto_renew, c.last_platform_invoice_for::text as last_platform_invoice_for from contracts c join workspaces w on w.id = c.workspace_id where c.status = 'active' and w.kind = 'org' and c.starts_on <= current_date`;
  for (const c of contracts) {
    // Platform fee: annual, in advance, on the start date and each anniversary while the contract renews.
    const fee = Number(c.platform_fee_cents);
    if (fee > 0) {
      for (let i = 0; i < 3; i++) {
        const next = c.last_platform_invoice_for ? addYears(c.last_platform_invoice_for, 1) : c.starts_on;
        const first = !c.last_platform_invoice_for;
        if (next > now || (!first && !c.auto_renew) || (c.ends_on && next > c.ends_on)) break;
        const end = addDays(addYears(next, 1), -1);
        const id = await createInvoice(env, admin, c, 'platform', next, end, [{ description: `Platform fee, ${next} to ${end}`, amount_cents: fee }]);
        if (id) out.invoices.push(id);
        await admin`update contracts set last_platform_invoice_for = ${next} where id = ${c.id}`;
        c.last_platform_invoice_for = next;
      }
    }
    // Usage: monthly in arrears for every full calendar month since the contract started (at most 14 back).
    const bps = Number(c.usage_bps);
    if (bps > 0) {
      const thisMonth = monthStart(now);
      let m = monthStart(c.starts_on) < addMonths(thisMonth, -14) ? addMonths(thisMonth, -14) : monthStart(c.starts_on);
      for (; m < thisMonth; m = addMonths(m, 1)) {
        const start = m < c.starts_on ? c.starts_on : m;
        let end = addDays(addMonths(m, 1), -1);
        if (c.ends_on && c.ends_on < end) end = c.ends_on;
        if (end < start) continue;
        const [exists] = await admin`select 1 as x from invoices where workspace_id = ${c.workspace_id} and kind = 'usage' and period_start = ${start}`;
        if (exists) continue;
        const [u] = await admin`select coalesce(sum(settled_value_usd), 0)::float8 as value, coalesce(sum(settlements), 0)::int as n from usage_daily where workspace_id = ${c.workspace_id} and day between ${start}::date and ${end}::date`;
        const cents = Math.round((u.value * bps) / 10_000 * 100);
        if (cents <= 0) continue;
        const id = await createInvoice(env, admin, c, 'usage', start, end, [{ description: `Usage ${start} to ${end}: ${u.n} settlement${u.n === 1 ? '' : 's'}, ${usd(Math.round(u.value * 100))} settled at ${bps} bps (EUR at ${EUR_USD})`, amount_cents: cents }]);
        if (id) out.invoices.push(id);
      }
    }
  }

  // Dunning. One message per invoice per stage; the highest stage reached wins if several were missed.
  const open = await admin`select i.id, i.workspace_id, i.number, i.total_cents, i.due_on::text as due_on, i.reminder_stage, w.name, w.brand_name, w.billing_status from invoices i join workspaces w on w.id = i.workspace_id where i.status = 'open' and i.due_on < current_date`;
  for (const i of open) {
    const late = daysBetween(i.due_on, now);
    const stage = DUNNING_DAYS.filter((d) => late >= d).length;
    if (stage <= i.reminder_stage) continue;
    await admin`update invoices set reminder_stage = ${stage} where id = ${i.id}`;
    if (stage === 3 && i.billing_status !== 'suspended') {
      await admin`update workspaces set billing_status = 'suspended' where id = ${i.workspace_id}`;
      await audit(admin, i.workspace_id, SYSTEM, 'billing.suspended', i.id, { number: i.number, days_late: late });
      out.suspended++;
    } else if (stage >= 1 && i.billing_status === 'active') {
      await admin`update workspaces set billing_status = 'past_due' where id = ${i.workspace_id}`;
      await audit(admin, i.workspace_id, SYSTEM, 'billing.past_due', i.id, { number: i.number, days_late: late });
      out.past_due++;
    }
    await admin`insert into billing_events (workspace_id, invoice_id, kind, detail) values (${i.workspace_id}, ${i.id}, ${`dunning.stage_${stage}`}, ${JSON.stringify({ days_late: late })})`;
    await emailAdmins(env, admin, i.workspace_id, 'billing', templates.paymentOverdue({ org: i.brand_name || i.name, number: i.number, total: usd(Number(i.total_cents)), daysLate: late, suspendOn: stage < 3 ? addDays(i.due_on, 30) : null, link: `${env.APP_URL}#/settings/billing` }));
    out.reminders++;
  }
  for (const w of await admin`select id from workspaces where billing_status in ('past_due', 'suspended')`) if (await restoreIfClear(env, admin, w.id)) out.restored++;

  // Anything that failed to reach Stripe earlier gets another try.
  if (stripeOn(env)) for (const i of await admin`select id from invoices where status = 'open' and stripe_invoice_id is null order by created_at limit 20`) if (await syncInvoiceToStripe(env, admin, i.id)) out.stripe_synced++;
  return out;
}

/** Voids the Stripe copy of an invoice. Best effort: the caller already voided ours. */
export async function stripeVoid(env: Env, stripeInvoiceId: string): Promise<void> {
  if (stripeOn(env)) await stripe(env, 'POST', `/invoices/${stripeInvoiceId}/void`, {});
}

/** Applies a Stripe webhook event. Returns what it did, for the response and the log. */
export async function applyStripeEvent(env: Env, admin: Sql, ev: any): Promise<string> {
  const obj = ev?.data?.object ?? {};
  const [inv] = await admin`select id, workspace_id, number from invoices where stripe_invoice_id = ${obj.id ?? ''} or id = ${obj.metadata?.laissez_invoice ?? ''} limit 1`;
  if (!inv) return 'ignored: not a Laissez invoice';
  switch (ev.type) {
    case 'invoice.paid': case 'invoice.payment_succeeded':
      return (await markPaid(env, admin, inv.id, { note: 'Paid through Stripe', actor: SYSTEM })) ? 'marked paid' : 'already settled';
    case 'invoice.payment_failed':
      await admin`insert into billing_events (workspace_id, invoice_id, kind, detail) values (${inv.workspace_id}, ${inv.id}, 'stripe.payment_failed', ${JSON.stringify({ reason: obj.last_finalization_error?.message ?? obj.last_payment_error?.message ?? null })})`;
      return 'recorded failed payment';
    case 'invoice.voided':
      await admin`update invoices set status = 'void' where id = ${inv.id} and status = 'open'`; await restoreIfClear(env, admin, inv.workspace_id); return 'voided';
    case 'invoice.marked_uncollectible':
      await admin`update invoices set status = 'uncollectible' where id = ${inv.id} and status = 'open'`; return 'marked uncollectible';
    default: return `ignored: ${ev.type}`;
  }
}

/** Sends an email to one address through the common path; used for staff notices. */
export const notifyStaff = async (env: Env, admin: Sql, subject: string, lines: string[], ws: string | null) => {
  const to = env.STAFF_EMAIL || (env as any).LEADS_EMAIL || 'parikshit.ambhore@rice.edu';
  if (!deliverable(to)) return;
  await sendEmail(env, admin, { ws, to, kind: 'billing', ...templates.securityAlert({ title: subject, lines, link: env.APP_URL, button: 'Open Laissez' }) });
};
void ApiError; void sha256;
