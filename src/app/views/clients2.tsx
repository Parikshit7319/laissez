/** @jsxImportSource preact */
// Client page additions: edit the record (maker-checker for eligibility fields), revision history,
// the suitability questionnaire and the FATCA/CRS tax profile.
import { useEffect, useState } from 'preact/hooks';
import { api, when, day, JUR, BOOKING } from '../api';
import { useApi, Btn, Chip, ErrorBox, Loading, Field, Card } from '../ui';
import { PermBtn, PermNote } from '../auth';

const RESIDENCES = ['SG', 'HK', 'CH', 'DE', 'LU', 'IE', 'GB', 'AE-DIFC', 'AE-ADGM', 'JP', 'IN', 'US'];
const KINDS = ['Corporate', 'Family office', 'Single-family office', 'Pension fund', 'Holding company', 'Individual'];

// ---------- Edit client ----------
export function EditClient({ inv, onDone }: { inv: any; onDone: (msg?: string) => void }) {
  const init = () => ({ name: inv.name ?? '', kind: inv.kind ?? 'Corporate', residence: inv.residence ?? 'SG', city: inv.city ?? '', booking_center: inv.booking ?? 'SG', us_person: !!inv.usPerson, email: inv.email ?? '', wallet: inv.wallet ?? '' });
  const [f, setF] = useState(init);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<any>(null);
  useEffect(() => setF(init()), [inv.id]);
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const base = init();
  const changed = (Object.keys(f) as (keyof typeof f)[]).filter((k) => f[k] !== base[k]);
  const eligibility = changed.filter((k) => ['residence', 'us_person', 'name'].includes(k));
  const submit = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    const patch: Record<string, unknown> = {};
    for (const k of changed) patch[k] = k === 'email' ? (f.email || null) : f[k];
    try {
      const r = await api(`/v1/investors/${inv.id}`, { method: 'PATCH', body: patch });
      if (r.pending) setPending(r);
      else onDone(`Saved as revision ${r.revision}.${r.monitoring_rechecked ? ' Monitoring re-checked the holder after the residence change.' : ''}`);
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  if (pending) return (
    <Card title="Change waiting for approval">
      <p>{pending.reason} Request <a href={`#/approvals/${pending.approval_id}`}>{pending.approval_id}</a> is in the approvals queue; nothing changes until someone else approves it.</p>
      <ul class="small">{Object.entries(pending.changes ?? {}).map(([k, v]: any) => <li><b>{k.replace('_', ' ')}</b>: {String(v.from ?? 'empty')} to <b>{String(v.to ?? 'empty')}</b></li>)}</ul>
      <div class="form-actions"><Btn onClick={() => onDone()}>Close</Btn><Btn kind="ghost" onClick={() => { location.hash = `#/approvals/${pending.approval_id}`; }}>Open the request</Btn></div>
    </Card>
  );
  return (
    <Card title="Edit client record">
      <form class="form-grid" onSubmit={submit}>
        <Field label="Legal name"><input required value={f.name} onInput={(e) => set('name', (e.target as HTMLInputElement).value)} /></Field>
        <Field label="Type"><select value={f.kind} onChange={(e) => set('kind', (e.target as HTMLSelectElement).value)}>{[...new Set([f.kind, ...KINDS])].map((k) => <option>{k}</option>)}</select></Field>
        <Field label="Residence"><select value={f.residence} onChange={(e) => set('residence', (e.target as HTMLSelectElement).value)}>{[...new Set([f.residence, ...RESIDENCES])].map((j) => <option value={j}>{JUR[j] ?? j}</option>)}</select></Field>
        <Field label="City"><input required value={f.city} onInput={(e) => set('city', (e.target as HTMLInputElement).value)} /></Field>
        <Field label="Booking center"><select value={f.booking_center} onChange={(e) => set('booking_center', (e.target as HTMLSelectElement).value)}>{Object.entries(BOOKING).map(([k, v]) => <option value={k}>{v}</option>)}</select></Field>
        <Field label="U.S. person"><label class="check"><input type="checkbox" checked={f.us_person || f.residence === 'US'} disabled={f.residence === 'US'} onChange={(e) => set('us_person', (e.target as HTMLInputElement).checked)} /> U.S. person under Regulation S</label></Field>
        <Field label="Email"><input type="email" value={f.email} onInput={(e) => set('email', (e.target as HTMLInputElement).value)} placeholder="ops@client.example" /></Field>
        <Field label="Wallet"><input value={f.wallet} onInput={(e) => set('wallet', (e.target as HTMLInputElement).value)} class="mono" /></Field>
        <div class="form-actions">
          <PermBtn perm="clients:write" type="submit" kind="primary" busy={busy} disabled={!changed.length}>{busy ? 'Saving' : eligibility.length ? 'Submit for approval' : 'Save changes'}</PermBtn>
          <Btn kind="ghost" onClick={() => onDone()}>Cancel</Btn>
          {eligibility.length ? <span class="small muted">Changing {eligibility.map((k) => k.replace('_', ' ')).join(', ')} affects eligibility, so a second person approves it first.</span> : changed.length ? <span class="small muted">Applies at once and writes a revision.</span> : null}
        </div>
      </form>
      <PermNote perm="clients:write" />
      <ErrorBox error={err} />
    </Card>
  );
}

// ---------- Revision history ----------
export function RevisionHistory({ investorId, refresh }: { investorId: string; refresh?: number }) {
  const r = useApi(`/v1/investors/${investorId}/revisions`, [investorId, refresh]);
  if (r.loading && !r.data) return <Card title="Change history"><Loading /></Card>;
  if (r.error) return <Card title="Change history"><ErrorBox error={r.error} onRetry={r.reload} /></Card>;
  const rows: any[] = r.data.data; const pending: any[] = r.data.pending ?? [];
  return (
    <Card title="Change history" actions={pending.length ? <Chip tone="warn">{pending.length} awaiting approval</Chip> : null}>
      {pending.map((p) => <p class="note small">Pending: <a href={`#/approvals/${p.id}`}>{p.title}</a>, requested by {p.requested_by} {when(p.created_at)}.</p>)}
      {rows.length ? (
        <div class="tw"><table class="t">
          <thead><tr><th>Rev.</th><th>Changes</th><th>By</th><th>Approved by</th><th>When</th></tr></thead>
          <tbody>{rows.map((x) => <tr>
            <td class="muted">{x.revision}</td>
            <td>{Object.entries(x.changes ?? {}).map(([k, v]: any) => <div class="small"><b>{k.replace('_', ' ')}</b>: {String(v.from ?? 'empty')} to {String(v.to ?? 'empty')}</div>)}</td>
            <td>{x.changed_by}</td><td>{x.approved_by ?? <span class="muted">direct</span>}</td><td class="muted nowrap">{when(x.changed_at)}</td>
          </tr>)}</tbody>
        </table></div>
      ) : <p class="small muted">No edits since the record was created.</p>}
    </Card>
  );
}

// ---------- Suitability ----------
const outcomeChip = (o: string) => o === 'suitable' ? <Chip tone="ok">Suitable</Chip> : o === 'advised_only' ? <Chip tone="warn">Advised only</Chip> : <Chip tone="no">Not suitable</Chip>;
export function SuitabilityCard({ investorId }: { investorId: string }) {
  const r = useApi(`/v1/investors/${investorId}/suitability`, [investorId]);
  const [editing, setEditing] = useState(false);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  if (r.loading && !r.data) return <Card title="Suitability"><Loading /></Card>;
  if (r.error) return <Card title="Suitability"><ErrorBox error={r.error} onRetry={r.reload} /></Card>;
  const d = r.data; const latest = d.latest;
  const questions: any[] = d.questions;
  const complete = questions.every((q) => answers[q.id] !== undefined);
  const score = questions.reduce((s, q) => s + (answers[q.id] ?? 0), 0);
  const preview = score >= 16 ? 'suitable' : score >= 10 ? 'advised_only' : 'not_suitable';
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await api(`/v1/investors/${investorId}/suitability`, { body: { answers, note: note || undefined } }); setEditing(false); setAnswers({}); setNote(''); r.reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Card title="Suitability" actions={<>{d.required ? <Chip tone="info">Required for subscriptions</Chip> : <Chip>Not required</Chip>}{!editing ? <PermBtn perm="clients:write" kind="ghost" onClick={() => setEditing(true)}>{latest ? 'Reassess' : 'Assess now'}</PermBtn> : null}</>}>
      {d.basis ? <p class="small muted">The client's residence applies {d.basis.text} ({d.basis.ruleRef}) to subscriptions. A suitable outcome is valid for 12 months.</p> : <p class="small muted">The client's residence does not require a suitability assessment for this product. You can still record one.</p>}
      {latest ? (
        <div class="row-inline tight" style={{ marginBottom: '0.6rem' }}>
          {outcomeChip(latest.outcome)}{!d.current ? <Chip tone="no">Expired {latest.expires_on}</Chip> : null}
          <span class="small">Score {latest.score} of 24, assessed by {latest.assessed_by} on {day(latest.assessed_at)}, valid to {latest.expires_on}.</span>
        </div>
      ) : <p class="small">No assessment on file.{d.required ? ' Subscriptions fail the suitability check until one is recorded.' : ''}</p>}
      {editing ? (
        <div style={{ marginTop: '0.6rem' }}>
          {questions.map((q, i) => (
            <fieldset class="wis" style={{ marginBottom: '0.6rem' }}><legend>{i + 1}. {q.text}</legend>
              {q.options.map((o: any) => <label><input type="radio" name={`suit-${q.id}`} checked={answers[q.id] === o.value} onChange={() => setAnswers({ ...answers, [q.id]: o.value })} /> {o.label}</label>)}
            </fieldset>
          ))}
          <Field label="Adviser note (optional)"><input value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} maxLength={500} /></Field>
          <div class="form-actions">
            <PermBtn perm="clients:write" kind="primary" disabled={!complete} busy={busy} onClick={submit}>{busy ? 'Saving' : 'Record assessment'}</PermBtn>
            <Btn kind="ghost" onClick={() => setEditing(false)}>Cancel</Btn>
            <span class="small muted">{complete ? <>Score {score} of 24: {outcomeChip(preview)}</> : `${questions.filter((q) => answers[q.id] === undefined).length} question${questions.filter((q) => answers[q.id] === undefined).length === 1 ? '' : 's'} left`}</span>
          </div>
          <ErrorBox error={err} />
        </div>
      ) : null}
      {d.history?.length > 1 ? <details class="small" style={{ marginTop: '0.6rem' }}><summary>Earlier assessments ({d.history.length - 1})</summary><ul>{d.history.slice(1).map((h: any) => <li>{day(h.assessed_at)}: {h.outcome.replace('_', ' ')}, score {h.score}, by {h.assessed_by}</li>)}</ul></details> : null}
    </Card>
  );
}

// ---------- FATCA / CRS ----------
const FORM_HINT: Record<string, string> = { 'W-9': 'U.S. persons', 'W-8BEN': 'Non-U.S. individuals', 'W-8BEN-E': 'Non-U.S. entities', 'W-8IMY': 'Intermediaries and flow-through entities', 'W-8EXP': 'Foreign governments and exempt organizations', 'W-8ECI': 'Income effectively connected with a U.S. trade' };
export function TaxCard({ investorId }: { investorId: string }) {
  const r = useApi(`/v1/investors/${investorId}/tax-profile`, [investorId]);
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<any>({ tax_residences: '', tin_provided: false, fatca_status: 'nffe_active', crs_status: '', w8_or_w9: '', self_certified_on: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  if (r.loading && !r.data) return <Card title="FATCA / CRS"><Loading /></Card>;
  if (r.error) return <Card title="FATCA / CRS"><ErrorBox error={r.error} onRetry={r.reload} /></Card>;
  const d = r.data; const p = d.profile;
  const start = () => { setF({ tax_residences: (p?.tax_residences ?? []).join(', '), tin_provided: !!p?.tin_provided, fatca_status: p?.fatca_status ?? (d.us_person ? 'us_person' : 'nffe_active'), crs_status: p?.crs_status ?? '', w8_or_w9: p?.w8_or_w9 ?? (d.us_person ? 'W-9' : ''), self_certified_on: p?.self_certified_on ?? '' }); setEditing(true); setWarnings([]); };
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const submit = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const res = await api(`/v1/investors/${investorId}/tax-profile`, { body: { tax_residences: f.tax_residences.split(',').map((x: string) => x.trim().toUpperCase()).filter(Boolean), tin_provided: f.tin_provided, fatca_status: f.fatca_status, crs_status: f.crs_status || null, w8_or_w9: f.w8_or_w9 || null, self_certified_on: f.self_certified_on || undefined } });
      setWarnings(res.warnings ?? []); setEditing(false); r.reload();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const label = (s: string) => d.fatca_statuses.find((x: any) => x.id === s)?.label ?? s;
  return (
    <Card title="FATCA / CRS" actions={!editing ? <PermBtn perm="clients:write" kind="ghost" onClick={start}>{p ? 'Update' : 'Record self-certification'}</PermBtn> : null}>
      {p ? (
        <div class="row-inline tight" style={{ flexWrap: 'wrap', marginBottom: '0.4rem' }}>
          <Chip tone={d.current ? 'ok' : 'no'}>{label(p.fatca_status)}</Chip>
          {p.w8_or_w9 ? <Chip tone={d.current ? 'info' : 'no'}>{p.w8_or_w9}{p.expires_on ? ` to ${p.expires_on}` : ''}</Chip> : <Chip tone="warn">No W-8 / W-9</Chip>}
          {p.crs_status ? <Chip>CRS {p.crs_status}</Chip> : null}
          <span class="small muted">Tax resident in {p.tax_residences.join(', ')}. {p.tin_provided ? 'TIN provided.' : 'No TIN.'} Certified {p.self_certified_on}, recorded by {p.updated_by}.{!d.current ? ' The form has lapsed.' : ''}</span>
        </div>
      ) : <p class="small">No tax self-certification on file.{d.us_person ? ' This client is a U.S. person: a W-9 is needed before any order.' : ' Needed before subscribing to a U.S.-domiciled fund.'}</p>}
      {warnings.map((w) => <p class="note small">{w}</p>)}
      {editing ? (
        <form class="form-grid" onSubmit={submit} style={{ marginTop: '0.6rem' }}>
          <Field label="Tax residences" hint="Country codes, comma separated"><input required value={f.tax_residences} onInput={(e) => set('tax_residences', (e.target as HTMLInputElement).value)} placeholder="SG, GB" /></Field>
          <Field label="FATCA status"><select value={f.fatca_status} onChange={(e) => set('fatca_status', (e.target as HTMLSelectElement).value)}>{d.fatca_statuses.map((x: any) => <option value={x.id}>{x.label}</option>)}</select></Field>
          <Field label="CRS status" hint="For example Reportable person, Active NFE, Financial institution"><input value={f.crs_status} onInput={(e) => set('crs_status', (e.target as HTMLInputElement).value)} /></Field>
          <Field label="Form on file"><select value={f.w8_or_w9} onChange={(e) => set('w8_or_w9', (e.target as HTMLSelectElement).value)}><option value="">None</option>{d.forms.map((x: string) => <option value={x}>{x}: {FORM_HINT[x]}</option>)}</select></Field>
          <Field label="Self-certified on"><input type="date" value={f.self_certified_on} onInput={(e) => set('self_certified_on', (e.target as HTMLInputElement).value)} /></Field>
          <Field label="TIN"><label class="check"><input type="checkbox" checked={f.tin_provided} onChange={(e) => set('tin_provided', (e.target as HTMLInputElement).checked)} /> Taxpayer identification number provided</label></Field>
          <div class="form-actions"><PermBtn perm="clients:write" type="submit" kind="primary" busy={busy}>{busy ? 'Saving' : 'Save tax profile'}</PermBtn><Btn kind="ghost" onClick={() => setEditing(false)}>Cancel</Btn></div>
          <ErrorBox error={err} />
        </form>
      ) : null}
      <p class="small muted" style={{ marginTop: '0.5rem' }}>A W-8 is valid to the end of the third calendar year after signature (Treas. Reg. 1.1441-1(e)(4)(ii)). Orders show the classification as a Credential-layer check; U.S.-domiciled funds and U.S. persons fail it without the right form.</p>
    </Card>
  );
}
