/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import { API_BASE, authHeaders, compact, money } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Loading, Empty, Card } from '../ui';

const EXPORTS: [name: string, label: string][] = [['register-by-jurisdiction', 'Register by jurisdiction'], ['placement', 'Placement headroom'], ['decisions', 'Decisions']];
const pct = (x: number | null | undefined) => (x === null || x === undefined ? 'None yet' : `${Math.round(x * 100)}%`);
const barColor = (u: number) => (u > 0.8 ? '#b0302a' : u > 0.6 ? '#aa7800' : '#0e7a5b');

function Meter({ value, color = '#b8975a', label }: { value: number; color?: string; label: string }) {
  return (
    <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-label={label} style={{ height: '8px', background: '#efebe4', borderRadius: '999px', overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(100, Math.max(value > 0 ? 2 : 0, value * 100))}%`, height: '100%', background: color, borderRadius: '999px' }} />
    </div>
  );
}

type BarRow = { key: string; label: string; currency: string; value: number; settlements: number };
/** Horizontal bars, scaled within each currency so USD and EUR are never compared on one axis. */
function BarList({ rows, empty }: { rows: BarRow[]; empty: string }) {
  if (!rows.length) return <Empty title={empty} />;
  const max: Record<string, number> = {};
  for (const r of rows) max[r.currency] = Math.max(max[r.currency] ?? 0, r.value);
  return (
    <ul class="plain" style={{ gap: '0.7rem' }}>
      {rows.map((r) => (
        <li>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', fontSize: '0.86rem', marginBottom: '0.3rem' }}>
            <span>{r.label}{rows.some((x) => x.currency !== r.currency) ? <span class="muted"> ({r.currency})</span> : null}</span>
            <span class="nowrap"><b title={money(r.value, r.currency)}>{compact(r.value, r.currency)}</b> <span class="muted small">{r.settlements} settled</span></span>
          </div>
          <Meter value={max[r.currency] ? r.value / max[r.currency] : 0} label={`${r.label}: ${money(r.value, r.currency)}`} />
        </li>
      ))}
    </ul>
  );
}

export function Reports() {
  const p = useApi('/v1/reports/placement');
  const d = useApi('/v1/reports/distribution');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const download = async (name: string) => {
    setBusy(name); setErr(null);
    try {
      const res = await fetch(`${API_BASE}/v1/reports/${name}.csv`, { headers: authHeaders() });
      if (!res.ok) {
        const j: any = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? `Export failed (${res.status}). Try again.`);
      }
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement('a'); a.href = href; a.download = `laissez-${name}.csv`; a.click(); URL.revokeObjectURL(href);
    } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const rows: any[] = p.data?.data ?? [];
  const dist = d.data;
  return (
    <>
      <Head title="Reports" sub="Private placement headroom per fund and jurisdiction, and where this organization's flow settles. Exports open in any spreadsheet."
        actions={EXPORTS.map(([n, l]) => <Btn onClick={() => download(n)} busy={busy === n} disabled={!!busy && busy !== n}>{l} CSV</Btn>)} />
      <ErrorBox error={err} />

      <Card title={<>Placement headroom{p.data?.flagged ? <> <Chip tone="no">{p.data.flagged} above 80%</Chip></> : null}</>} pad={false}>
        {p.loading && !p.data ? <div class="pad"><Loading /></div> : p.error ? <div class="pad"><ErrorBox error={p.error} onRetry={p.reload} /></div> : !rows.length ? (
          <div style={{ padding: '0 1.35rem 1rem' }}><Empty title="No funds to report on">Create a fund with a distribution list to see placement limits.</Empty></div>
        ) : (
          <>
            <div class="tw"><table class="t">
              <thead><tr><th>Fund</th><th>Jurisdiction and basis</th><th class="r">Holders here</th><th class="r">Holders of record</th><th>Limit</th><th style={{ minWidth: '11rem' }}>Headroom</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr style={r.flag ? { background: 'rgba(176, 48, 42, 0.04)' } : undefined}>
                  <td><strong>{r.ticker}</strong><div class="small muted">{r.fund}</div></td>
                  <td>{r.jurisdiction_name}<div class="small muted clamp">{r.basis}</div></td>
                  <td class="r">{r.holders_in_org}</td>
                  <td class="r">{r.fund_holders_of_record}</td>
                  <td class="small" style={{ maxWidth: '20rem' }}>
                    {r.limit_text}
                    {r.citation ? <div class="muted">{r.source_url ? <a href={r.source_url} target="_blank" rel="noopener">{r.citation}</a> : r.citation}{r.verified === false ? ' (unverified)' : ''}</div> : null}
                  </td>
                  <td class="small">
                    {r.limit_number !== null && r.limit_number !== undefined ? (
                      <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.6rem', marginBottom: '0.3rem' }}>
                          <span>{r.counted} of {r.limit_number}{r.flag ? <> <Chip tone="no">Near limit</Chip></> : null}</span>
                          <b>{r.headroom >= 0 ? `${r.headroom} left` : `${-r.headroom} over`}</b>
                        </div>
                        <Meter value={r.utilization ?? 0} color={barColor(r.utilization ?? 0)} label={`${r.ticker} ${r.jurisdiction_name}: ${pct(r.utilization)} of the limit used`} />
                        <div class="muted" style={{ marginTop: '0.25rem' }}>{r.counted_basis}</div>
                      </>
                    ) : <span class="muted">No numeric cap</span>}
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
            <p class="small muted" style={{ padding: '0.8rem 1.35rem 1rem', margin: 0 }}>{p.data.note}</p>
          </>
        )}
      </Card>

      {d.loading && !d.data ? <Loading /> : d.error ? <ErrorBox error={d.error} onRetry={d.reload} /> : dist ? (
        <>
          <div class="grid2">
            <Card title="Settled value by investor jurisdiction"><BarList rows={dist.settled_value.by_jurisdiction} empty="Nothing settled yet" /></Card>
            <Card title="Settled value by booking center"><BarList rows={dist.settled_value.by_booking_center} empty="Nothing settled yet" /></Card>
            <Card title="Settled value by fund"><BarList rows={dist.settled_value.by_fund} empty="Nothing settled yet" /></Card>
            <Card title="Settled value by month"><BarList rows={dist.settled_value.by_month} empty="Nothing settled yet" /></Card>
          </div>
          <Card title="Decisions by investor jurisdiction" pad={false}>
            {!dist.decisions_by_jurisdiction.length ? <div style={{ padding: '0 1.35rem 1rem' }}><Empty title="No decisions yet">Place an order to see allow rates here.</Empty></div> : (
              <div class="tw"><table class="t">
                <thead><tr><th>Jurisdiction</th><th class="r">Decisions</th><th style={{ minWidth: '10rem' }}>Allow rate</th><th>Top refusal reasons</th></tr></thead>
                <tbody>{dist.decisions_by_jurisdiction.map((j: any) => (
                  <tr>
                    <td>{j.jurisdiction_name}</td>
                    <td class="r">{j.decisions}<div class="small muted">{j.allowed} allowed, {j.denied} denied{j.frozen ? `, ${j.frozen} frozen` : ''}</div></td>
                    <td><div class="small" style={{ marginBottom: '0.3rem' }}>{pct(j.allow_rate)}</div><Meter value={j.allow_rate ?? 0} color="#0e7a5b" label={`${j.jurisdiction_name} allow rate ${pct(j.allow_rate)}`} /></td>
                    <td class="small">{j.top_refusal_reasons.length ? <ol class="plain" style={{ gap: '0.2rem' }}>{j.top_refusal_reasons.map((r: any) => <li>{r.label} <span class="muted">({r.n})</span></li>)}</ol> : <span class="muted">No refusals</span>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Card>
          <p class="small muted">{dist.note}</p>
        </>
      ) : null}
    </>
  );
}
