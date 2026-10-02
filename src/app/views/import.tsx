/** @jsxImportSource preact */
// Import: bring clients, credentials and holdings in from a CSV or JSON file in three steps. Pick the type and
// download its template, drop or paste the file, preview every row with its status and messages, then apply in
// chunks with a progress bar. A holdings import ends with the reconciliation report. Past imports open from the list.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, when, track } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Loading, Empty, Card, go } from '../ui';
import { PermBtn, PermNote } from '../auth';

type ImportType = 'clients' | 'credentials' | 'holdings';
const TYPES: { id: ImportType; label: string; what: string; perm: string }[] = [
  { id: 'clients', label: 'Clients', what: 'Investors with their residence, booking center and your own external id.', perm: 'clients:write' },
  { id: 'credentials', label: 'Credentials', what: 'Classifications with the evidence behind each one, tested against the legal threshold before issue.', perm: 'clients:write' },
  { id: 'holdings', label: 'Holdings', what: 'Register positions per client and fund, reconciled against the register and the chain.', perm: 'funds:write' },
];
const STATUS_LABEL: Record<string, string> = { create: 'Create', update: 'Update', skip: 'Skip', error: 'Error' };
const statusChip = (s: string) => s === 'create' ? <Chip tone="ok">Create</Chip> : s === 'update' ? <Chip tone="info">Update</Chip> : s === 'skip' ? <Chip>Skip</Chip> : <Chip tone="no">Error</Chip>;
const resultChip = (r: any) => !r ? null : r.status === 'done' ? <Chip tone="ok">Done</Chip> : <Chip tone="no">Failed</Chip>;
const importStatusChip = (s: string) => s === 'applied' ? <Chip tone="ok">Applied</Chip> : s === 'applying' ? <Chip tone="warn">Applying</Chip> : s === 'failed' ? <Chip tone="no">Failed</Chip> : <Chip tone="info">Previewed</Chip>;

function downloadText(name: string, text: string, type = 'text/csv') {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch { /* download blocked */ }
}
const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));

/** Columns shown in the preview table per type, read from the normalized row data. */
const COLS: Record<ImportType, { key: string; label: string }[]> = {
  clients: [{ key: 'external_id', label: 'External id' }, { key: 'name', label: 'Name' }, { key: 'kind', label: 'Kind' }, { key: 'residence', label: 'Residence' }, { key: 'booking_center', label: 'Booking' }],
  credentials: [{ key: 'client_external_id', label: 'Client' }, { key: 'class_code', label: 'Class' }, { key: 'verified_on', label: 'Verified' }, { key: 'expires_on', label: 'Expires' }],
  holdings: [{ key: 'client_external_id', label: 'Client' }, { key: 'ticker', label: 'Fund' }, { key: 'units', label: 'Units' }, { key: 'since', label: 'Since' }],
};

export function ImportPage({ id }: { id?: string }) {
  const [type, setType] = useState<ImportType>('clients');
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [imp, setImp] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<any>(null);
  const [filter, setFilter] = useState<string>('all');
  const [over, setOver] = useState(false);
  const list = useApi('/v1/imports', [imp?.id, imp?.status]);
  const stopRef = useRef(false);

  // Deep link to a past import: /import/:id
  useEffect(() => {
    if (!id) return;
    setBusy(true); setErr(null);
    api(`/v1/imports/${id}`).then((d) => { setImp(d); setType(d.type); setProgress(d.status === 'applied' ? { processed: d.rows.length, total: d.rows.length } : null); }).catch(setErr).finally(() => setBusy(false));
  }, [id]);

  const perm = TYPES.find((t) => t.id === type)!.perm;
  const rowsOf = (text: string) => text.trim() ? text.trim().split(/\r?\n/).length - (text.trim().startsWith('[') || text.trim().startsWith('{') ? 0 : 1) : 0;
  const lineCount = useMemo(() => rowsOf(content), [content]);

  const readFile = (f: File | undefined) => { if (!f) return; if (f.size > 5 * 1024 * 1024) { setErr(new Error('The file is larger than 5 MB. Split it and import the parts.')); return; } f.text().then((t) => { setContent(t); setFileName(f.name); setImp(null); setErr(null); }); };
  const onFile = (e: Event) => readFile((e.target as HTMLInputElement).files?.[0]);
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); readFile(e.dataTransfer?.files?.[0]); };

  const template = async () => {
    try {
      const res = await api<Response>(`/v1/imports/templates/${type}.csv`, { raw: true });
      if (!res.ok) throw new Error('The template could not be downloaded.');
      downloadText(`laissez-import-${type}.csv`, await res.text());
    } catch (e) { setErr(e); }
  };
  const preview = async () => {
    setBusy(true); setErr(null); setProgress(null);
    try {
      const d = await api('/v1/imports', { body: { type, content, file_name: fileName ?? undefined } });
      setImp(d); setFilter('all');
      track('import_previewed', { type, rows: d.totals?.rows ?? 0, errors: d.totals?.error ?? 0 });
      if (location.hash !== `#/import/${d.id}`) history.replaceState(null, '', `#/import/${d.id}`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!imp) return;
    setApplying(true); setErr(null); stopRef.current = false;
    let cur = imp;
    try {
      let done = false;
      while (!done && !stopRef.current) {
        const step = await api(`/v1/imports/${imp.id}/apply`, { body: {} });
        setProgress(step.progress);
        // Merge the chunk's row results into the preview so the table updates as it goes.
        const byN = new Map<number, any>(step.rows.map((r: any) => [r.n, r]));
        cur = { ...cur, status: step.status, rows: cur.rows.map((r: any) => byN.get(r.n) ?? r), result: step.result ?? cur.result };
        setImp(cur);
        done = step.done;
      }
      if (done) { track('import_applied', { type: imp.type, applied: cur.rows.filter((r: any) => r.result?.status === 'done').length }); list.reload(); }
    } catch (e) { setErr(e); } finally { setApplying(false); }
  };
  const reset = () => { setImp(null); setContent(''); setFileName(null); setProgress(null); setErr(null); if (id) go('/import'); };

  const rows: any[] = imp?.rows ?? [];
  const totals = imp?.totals ?? { rows: 0, create: 0, update: 0, skip: 0, error: 0 };
  const applicable = totals.create + totals.update;
  const shown = filter === 'all' ? rows : filter === 'failed' ? rows.filter((r) => r.result?.status === 'failed') : rows.filter((r) => r.status === filter);
  const cols = COLS[(imp?.type ?? type) as ImportType];
  const appliedCount = rows.filter((r) => r.result?.status === 'done').length;
  const failedCount = rows.filter((r) => r.result?.status === 'failed').length;
  const pct = progress?.total ? Math.round((progress.processed / progress.total) * 100) : imp?.status === 'applied' ? 100 : 0;
  const canApply = imp && imp.status !== 'applied' && applicable > 0 && !applying;

  const downloadResults = () => {
    if (!imp) return;
    const head = ['row', 'status', ...cols.map((c) => c.key), 'matched_client', 'messages', 'result', 'result_message', 'investor_id', 'credential_id'];
    const cell = (v: unknown) => { let s = String(v ?? ''); if (/^[=+@\t\r]|^-[^0-9]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const body = rows.map((r) => [r.n, r.status, ...cols.map((c) => r.data?.[c.key] ?? ''), r.match?.investor_id ?? '', r.messages.join(' '), r.result?.status ?? '', r.result?.message ?? '', r.result?.investor_id ?? '', r.result?.credential_id ?? '']);
    downloadText(`laissez-import-${imp.type}-${imp.id}.csv`, [head, ...body].map((l) => l.map(cell).join(',')).join('\r\n') + '\r\n');
  };

  return (
    <>
      <Head title="Import" sub="Bring clients, credentials and holdings in from your existing systems. Every row is validated and matched before anything is written, and a holdings import ends with a reconciliation report." actions={imp ? <Btn kind="ghost" onClick={reset}>New import</Btn> : null} />

      {!imp ? (
        <Card title="1. Pick what you are importing" actions={<Btn kind="ghost" onClick={template}>Download {type} template</Btn>}>
          <div class="seg-c" role="radiogroup" aria-label="Import type">{TYPES.map((t) => <button type="button" role="radio" aria-checked={type === t.id} class={type === t.id ? 'on' : ''} onClick={() => { setType(t.id); setErr(null); }}>{t.label}</button>)}</div>
          <p class="small muted" style={{ marginTop: 0 }}>{TYPES.find((t) => t.id === type)!.what}</p>
          <TemplateNotes type={type} templates={list.data?.templates} />
          <PermNote perm={perm} />
        </Card>
      ) : null}

      {!imp ? (
        <Card title="2. Drop a file or paste its contents" actions={<label class="b b-ghost file">Choose file<input type="file" accept=".csv,.json,text/csv,application/json" onChange={onFile} /></label>}>
          <div
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
            style={{ border: `2px dashed ${over ? 'var(--green)' : 'var(--line-2)'}`, borderRadius: 10, padding: '0.75rem', background: over ? 'color-mix(in srgb, var(--green) 6%, transparent)' : 'transparent' }}
          >
            <textarea class="csv" rows={10} value={content} onInput={(e) => { setContent((e.target as HTMLTextAreaElement).value); setFileName(null); }} aria-label="File contents" placeholder={`Drop a .csv or .json file here, or paste it. Columns for ${type}: ${(list.data?.templates ?? []).find((t: any) => t.type === type)?.columns.join(', ') ?? 'see the template'}.`} style={{ width: '100%', border: 0, background: 'transparent', resize: 'vertical' }} />
          </div>
          <div class="row-inline tight" style={{ marginTop: '0.8rem', gap: '0.8rem' }}>
            <PermBtn perm={perm} kind="primary" busy={busy} disabled={!content.trim()} onClick={preview}>{busy ? 'Validating' : `Preview ${lineCount > 0 ? `${lineCount.toLocaleString('en-US')} row${lineCount === 1 ? '' : 's'}` : 'rows'}`}</PermBtn>
            <span class="small muted">{fileName ? `${fileName}, ${(content.length / 1024).toFixed(0)} KB.` : content ? `${(content.length / 1024).toFixed(0)} KB pasted.` : 'CSV or JSON, up to 5 MB. Nothing is written at this step.'}</span>
          </div>
          <ErrorBox error={err} />
        </Card>
      ) : null}

      {busy && id && !imp ? <Loading label="Loading import" /> : null}

      {imp ? (
        <>
          <Card title={<>{imp.status === 'applied' ? 'Result' : '3. Preview'} <span class="muted small">{imp.id}{imp.file_name ? `, ${imp.file_name}` : ''}</span></>} actions={<><Btn kind="ghost" onClick={downloadResults}>Download results CSV</Btn>{importStatusChip(imp.status)}</>}>
            <div class="kpis" style={{ marginBottom: '0.9rem' }}>
              <button type="button" class="kpi" style={{ cursor: 'pointer', textAlign: 'left', outline: filter === 'all' ? '2px solid var(--ink)' : undefined }} onClick={() => setFilter('all')}><span>Rows</span><b>{fmt(totals.rows)}</b><em>{imp.type}</em></button>
              {(['create', 'update', 'skip', 'error'] as const).map((s) => <button type="button" class="kpi" style={{ cursor: 'pointer', textAlign: 'left', outline: filter === s ? '2px solid var(--ink)' : undefined }} onClick={() => setFilter(s)}><span>{STATUS_LABEL[s]}</span><b>{fmt(totals[s])}</b><em>{s === 'create' ? 'new records' : s === 'update' ? 'existing records' : s === 'skip' ? 'nothing to do' : 'will not be applied'}</em></button>)}
              {imp.status !== 'previewed' ? <button type="button" class="kpi" style={{ cursor: 'pointer', textAlign: 'left', outline: filter === 'failed' ? '2px solid var(--ink)' : undefined }} onClick={() => setFilter('failed')}><span>Applied</span><b>{fmt(appliedCount)}</b><em>{failedCount ? `${failedCount} failed` : 'no failures'}</em></button> : null}
            </div>
            {imp.warnings?.length ? <p class="small muted">{imp.warnings.join(' ')}</p> : null}
            {imp.note && imp.status === 'previewed' ? <p class="small">{imp.note}</p> : null}

            {imp.status !== 'applied' ? (
              <div class="row-inline tight" style={{ gap: '0.8rem', marginBottom: '0.6rem' }}>
                <PermBtn perm={TYPES.find((t) => t.id === imp.type)!.perm} kind="primary" busy={applying} disabled={!canApply} onClick={apply}>
                  {applying ? `Applying ${pct}%` : imp.status === 'applying' || imp.status === 'failed' ? `Continue applying ${fmt(applicable - appliedCount - failedCount)} rows` : `Apply ${fmt(applicable)} row${applicable === 1 ? '' : 's'}`}
                </PermBtn>
                {applying ? <Btn kind="ghost" onClick={() => { stopRef.current = true; }}>Stop after this chunk</Btn> : null}
                <span class="small muted">{applicable === 0 ? 'Nothing to apply: every row is a skip or an error.' : `Rows marked error and skip are left out. Writes happen in chunks of up to ${imp.type === 'credentials' ? 50 : 200} rows.`}</span>
              </div>
            ) : null}
            {imp.status === 'failed' && imp.error ? <ErrorBox error={new Error(`The last chunk failed: ${imp.error}`)} /> : null}
            {(applying || progress || imp.status === 'applied') && applicable > 0 ? (
              <div style={{ margin: '0.4rem 0 0.9rem' }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Import progress">
                <div style={{ height: 8, borderRadius: 999, background: 'var(--line)', overflow: 'hidden' }}><div style={{ height: '100%', width: `${pct}%`, background: failedCount ? 'var(--coral)' : 'var(--green)', transition: 'width 250ms ease' }} /></div>
                <div class="small muted" style={{ marginTop: '0.3rem' }}>{progress ? `${fmt(progress.processed)} of ${fmt(progress.total)} rows processed, ${fmt(appliedCount)} applied${failedCount ? `, ${fmt(failedCount)} failed` : ''}.` : `${fmt(appliedCount)} applied${failedCount ? `, ${fmt(failedCount)} failed` : ''}.`}</div>
              </div>
            ) : null}
            <ErrorBox error={imp && err ? err : null} />

            {imp.status === 'applied' && imp.type !== 'holdings' && imp.result ? (
              <p class="small">
                {imp.type === 'clients' ? <>{fmt(imp.result.created)} client{imp.result.created === 1 ? '' : 's'} created and {fmt(imp.result.updated)} updated. <a href="#/clients">Open clients</a>.</> : <>{fmt(imp.result.credentials)} credential{imp.result.credentials === 1 ? '' : 's'} issued across {fmt(imp.result.applied)} row{imp.result.applied === 1 ? '' : 's'}. <a href="#/clients?credential_status=active">Open clients</a>.</>}
                {imp.result.failed ? ` ${fmt(imp.result.failed)} row${imp.result.failed === 1 ? '' : 's'} failed; see the messages below.` : ''}
              </p>
            ) : null}
          </Card>

          {imp.type === 'holdings' && imp.result ? <ReconReport r={imp.result} /> : null}

          <Card title={`Rows${filter === 'all' ? '' : `: ${filter}`}`} pad={false}>
            {shown.length ? (
              <div class="tw"><table class="t">
                <thead><tr><th class="r">#</th><th>Status</th>{cols.map((c) => <th>{c.label}</th>)}<th>Matched client</th><th>Messages</th>{imp.status !== 'previewed' ? <th>Result</th> : null}</tr></thead>
                <tbody>{shown.slice(0, 1000).map((r: any) => (
                  <tr>
                    <td class="r muted">{r.n}</td>
                    <td>{statusChip(r.status)}</td>
                    {cols.map((c) => <td class={c.key === 'units' ? 'r' : ''}>{c.key === 'units' ? fmt(r.data?.[c.key]) : r.data?.[c.key] ?? <span class="muted">{'—'.replace('—', '')}</span>}</td>)}
                    <td>{r.match ? <a href={`#/clients/${r.match.investor_id}`}>{r.match.name}</a> : r.result?.investor_id ? <a href={`#/clients/${r.result.investor_id}`}>{r.result.investor_id}</a> : <span class="muted small">New</span>}{r.match?.by === 'name' ? <div><Chip tone="warn">By name</Chip></div> : null}</td>
                    <td class="small">{r.messages.map((m: string) => <div>{m}</div>)}</td>
                    {imp.status !== 'previewed' ? <td class="small">{resultChip(r.result)}{r.result?.message ? <div class="muted">{r.result.message}</div> : null}{r.result?.credential_id ? <div><code>{r.result.credential_id}</code>{r.result.lzid ? <span class="muted"> {r.result.lzid}</span> : null}</div> : null}</td> : null}
                  </tr>
                ))}</tbody>
              </table></div>
            ) : <div style={{ padding: '1rem 1.35rem' }}><Empty title={`No ${filter === 'all' ? '' : filter + ' '}rows`} /></div>}
            {shown.length > 1000 ? <p class="small muted" style={{ padding: '0 1.35rem 1rem' }}>Showing the first 1,000 of {fmt(shown.length)} rows. Download the results CSV for all of them.</p> : null}
          </Card>
        </>
      ) : null}

      {!id || imp ? (
        <Card title="Past imports" pad={false}>
          {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !(list.data?.data ?? []).length ? <div style={{ padding: '1rem 1.35rem' }}><Empty title="No imports yet">The first one usually is the client list from your CRM or transfer agent.</Empty></div> : (
            <div class="tw"><table class="t">
              <thead><tr><th>When</th><th>Type</th><th>File</th><th>Status</th><th class="r">Rows</th><th class="r">Create</th><th class="r">Update</th><th class="r">Skip</th><th class="r">Error</th><th>By</th><th /></tr></thead>
              <tbody>{(list.data.data as any[]).map((r) => (
                <tr>
                  <td class="nowrap">{when(r.created_at)}</td>
                  <td>{r.type}</td>
                  <td class="small">{r.file_name ?? <span class="muted">pasted</span>}</td>
                  <td>{importStatusChip(r.status)}</td>
                  <td class="r">{fmt(r.totals?.rows)}</td><td class="r">{fmt(r.totals?.create)}</td><td class="r">{fmt(r.totals?.update)}</td><td class="r">{fmt(r.totals?.skip)}</td><td class="r">{fmt(r.totals?.error)}</td>
                  <td class="small">{r.applied_by ?? r.created_by}</td>
                  <td><a href={`#/import/${r.id}`}>{r.status === 'previewed' || r.status === 'applying' || r.status === 'failed' ? 'Open and apply' : 'Open'}</a></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      ) : null}
    </>
  );
}

function TemplateNotes({ type, templates }: { type: ImportType; templates?: any[] }) {
  const t = (templates ?? []).find((x) => x.type === type);
  if (!t) return null;
  return (
    <details class="more" open>
      <summary class="small">Columns and rules for {type}</summary>
      <p class="small" style={{ margin: '0.4rem 0' }}><code>{t.columns.join(', ')}</code> <span class="muted">(required: {t.required.join(', ')})</span></p>
      <ul class="small muted" style={{ margin: 0, paddingLeft: '1.1rem' }}>{t.notes.map((n: string) => <li>{n}</li>)}</ul>
    </details>
  );
}

/** The reconciliation report a holdings import carries: file against the register, and the chain run when on. */
function ReconReport({ r }: { r: any }) {
  const diffs: any[] = r.differences ?? [];
  const chain = r.chain;
  return (
    <Card title={<>Reconciliation report <span class="muted small">{r.stage === 'preview' ? 'what will change' : 'after the import'}</span></>} actions={chain ? <a class="b b-ghost" href="#/reconciliation">Open reconciliation</a> : null}>
      <div class="kpis" style={{ marginBottom: '0.8rem' }}>
        <div class="kpi"><span>Positions compared</span><b>{fmt(r.compared)}</b><em>rows that parsed</em></div>
        <div class="kpi"><span>Matched the register</span><b>{fmt(r.matched)}</b><em>no change</em></div>
        <div class="kpi"><span>New positions</span><b>{fmt(r.added)}</b><em>not on the register before</em></div>
        <div class="kpi"><span>Differences</span><b>{fmt(diffs.length)}</b><em>{r.stage === 'preview' ? 'register will be set to the file' : `${fmt(r.adjusted)} applied${r.failed ? `, ${fmt(r.failed)} failed` : ''}`}</em></div>
        {chain ? <div class="kpi"><span>On-chain breaks</span><b>{fmt(chain.breaks)}</b><em>{chain.run?.network ?? 'chain'} block {fmt(chain.run?.chain_block)}</em></div> : null}
      </div>
      {diffs.length ? (
        <div class="tw"><table class="t">
          <thead><tr><th class="r">Row</th><th>Client</th><th>Fund</th><th class="r">Register before</th><th class="r">Imported</th><th class="r">Difference</th>{r.stage !== 'preview' ? <th>Applied</th> : null}</tr></thead>
          <tbody>{diffs.map((d) => <tr><td class="r muted">{d.row}</td><td>{d.investor_id ? <a href={`#/clients/${d.investor_id}`}>{d.investor}</a> : d.investor}</td><td>{d.ticker}</td><td class="r">{fmt(d.register_units)}</td><td class="r">{fmt(d.imported_units)}</td><td class="r">{d.difference > 0 ? '+' : ''}{fmt(d.difference)}</td>{r.stage !== 'preview' ? <td>{d.applied ? <Chip tone="ok">Yes</Chip> : <Chip tone="no">No</Chip>}</td> : null}</tr>)}</tbody>
        </table></div>
      ) : <p class="small muted">Every imported position already matched the register.</p>}
      {chain ? (
        <>
          <h3 style={{ fontSize: '0.95rem', margin: '1rem 0 0.4rem' }}>Token balances on chain</h3>
          <p class="small muted">{chain.note}</p>
          {(chain.positions ?? []).length ? (
            <div class="tw"><table class="t">
              <thead><tr><th>Client</th><th>Fund</th><th class="r">Register</th><th class="r">On chain</th><th>Status</th></tr></thead>
              <tbody>{chain.positions.map((p: any) => <tr><td><a href={`#/clients/${p.investor_id}`}>{p.name}</a></td><td>{p.ticker}</td><td class="r">{fmt(p.register)}</td><td class="r">{fmt(p.chain)}</td><td>{p.status === 'matched' ? <Chip tone="ok">Matched</Chip> : p.status === 'break' ? <Chip tone="no">Break</Chip> : <Chip>Off chain</Chip>}</td></tr>)}</tbody>
            </table></div>
          ) : <p class="small muted">No onboarded wallets hold these funds on chain yet.</p>}
        </>
      ) : r.chain_note ? <p class="small muted">{r.chain_note}</p> : null}
      {r.note ? <p class="small muted">{r.note}</p> : null}
    </Card>
  );
}
