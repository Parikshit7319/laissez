// PEP and adverse media reviews: pending matches to decide, decided reviews to read, and a form to record a check.
import { useState } from 'preact/hooks';
import { api, when, day } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Loading, Empty, Field, Card } from '../ui';
import { useMe, PermBtn, PermNote } from '../auth';

const KIND: Record<string, string> = { pep: 'Politically exposed person', adverse_media: 'Adverse media' };
const TONE: Record<string, 'ok' | 'no' | 'warn' | 'muted'> = { clear: 'ok', hit: 'no', pending: 'warn' };

export function Reviews() {
  const { can } = useMe();
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const r = useApi(`/v1/screening-reviews${filter === 'pending' ? '?result=pending' : ''}`, [filter]);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const rows = r.data?.data ?? [];
  const sweep = async () => { setErr(null); setNote(null); try { const x = await api('/v1/screening-reviews/pep-sweep', { body: {} }); setNote(`${x.investors} investors screened, ${x.opened} new review${x.opened === 1 ? '' : 's'}.`); r.reload(); } catch (e) { setErr(e); } };
  return (
    <>
      <Head title="PEP and media reviews" sub={`Politically exposed persons are matched against the OpenSanctions list (${(r.data?.pep_list_entries ?? 0).toLocaleString('en-US')} names loaded). A match opens a review and a work item; it never blocks an order. Adverse media is recorded by a person.`}
        actions={<><Btn kind="ghost" onClick={() => setFilter(filter === 'pending' ? 'all' : 'pending')}>{filter === 'pending' ? 'Show all' : 'Show pending'}</Btn><PermBtn perm="compliance:write" kind="ghost" onClick={sweep}>Screen everyone now</PermBtn><PermBtn perm="compliance:write" kind="primary" onClick={() => setAdding(true)}>Record a review</PermBtn></>} />
      {!can('compliance:write') ? <PermNote perm="compliance:write" /> : null}
      {note ? <p class="ok-text" role="status">{note}</p> : null}
      <ErrorBox error={err} />
      {adding ? <RecordReview onDone={(ok) => { setAdding(false); if (ok) { setNote('Review recorded.'); r.reload(); } }} /> : null}
      <Card pad={false}>
        {r.loading && !r.data ? <div class="pad"><Loading /></div> : r.error ? <div class="pad"><ErrorBox error={r.error} onRetry={r.reload} /></div> : rows.length ? (
          <div class="tw"><table class="t">
            <thead><tr><th>Investor</th><th>Kind</th><th>Result</th><th>Source</th><th>Reviewed</th><th></th></tr></thead>
            <tbody>{rows.map((x: any) => (
              <>
                <tr aria-selected={open === x.id ? 'true' : undefined}>
                  <td><a href={`#/clients/${x.investor_id}`}><strong>{x.investor ?? x.investor_id}</strong></a></td>
                  <td>{KIND[x.kind] ?? x.kind}</td>
                  <td><Chip tone={TONE[x.result] ?? 'muted'}>{x.result === 'pending' ? 'Pending' : x.result === 'hit' ? 'Confirmed' : 'Clear'}</Chip>{x.next_review_on ? <div class="small muted">Next review {day(x.next_review_on)}</div> : null}</td>
                  <td class="small break">{x.source}</td>
                  <td class="muted nowrap">{when(x.reviewed_at)}<div class="small">{String(x.reviewed_by).replace(/^(user|key|system):/, '')}</div></td>
                  <td class="nowrap"><Btn kind="ghost" onClick={() => setOpen(open === x.id ? null : x.id)}>{open === x.id ? 'Close' : x.result === 'pending' ? 'Decide' : 'Details'}</Btn></td>
                </tr>
                {open === x.id ? <tr><td colSpan={6}><ReviewDetail review={x} onDone={() => { setOpen(null); r.reload(); }} /></td></tr> : null}
              </>
            ))}</tbody>
          </table></div>
        ) : <div class="pad"><Empty title={filter === 'pending' ? 'Nothing to decide' : 'No reviews yet'}>{filter === 'pending' ? 'New PEP matches appear here after a credential is issued or the nightly sweep runs.' : 'Record an adverse media check or screen everyone against the PEP list.'}</Empty></div>}
      </Card>
    </>
  );
}

function ReviewDetail({ review, onDone }: { review: any; onDone: () => void }) {
  const { can } = useMe();
  const [result, setResult] = useState<'clear' | 'hit'>(review.result === 'hit' ? 'hit' : 'clear');
  const [summary, setSummary] = useState(review.result === 'pending' ? '' : review.summary ?? '');
  const [ref, setRef] = useState({ title: '', url: '' });
  const [next, setNext] = useState(review.next_review_on ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const decide = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const references = [...(review.references ?? []), ...(ref.title ? [{ title: ref.title, url: ref.url || undefined }] : [])];
      await api(`/v1/screening-reviews/${review.id}/decide`, { body: { result, summary: summary || null, references, next_review_on: next || null } });
      onDone();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <div class="pad" style={{ background: 'var(--paper-2)' }}>
      <p class="muted" style={{ marginTop: 0 }}>{review.summary}</p>
      {(review.references ?? []).length ? <ul class="small">{review.references.map((x: any, i: number) => <li key={i}>{x.url ? <a href={x.url} target="_blank" rel="noopener">{x.title ?? x.entry ?? x.url}</a> : x.title ?? x.entry}{x.program ? <span class="muted"> ({x.program}{x.score != null ? `, similarity ${x.score}` : ''})</span> : null}{x.date ? <span class="muted"> {x.date}</span> : null}</li>)}</ul> : null}
      {can('compliance:write') ? (
        <form class="form-grid" onSubmit={decide}>
          <Field label="Decision"><select value={result} onChange={(e) => setResult((e.target as HTMLSelectElement).value as any)}><option value="clear">Clear: not the same person, or no concern</option><option value="hit">Confirmed: {review.kind === 'pep' ? 'politically exposed, enhanced due diligence applies' : 'adverse media stands'}</option></select></Field>
          <Field label="Next review date (optional)"><input type="date" value={next} onInput={(e) => setNext((e.target as HTMLInputElement).value)} /></Field>
          <div style={{ gridColumn: '1 / -1' }}><Field label="What was checked and why this decision"><textarea rows={3} maxLength={2000} value={summary} onInput={(e) => setSummary((e.target as HTMLTextAreaElement).value)} placeholder="Date of birth and nationality do not match the list entry." /></Field></div>
          <Field label="Reference title (optional)"><input value={ref.title} onInput={(e) => setRef({ ...ref, title: (e.target as HTMLInputElement).value })} placeholder="Passport check, Reuters article" /></Field>
          <Field label="Reference link (optional)"><input type="url" value={ref.url} onInput={(e) => setRef({ ...ref, url: (e.target as HTMLInputElement).value })} /></Field>
          <div class="form-actions"><PermBtn perm="compliance:write" type="submit" kind="primary" busy={busy}>Record decision</PermBtn></div>
        </form>
      ) : null}
      <ErrorBox error={err} />
    </div>
  );
}

function RecordReview({ onDone }: { onDone: (ok: boolean) => void }) {
  const [f, setF] = useState({ investor_id: '', kind: 'adverse_media', result: 'clear', source: '', summary: '', title: '', url: '', next: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const set = (k: string) => (e: Event) => setF({ ...f, [k]: (e.target as HTMLInputElement).value });
  const submit = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      await api(`/v1/investors/${encodeURIComponent(f.investor_id.trim())}/screening-reviews`, { body: { kind: f.kind, result: f.result, source: f.source, summary: f.summary || null, references: f.title ? [{ title: f.title, url: f.url || undefined }] : [], next_review_on: f.next || null } });
      onDone(true);
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Card title="Record a review">
      <form class="form-grid" onSubmit={submit}>
        <Field label="Investor id" hint="From the client's page, for example inv_8f2k1c9d0a."><input required value={f.investor_id} onInput={set('investor_id')} /></Field>
        <Field label="Kind"><select value={f.kind} onChange={set('kind') as any}><option value="adverse_media">Adverse media</option><option value="pep">Politically exposed person</option></select></Field>
        <Field label="Result"><select value={f.result} onChange={set('result') as any}><option value="clear">Clear</option><option value="hit">Confirmed</option><option value="pending">Pending</option></select></Field>
        <Field label="Source checked" hint="Which provider, search or list."><input required minLength={2} value={f.source} onInput={set('source')} placeholder="Dow Jones Factiva, Google News, World-Check" /></Field>
        <div style={{ gridColumn: '1 / -1' }}><Field label="Summary"><textarea rows={3} maxLength={2000} value={f.summary} onInput={set('summary') as any} /></Field></div>
        <Field label="Reference title (optional)"><input value={f.title} onInput={set('title')} /></Field>
        <Field label="Reference link (optional)"><input type="url" value={f.url} onInput={set('url')} /></Field>
        <Field label="Next review date (optional)"><input type="date" value={f.next} onInput={set('next')} /></Field>
        <div class="form-actions"><PermBtn perm="compliance:write" type="submit" kind="primary" busy={busy}>Record</PermBtn><Btn kind="ghost" onClick={() => onDone(false)}>Cancel</Btn></div>
      </form>
      <ErrorBox error={err} />
    </Card>
  );
}

/** The PEP and adverse media reviews for one client, on the client's page. */
export function ReviewsCard({ investorId }: { investorId: string }) {
  const r = useApi(`/v1/investors/${investorId}/screening-reviews`, [investorId]);
  const rows = r.data?.data ?? [];
  return (
    <Card title="PEP and adverse media" actions={<a class="btn ghost sm" href="#/reviews">All reviews</a>}>
      {r.loading && !r.data ? <Loading /> : rows.length ? (
        <ul class="small" style={{ margin: 0, paddingLeft: '1.1rem' }}>{rows.map((x: any) => <li key={x.id}><Chip tone={TONE[x.result] ?? 'muted'}>{x.result === 'pending' ? 'Pending' : x.result === 'hit' ? 'Confirmed' : 'Clear'}</Chip> {KIND[x.kind] ?? x.kind}, {x.source}, {when(x.reviewed_at)}{x.summary ? <div class="muted">{x.summary}</div> : null}</li>)}</ul>
      ) : <p class="muted small">No PEP match and no media review recorded. A match against the politically exposed persons list opens a review here and a work item; adverse media is recorded by a person from the reviews page.</p>}
    </Card>
  );
}
