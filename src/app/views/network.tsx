/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, day, when, JUR, CLASS_LABEL, BOOKING } from '../api';
import { useApi, Btn, Chip, ErrorBox, Loading, Empty, Field, Card, Copy } from '../ui';

const DEFAULT_PURPOSE = 'Onboard the client for tokenized fund subscriptions booked with us';
const classList = (codes: string[]) => (codes?.length ? codes.map((c) => CLASS_LABEL[c] ?? c).join(', ') : 'KYC only');

function shareChip(s: any) {
  if (s.status === 'active') return s.credential_live === false ? <Chip tone="warn" title="The issuing distributor revoked or let the credential lapse">Credential lapsed</Chip> : <Chip tone="ok">Active</Chip>;
  if (s.status === 'pending') return <Chip tone="info">Waiting for client</Chip>;
  if (s.status === 'declined') return <Chip tone="no">Declined</Chip>;
  return <Chip>Revoked</Chip>;
}

function RevokeShare({ share, issuer, onDone }: { share: any; issuer: boolean; onDone: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  if (share.status !== 'active' && share.status !== 'pending') return null;
  if (!open) return <Btn kind="ghost" onClick={() => setOpen(true)}>Revoke</Btn>;
  const submit = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await api(`/v1/credential-shares/${share.id}/revoke`, { body: { reason, all_recipients: issuer && all } }); onDone(r.note); setOpen(false); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <form class="row-inline tight" onSubmit={submit} style={{ flexWrap: 'wrap', gap: '0.4rem' }}>
      <input class="sm" required minLength={3} value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} placeholder="Reason, for the audit log" aria-label="Reason for revoking" />
      {issuer ? <label class="check small"><input type="checkbox" checked={all} onChange={(e) => setAll((e.target as HTMLInputElement).checked)} /> Every recipient</label> : null}
      <Btn type="submit" kind="danger" busy={busy}>Revoke</Btn>
      <Btn kind="ghost" onClick={() => setOpen(false)}>Cancel</Btn>
      <ErrorBox error={err} />
    </form>
  );
}

/**
 * One client's place in the network: the passport number with Copy, who relies on it, and a Share button
 * that explains how another distributor imports the client. Used on the client page and on Network.
 */
export function NetworkCard({ investorId, title = 'Credential network' }: { investorId: string; title?: string }) {
  const r = useApi(`/v1/investors/${investorId}/network`, [investorId]);
  const [sharing, setSharing] = useState(false);
  if (r.loading && !r.data) return <Card title={title}><Loading /></Card>;
  if (r.error) return <Card title={title}><ErrorBox error={r.error} onRetry={r.reload} /></Card>;
  const d = r.data;
  const out: any[] = d.shares_out ?? [];
  const active = out.filter((s) => s.status === 'active');
  const relied = d.relied_on;
  return (
    <Card title={title} class="netcard" actions={d.lzid ? <Btn kind={sharing ? 'default' : 'primary'} onClick={() => setSharing((x) => !x)}>{sharing ? 'Done' : 'Share'}</Btn> : null}>
      {d.lzid ? (
        <div class="netcard-pp">
          <span class="f-l">Passport number</span>
          <div class="netcard-pp-row"><code class="netcard-num">{d.lzid}</code><Copy text={d.lzid} /></div>
          {d.credential ? <span class="small muted">Valid {d.credential.issued_on} to {d.credential.expires_on}.</span> : null}
        </div>
      ) : <p class="muted small">{d.note}</p>}
      {sharing ? (
        <div class="reveal" role="status">
          <span class="f-l">How another distributor relies on this credential</span>
          <ol class="netcard-steps">
            <li>Give them the passport number <code>{d.lzid}</code>. It carries no personal data on its own.</li>
            <li>They enter it under Network, Import a client, and choose where to book the client.</li>
            <li>{d.investor.name} receives a consent request and approves or declines. On approval they appear in that distributor's client list, reading this credential live.</li>
          </ol>
          <p class="small muted">You can revoke any share from this card or from Network. Identity documents and evidence never leave you.</p>
        </div>
      ) : null}
      {relied ? (
        <p class="note small" style={{ marginTop: '0.9rem' }}>Relied on from <b>{relied.issuing_org}</b>{relied.consent_at ? <>, consent signed by {relied.consent_name} on {day(relied.consent_at)}</> : null}. {relied.credential_live ? 'Their credential is live, so it applies here at once.' : 'Their credential is no longer live, so this client is redemption-only until you issue your own.'} <a href="#/network">Manage on Network</a>.</p>
      ) : null}
      <div class="netcard-rel">
        <span class="f-l">Who relies on it</span>
        {out.length ? (
          <ul class="netcard-list">
            {out.map((s) => <li><span><b>{s.receiving_org}</b>{s.purpose ? <em class="clamp">{s.purpose}</em> : null}</span><span class="netcard-st">{shareChip(s)}<small class="muted">{s.consent_at ? `Consented ${day(s.consent_at)}` : s.status === 'pending' ? `Requested ${day(s.requested_at)}` : s.revoked_at ? `Ended ${day(s.revoked_at)}` : ''}</small></span></li>)}
          </ul>
        ) : <p class="small muted" style={{ margin: '0.3rem 0 0' }}>No other distributor relies on this credential yet.{active.length ? '' : d.lzid ? ' Share the passport number to change that.' : ''}</p>}
      </div>
    </Card>
  );
}

/** Pick one of your clients, then see and share their passport number. */
function SharePicker({ onClose }: { onClose: () => void }) {
  const clients = useApi('/v1/investors?credential_status=active&limit=200');
  const [id, setId] = useState('');
  const rows: any[] = clients.data?.data ?? [];
  useEffect(() => { if (!id && rows.length) setId(rows[0].id); }, [rows.length]);
  return (
    <Card title="Share a client's credential" actions={<Btn kind="ghost" onClick={onClose}>Close</Btn>}>
      {clients.loading && !clients.data ? <Loading /> : clients.error ? <ErrorBox error={clients.error} onRetry={clients.reload} /> : !rows.length ? (
        <Empty title="No client with an active credential">Issue a credential first; its passport number is what you share.</Empty>
      ) : (
        <>
          <Field label="Client"><select value={id} onChange={(e) => setId((e.target as HTMLSelectElement).value)}>{rows.map((i) => <option value={i.id}>{i.name} ({i.residence_name})</option>)}</select></Field>
          {id ? <div style={{ marginTop: '1rem' }}><NetworkCard investorId={id} title="Passport and shares" /></div> : null}
        </>
      )}
    </Card>
  );
}

export function Network() {
  const shares = useApi('/v1/credential-shares');
  const demo = useApi('/v1/network/demo-ids');
  const metrics = useApi('/v1/metrics');
  const [f, setF] = useState({ lzid: '', booking_center: 'SG', purpose: DEFAULT_PURPOSE });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  const net = metrics.data?.network ?? null;
  const focusImport = () => { document.getElementById('net-import')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setTimeout(() => importRef.current?.focus(), 350); };

  const request = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null); setResult(null);
    try { const r = await api('/v1/credential-shares', { body: f }); setResult(r); shares.reload(); demo.reload(); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const after = (m: string) => { setMsg(m); shares.reload(); demo.reload(); };
  const incoming: any[] = shares.data?.incoming ?? [];
  const outgoing: any[] = shares.data?.outgoing ?? [];
  const demoRows: any[] = demo.data?.data ?? [];

  return (
    <>
      <section class="net-hero" aria-labelledby="net-hero-h">
        <div class="net-hero-copy">
          <h1 id="net-hero-h">Verify once. Reuse everywhere.</h1>
          <p>A client verified by one distributor can buy through another without a second onboarding. The client consents, the issuing distributor keeps the records, classifications are read live, and either side can revoke.</p>
          <div class="net-hero-actions">
            <Btn kind="primary" onClick={focusImport}>Import a client by passport number</Btn>
            <Btn kind="primary" onClick={() => { setSharing(true); setTimeout(() => document.getElementById('net-share')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }}>Share a client's credential</Btn>
          </div>
        </div>
        <dl class="net-hero-nums" aria-label="Network numbers">
          <div><dt>Relied on</dt><dd>{net ? net.relied_on : metrics.error ? '0' : '…'}</dd><p>clients you serve on another distributor's credential</p></div>
          <div><dt>Shared out</dt><dd>{net ? net.shared_out : metrics.error ? '0' : '…'}</dd><p>of your credentials other distributors rely on</p></div>
          <div><dt>Pending</dt><dd>{net ? net.pending_shares : metrics.error ? '0' : '…'}</dd><p>shares waiting for the client to consent</p></div>
        </dl>
      </section>
      {msg ? <p class="note" role="status">{msg}</p> : null}
      {sharing ? <div id="net-share"><SharePicker onClose={() => setSharing(false)} /></div> : null}

      <div class="grid2" id="net-import">
        <Card title="Import a client by passport number">
          <form onSubmit={request}>
            <Field label="Network passport number" hint="Printed on the client's Laissez-passer, for example LZ-7K2M-9QX4-PA3D.">
              <input ref={importRef} class="mono" required value={f.lzid} onInput={(e) => set('lzid', (e.target as HTMLInputElement).value.toUpperCase())} placeholder="LZ-XXXX-XXXX-XXXX" autocomplete="off" spellcheck={false} />
            </Field>
            <Field label="Book the client in" hint="The booking center's licence rules apply to every order you place for this client.">
              <select value={f.booking_center} onChange={(e) => set('booking_center', (e.target as HTMLSelectElement).value)}>{Object.entries(BOOKING).map(([k, v]) => <option value={k}>{v}</option>)}</select>
            </Field>
            <Field label="Purpose, shown to the client"><input required minLength={3} maxLength={300} value={f.purpose} onInput={(e) => set('purpose', (e.target as HTMLInputElement).value)} /></Field>
            <div class="form-actions"><Btn type="submit" kind="primary" busy={busy}>Request consent</Btn></div>
          </form>
          <ErrorBox error={err} />
          {result ? (
            <div class="reveal" role="status" style={{ marginTop: '1rem' }}>
              <span class="f-l">Consent requested for {result.share.investor_name} from {result.share.issuing_org} {result.email_status === 'sent' ? <Chip tone="ok">Emailed to the client</Chip> : result.email_status === 'outbox' ? <Chip tone="info">In the outbox</Chip> : result.email_status === 'failed' ? <Chip tone="warn">Email failed</Chip> : null}</span>
              {result.consent_url ? (
                <>
                  <div class="reveal-row"><code class="break">{result.consent_url}</code><Copy text={result.consent_url} /></div>
                  <p class="small muted">{result.delivery}</p>
                  <div class="row-inline tight"><a class="b b-default" href={result.consent_url} target="_blank" rel="noopener">Open the consent page <span aria-hidden="true">↗</span></a></div>
                </>
              ) : <p class="small muted">{result.delivery} The client can also approve it from the inbox in their investor portal at the issuing distributor.</p>}
              <p class="small muted">The request expires in {result.consent_expires_in_days} days if the client does not answer.</p>
            </div>
          ) : null}
        </Card>

        <Card title="How reliance works">
          <ol class="plain small" style={{ paddingLeft: '1.1rem', listStyle: 'decimal' }}>
            <li>You ask to rely on a credential another distributor issued, by its passport number.</li>
            <li>The client sees exactly what is shared and approves or declines with a typed signature, by email link or from their investor portal at the issuing distributor.</li>
            <li>On approval the client appears in your client list. Classifications are read live from the issuing distributor, so a revocation or lapse there applies here at once.</li>
            <li>You still screen the client against sanctions lists yourself on every order.</li>
          </ol>
          <p class="small muted" style={{ marginTop: '0.8rem' }}>Reliance terms: the issuing distributor keeps the records and must provide them on request.</p>
        </Card>
      </div>

      {demoRows.length ? (
        <Card title={`Try it with ${demo.data.issuer}`} pad={false}>
          <p class="small muted" style={{ padding: '0 1.35rem' }}>{demo.data.note}</p>
          <div class="tw"><table class="t">
            <thead><tr><th>Client</th><th>Residence</th><th>Classifications</th><th>Passport number</th><th>Valid to</th><th /></tr></thead>
            <tbody>{demoRows.map((d) => (
              <tr>
                <td><strong>{d.name}</strong><div class="small muted">{d.kind}, {d.city}</div></td>
                <td>{JUR[d.residence] ?? d.residence}</td>
                <td class="small">{classList(d.classifications)}</td>
                <td><code>{d.lzid}</code></td>
                <td class="nowrap">{d.expires_on}</td>
                <td class="r">{d.share_status === 'active' ? <Chip tone="ok">Imported</Chip> : d.share_status === 'pending' ? <Chip tone="info">Requested</Chip> : <Btn kind="ghost" onClick={() => { setF({ ...f, lzid: d.lzid, booking_center: d.suggested_booking_center }); setResult(null); setErr(null); }}>Use this</Btn>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Card>
      ) : null}

      <Card title="Incoming: credentials you rely on" pad={false}>
        {shares.loading && !shares.data ? <div class="pad"><Loading /></div> : shares.error ? <div class="pad"><ErrorBox error={shares.error} onRetry={shares.reload} /></div> : !incoming.length ? (
          <div style={{ padding: '0 1.35rem 1rem' }}><Empty title="You rely on no other distributor's credentials yet">Import a client above to start.</Empty></div>
        ) : (
          <div class="tw"><table class="t">
            <thead><tr><th>Client</th><th>Issued by</th><th>Classifications</th><th>Booked in</th><th>Status</th><th>Consent</th><th /></tr></thead>
            <tbody>{incoming.map((s) => (
              <tr>
                <td>{s.to_investor_id && s.status === 'active' ? <a href={`#/clients/${s.to_investor_id}`}>{s.investor_name}</a> : s.investor_name}<div class="small muted mono">{s.lzid}</div></td>
                <td>{s.issuing_org}</td>
                <td class="small">{classList(s.classifications)}{s.credential_expires_on ? <div class="muted">Valid to {s.credential_expires_on}</div> : null}</td>
                <td>{BOOKING[s.booking_center] ?? s.booking_center ?? 'Not set'}</td>
                <td>{shareChip(s)}{s.revoked_reason ? <div class="small muted clamp">{s.revoked_reason}</div> : null}</td>
                <td class="small">{s.consent_at ? <>Signed by {s.consent_name}<div class="muted">{when(s.consent_at)}</div></> : s.status === 'pending' ? <span class="muted">Requested {when(s.created_at)}</span> : <span class="muted">None</span>}</td>
                <td class="r"><RevokeShare share={s} issuer={false} onDone={after} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      <Card title="Outgoing: your credentials others rely on" pad={false}>
        {shares.loading && !shares.data ? <div class="pad"><Loading /></div> : !outgoing.length ? (
          <div style={{ padding: '0 1.35rem 1rem' }}><Empty title="No other distributor relies on your credentials yet">When another distributor imports one of your clients and the client consents, it appears here.</Empty></div>
        ) : (
          <div class="tw"><table class="t">
            <thead><tr><th>Client</th><th>Relied on by</th><th>Purpose</th><th>Status</th><th>Consent</th><th /></tr></thead>
            <tbody>{outgoing.map((s) => (
              <tr>
                <td>{s.investor_name}<div class="small muted mono">{s.lzid}</div></td>
                <td>{s.receiving_org}{s.requested_by ? <div class="small muted">Requested by {s.requested_by}</div> : null}</td>
                <td class="small clamp">{s.purpose}</td>
                <td>{shareChip(s)}</td>
                <td class="small">{s.consent_at ? <>Signed by {s.consent_name}<div class="muted">{day(s.consent_at)}</div></> : <span class="muted">Not yet</span>}</td>
                <td class="r"><RevokeShare share={s} issuer onDone={after} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
