/** @jsxImportSource preact */
// Billing: the order form to accept, this month's usage, invoices with a PDF and a pay link, the billing profile used on
// invoices, and a way to ask for a quote. Customers never move money in the app; payment happens on the Stripe invoice
// page or by bank transfer, and staff mark a transfer received.
import { useEffect, useState } from 'preact/hooks';
import { api, day, downloadFile, when } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Loading, Field, Card } from '../ui';
import { useMe, PermBtn, PermNote } from '../auth';

const cur = (cents: number, ccy = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, maximumFractionDigits: 2 }).format(cents / 100);
const usd0 = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const PLAN: Record<string, string> = { platform: 'Platform', enterprise: 'Enterprise', pilot: 'Design partner pilot', sandbox: 'Sandbox', none: 'No plan yet' };
const BILLING: Record<string, { tone: 'ok' | 'warn' | 'no' | 'muted'; label: string }> = { active: { tone: 'ok', label: 'In good standing' }, none: { tone: 'muted', label: 'No contract' }, past_due: { tone: 'warn', label: 'Past due' }, suspended: { tone: 'no', label: 'Suspended' } };
const INV: Record<string, { tone: 'ok' | 'warn' | 'no' | 'muted'; label: string }> = { open: { tone: 'warn', label: 'Open' }, paid: { tone: 'ok', label: 'Paid' }, void: { tone: 'muted', label: 'Void' }, uncollectible: { tone: 'no', label: 'Written off' }, draft: { tone: 'muted', label: 'Draft' } };

export function Billing() {
  const { me, isSandbox, can } = useMe();
  const b = useApi('/v1/billing');
  const d = b.data;
  const [reloaded, setReloaded] = useState(0);
  const refresh = () => { b.reload(); setReloaded((n) => n + 1); };
  if (b.loading && !d) return <><Head title="Billing" /><Loading /></>;
  if (b.error) return <><Head title="Billing" /><ErrorBox error={b.error} onRetry={b.reload} /></>;
  const st = BILLING[d.status] ?? BILLING.none;
  return (
    <>
      <Head title="Billing" sub={isSandbox ? 'A sandbox is free and deleted after 7 days. This page is where you turn it into a paid organization.' : `Contract, usage and invoices for ${me!.workspace.name}.`} actions={<><Chip tone="brass">{PLAN[d.plan] ?? d.plan}</Chip>{!d.sandbox ? <Chip tone={st.tone}>{st.label}</Chip> : null}</>} />
      <PermNote perm="billing:write" />
      {d.suspended ? <div class="err" role="alert"><strong>Billing is suspended.</strong> An invoice is more than 30 days overdue, so the organization is read-only. Pay the open invoice below and access returns the same day. Exports stay available.</div> : null}
      {d.sandbox ? <SandboxPlan d={d} /> : (
        <>
          {d.pending_contract ? <AcceptOrderForm contract={d.pending_contract} verification={d.verification_status} onAccepted={refresh} /> : null}
          <Overview d={d} />
          {d.contract ? <ContractCard c={d.contract} /> : !d.pending_contract ? <Card title="No contract yet"><p class="muted">Billing starts when you accept an order form. Laissez sends one after a quote. Ask for a quote below, or write to <a href="mailto:parikshit.ambhore@rice.edu">the founder</a>.</p></Card> : null}
          <Usage key={reloaded} />
          <Invoices key={`i${reloaded}`} stripe={d.stripe} />
          <ProfileForm profile={d.profile} onSaved={refresh} />
        </>
      )}
      {can('billing:write') || d.sandbox ? <QuoteForm sandbox={d.sandbox} hasContract={!!d.contract} /> : null}
    </>
  );
}

function SandboxPlan({ d }: { d: any }) {
  return (
    <div class="grid2">
      <Card title="Free sandbox" actions={d.trial ? <Chip tone={d.trial.days_left <= 2 ? 'warn' : 'ok'}>{d.trial.days_left} day{d.trial.days_left === 1 ? '' : 's'} left</Chip> : null}>
        <p class="muted">You have the whole product with fictional institutions and simulated settlement. Nothing here is billed. It is deleted {d.trial?.expires_at ? day(d.trial.expires_at) : 'after 7 days'}.</p>
        <p><a class="b b-primary" href="#/settings/organization">Keep this sandbox as an organization</a></p>
        <p class="small muted">Keeping it stops the expiry and makes your account its first administrator. Real settlement then needs a signed order form and, in production, a verified organization.</p>
      </Card>
      <Card title="What a paid plan costs">
        <dl class="kv wide">
          <div><dt>Issuers</dt><dd>No charge</dd></div>
          <div><dt>Distributors</dt><dd>From $60K a year, plus 1.5 bps of value settled</dd></div>
          <div><dt>Design partners</dt><dd>Free pilot with a named integration owner</dd></div>
        </dl>
        <p class="small muted">The order form sets the real figures for your corridors. See <a href="../pricing/">pricing</a> for how they are built.</p>
      </Card>
    </div>
  );
}

function Overview({ d }: { d: any }) {
  const u = d.usage;
  return (
    <div class="kpis">
      <div class="kpi"><span>Settled this month</span><b>{usd0(u.settled_value_usd)}</b><em>{u.settlements} settlement{u.settlements === 1 ? '' : 's'}, {u.month}</em></div>
      <div class="kpi"><span>Projected usage fee</span><b>{cur(u.projected_usage_fee_cents)}</b><em>{u.usage_bps ? `${u.usage_bps} bps, invoiced monthly in arrears` : 'No usage fee on this contract'}</em></div>
      <div class="kpi"><span>Open invoices</span><b>{d.invoices.open_count ? cur(d.invoices.open_cents) : 'None'}</b><em>{d.invoices.overdue_count ? `${d.invoices.overdue_count} overdue, ${cur(d.invoices.overdue_cents)}` : d.invoices.next_due_on ? `next due ${day(d.invoices.next_due_on)}` : 'nothing owed'}</em></div>
      <div class="kpi"><span>Next platform invoice</span><b>{d.next_platform_invoice_on ? day(d.next_platform_invoice_on) : 'None'}</b><em>{d.contract?.auto_renew ? 'annual, in advance' : d.contract ? 'does not renew' : 'no active contract'}</em></div>
    </div>
  );
}

function ContractCard({ c }: { c: any }) {
  return (
    <Card title="Contract" actions={<Chip tone="ok">Active</Chip>}>
      <dl class="kv wide">
        <div><dt>Plan</dt><dd>{PLAN[c.plan] ?? c.plan}</dd></div>
        <div><dt>Platform fee</dt><dd>{c.platform_fee_cents ? `${cur(c.platform_fee_cents, c.currency)} a year, invoiced in advance` : 'None'}</dd></div>
        <div><dt>Usage fee</dt><dd>{c.usage_bps ? `${c.usage_bps} bps of value settled, invoiced monthly in arrears` : 'None'}</dd></div>
        <div><dt>Payment terms</dt><dd>Net {c.net_days} days{c.tax_bps ? `, plus ${c.tax_bps / 100}% tax` : ''}</dd></div>
        <div><dt>Term</dt><dd>From {day(c.starts_on)}{c.ends_on ? ` to ${day(c.ends_on)}` : ''}{c.auto_renew ? ', renews each year' : ''}</dd></div>
        <div><dt>Accepted</dt><dd>{c.accepted_by ? `${c.accepted_by}${c.accepted_title ? `, ${c.accepted_title}` : ''}, ${when(c.accepted_at)}` : 'Not yet'}</dd></div>
        <div><dt>Text fingerprint</dt><dd><code class="break small" title="SHA-256 of the order form text as accepted">{c.terms_sha256}</code></dd></div>
      </dl>
    </Card>
  );
}

function AcceptOrderForm({ contract, verification, onAccepted }: { contract: any; verification: string; onAccepted: () => void }) {
  const { me } = useMe();
  const full = useApi(`/v1/billing/contracts/${contract.id}`);
  const [f, setF] = useState({ name: me!.user?.name ?? '', title: me!.user?.title ?? '', agree: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const accept = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api(`/v1/billing/contracts/${contract.id}/accept`, { body: { name: f.name.trim(), title: f.title.trim(), agree: true } }); onAccepted(); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Card title="Order form to accept" actions={<Chip tone="warn">Waiting for you</Chip>}>
      <p>Laissez issued an order form for {PLAN[contract.plan] ?? contract.plan}: {contract.platform_fee_cents ? `${cur(contract.platform_fee_cents, contract.currency)} a year` : 'no platform fee'}{contract.usage_bps ? `, plus ${contract.usage_bps} bps of value settled` : ''}, net {contract.net_days} days. Read the full text, then accept it as an administrator.</p>
      {full.loading && !full.data ? <Loading /> : full.error ? <ErrorBox error={full.error} onRetry={full.reload} /> : <pre class="contract-text" tabIndex={0} aria-label="Order form text">{full.data.terms_text}</pre>}
      {verification !== 'verified' ? <div class="note">Your organization is {verification === 'pending' ? 'under review' : 'not verified'}. In production, an order form can be accepted only after <a href="#/settings/verification">verification</a>.</div> : null}
      <form class="form-grid" onSubmit={accept}>
        <Field label="Your full name"><input required minLength={2} maxLength={120} autoComplete="name" value={f.name} onInput={(e) => setF({ ...f, name: (e.target as HTMLInputElement).value })} /></Field>
        <Field label="Your title" hint="You must be authorised to bind the organization."><input required minLength={2} maxLength={120} autoComplete="organization-title" value={f.title} onInput={(e) => setF({ ...f, title: (e.target as HTMLInputElement).value })} /></Field>
        <label class="check gate-check" style={{ gridColumn: '1 / -1' }}><input type="checkbox" checked={f.agree} onChange={(e) => setF({ ...f, agree: (e.target as HTMLInputElement).checked })} /><span>I have read this order form and accept it on behalf of {me!.workspace.name}.<span class="f-h">We record your name, title, the time, a hash of your network address and a hash of the exact text. Accepting replaces any earlier contract.</span></span></label>
        <div class="form-actions"><PermBtn perm="billing:write" type="submit" kind="primary" busy={busy} disabled={!f.agree || f.name.trim().length < 2 || f.title.trim().length < 2}>Accept order form</PermBtn></div>
      </form>
      <ErrorBox error={err} />
    </Card>
  );
}

// Daily settled value as bars, drawn to one scale, with a table behind a disclosure.
function Usage() {
  const u = useApi('/v1/billing/usage');
  const rows: { day: string; settled_value_usd: number; settlements: number }[] = u.data?.data ?? [];
  const max = Math.max(1, ...rows.map((r) => r.settled_value_usd));
  const W = 640; const H = 120; const pad = 4;
  const bw = rows.length ? Math.max(2, (W - pad * 2) / rows.length - 2) : 0;
  return (
    <Card title="Usage, last 90 days" actions={u.data ? <span class="small muted">{usd0(u.data.totals.settled_value_usd)} settled in {u.data.totals.settlements} settlements</span> : null}>
      {u.loading && !u.data ? <Loading /> : u.error ? <ErrorBox error={u.error} onRetry={u.reload} /> : rows.length ? (
        <>
          <svg viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label={`Settled value per day, peak ${usd0(max)}`} style={{ width: '100%', height: 'auto', maxHeight: '180px' }}>
            <line x1={pad} x2={W - pad} y1={H} y2={H} stroke="var(--line)" />
            {rows.map((r, i) => { const h = (r.settled_value_usd / max) * (H - 8); return <rect x={pad + i * (bw + 2)} y={H - h} width={bw} height={Math.max(h, 1)} rx="1.5" fill="var(--green)"><title>{`${r.day}: ${usd0(r.settled_value_usd)}, ${r.settlements} settlement${r.settlements === 1 ? '' : 's'}`}</title></rect>; })}
            <text x={pad} y={H + 14} font-size="10" fill="var(--ink-3)">{rows[0].day}</text>
            <text x={W - pad} y={H + 14} font-size="10" text-anchor="end" fill="var(--ink-3)">{rows[rows.length - 1].day}</text>
            <text x={W - pad} y="10" font-size="10" text-anchor="end" fill="var(--ink-3)">peak {usd0(max)}</text>
          </svg>
          <details><summary class="small muted">Table view</summary>
            <div class="tw"><table class="t"><thead><tr><th>Day</th><th>Settled value</th><th>Settlements</th></tr></thead><tbody>{[...rows].reverse().map((r) => <tr><td>{r.day}</td><td>{usd0(r.settled_value_usd)}</td><td>{r.settlements}</td></tr>)}</tbody></table></div>
          </details>
        </>
      ) : <p class="muted">No settled value yet. Usage appears here after the first settlement and is what usage invoices are computed from.</p>}
      <p class="small muted">{u.data?.note}</p>
    </Card>
  );
}

function Invoices({ stripe }: { stripe: boolean }) {
  const r = useApi('/v1/billing/invoices');
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const pdf = async (i: any) => { setBusy(i.id); setErr(null); try { await downloadFile(`/v1/billing/invoices/${i.id}/pdf`, `${i.number}.pdf`); } catch (e) { setErr(e); } finally { setBusy(null); } };
  const rows: any[] = r.data?.data ?? [];
  return (
    <Card title="Invoices" pad={false}>
      {r.loading && !r.data ? <div class="pad"><Loading /></div> : r.error ? <div class="pad"><ErrorBox error={r.error} onRetry={r.reload} /></div> : rows.length ? (
        <div class="tw"><table class="t">
          <thead><tr><th>Invoice</th><th>Period</th><th>Issued</th><th>Due</th><th>Total</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map((i) => {
            const s = INV[i.status] ?? INV.draft;
            return (
              <tr>
                <td><strong>{i.number}</strong><div class="small muted">{i.kind === 'platform' ? 'Platform fee' : 'Usage'}</div></td>
                <td class="nowrap">{day(i.period_start)} to {day(i.period_end)}</td>
                <td class="nowrap">{day(i.issued_on)}</td>
                <td class="nowrap">{day(i.due_on)}</td>
                <td class="nowrap"><strong>{cur(i.total_cents, i.currency)}</strong>{i.tax_cents ? <div class="small muted">incl. {cur(i.tax_cents, i.currency)} tax</div> : null}</td>
                <td><Chip tone={s.tone}>{s.label}</Chip>{i.overdue_days ? <Chip tone="no">{i.overdue_days} days late</Chip> : null}{i.paid_at ? <div class="small muted">{day(i.paid_at)}</div> : null}</td>
                <td class="nowrap">
                  {i.status === 'open' && i.hosted_invoice_url ? <a class="b b-primary" href={i.hosted_invoice_url} target="_blank" rel="noopener">Pay online<span class="sr"> (opens Stripe)</span></a> : null}
                  <Btn kind="ghost" busy={busy === i.id} onClick={() => pdf(i)}>PDF</Btn>
                </td>
              </tr>
            );
          })}</tbody>
        </table></div>
      ) : <div class="pad"><p class="muted">No invoices yet. The first platform invoice goes out on the day after you accept an order form; usage is invoiced monthly after that.</p></div>}
      <div class="pad"><ErrorBox error={err} /><p class="small muted">{stripe ? 'Pay online opens a Stripe page for card or ACH. We never see or store card numbers.' : 'Pay by bank transfer using the details on the PDF and quote the invoice number. We mark it paid when it arrives, usually within a business day.'} Overdue by 14 days, we warn the administrators. Overdue by 30, the organization becomes read-only until it is paid.</p></div>
    </Card>
  );
}

function ProfileForm({ profile, onSaved }: { profile: any; onSaved: () => void }) {
  const { me } = useMe();
  const [f, setF] = useState({ legal_name: '', billing_email: '', address: '', country: '', tax_id: '', tax_exempt: false, po_number: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setF((x) => ({ ...x, legal_name: profile?.legal_name ?? me!.workspace.name, billing_email: profile?.billing_email ?? '', address: profile?.address ?? '', country: profile?.country ?? '', tax_id: profile?.tax_id ?? '', tax_exempt: !!profile?.tax_exempt, po_number: profile?.po_number ?? '' })); }, [profile]);
  const set = (k: string, v: unknown) => { setF({ ...f, [k]: v }); setSaved(false); };
  const save = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null); setSaved(false);
    try {
      const body: Record<string, unknown> = { legal_name: f.legal_name.trim(), billing_email: f.billing_email.trim(), address: f.address.trim(), country: f.country.trim().toUpperCase(), tax_exempt: f.tax_exempt };
      if (f.tax_id.trim()) body.tax_id = f.tax_id.trim();
      if (f.po_number.trim()) body.po_number = f.po_number.trim();
      await api('/v1/billing/profile', { method: 'PATCH', body }); setSaved(true); onSaved();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Card title="Billing details" actions={profile?.legal_name ? <Chip tone="ok">Saved</Chip> : <Chip>Not set</Chip>}>
      <p class="muted">Printed on every invoice. Invoices are emailed to the billing address.</p>
      <form class="form-grid" onSubmit={save}>
        <fieldset class="plain-fs" style={{ gridColumn: '1 / -1' }}>
          <div class="form-grid">
            <Field label="Legal name to invoice"><input required minLength={2} maxLength={160} value={f.legal_name} onInput={(e) => set('legal_name', (e.target as HTMLInputElement).value)} /></Field>
            <Field label="Billing email"><input type="email" required value={f.billing_email} onInput={(e) => set('billing_email', (e.target as HTMLInputElement).value)} placeholder="ap@harbourline.example" /></Field>
            <Field label="Country" hint="Two letters, for example US."><input required minLength={2} maxLength={2} value={f.country} style={{ textTransform: 'uppercase' }} onInput={(e) => set('country', (e.target as HTMLInputElement).value)} /></Field>
            <Field label="Tax or VAT number" hint="Printed on invoices. Needed for reverse-charge treatment."><input maxLength={40} value={f.tax_id} onInput={(e) => set('tax_id', (e.target as HTMLInputElement).value)} /></Field>
            <Field label="Purchase order number" hint="Optional. Printed on invoices."><input maxLength={60} value={f.po_number} onInput={(e) => set('po_number', (e.target as HTMLInputElement).value)} /></Field>
          </div>
          <Field label="Billing address"><textarea rows={2} required minLength={5} maxLength={300} value={f.address} onInput={(e) => set('address', (e.target as HTMLTextAreaElement).value)} /></Field>
          <label class="check"><input type="checkbox" checked={f.tax_exempt} onChange={(e) => set('tax_exempt', (e.target as HTMLInputElement).checked)} /> This organization is tax exempt or reverse-charges the tax</label>
        </fieldset>
        <div class="form-actions"><PermBtn perm="billing:write" type="submit" kind="primary" busy={busy}>Save billing details</PermBtn>{saved ? <span class="ok-text" role="status">Saved.</span> : null}</div>
      </form>
      <ErrorBox error={err} />
    </Card>
  );
}

function QuoteForm({ sandbox, hasContract }: { sandbox: boolean; hasContract: boolean }) {
  const [f, setF] = useState({ plan: 'platform', value: '', message: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [res, setRes] = useState<any>(null);
  const send = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null); setRes(null);
    try {
      const body: Record<string, unknown> = { plan: f.plan };
      if (f.value.trim() !== '') body.expected_value_usd = Number(f.value);
      if (f.message.trim()) body.message = f.message.trim();
      setRes(await api('/v1/billing/quote-request', { body }));
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Card title={hasContract ? 'Change your plan' : 'Ask for a quote'}>
      <p class="muted">{sandbox ? 'Tell us what you would settle and we send an order form you can accept here.' : 'Ask for a different plan or more corridors. We reply by email, usually within one business day.'}</p>
      {res ? <p class="ok-text" role="status">{res.note}</p> : (
        <form class="form-grid" onSubmit={send}>
          <Field label="Plan"><select value={f.plan} onChange={(e) => setF({ ...f, plan: (e.target as HTMLSelectElement).value })}><option value="pilot">Design partner pilot</option><option value="platform">Platform</option><option value="enterprise">Enterprise</option></select></Field>
          <Field label="Value you expect to settle in a year, USD" hint="A rough number is fine."><input type="number" min={0} value={f.value} onInput={(e) => setF({ ...f, value: (e.target as HTMLInputElement).value })} placeholder="500000000" /></Field>
          <div style={{ gridColumn: '1 / -1' }}><Field label="Anything we should know"><textarea rows={3} maxLength={1000} value={f.message} onInput={(e) => setF({ ...f, message: (e.target as HTMLTextAreaElement).value })} placeholder="Corridors, funds, the date you want to go live" /></Field></div>
          <div class="form-actions"><PermBtn perm="billing:write" type="submit" kind="primary" busy={busy}>Send request</PermBtn></div>
        </form>
      )}
      <ErrorBox error={err} />
    </Card>
  );
}
