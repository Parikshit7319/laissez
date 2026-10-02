/** @jsxImportSource preact */
// Report builder: pick a source, choose columns, add filters, group, preview, save, schedule.
// Everything the builder sends is a key from GET /v1/reports/catalog; the API compiles it, never the client.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, API_BASE, authHeaders, when } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Loading, Empty, Field, Card, ConfirmBtn, go } from '../ui';
import { useMe } from '../auth';

type Col = { key: string; label: string; type: 'text' | 'number' | 'date' | 'datetime' | 'bool'; summable: boolean };
type Source = { key: string; label: string; permission: string; default_columns: string[]; columns: Col[] };
type Filter = { column: string; op: string; value?: unknown };
type Def = { name: string; source: string; columns: string[]; filters: Filter[]; group_by: string[]; sort: { column: string; dir: 'asc' | 'desc' }[]; schedule: string | null; recipients: string[] };

const OP_LABEL: Record<string, string> = {
  eq: 'is', neq: 'is not', in: 'is one of', contains: 'contains', starts_with: 'starts with', gt: 'greater than', gte: 'at least', lt: 'less than', lte: 'at most',
  between: 'between', last_days: 'in the last N days', is_null: 'is empty', not_null: 'is set',
};
const NO_VALUE = new Set(['is_null', 'not_null']);
const val = (e: Event) => (e.target as HTMLInputElement).value;
const blank = (source = 'decisions', cols: string[] = []): Def => ({ name: '', source, columns: cols, filters: [], group_by: [], sort: [], schedule: null, recipients: [] });

function fmtCell(v: unknown, type: string) {
  if (v === null || v === undefined) return <span class="muted">None</span>;
  if (type === 'bool') return v ? 'Yes' : 'No';
  if (type === 'number') return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (type === 'datetime') return when(String(v));
  return String(v);
}

export function ReportBuilder({ id }: { id?: string }) {
  const { can } = useMe();
  const cat = useApi<any>('/v1/reports/catalog');
  const saved = useApi<any>('/v1/reports/definitions');
  const [def, setDef] = useState<Def>(blank());
  const [editing, setEditing] = useState<string | null>(id ?? null);
  const [preview, setPreview] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [recipientsText, setRecipientsText] = useState('');
  const sources: Source[] = cat.data?.sources ?? [];
  const source = useMemo(() => sources.find((s) => s.key === def.source), [sources, def.source]);
  const operators: Record<string, string[]> = cat.data?.operators ?? {};
  const colOf = (k: string) => source?.columns.find((c) => c.key === k);

  // First load: default columns for the default source, or the saved report named in the URL.
  useEffect(() => {
    if (!sources.length) return;
    if (id) {
      api(`/v1/reports/definitions/${id}`).then((r) => { setDef({ ...r }); setRecipientsText((r.recipients ?? []).join(', ')); setEditing(id); }).catch(setErr);
    } else if (!def.columns.length) {
      const s = sources.find((x) => x.key === def.source) ?? sources[0];
      setDef(blank(s.key, s.default_columns));
    }
  }, [sources.length, id]);

  const pickSource = (key: string) => {
    const s = sources.find((x) => x.key === key)!;
    setDef({ ...def, source: key, columns: s.default_columns, filters: [], group_by: [], sort: [] }); setPreview(null);
  };
  const toggleCol = (k: string) => setDef({ ...def, columns: def.columns.includes(k) ? def.columns.filter((c) => c !== k) : [...def.columns, k] });
  const toggleGroup = (k: string) => setDef({ ...def, group_by: def.group_by.includes(k) ? def.group_by.filter((c) => c !== k) : def.group_by.length < 5 ? [...def.group_by, k] : def.group_by, sort: [] });
  const setFilter = (i: number, patch: Partial<Filter>) => setDef({ ...def, filters: def.filters.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const addFilter = () => { const c = source?.columns[0]; if (c) setDef({ ...def, filters: [...def.filters, { column: c.key, op: operators[c.type]?.[0] ?? 'eq', value: '' }] }); };
  const removeFilter = (i: number) => setDef({ ...def, filters: def.filters.filter((_, j) => j !== i) });

  const payload = (): Def => ({
    ...def, name: def.name.trim() || `${source?.label ?? 'Report'} report`,
    filters: def.filters.map((f) => {
      const c = colOf(f.column);
      let v: unknown = f.value;
      if (NO_VALUE.has(f.op)) v = undefined;
      else if (f.op === 'in') v = String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      else if (f.op === 'between') v = String(v ?? '').split(',').map((x) => x.trim());
      else if (c?.type === 'number' || f.op === 'last_days') v = Number(v);
      else if (c?.type === 'bool') v = v === true || v === 'true';
      return { column: f.column, op: f.op, ...(v === undefined ? {} : { value: v }) };
    }),
    recipients: recipientsText.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean),
  });
  const run = async () => {
    setErr(null); setBusy('preview');
    try { setPreview(await api('/v1/reports/preview', { body: { ...payload(), limit: 200 } })); } catch (x) { setErr(x); } finally { setBusy(null); }
  };
  const save = async () => {
    setErr(null); setBusy('save'); setMsg(null);
    try {
      const body = payload();
      const r = editing ? await api(`/v1/reports/definitions/${editing}`, { method: 'PUT', body }) : await api('/v1/reports/definitions', { body });
      setEditing(r.id); setDef({ ...r }); setMsg(`Saved "${r.name}".${r.schedule ? ` It runs ${r.schedule} and goes to ${r.recipients.length} recipient${r.recipients.length === 1 ? '' : 's'}.` : ''}`); saved.reload();
    } catch (x) { setErr(x); } finally { setBusy(null); }
  };
  const load = (r: any) => { setDef({ ...r }); setRecipientsText((r.recipients ?? []).join(', ')); setEditing(r.id); setPreview(null); setMsg(null); go(`/reports/builder/${r.id}`); };
  const fresh = () => { const s = source ?? sources[0]; setDef(blank(s.key, s.default_columns)); setRecipientsText(''); setEditing(null); setPreview(null); setMsg(null); go('/reports/builder'); };
  const remove = async (rid: string) => { setErr(null); try { await api(`/v1/reports/definitions/${rid}`, { method: 'DELETE' }); if (editing === rid) fresh(); saved.reload(); } catch (x) { setErr(x); } };
  const csv = async () => {
    setErr(null); setBusy('csv');
    try {
      const res = await fetch(`${API_BASE}${editing ? `/v1/reports/definitions/${editing}/run` : '/v1/reports/preview'}`, { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json', accept: 'text/csv' }, body: JSON.stringify(editing ? {} : { ...payload(), limit: 5000 }) });
      if (!res.ok) { const j: any = await res.json().catch(() => ({})); throw new Error(j?.error?.message ?? `Export failed (${res.status}).`); }
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement('a'); a.href = href; a.download = `laissez-${(def.name || 'report').replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.csv`; a.click(); URL.revokeObjectURL(href);
    } catch (x) { setErr(x); } finally { setBusy(null); }
  };

  if (cat.loading && !cat.data) return <><Head title="Report builder" /><Loading /></>;
  if (cat.error) return <><Head title="Report builder" /><ErrorBox error={cat.error} onRetry={cat.reload} /></>;
  const grouped = def.group_by.length > 0;
  const sortable: string[] = grouped ? [...def.group_by, 'count', ...def.columns.filter((k) => colOf(k)?.summable && !def.group_by.includes(k)).map((k) => `sum_${k}`)] : def.columns;
  const canSchedule = can('audit:export');
  return (
    <>
      <Head title="Report builder" sub="Pick a source, choose the columns, filter and group. Preview before you save; schedule a saved report to arrive by email as CSV."
        actions={<><Btn kind="ghost" onClick={fresh}>New report</Btn><Btn onClick={csv} busy={busy === 'csv'}>Download CSV</Btn><Btn kind="primary" onClick={run} busy={busy === 'preview'}>Preview</Btn></>} />
      <style>{`.rb-chips { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.rb-chip { font: inherit; font-size: 0.8rem; padding: 0.25rem 0.65rem; border-radius: 999px; border: 1px solid var(--line-2, #c6c1b6); background: var(--white, #fff); color: inherit; cursor: pointer; }
.rb-chip.on { background: var(--green, #0f5c4a); border-color: var(--green, #0f5c4a); color: #fff; }
.rb-chip:focus-visible { outline: 2px solid var(--green, #0f5c4a); outline-offset: 2px; }
.t tr.sel td { background: rgba(15, 92, 74, 0.07); }`}</style>
      {msg ? <div class="note" role="status">{msg}</div> : null}
      <ErrorBox error={err} />
      <div class="grid2" style={{ alignItems: 'start' }}>
        <div>
          <Card title={editing ? `Editing ${def.name || 'saved report'}` : 'Definition'}>
            <div class="form-grid one">
              <Field label="Name"><input value={def.name} maxLength={120} placeholder={`${source?.label ?? 'Report'} report`} onInput={(e) => setDef({ ...def, name: val(e) })} /></Field>
              <Field label="Source">
                <select value={def.source} onChange={(e) => pickSource(val(e))}>
                  {sources.map((s) => <option value={s.key} disabled={!can(s.permission)}>{s.label}{!can(s.permission) ? ` (needs ${s.permission})` : ''}</option>)}
                </select>
              </Field>
            </div>
            <p class="f-l" style={{ marginTop: '0.9rem' }}>Columns</p>
            <div class="rb-chips" role="group" aria-label="Columns">
              {source?.columns.map((c) => (
                <button type="button" class={`rb-chip${def.columns.includes(c.key) ? ' on' : ''}`} aria-pressed={def.columns.includes(c.key)} onClick={() => toggleCol(c.key)} title={`${c.type}${c.summable ? ', summed when grouped' : ''}`}>{c.label}</button>
              ))}
            </div>
            <p class="f-l" style={{ marginTop: '0.9rem' }}>Group by <span class="muted">(optional, up to 5)</span></p>
            <div class="rb-chips" role="group" aria-label="Group by">
              {source?.columns.filter((c) => c.type !== 'datetime').map((c) => (
                <button type="button" class={`rb-chip${def.group_by.includes(c.key) ? ' on' : ''}`} aria-pressed={def.group_by.includes(c.key)} onClick={() => toggleGroup(c.key)}>{c.label}</button>
              ))}
            </div>
            {grouped ? <p class="small muted">Grouped reports return a count per group plus totals of the numeric columns you selected ({def.columns.filter((k) => colOf(k)?.summable && !def.group_by.includes(k)).map((k) => colOf(k)!.label).join(', ') || 'none selected'}).</p> : null}
          </Card>
          <Card title="Filters" actions={<Btn kind="ghost" onClick={addFilter}>Add filter</Btn>}>
            {!def.filters.length ? <p class="small muted" style={{ margin: 0 }}>No filters: every row in the source.</p> : (
              <ul class="plain" style={{ gap: '0.6rem' }}>
                {def.filters.map((f, i) => {
                  const c = colOf(f.column);
                  const ops = c ? operators[c.type] ?? [] : [];
                  return (
                    <li class="row-inline" style={{ flexWrap: 'wrap', gap: '0.4rem' }}>
                      <select value={f.column} aria-label="Filter column" onChange={(e) => { const nc = colOf(val(e)); setFilter(i, { column: val(e), op: nc ? (operators[nc.type]?.[0] ?? 'eq') : 'eq', value: '' }); }}>{source?.columns.map((x) => <option value={x.key}>{x.label}</option>)}</select>
                      <select value={f.op} aria-label="Operator" onChange={(e) => setFilter(i, { op: val(e) })}>{ops.map((o) => <option value={o}>{OP_LABEL[o] ?? o}</option>)}</select>
                      {NO_VALUE.has(f.op) ? null : c?.type === 'bool' && f.op === 'eq'
                        ? <select value={String(f.value ?? 'true')} aria-label="Value" onChange={(e) => setFilter(i, { value: val(e) })}><option value="true">Yes</option><option value="false">No</option></select>
                        : <input aria-label="Value" style={{ minWidth: '12rem' }} value={String(f.value ?? '')} placeholder={f.op === 'in' ? 'a, b, c' : f.op === 'between' ? 'from, to' : f.op === 'last_days' ? 'days' : c?.type === 'date' ? 'YYYY-MM-DD' : ''} onInput={(e) => setFilter(i, { value: val(e) })} />}
                      <Btn kind="ghost" onClick={() => removeFilter(i)} ariaLabel="Remove filter">Remove</Btn>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card title="Sort, schedule and save">
            <div class="form-grid">
              <Field label="Sort by">
                <select value={def.sort[0]?.column ?? ''} onChange={(e) => setDef({ ...def, sort: val(e) ? [{ column: val(e), dir: def.sort[0]?.dir ?? 'desc' }] : [] })}>
                  <option value="">Default order</option>
                  {sortable.map((k) => <option value={k}>{k === 'count' ? 'Count' : k.startsWith('sum_') ? `Total ${colOf(k.slice(4))?.label.toLowerCase() ?? k}` : colOf(k)?.label ?? k}</option>)}
                </select>
              </Field>
              <Field label="Direction"><select value={def.sort[0]?.dir ?? 'desc'} disabled={!def.sort.length} onChange={(e) => setDef({ ...def, sort: def.sort.length ? [{ column: def.sort[0].column, dir: val(e) as 'asc' | 'desc' }] : [] })}><option value="desc">Descending</option><option value="asc">Ascending</option></select></Field>
              <Field label="Schedule" hint={canSchedule ? 'Scheduled reports are emailed as CSV from the daily job.' : 'Scheduling emails data out, so it needs the audit:export permission.'}>
                <select value={def.schedule ?? ''} disabled={!canSchedule} onChange={(e) => setDef({ ...def, schedule: val(e) || null })}><option value="">Not scheduled</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>
              </Field>
              <Field label="Recipients" hint="Comma-separated email addresses."><input value={recipientsText} disabled={!canSchedule} placeholder="ops@yourbank.example, risk@yourbank.example" onInput={(e) => setRecipientsText(val(e))} /></Field>
            </div>
            <div class="form-actions">
              <Btn kind="primary" onClick={save} busy={busy === 'save'} disabled={!def.columns.length}>{editing ? 'Save changes' : 'Save report'}</Btn>
              {editing ? <ConfirmBtn kind="ghost" confirm="Delete this saved report" onConfirm={() => remove(editing)}>Delete</ConfirmBtn> : null}
            </div>
          </Card>
        </div>
        <div>
          <Card title={preview ? <>Preview <Chip>{preview.rows.length}{preview.truncated ? '+' : ''} rows</Chip></> : 'Preview'} pad={false}>
            {!preview ? <div class="pad"><Empty title="No preview yet">Press Preview to run the definition. Up to 200 rows show here; Download CSV gives up to 5,000.</Empty></div> : !preview.rows.length ? <div class="pad"><Empty title="No rows match">Loosen the filters or pick another source.</Empty></div> : (
              <div class="tw" style={{ maxHeight: '32rem', overflow: 'auto' }}><table class="t small">
                <thead><tr>{preview.header.map((h: any) => <th class={h.type === 'number' ? 'r' : ''}>{h.label}</th>)}</tr></thead>
                <tbody>{preview.rows.map((row: any) => <tr>{preview.header.map((h: any) => <td class={h.type === 'number' ? 'r' : ''}>{fmtCell(row[h.key], h.type)}</td>)}</tr>)}</tbody>
              </table></div>
            )}
            {preview ? <p class="small muted" style={{ padding: '0.6rem 1.35rem 0.9rem', margin: 0 }}>Run {when(preview.as_of)}. {preview.grouped ? 'Grouped: one row per group.' : ''}</p> : null}
          </Card>
          <Card title="Saved reports" pad={false}>
            {saved.loading && !saved.data ? <div class="pad"><Loading /></div> : !(saved.data?.data ?? []).length ? <div class="pad"><Empty title="Nothing saved yet" /></div> : (
              <div class="tw"><table class="t">
                <thead><tr><th>Name</th><th>Source</th><th>Schedule</th><th>Last run</th></tr></thead>
                <tbody>{saved.data.data.map((r: any) => (
                  <tr class={`click${editing === r.id ? ' sel' : ''}`} onClick={() => load(r)}>
                    <td><strong>{r.name}</strong><div class="small muted">{r.columns.length} columns{r.filters.length ? `, ${r.filters.length} filter${r.filters.length === 1 ? '' : 's'}` : ''}{r.group_by.length ? `, grouped by ${r.group_by.join(', ')}` : ''}</div></td>
                    <td>{sources.find((s) => s.key === r.source)?.label ?? r.source}</td>
                    <td>{r.schedule ? <Chip tone="info">{r.schedule}, {r.recipients.length} recipient{r.recipients.length === 1 ? '' : 's'}</Chip> : <span class="muted">Manual</span>}</td>
                    <td class="muted small">{r.last_run_at ? when(r.last_run_at) : 'Never'}{r.last_sent_at ? <div>Sent {when(r.last_sent_at)}</div> : null}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
