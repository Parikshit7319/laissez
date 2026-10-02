/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { call, captureToken, fmtDate, fmtWhen, onColor } from './client';
import './portal.css';

const KEY = 'laissez-consent-token';

export default function Consent() {
  const [token] = useState(() => captureToken('lz_cns_', KEY));
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [actErr, setActErr] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [withdrawing, setWithdrawing] = useState(false);

  const load = () => {
    if (!token) return;
    call(`/v1/consent/${encodeURIComponent(token)}`).then((d) => { setData(d); setError(null); }).catch(setError);
  };
  useEffect(load, [token]);

  const decide = async (decision: 'approve' | 'decline') => {
    setBusy(decision); setActErr(null);
    try { setResult(await call(`/v1/consent/${encodeURIComponent(token!)}`, { body: { decision, name } })); load(); }
    catch (e) { setActErr(e); } finally { setBusy(null); }
  };
  const withdraw = async () => {
    setBusy('withdraw'); setActErr(null);
    try { setResult(await call(`/v1/consent/${encodeURIComponent(token!)}/withdraw`, { body: name.trim() ? { name } : {} })); setWithdrawing(false); load(); }
    catch (e) { setActErr(e); } finally { setBusy(null); }
  };

  const brand = data?.requester?.brand_color ?? '#1f3a33';
  return (
    <div class="pt" style={{ '--brand': brand, '--on-brand': onColor(brand) } as any}>
      <header class="pt-bar">
        <div class="pt-wrap">
          <div class="pt-brand"><span class="pt-mono" aria-hidden="true">Lz</span><b>Consent to share your credential</b></div>
        </div>
      </header>
      {data?.sandbox ? <div class="pt-sandbox"><div class="pt-wrap">Sandbox: you are acting as the client. The distributors and the client are fictional.</div></div> : null}
      <main class="pt-main" id="main">
        <div class="pt-wrap">
          {!token ? (
            <div class="pt-card"><h1>Open this page from your consent link</h1><p class="pt-muted" style={{ margin: 0 }}>A distributor asking to rely on your credential sends you a private link. Open that link to see the request.</p></div>
          ) : error ? (
            <div class="pt-card"><h1>This consent link does not work</h1><p class="pt-muted" style={{ margin: 0 }}>{error.message}</p></div>
          ) : !data ? (
            <div class="pt-loading" aria-live="polite"><span class="pt-spin" aria-hidden="true" />Loading the request…</div>
          ) : (
            <Request data={data} name={name} setName={setName} busy={busy} actErr={actErr} result={result}
              onDecide={decide} withdrawing={withdrawing} setWithdrawing={setWithdrawing} onWithdraw={withdraw} />
          )}
        </div>
      </main>
      <footer class="pt-foot"><div class="pt-wrap"><span>Laissez records your answer in both distributors' audit logs.</span><span class="pt-powered">Powered by <b>Laissez</b></span></div></footer>
    </div>
  );
}

function Request(p: { data: any; name: string; setName: (s: string) => void; busy: string | null; actErr: any; result: any; onDecide: (d: 'approve' | 'decline') => void; withdrawing: boolean; setWithdrawing: (b: boolean) => void; onWithdraw: () => void }) {
  const { data: d } = p;
  const s = d.share;
  const who = d.requester.name;
  return (
    <>
      <p class="pt-small pt-muted" style={{ marginBottom: '0.4rem' }}>Request from {who}</p>
      <h1>{who} asks to rely on your credential from {d.issuer.name}</h1>
      <p class="pt-lede">If you approve, {who} can accept your verified status instead of asking you to repeat onboarding. {d.issuer.name} keeps your records. You can withdraw at any time.</p>

      {p.result ? <div class={`pt-alert ${p.result.status === 'active' ? 'ok' : 'note'}`} role="status"><strong>{p.result.status === 'active' ? 'Approved.' : p.result.status === 'declined' ? 'Declined.' : 'Consent withdrawn.'}</strong> {p.result.message}</div> : null}

      <div class="pt-card">
        <dl class="pt-dl">
          <div><dt>Client</dt><dd>{d.investor.name}<div class="pt-small pt-muted">{d.investor.kind}, {d.investor.city}, {d.investor.residence_name}</div></dd></div>
          <div><dt>Asking</dt><dd>{who}{d.requester.requested_by ? <div class="pt-small pt-muted">Requested by {d.requester.requested_by}</div> : null}</dd></div>
          <div><dt>Purpose</dt><dd>{s.purpose}</dd></div>
          <div><dt>Booked in</dt><dd>{d.requester.booking_center.name}{d.requester.booking_center.licence ? <div class="pt-small pt-muted">{d.requester.booking_center.licence}</div> : null}</dd></div>
          <div><dt>Credential</dt><dd><span class="pt-mono-t">{d.credential.lzid}</span><div class="pt-small pt-muted">Issued by {d.issuer.name}, valid until {fmtDate(d.credential.expires_on)}</div></dd></div>
        </dl>
      </div>

      <section class="pt-section" aria-labelledby="sh-h">
        <h2 id="sh-h">What is shared</h2>
        <div class="pt-card">
          <h3>Your classifications</h3>
          {d.classifications.length ? d.classifications.map((c: any) => (
            <div class="cs-class">
              <span><b style={{ fontWeight: 560 }}>{c.jurisdiction_name ? `${c.jurisdiction_name}: ` : ''}{c.label}</b>{c.opt_in ? <span class="pt-muted"> (opt-in recorded)</span> : null}<div class="pt-small pt-muted">{c.rule}</div></span>
              <span class="pt-small pt-muted" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>Valid until<br />{fmtDate(c.expires_on)}</span>
            </div>
          )) : <p class="pt-small pt-muted">No investor classifications. Only your verified identity details are shared.</p>}
          <div class="cs-two" style={{ marginTop: '1rem' }}>
            <div><h3>Shared</h3><ul class="cs-list">{d.shared.map((x: string) => <li>{x}</li>)}</ul></div>
            <div><h3>Not shared</h3><ul class="cs-list">{d.not_shared.map((x: string) => <li>{x}</li>)}</ul></div>
          </div>
        </div>
      </section>

      <section class="pt-section" aria-labelledby="terms-h">
        <h2 id="terms-h">Terms</h2>
        <div class="cs-terms">
          <p style={{ margin: '0 0 0.5rem' }}>{d.terms?.reliance}</p>
          {d.terms?.expires_with_credential ? <p style={{ margin: 0 }}>The share ends automatically when your credential expires{d.terms.credential_expires_on ? ` on ${fmtDate(d.terms.credential_expires_on)}` : ''}, or when you, {d.issuer.name} or {who} ends it.</p> : null}
        </div>
      </section>

      <section class="pt-section" aria-labelledby="ans-h">
        <h2 id="ans-h">Your answer</h2>
        <div class="pt-card">
          {s.status === 'pending' ? (
            <form class="pt-form" onSubmit={(e) => { e.preventDefault(); p.onDecide('approve'); }}>
              <label class="pt-f"><span>Type your full name to sign</span>
                <input class="pt-sign" required minLength={2} maxLength={120} value={p.name} onInput={(e) => p.setName((e.target as HTMLInputElement).value)} autocomplete="name" placeholder={d.investor.kind === 'Individual' ? d.investor.name : 'Name of the authorized signatory'} />
                <small>Your typed name and the time are recorded with your answer.</small>
              </label>
              <div class="cs-actions">
                <button type="button" class="pt-btn" disabled={!!p.busy || p.name.trim().length < 2} onClick={() => p.onDecide('decline')}>{p.busy === 'decline' ? 'Declining' : 'Decline'}</button>
                <button type="submit" class="pt-btn primary" disabled={!!p.busy || p.name.trim().length < 2}>{p.busy === 'approve' ? 'Approving' : 'Approve'}</button>
              </div>
              <p class="pt-small pt-muted" style={{ margin: 0 }}>This request expires on {fmtDate(s.expires_at)} if you do not answer.</p>
            </form>
          ) : s.status === 'active' ? (
            <>
              <p style={{ marginBottom: '0.6rem' }}><b style={{ fontWeight: 560 }}>You approved this share</b>{s.consent_name ? ` as ${s.consent_name}` : ''}{s.consent_at ? ` on ${fmtWhen(s.consent_at)}` : ''}. {who} can rely on your credential.</p>
              {!p.withdrawing ? <button type="button" class="pt-btn danger" onClick={() => p.setWithdrawing(true)}>Withdraw consent</button> : (
                <div class="pt-form">
                  <p class="pt-small" style={{ margin: 0 }}>{who} will no longer be able to rely on your credential. Any holdings stay yours and can be redeemed.</p>
                  <div class="cs-actions">
                    <button type="button" class="pt-btn" onClick={() => p.setWithdrawing(false)}>Keep sharing</button>
                    <button type="button" class="pt-btn danger" disabled={!!p.busy} onClick={p.onWithdraw}>{p.busy === 'withdraw' ? 'Withdrawing' : 'Withdraw now'}</button>
                  </div>
                </div>
              )}
            </>
          ) : s.status === 'declined' ? (
            <p style={{ margin: 0 }}>You declined this request{s.consent_name ? ` as ${s.consent_name}` : ''}{s.consent_at ? ` on ${fmtWhen(s.consent_at)}` : ''}. Nothing was shared.</p>
          ) : s.status === 'expired' ? (
            <p style={{ margin: 0 }}>This request expired without an answer. Nothing was shared. {who} can send a new request.</p>
          ) : (
            <p style={{ margin: 0 }}>This share has ended{s.revoked_at ? ` (${fmtDate(s.revoked_at)})` : ''}. {s.revoked_reason ?? ''}</p>
          )}
          {p.actErr ? <div class="pt-alert err" role="alert"><strong>{p.actErr.message}</strong>{Array.isArray(p.actErr.detail) ? <ul>{p.actErr.detail.map((x: any) => <li>{String(x)}</li>)}</ul> : null}</div> : null}
        </div>
      </section>
    </>
  );
}
