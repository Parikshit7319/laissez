#!/usr/bin/env node
// Staff CLI: runs the business side of Laissez through the guarded /v1/internal routes.
//
//   INTERNAL_TOKEN=... node scripts/staff.mjs <command>            against the live API
//   node scripts/staff.mjs --local <command>                        against http://127.0.0.1:8787, token from api/.dev.local.vars
//   LAISSEZ_API=https://... overrides the base URL.
//
// Commands
//   verification list [pending|verified|rejected|unverified]
//   verification decide <workspace-id> approve|reject ["note"]
//   contract create <workspace-id> --plan platform|enterprise|pilot|decisions --fee <usd per year> --bps <usage basis points>
//                   [--decision-fee <usd per allowed decision>] [--tax-bps 0] [--net-days 30] [--starts YYYY-MM-DD] [--ends YYYY-MM-DD]
//                   [--no-renew] [--pilot-metrics "text"]   (a pilot ends after 90 days unless --ends is given, and never renews)
//   contract end <contract-id>
//   billing run
//   invoices [--status open|paid|void] [--ws <workspace-id>]
//   invoice paid <invoice-id> "how it was paid" [YYYY-MM-DD]
//   invoice void <invoice-id> "reason"
//   revenue
//   quotes list
//   quotes set <quote-id> new|contacted|won|lost
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const local = args[0] === '--local';
if (local) args.shift();
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function localToken() {
  const f = join(root, 'api', '.dev.local.vars');
  if (!existsSync(f)) return '';
  const m = readFileSync(f, 'utf8').match(/^INTERNAL_TOKEN=(.*)$/m);
  return m ? m[1].trim() : '';
}
const base = (process.env.LAISSEZ_API || (local ? 'http://127.0.0.1:8787' : 'https://laissez-api.laissez.workers.dev')).replace(/\/$/, '');
const token = process.env.INTERNAL_TOKEN || (local ? localToken() : '');
if (!token) { console.error('INTERNAL_TOKEN is not set. Export it, or use --local with api/.dev.local.vars.'); process.exit(2); }

async function call(method, path, body) {
  const res = await fetch(`${base}/v1/internal${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) { console.error(`${res.status} ${data?.error?.code ?? ''} ${data?.error?.message ?? text}`.trim()); process.exit(1); }
  return data;
}
function flags(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k === 'no-renew') out.noRenew = true;
      else out[k] = list[++i];
    } else out._.push(a);
  }
  return out;
}
const usd = (cents) => (Number(cents) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const table = (rows) => rows.length ? console.table(rows) : console.log('Nothing to show.');
const need = (cond, msg) => { if (!cond) { console.error(msg); process.exit(2); } };

const [group, action, ...tail] = args;
const single = group === 'invoices' || group === 'revenue';
const rest = single ? args.slice(1) : tail;
switch (single ? group : `${group} ${action ?? ''}`.trim()) {
  case 'verification list': {
    const r = await call('GET', `/verifications?status=${rest[0] ?? 'pending'}`);
    table(r.data.map((w) => ({ id: w.id, organization: w.name, status: w.verification_status, submitted: w.verification_submitted_at, legal_name: w.verification_profile?.legal_name, country: w.verification_profile?.country, registration: w.verification_profile?.registration_number })));
    break;
  }
  case 'verification decide': {
    const [ws, decision, note] = rest;
    need(ws && ['approve', 'reject'].includes(decision), 'Usage: verification decide <workspace-id> approve|reject ["note"]');
    console.log(JSON.stringify(await call('POST', `/verifications/${ws}/decision`, { decision, ...(note ? { note } : {}) }), null, 2));
    break;
  }
  case 'contract create': {
    const f = flags(rest); const ws = f._[0];
    need(ws && f.plan && f.fee !== undefined && f.bps !== undefined, 'Usage: contract create <workspace-id> --plan platform|enterprise|pilot|decisions --fee <usd per year> --bps <basis points> [--decision-fee <usd>] [--tax-bps n] [--net-days n] [--starts date] [--ends date] [--no-renew] [--pilot-metrics "text"]');
    const body = { workspace_id: ws, plan: f.plan, platform_fee_cents: Math.round(Number(f.fee) * 100), usage_bps: Number(f.bps), decision_fee_cents: Math.round(Number(f['decision-fee'] ?? 0) * 100), tax_bps: Number(f['tax-bps'] ?? 0), net_days: Number(f['net-days'] ?? 30), auto_renew: !f.noRenew };
    if (f['pilot-metrics']) body.pilot_metrics = f['pilot-metrics'];
    if (f.starts) body.starts_on = f.starts;
    if (f.ends) body.ends_on = f.ends;
    const r = await call('POST', '/contracts', body);
    console.log(`Order form ${r.id} is waiting for the organization's administrator to accept it under Settings, Billing.\n`);
    console.log(r.terms_text);
    break;
  }
  case 'contract end': need(rest[0], 'Usage: contract end <contract-id>'); console.log(JSON.stringify(await call('POST', `/contracts/${rest[0]}/end`, {}))); break;
  case 'billing run': console.log(JSON.stringify(await call('POST', '/billing/run', {}), null, 2)); break;
  case 'invoices': {
    const f = flags(rest);
    const q = new URLSearchParams(); if (f.status) q.set('status', f.status); if (f.ws) q.set('workspace_id', f.ws);
    const r = await call('GET', `/invoices${q.size ? `?${q}` : ''}`);
    table(r.data.map((i) => ({ id: i.id, number: i.number, organization: i.organization, kind: i.kind, status: i.status, total: usd(i.total_cents), issued: i.issued_on, due: i.due_on, reminders: i.reminder_stage, stripe: i.stripe_invoice_id ?? '' })));
    break;
  }
  case 'invoice paid': {
    const [id, note, paid_on] = rest;
    need(id && note, 'Usage: invoice paid <invoice-id> "how it was paid" [YYYY-MM-DD]');
    console.log(JSON.stringify(await call('POST', `/invoices/${id}/paid`, { note, ...(paid_on ? { paid_on } : {}) })));
    break;
  }
  case 'invoice void': {
    const [id, reason] = rest;
    need(id && reason, 'Usage: invoice void <invoice-id> "reason"');
    console.log(JSON.stringify(await call('POST', `/invoices/${id}/void`, { reason })));
    break;
  }
  case 'revenue': {
    const r = await call('GET', '/revenue');
    console.log(`As of ${r.as_of}`);
    console.log(`Customers ${r.customers}   MRR ${usd(r.mrr_cents)}   ARR ${usd(r.arr_cents)}   Platform ARR ${usd(r.arr_platform_cents)}`);
    console.log(`Settled value (USD) last 30 days ${Math.round(r.value_settled_usd.last_30d).toLocaleString('en-US')}`);
    console.log(`Logo churn 90 days ${r.logo_churn_90d.churned} of ${r.logo_churn_90d.base} (${r.logo_churn_90d.rate}%)`);
    console.log(`Receivables open ${usd(r.receivables.open_cents)}   overdue ${usd(r.receivables.overdue_cents ?? 0)}   collected last 30 days ${usd(r.receivables.collected_30d_cents)}`);
    table(r.per_customer.map((c) => ({ organization: c.name, plan: c.plan, platform_fee: usd(c.platform_fee_cents), usage_bps: c.usage_bps, billing: c.billing_status, value_30d: Math.round(c.value_30d), paid_12m: usd(c.paid_12m), open: usd(c.open_cents) })));
    break;
  }
  case 'quotes list': {
    const r = await call('GET', '/quotes');
    table(r.data.map((q) => ({ id: q.id, organization: q.organization, email: q.email, plan: q.plan, expected_value_usd: q.expected_value_usd, status: q.status, requested: q.created_at })));
    break;
  }
  case 'quotes set': {
    const [id, status] = rest;
    need(id && ['new', 'contacted', 'won', 'lost'].includes(status), 'Usage: quotes set <quote-id> new|contacted|won|lost');
    console.log(JSON.stringify(await call('POST', `/quotes/${id}`, { status })));
    break;
  }
  default:
    console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    process.exit(2);
}
