/** @jsxImportSource preact */
// Rule workbench: the organization's own rules, written as data on top of the shipped packs. A rule is built from a
// fixed vocabulary (fields, operators, outcomes), tested against the golden regression suite and the last 90 days of
// this organization's decisions, sent for review, approved by a second person with an effective date, and retired on
// a date. Every version is kept; the diff between versions is shown. Nothing here edits engine code.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, when, day, money, track } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Loading, Empty, Card, Field, ConfirmBtn, go, outcomeChip } from '../ui';
import { useMe, PermBtn, PermNote } from '../auth';

type FieldDef = { key: string; label: string; type: 'number' | 'string' | 'boolean' | 'set'; group: string; hint: string; values?: string[] };
type OperatorDef = { id: string; label: string; types: string[]; list: boolean };
type Vocab = {
  fields: FieldDef[]; operators: OperatorDef[]; layers: string[]; actions: string[]; results: { id: string; label: string }[]; severities: string[];
  statuses: { id: string; label: string }[]; templates: { id: string; name: string; summary: string; summary_sentence: string; definition: any }[]; reviewer_roles: string[]; note: string;
};
type Leaf = { op: string; field: string; value: any };
type Group = { op: 'and' | 'or'; items: Cond[] };
type Cond = Leaf | Group | { op: 'not'; item: Cond };
const isGroup = (c: Cond): c is Group => c.op === 'and' || c.op === 'or';

const STATUS_TONE: Record<string, 'ok' | 'no' | 'warn' | 'info' | 'muted' | 'brass'> = { draft: 'muted', in_review: 'brass', approved: 'info', scheduled: 'info', active: 'ok', retired: 'no' };
const statusChip = (s: string, label?: string) => <Chip tone={STATUS_TONE[s] ?? 'muted'}>{label ?? s.replace('_', ' ')}</Chip>;
const RESULT_TONE: Record<string, 'ok' | 'no' | 'warn' | 'info'> = { fail: 'no', freeze: 'no', info: 'info' };

const blank = (): any => ({
  name: '', description: '', jurisdiction: '*',
  applies_to: { actions: ['subscribe'], funds: '*', investor_kinds: '*', residence: '*' },
  condition: { op: 'and', items: [{ op: 'gt', field: 'order.amount', value: 1_000_000 }] },
  outcome: { result: 'fail', layer: 'Fund policy', label: '', detail: '', remedy: '' },
  severity: 'medium',
});
const listText = (v: '*' | string[] | undefined) => (!v || v === '*' ? '' : v.join(', '));
const textList = (s: string): '*' | string[] => { const a = s.split(',').map((x) => x.trim()).filter(Boolean); return a.length ? a : '*'; };
const defOf = (r: any) => ({ name: r.name, description: r.description ?? '', jurisdiction: r.jurisdiction ?? '*', applies_to: r.applies_to, condition: r.condition, outcome: { ...r.outcome }, severity: r.severity ?? 'medium' });

// ---------- List ----------
export function RuleWorkbench({ id }: { id?: string }) {
  if (id === 'new') return <RuleEditor />;
  if (id) return <RuleDetail id={id} />;
  return <RuleList />;
}

function RuleList() {
  const [status, setStatus] = useState('');
  const r = useApi(`/v1/rules${status ? `?status=${status}` : ''}`, [status]);
  const v = useApi<Vocab>('/v1/rules/vocabulary', []);
  const rows: any[] = r.data?.data ?? [];
  const counts = r.data?.counts ?? {};
  return (
    <>
      <Head title="Rule workbench" sub="Your own rules on top of the shipped packs. Written from a fixed vocabulary, tested against the golden cases and your last 90 days of decisions, approved by a second person with an effective date."
        actions={<PermBtn perm="rules:write" kind="primary" onClick={() => go('/rule-workbench/new')}>New rule</PermBtn>} />
      <PermNote perm="rules:write" />
      <div class="kpis">
        <div class="kpi"><span>Active</span><b>{counts.active ?? 0}</b><em>applied to every order today</em></div>
        <div class="kpi"><span>In review</span><b>{counts.in_review ?? 0}</b><em>waiting for a second person</em></div>
        <div class="kpi"><span>Scheduled</span><b>{counts.scheduled ?? 0}</b><em>approved, effective on a date</em></div>
        <div class="kpi"><span>Drafts</span><b>{counts.draft ?? 0}</b><em>not yet in force</em></div>
      </div>
      <div class="toolbar">
        <select value={status} onChange={(e) => setStatus((e.target as HTMLSelectElement).value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {(v.data?.statuses ?? []).map((s) => <option value={s.id}>{s.label}</option>)}
        </select>
      </div>
      {r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : r.loading && !r.data ? <Loading /> : rows.length === 0 ? (
        <Empty title={status ? 'No rules with this status' : 'No custom rules yet'}>
          {status ? 'Clear the filter to see every rule.' : 'Start from a template below, or write one from scratch. A rule changes nothing until a second person approves it.'}
        </Empty>
      ) : (
        <Card pad={false}>
          <div class="tw"><table class="t">
            <thead><tr><th>Rule</th><th>Applies to</th><th>Outcome</th><th>Status</th><th>In force</th><th>Updated</th></tr></thead>
            <tbody>{rows.map((x) => (
              <tr class="click" onClick={() => go(`/rule-workbench/${x.id}`)}>
                <td><a href={`#/rule-workbench/${x.id}`} onClick={(e) => e.preventDefault()}>{x.name}</a><div class="small muted">v{x.version} by {x.authored_by}{x.jurisdiction !== '*' ? ` · ${x.jurisdiction}` : ''}</div></td>
                <td class="small">{x.applies_to.actions.join(', ')}<div class="muted">{x.applies_to.funds === '*' ? 'any fund' : x.applies_to.funds.join(', ')}</div></td>
                <td><Chip tone={RESULT_TONE[x.outcome.result]}>{x.outcome.result === 'fail' ? 'Deny' : x.outcome.result === 'freeze' ? 'Freeze' : 'Flag'}</Chip><div class="small muted">{x.outcome.layer}</div></td>
                <td>{statusChip(x.status)}{!x.tested && x.status === 'draft' ? <div class="small muted">Not tested</div> : null}</td>
                <td class="small muted nowrap">{x.effective_from ? `${x.effective_from}${x.effective_to ? ` to ${x.effective_to}` : ' onward'}` : 'Not yet'}</td>
                <td class="small muted nowrap">{when(x.updated_at)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Card>
      )}
      {!status && v.data ? (
        <Card title="Start from a template">
          <p class="small muted">Six rules desks ask for most. Each opens pre-filled; change anything before you save.</p>
          <div class="tpl-grid">
            {v.data.templates.map((t) => (
              <button type="button" class="tpl" onClick={() => go(`/rule-workbench/new?template=${t.id}`)}>
                <b>{t.name}</b>
                <span class="small muted">{t.summary}</span>
              </button>
            ))}
          </div>
        </Card>
      ) : null}
    </>
  );
}

// ---------- Editor (new rule, or the next version of an existing one) ----------
function RuleEditor({ existing, onSaved, onCancel }: { existing?: any; onSaved?: (r: any) => void; onCancel?: () => void }) {
  const v = useApi<Vocab>('/v1/rules/vocabulary', []);
  const tplId = new URLSearchParams(location.hash.split('?')[1] ?? '').get('template');
  const [d, setD] = useState<any>(() => (existing ? defOf(existing) : blank()));
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!existing && tplId && v.data) { const t = v.data.templates.find((x) => x.id === tplId); if (t) setD(defOf(t.definition)); }
  }, [tplId, v.data]);
  const set = (k: string, val: any) => setD((x: any) => ({ ...x, [k]: val }));
  const setA = (k: string, val: any) => setD((x: any) => ({ ...x, applies_to: { ...x.applies_to, [k]: val } }));
  const setO = (k: string, val: any) => setD((x: any) => ({ ...x, outcome: { ...x.outcome, [k]: val } }));
  const save = async (e: Event) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const body = { ...d, outcome: { ...d.outcome, remedy: d.outcome.remedy || undefined, rule_ref: d.outcome.rule_ref || undefined, source_id: d.outcome.source_id || undefined } };
      const r = existing ? await api(`/v1/rules/${existing.id}`, { method: 'PUT', body }) : await api('/v1/rules', { body });
      track(existing ? 'rule_edited' : 'rule_created', { template: tplId ?? null });
      if (onSaved) onSaved(r); else go(`/rule-workbench/${r.id}`);
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  if (!v.data) return v.error ? <ErrorBox error={v.error} onRetry={v.reload} /> : <Loading label="Loading the vocabulary" />;
  const vocab = v.data;
  const form = (
    <form onSubmit={save}>
      <div class="form-grid">
        <Field label="Name" hint="What the rule enforces, in one line."><input required minLength={3} maxLength={120} value={d.name} onInput={(e) => set('name', (e.target as HTMLInputElement).value)} placeholder="Entity subscriptions above $25,000,000 need pre-clearance" /></Field>
        <Field label="Jurisdiction" hint="A residence code, or * for any. A coded rule applies when the investor or the counterparty is resident there."><input maxLength={10} value={d.jurisdiction} onInput={(e) => set('jurisdiction', (e.target as HTMLInputElement).value.toUpperCase() || '*')} /></Field>
        <div class="span2"><Field label="Why it exists" hint="Shown to reviewers and in the audit log."><textarea rows={2} maxLength={1000} value={d.description} onInput={(e) => set('description', (e.target as HTMLTextAreaElement).value)} /></Field></div>
      </div>

      <h3 class="sec-h">Applies to</h3>
      <div class="form-grid">
        <Field label="Actions">
          <div class="pick">{vocab.actions.map((a) => {
            const on = d.applies_to.actions.includes(a);
            return <label class={`pick-i${on ? ' on' : ''}`}><input type="checkbox" checked={on} onChange={() => setA('actions', on ? d.applies_to.actions.filter((x: string) => x !== a) : [...d.applies_to.actions, a])} />{a}</label>;
          })}</div>
        </Field>
        <Field label="Funds" hint="Tickers separated by commas. Empty means any fund."><input value={listText(d.applies_to.funds)} onInput={(e) => setA('funds', textList((e.target as HTMLInputElement).value.toUpperCase()))} placeholder="TWLF, GSMF" /></Field>
        <Field label="Client kinds" hint="Individual, Corporate (any entity), or an exact recorded kind. Empty means any."><input value={listText(d.applies_to.investor_kinds)} onInput={(e) => setA('investor_kinds', textList((e.target as HTMLInputElement).value))} placeholder="Corporate" /></Field>
        <Field label="Investor residence" hint="Codes separated by commas. Empty means any."><input value={listText(d.applies_to.residence)} onInput={(e) => setA('residence', textList((e.target as HTMLInputElement).value.toUpperCase()))} placeholder="SG, HK" /></Field>
      </div>

      <h3 class="sec-h">When</h3>
      <p class="small muted">The rule fires when this is true for the order. An empty value never satisfies a condition.</p>
      <CondEditor c={d.condition} vocab={vocab} onChange={(c) => set('condition', c)} root />

      <h3 class="sec-h">Then</h3>
      <div class="form-grid">
        <Field label="Result">
          <select value={d.outcome.result} onChange={(e) => setO('result', (e.target as HTMLSelectElement).value)}>{vocab.results.map((r) => <option value={r.id}>{r.label}</option>)}</select>
        </Field>
        <Field label="Layer" hint="Where the check appears in the decision trace.">
          <select value={d.outcome.layer} onChange={(e) => setO('layer', (e.target as HTMLSelectElement).value)}>{vocab.layers.map((l) => <option value={l}>{l}</option>)}</select>
        </Field>
        <Field label="Check label" hint="The headline shown on a decision."><input required minLength={3} maxLength={140} value={d.outcome.label} onInput={(e) => setO('label', (e.target as HTMLInputElement).value)} /></Field>
        <Field label="Severity">
          <select value={d.severity} onChange={(e) => set('severity', (e.target as HTMLSelectElement).value)}>{vocab.severities.map((s) => <option value={s}>{s}</option>)}</select>
        </Field>
        <div class="span2"><Field label="Detail" hint="Shown under the label. Placeholders such as {investor.short}, {order.amount} or {fund.ticker} are filled from the order."><textarea required rows={2} minLength={3} maxLength={600} value={d.outcome.detail} onInput={(e) => setO('detail', (e.target as HTMLTextAreaElement).value)} /></Field></div>
        <div class="span2"><Field label="Remedy (optional)" hint="What the distributor can do about it. Shown as the next step on a denied order."><input maxLength={400} value={d.outcome.remedy ?? ''} onInput={(e) => setO('remedy', (e.target as HTMLInputElement).value)} /></Field></div>
        <Field label="Rule reference (optional)" hint="Your policy or mandate reference."><input maxLength={120} value={d.outcome.rule_ref ?? ''} onInput={(e) => setO('rule_ref', (e.target as HTMLInputElement).value)} placeholder="Desk mandate 4.2" /></Field>
      </div>

      <ErrorBox error={err} />
      <div class="form-actions">
        <Btn type="submit" kind="primary" busy={busy} disabled={busy || d.applies_to.actions.length === 0}>{existing ? (existing.status === 'draft' ? 'Save draft' : `Save as version ${existing.version + 1}`) : 'Save draft'}</Btn>
        <Btn kind="ghost" onClick={() => (onCancel ? onCancel() : go('/rule-workbench'))}>Cancel</Btn>
        <span class="small muted">Saving creates a draft. Test it, send it for review, and a second person approves it with an effective date.</span>
      </div>
    </form>
  );
  if (existing) return form;
  return (
    <>
      <Head title="New rule" sub={tplId && vocab.templates.find((t) => t.id === tplId) ? `From the template "${vocab.templates.find((t) => t.id === tplId)!.name}". Change anything.` : 'Built from a fixed vocabulary, so every rule can be tested and explained.'} />
      <Card>{form}</Card>
    </>
  );
}

/** A condition tree editor: groups of all-of / any-of, with leaves of field, operator and value. */
function CondEditor({ c, vocab, onChange, root, onRemove }: { c: Cond; vocab: Vocab; onChange: (c: Cond) => void; root?: boolean; onRemove?: () => void }) {
  if (c.op === 'not') return <div class="cond-not"><span class="small">Not:</span><CondEditor c={(c as any).item} vocab={vocab} onChange={(item) => onChange({ op: 'not', item })} onRemove={onRemove} /></div>;
  if (isGroup(c)) {
    const items = c.items;
    return (
      <div class={`cond-group${root ? ' root' : ''}`}>
        <div class="row-inline tight">
          <div class="seg-c" role="group" aria-label="Group operator">
            <button type="button" class={c.op === 'and' ? 'on' : ''} onClick={() => onChange({ ...c, op: 'and' })}>All of</button>
            <button type="button" class={c.op === 'or' ? 'on' : ''} onClick={() => onChange({ ...c, op: 'or' })}>Any of</button>
          </div>
          {!root && onRemove ? <Btn kind="ghost" onClick={onRemove}>Remove group</Btn> : null}
        </div>
        <div class="cond-items">
          {items.map((it, i) => (
            <CondEditor c={it} vocab={vocab} onChange={(n) => onChange({ ...c, items: items.map((x, j) => (j === i ? n : x)) })}
              onRemove={items.length > 1 ? () => onChange({ ...c, items: items.filter((_, j) => j !== i) }) : undefined} />
          ))}
        </div>
        <div class="row-inline tight">
          <Btn kind="ghost" onClick={() => onChange({ ...c, items: [...items, { op: 'eq', field: 'investor.residence', value: 'SG' }] })} disabled={items.length >= 20}>Add condition</Btn>
          <Btn kind="ghost" onClick={() => onChange({ ...c, items: [...items, { op: 'or', items: [{ op: 'eq', field: 'order.asset', value: 'USDC' }] }] })} disabled={items.length >= 20}>Add group</Btn>
        </div>
      </div>
    );
  }
  const leaf = c as Leaf;
  const f = vocab.fields.find((x) => x.key === leaf.field) ?? vocab.fields[0];
  const ops = vocab.operators.filter((o) => o.types.includes(f.type));
  const op = ops.find((o) => o.id === leaf.op) ?? ops[0];
  const setField = (key: string) => {
    const nf = vocab.fields.find((x) => x.key === key)!;
    const nops = vocab.operators.filter((o) => o.types.includes(nf.type));
    const nop = nops.find((o) => o.id === leaf.op) ?? nops[0];
    const value = nf.type === 'boolean' ? true : nf.type === 'number' ? 0 : nop.list ? [nf.values?.[0] ?? ''] : (nf.values?.[0] ?? '');
    onChange({ op: nop.id, field: key, value });
  };
  const setOp = (id: string) => {
    const nop = ops.find((o) => o.id === id)!;
    let value = leaf.value;
    if (nop.list && !Array.isArray(value)) value = [value];
    if (!nop.list && Array.isArray(value)) value = value[0] ?? '';
    onChange({ ...leaf, op: nop.id, value });
  };
  const setValue = (raw: string) => {
    if (op.list) { const parts = raw.split(',').map((x) => x.trim()).filter(Boolean); onChange({ ...leaf, value: f.type === 'number' ? parts.map(Number).filter((n) => !Number.isNaN(n)) : parts }); return; }
    if (f.type === 'number') { const n = Number(raw.replace(/,/g, '')); onChange({ ...leaf, value: Number.isNaN(n) ? 0 : n }); return; }
    if (f.type === 'boolean') { onChange({ ...leaf, value: raw === 'true' }); return; }
    onChange({ ...leaf, value: raw });
  };
  const groups = [...new Set(vocab.fields.map((x) => x.group))];
  const valueText = Array.isArray(leaf.value) ? leaf.value.join(', ') : String(leaf.value ?? '');
  return (
    <div class="cond-leaf">
      <select aria-label="Field" value={f.key} onChange={(e) => setField((e.target as HTMLSelectElement).value)}>
        {groups.map((g) => <optgroup label={g}>{vocab.fields.filter((x) => x.group === g).map((x) => <option value={x.key}>{x.label}</option>)}</optgroup>)}
      </select>
      <select aria-label="Operator" value={op.id} onChange={(e) => setOp((e.target as HTMLSelectElement).value)}>{ops.map((o) => <option value={o.id}>{o.label}</option>)}</select>
      {f.type === 'boolean' ? (
        <select aria-label="Value" value={String(leaf.value)} onChange={(e) => setValue((e.target as HTMLSelectElement).value)}><option value="true">true</option><option value="false">false</option></select>
      ) : f.values && !op.list ? (
        <input aria-label="Value" list={`vals-${f.key.replace('.', '-')}`} value={valueText} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />
      ) : (
        <input aria-label="Value" value={valueText} onInput={(e) => setValue((e.target as HTMLInputElement).value)} placeholder={op.list ? 'a, b, c' : f.type === 'number' ? '0' : ''} inputMode={f.type === 'number' ? 'decimal' : undefined} />
      )}
      {f.values && !op.list ? <datalist id={`vals-${f.key.replace('.', '-')}`}>{f.values.map((x) => <option value={x} />)}</datalist> : null}
      {onRemove ? <button type="button" class="x" aria-label="Remove condition" title="Remove" onClick={onRemove}>×</button> : null}
      <div class="small muted hint">{f.hint}</div>
    </div>
  );
}

// ---------- Detail: status, actions, test, versions ----------
function RuleDetail({ id }: { id: string }) {
  const { me } = useMe();
  const r = useApi(`/v1/rules/${id}`, [id]);
  const [rule, setRule] = useState<any>(null);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<'test' | 'versions'>('test');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const [note, setNote] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [test, setTest] = useState<any>(null);
  useEffect(() => { if (r.data) { setRule(r.data); setTest(null); } }, [r.data]);
  if (r.error) return <><Head title="Rule" /><ErrorBox error={r.error} onRetry={r.reload} /></>;
  if (!rule) return <Loading />;
  const x = rule;
  const mine = x.authored_by_user ? x.authored_by_user === me?.user?.id || x.authored_by_user === me?.acting_as?.id : x.authored_by === (me?.acting_as?.name ?? me?.user?.name);
  const act = async (what: string, body: any = {}) => {
    setBusy(what); setErr(null); setMsg(null);
    try {
      const res = await api(`/v1/rules/${id}/${what}`, { body });
      track(`rule_${what.replace('-', '_')}`);
      if (what === 'test') { setTest(res); setRule(res.rule); setMsg(`Tested ${when(res.ran_at)}.`); }
      else { setRule(res); setMsg(res.note ?? null); setNote(''); }
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  if (editing) {
    return (
      <>
        <Head title={x.status === 'draft' ? `Edit "${x.name}"` : `New version of "${x.name}"`} sub={x.status === 'draft' ? 'Changes to a draft replace it. Test it again before review.' : `Version ${x.version} keeps running until the new one is approved.`} />
        <Card><RuleEditor existing={x} onSaved={(n) => { setRule({ ...n, versions: x.versions }); setEditing(false); setTest(null); r.reload(); }} onCancel={() => setEditing(false)} /></Card>
      </>
    );
  }
  const canEdit = x.status !== 'in_review' && x.status !== 'retired';
  return (
    <>
      <Head title={x.name} sub={<>{statusChip(x.status)} <span class="small muted">Version {x.version} of {x.versions?.length ?? 1}. Written by {x.authored_by}{x.reviewed_by ? `, reviewed by ${x.reviewed_by}` : ''}.{x.effective_from ? ` In force ${x.effective_from}${x.effective_to ? ` to ${x.effective_to}` : ' onward'}.` : ''}</span></>}
        actions={<><Btn kind="ghost" onClick={() => go('/rule-workbench')}>All rules</Btn>{canEdit ? <PermBtn perm="rules:write" onClick={() => setEditing(true)}>{x.status === 'draft' ? 'Edit' : 'New version'}</PermBtn> : null}</>} />
      {x.review_note ? <p class="note"><b>Reviewer note:</b> {x.review_note}</p> : null}
      {x.problems?.length ? <div class="err"><b>This rule cannot run as written.</b><ul>{x.problems.map((p: string) => <li>{p}</li>)}</ul></div> : null}
      <div class="grid2">
        <Card title="What it does">
          <p>{x.summary}</p>
          <dl class="kv">
            <div><dt>Applies to</dt><dd>{x.applies_to.actions.join(', ')} on {x.applies_to.funds === '*' ? 'any fund' : x.applies_to.funds.join(', ')}, for {x.applies_to.investor_kinds === '*' ? 'any client kind' : x.applies_to.investor_kinds.join(', ')} resident {x.applies_to.residence === '*' ? 'anywhere' : `in ${x.applies_to.residence.join(', ')}`}{x.jurisdiction !== '*' ? `, under ${x.jurisdiction}` : ''}</dd></div>
            <div><dt>Outcome</dt><dd><Chip tone={RESULT_TONE[x.outcome.result]}>{x.outcome.result === 'fail' ? 'Deny the order' : x.outcome.result === 'freeze' ? 'Freeze the units' : 'Flag for information'}</Chip> in the {x.outcome.layer} layer, severity {x.severity}</dd></div>
            <div><dt>Check</dt><dd><b>{x.outcome.label}</b><div class="small muted">{x.outcome.detail}</div>{x.outcome.remedy ? <div class="small">Remedy: {x.outcome.remedy}</div> : null}</dd></div>
            {x.description ? <div><dt>Why</dt><dd>{x.description}</dd></div> : null}
            {x.outcome.rule_ref ? <div><dt>Reference</dt><dd>{x.outcome.rule_ref}</dd></div> : null}
          </dl>
        </Card>
        <Card title="Lifecycle">
          <Steps status={x.status} tested={x.tested} />
          {x.status === 'draft' ? (
            <>
              <p class="small muted">{x.tested ? 'Tested since the last edit. Send it for review when the results look right.' : 'Run Test first. Reviewers see the results with the rule.'}</p>
              <div class="form-actions">
                <Btn kind={x.tested ? 'default' : 'primary'} busy={busy === 'test'} disabled={!!busy || !!x.problems?.length} onClick={() => act('test')}>{busy === 'test' ? 'Testing' : 'Test'}</Btn>
                <PermBtn perm="rules:write" kind={x.tested ? 'primary' : 'default'} busy={busy === 'submit'} disabled={!!busy || !x.tested || !!x.problems?.length} onClick={() => act('submit')}>Send for review</PermBtn>
                <ConfirmBtn confirm="Withdraw this draft" disabled={!!busy} onConfirm={() => act('retire')}>Withdraw</ConfirmBtn>
              </div>
            </>
          ) : null}
          {x.status === 'in_review' ? (
            <>
              {mine ? <p class="note">You wrote this version, so a second person has to approve it.{me?.workspace?.kind === 'sandbox' ? ' Switch teammate from the top bar to try it.' : ''}</p> : <p class="small muted">Approving needs the legal, compliance or administrator role. Nothing changes until you do.</p>}
              <div class="form-grid">
                <Field label="Effective from" hint="Today makes it active at once. A later date schedules it."><input type="date" value={from} min={new Date().toISOString().slice(0, 10)} onInput={(e) => setFrom((e.target as HTMLInputElement).value)} /></Field>
                <Field label="Review note" hint="Kept on the version and in the audit log."><input value={note} maxLength={1000} onInput={(e) => setNote((e.target as HTMLInputElement).value)} placeholder="Reviewed against the desk mandate" /></Field>
              </div>
              <div class="form-actions">
                <PermBtn perm="rules:approve" kind="primary" busy={busy === 'approve'} disabled={mine || !!busy} onClick={() => act('approve', { note: note || undefined, effective_from: from || undefined })}>{from && from > new Date().toISOString().slice(0, 10) ? `Approve, effective ${from}` : 'Approve, effective today'}</PermBtn>
                <PermBtn perm="rules:approve" busy={busy === 'request-changes'} disabled={mine || !!busy || note.trim().length < 3} onClick={() => act('request-changes', { note })}>Request changes</PermBtn>
                <Btn kind="ghost" busy={busy === 'test'} disabled={!!busy} onClick={() => act('test')}>Run the tests again</Btn>
              </div>
              {!mine && note.trim().length < 3 ? <p class="small muted">Requesting changes needs a note of what to change.</p> : null}
            </>
          ) : null}
          {x.status === 'active' || x.status === 'scheduled' ? (
            <>
              <p class="small muted">{x.status === 'active' ? 'Applied to every matching order. Retire it today or on a date; edit it to start the next version.' : `Takes effect on ${x.effective_from}. Retire it to cancel.`}</p>
              <div class="form-grid">
                <Field label="Retire on" hint="Empty retires it today."><input type="date" value={to} min={new Date().toISOString().slice(0, 10)} onInput={(e) => setTo((e.target as HTMLInputElement).value)} /></Field>
                <Field label="Note (optional)"><input value={note} maxLength={500} onInput={(e) => setNote((e.target as HTMLInputElement).value)} /></Field>
              </div>
              <div class="form-actions">
                <ConfirmBtn confirm={to ? `Retire on ${to}` : 'Retire this rule now'} disabled={!!busy} onConfirm={() => act('retire', { effective_to: to || undefined, note: note || undefined })}>{to ? `Retire on ${to}` : 'Retire now'}</ConfirmBtn>
                <Btn kind="ghost" busy={busy === 'test'} disabled={!!busy} onClick={() => act('test')}>Test against today's decisions</Btn>
              </div>
            </>
          ) : null}
          {x.status === 'retired' ? <p class="small muted">Retired {x.retired_at ? when(x.retired_at) : ''}{x.retired_by ? ` (${x.retired_by})` : ''}. Start a new version from the editor to bring it back.</p> : null}
          {msg ? <p class="verdict-line ok">{msg}</p> : null}
          <ErrorBox error={err} />
        </Card>
      </div>

      <div class="tabs" role="tablist" style={{ marginTop: '1.25rem' }}>
        <button type="button" role="tab" aria-selected={tab === 'test'} class={tab === 'test' ? 'on' : ''} onClick={() => setTab('test')}>Test results</button>
        <button type="button" role="tab" aria-selected={tab === 'versions'} class={tab === 'versions' ? 'on' : ''} onClick={() => setTab('versions')}>Versions{x.versions?.length > 1 ? ` (${x.versions.length})` : ''}</button>
      </div>
      {tab === 'test' ? <TestPanel id={id} rule={x} test={test} onTested={(res) => { setTest(res); setRule(res.rule); }} /> : <VersionsPanel id={id} />}
    </>
  );
}

function Steps({ status, tested }: { status: string; tested: boolean }) {
  const steps = [
    { k: 'draft', l: 'Draft' }, { k: 'tested', l: 'Tested' }, { k: 'in_review', l: 'In review' }, { k: 'active', l: status === 'scheduled' ? 'Scheduled' : 'Active' }, { k: 'retired', l: 'Retired' },
  ];
  const order = ['draft', 'tested', 'in_review', 'active', 'retired'];
  const cur = status === 'draft' ? (tested ? 'tested' : 'draft') : status === 'scheduled' || status === 'approved' ? 'active' : status;
  const idx = order.indexOf(cur);
  return (
    <ol class="steps" aria-label="Rule lifecycle">
      {steps.map((s, i) => <li class={i < idx ? 'done' : i === idx ? 'now' : ''}>{s.l}</li>)}
    </ol>
  );
}

function TestPanel({ id, rule, test, onTested }: { id: string; rule: any; test: any; onTested: (r: any) => void }) {
  const lt = test ?? (rule.last_test ? { ...rule.last_test, stored: true } : null);
  const [tr, setTr] = useState({ action: 'subscribe', investor_id: '', fund: rule.applies_to.funds !== '*' ? rule.applies_to.funds[0] : '', amount: '1000000', settle_with: 'USDC', counterparty_id: '' });
  const clients = useApi('/v1/investors?limit=100', []);
  const funds = useApi('/v1/funds', []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const run = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const res = await api(`/v1/rules/${id}/test`, { body: { try: { ...tr, amount: Number(tr.amount), counterparty_id: tr.action === 'transfer' ? tr.counterparty_id || undefined : undefined } } });
      onTested(res);
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const cl: any[] = clients.data?.data ?? clients.data ?? [];
  const fl: any[] = funds.data?.data ?? funds.data ?? [];
  return (
    <div class="grid2">
      <Card title="Regression and backtest">
        {!lt ? <Empty title="Not tested yet">Test runs the golden cases for this jurisdiction without and with the rule, then re-runs your last 90 days of decisions with it. Nothing is persisted.</Empty> : (
          <>
            <p class="small muted">Ran {when(lt.ran_at)}{lt.by ? ` by ${lt.by}` : ''} against version {lt.version}.{!rule.tested ? ' The rule changed since: test again.' : ''}</p>
            <div class="kpis">
              <div class="kpi"><span>Golden cases</span><b>{lt.regression.cases}</b><em>{lt.regression.scope}</em></div>
              <div class="kpi"><span>Rule applied</span><b>{lt.regression.applied}</b><em>fired on {lt.regression.fired}</em></div>
              <div class="kpi"><span>Changed outcomes</span><b>{lt.regression.changed.length}</b><em>cases that decide differently</em></div>
              <div class="kpi"><span>Your decisions</span><b>{lt.backtest.decisions_checked}</b><em>{lt.backtest.flips.length} would flip{lt.backtest.truncated ? ' (first 120)' : ''}</em></div>
            </div>
            {lt.regression.changed.length ? (
              <>
                <h4 class="sub-h">Golden cases that change</h4>
                <div class="tw"><table class="t">
                  <thead><tr><th>Case</th><th>Before</th><th>After</th><th>Checks</th></tr></thead>
                  <tbody>{lt.regression.changed.map((c: any) => <tr><td>{c.name}<div class="small muted">{c.pack}</div></td><td>{outcomeChip(c.from)}</td><td>{outcomeChip(c.to)}</td><td class="small muted">{c.failing_after.filter((f: string) => !c.failing_before.includes(f)).join(', ') || 'no new failures'}</td></tr>)}</tbody>
                </table></div>
                <p class="small muted">A change on a golden case is not wrong by itself: your rule is stricter than the law. It is what a reviewer should read before approving.</p>
              </>
            ) : lt.regression.cases ? <p class="verdict-line ok">No golden case decides differently with this rule.</p> : null}
            {lt.backtest.flips.length ? (
              <>
                <h4 class="sub-h">Your decisions that would flip</h4>
                <div class="tw"><table class="t">
                  <thead><tr><th>Decision</th><th>Order</th><th>Was</th><th>Would be</th></tr></thead>
                  <tbody>{lt.backtest.flips.map((f: any) => <tr><td><a href={`#/decisions/${f.decision_id}`}>{f.investor}</a><div class="small muted">{when(f.created_at)}</div></td><td class="small">{f.action} {money(f.amount)} {f.fund}</td><td>{outcomeChip(f.from)}</td><td>{outcomeChip(f.to)}<div class="small muted">{f.reason}</div></td></tr>)}</tbody>
                </table></div>
              </>
            ) : lt.backtest.decisions_checked ? <p class="verdict-line ok">None of your last {lt.backtest.decisions_checked} decisions would flip.</p> : <p class="small muted">No decisions in the last 90 days to backtest against.</p>}
          </>
        )}
      </Card>
      <Card title="Try one order">
        <p class="small muted">Evaluates a live order with the rule added. Nothing is persisted and no settlement starts.</p>
        <form onSubmit={run}>
          <div class="form-grid">
            <Field label="Action"><select value={tr.action} onChange={(e) => setTr({ ...tr, action: (e.target as HTMLSelectElement).value })}>{rule.applies_to.actions.map((a: string) => <option value={a}>{a}</option>)}</select></Field>
            <Field label="Fund"><select required value={tr.fund} onChange={(e) => setTr({ ...tr, fund: (e.target as HTMLSelectElement).value })}><option value="">Choose</option>{fl.map((f: any) => <option value={f.ticker}>{f.ticker}</option>)}</select></Field>
            <Field label="Client"><select required value={tr.investor_id} onChange={(e) => setTr({ ...tr, investor_id: (e.target as HTMLSelectElement).value })}><option value="">Choose</option>{cl.map((c: any) => <option value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="Amount"><input required inputMode="decimal" value={tr.amount} onInput={(e) => setTr({ ...tr, amount: (e.target as HTMLInputElement).value })} /></Field>
            {tr.action === 'transfer' ? <Field label="Counterparty"><select required value={tr.counterparty_id} onChange={(e) => setTr({ ...tr, counterparty_id: (e.target as HTMLSelectElement).value })}><option value="">Choose</option>{cl.filter((c: any) => c.id !== tr.investor_id).map((c: any) => <option value={c.id}>{c.name}</option>)}</select></Field> : null}
          </div>
          <div class="form-actions"><Btn type="submit" kind="primary" busy={busy} disabled={busy || !!rule.problems?.length}>Run</Btn></div>
          <ErrorBox error={err} />
        </form>
        {test?.try ? (
          <div class="try-out">
            <p>{outcomeChip(test.try.outcome)} <b>{test.try.headline}</b></p>
            {test.try.custom_check ? <p class={`small ${test.try.custom_check.custom?.matched ? '' : 'muted'}`}>{test.try.custom_check.custom?.matched ? 'This rule fired: ' : 'This rule applied but did not fire: '}{test.try.custom_check.label}. {test.try.custom_check.detail}</p> : <p class="small muted">This rule did not apply to the order (scope did not match).</p>}
            {test.try.remedies?.length ? <ul class="small">{test.try.remedies.map((r: string) => <li>{r}</li>)}</ul> : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function VersionsPanel({ id }: { id: string }) {
  const r = useApi(`/v1/rules/${id}/versions`, [id]);
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  if (!r.data) return <Loading />;
  const rows: any[] = [...r.data.data].reverse();
  return (
    <Card pad={false}>
      <div class="tw"><table class="t">
        <thead><tr><th>Version</th><th>Status</th><th>Condition</th><th>Changes from the previous version</th><th>People</th></tr></thead>
        <tbody>{rows.map((v) => (
          <tr>
            <td><b>v{v.version}</b><div class="small muted">{day(v.created_at)}</div></td>
            <td>{statusChip(v.status)}<div class="small muted">{v.effective_from ? `${v.effective_from}${v.effective_to ? ` to ${v.effective_to}` : ' onward'}` : ''}</div></td>
            <td class="small">{v.condition_text}</td>
            <td class="small">{v.changes_from_previous.length === 0 ? <span class="muted">{v.version === 1 ? 'First version' : 'No change to the definition'}</span> : <ul class="plain">{v.changes_from_previous.map((c: any) => <li><code>{c.path}</code>: {fmtVal(c.before)} to <b>{fmtVal(c.after)}</b></li>)}</ul>}</td>
            <td class="small">{v.authored_by}{v.reviewed_by ? <div class="muted">reviewed by {v.reviewed_by}{v.review_note ? `: ${v.review_note}` : ''}</div> : null}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </Card>
  );
}
const fmtVal = (v: unknown) => (v === undefined || v === null ? 'empty' : typeof v === 'object' ? JSON.stringify(v) : String(v));
