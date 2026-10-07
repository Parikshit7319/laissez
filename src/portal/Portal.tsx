/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Credential } from '../proto/Credential';
import { classInfo, jurName, bookingCenters, type Investor } from '../proto/data';
import { TESTS, subjectOf } from '../proto/thresholds';
import { call, captureToken, forgetToken, PortalError, fmtMoney, fmtDate, fmtWhen, onColor } from './client';
import { CreateAccount, SignIn, AccountPage, getSession, setSession } from './Account';
import '../styles/proto.css';
import './portal.css';

const KEY = 'laissez-portal-token';
const BRAND_KEY = 'laissez-portal-brand';
/** Branding of the distributor operating the portal (GET /v1/brand/portal). Cached per tab so the next load paints without a flash. */
type Brand = { name: string; brand_color: string; logo_data_url: string | null; email_footer: string | null; support_email: string | null; support_phone: string | null; sandbox: boolean };
const cachedBrand = (): Brand | null => { try { return JSON.parse(sessionStorage.getItem(BRAND_KEY) ?? 'null'); } catch { return null; } };
const rememberBrand = (b: Brand) => { try { sessionStorage.setItem(BRAND_KEY, JSON.stringify(b)); } catch { /* storage blocked */ } };
function applyBrandToDocument(b: Brand) {
  try {
    document.title = `${b.name}: investor portal`;
    const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', b.brand_color);
    document.documentElement.style.setProperty('--brand', b.brand_color); document.documentElement.style.setProperty('--on-brand', onColor(b.brand_color));
  } catch { /* no document */ }
}
type Api = <T = any>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;
type Route = { name: 'overview' | 'fund' | 'requests' | 'evidence' | 'account'; arg?: string };

const parse = (): Route => {
  const p = (location.hash || '#/').slice(1).split('?')[0].split('/').filter(Boolean);
  if (p[0] === 'fund' && p[1]) return { name: 'fund', arg: decodeURIComponent(p[1]) };
  if (p[0] === 'requests') return { name: 'requests' };
  if (p[0] === 'evidence') return { name: 'evidence' };
  if (p[0] === 'account') return { name: 'account' };
  return { name: 'overview' };
};

function useLoad<T>(fn: (() => Promise<T>) | null, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<PortalError | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!fn) return;
    let live = true;
    fn().then((d) => { if (live) { setData(d); setError(null); } }).catch((e) => { if (live) setError(e); });
    return () => { live = false; };
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}

// ---------- Small pieces ----------
const Spinner = ({ label = 'Loading' }: { label?: string }) => <div class="pt-loading" aria-live="polite"><span class="pt-spin" aria-hidden="true" />{label}…</div>;
function Alert({ error }: { error: any }) {
  if (!error) return null;
  return (
    <div class="pt-alert err" role="alert">
      <strong>{error.message}</strong>
      {Array.isArray(error.detail) && error.detail.length ? <ul>{error.detail.map((d: any) => <li>{typeof d === 'string' ? d : d.message ?? JSON.stringify(d)}</li>)}</ul> : null}
    </div>
  );
}
const Chip = ({ tone = '', children }: { tone?: 'ok' | 'no' | 'warn' | 'info' | ''; children: ComponentChildren }) => <span class={`pt-chip ${tone}`}>{children}</span>;
const initials = (s: string) => s.replace(/\(.*?\)/g, '').split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const classLabel = (code: string, fallback?: string) => classInfo[code] ? `${jurName[classInfo[code].jur] ?? classInfo[code].jur}: ${classInfo[code].label}` : fallback ?? code;

function Gate({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div class="pt">
      <div class="pt-gate">
        <div class="pt-card">
          <p class="pt-small pt-muted" style={{ marginBottom: '0.4rem' }}>Investor portal</p>
          <h1>{title}</h1>
          {children}
        </div>
      </div>
      <Footer sandbox={false} />
    </div>
  );
}

function Footer({ sandbox, brand }: { sandbox: boolean; brand?: Brand | null }) {
  const contact = brand && (brand.support_email || brand.support_phone)
    ? <span class="pt-contact">Questions: {brand.support_email ? <a href={`mailto:${brand.support_email}`}>{brand.support_email}</a> : null}{brand.support_email && brand.support_phone ? ' or ' : ''}{brand.support_phone ? <a href={`tel:${brand.support_phone.replace(/[^+\d]/g, '')}`}>{brand.support_phone}</a> : null}</span>
    : null;
  return (
    <footer class="pt-foot">
      <div class="pt-wrap">
        <span>{sandbox ? 'Sandbox. The distributor, funds and people here are fictional.' : brand?.email_footer || `${brand?.name ?? 'Your distributor'} operates this portal.`}</span>
        {contact}
        <span class="pt-powered">Powered by <b>Laissez</b></span>
      </div>
    </footer>
  );
}

// ---------- App ----------
export default function Portal() {
  const [linkToken] = useState(() => captureToken('lz_inv_', KEY));
  const [session, setSessionState] = useState<string | null>(getSession);
  // A signed-in session wins over a link; a link alone works until the distributor requires accounts.
  const token = session ?? linkToken;
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const on = () => { setRoute(parse()); try { window.scrollTo(0, 0); } catch { /* no window */ } };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const api: Api = (path, opts = {}) => call(`/v1/portal${path}`, { ...opts, token });
  const me = useLoad<any>(token ? () => api('/me') : null, [token]);
  const funds = useLoad<any>(token ? () => api('/funds') : null, [token]);
  const [brandInfo, setBrandInfo] = useState<Brand | null>(cachedBrand);
  useEffect(() => {
    if (!token) return;
    call<Brand>('/v1/brand/portal', { token }).then((b) => { setBrandInfo(b); rememberBrand(b); applyBrandToDocument(b); }).catch(() => { /* the portal still works with the name and color from /me */ });
  }, [token]);
  const refresh = () => { me.reload(); funds.reload(); };

  const signedIn = (tok: string) => { setSessionState(tok); location.hash = '#/'; };
  if (!token) {
    return (
      <Gate title="Sign in to your portal">
        <SignIn onDone={signedIn} note="If you have created an account before, sign in with your passkey. Otherwise open the private link your distributor sent you; links work for 30 days." />
      </Gate>
    );
  }
  if (me.error && session && me.error.status === 401) {
    setSession(null);
    return (
      <Gate title="Your session ended">
        <SignIn onDone={signedIn} note="Sign in again with your passkey." />
      </Gate>
    );
  }
  if (me.error && (me.error.status === 401 || me.error.status === 404)) {
    return (
      <Gate title="This link no longer works">
        <p class="pt-muted">{me.error.message}</p>
        <p class="pt-small pt-muted">For your security, portal links expire after 30 days and can be withdrawn by your distributor at any time.</p>
        <button type="button" class="pt-btn" onClick={() => { forgetToken(KEY); location.reload(); }}>Forget this link on this device</button>
        <p class="pt-small pt-muted" style={{ marginTop: '1rem' }}>Created an account before?</p>
        <SignIn onDone={signedIn} />
      </Gate>
    );
  }
  // The link opened, but the account rules say the portal only opens to a signed-in account.
  if (me.data?.account?.via === 'link' && (me.data.account.required || me.data.account.exists)) {
    return me.data.account.exists ? (
      <Gate title="Sign in with your passkey">
        <SignIn onDone={signedIn} note={`You already have a portal account with ${me.data.distributor?.name ?? 'your distributor'}. Links no longer open the portal once an account exists.`} />
      </Gate>
    ) : (
      <Gate title="Create your portal account">
        <CreateAccount linkToken={linkToken!} distributor={me.data.distributor?.name} onDone={signedIn} />
      </Gate>
    );
  }

  const d = me.data?.distributor;
  const brand = brandInfo?.brand_color ?? d?.brand_color ?? '#1f3a33';
  const brandName = brandInfo?.name ?? d?.name;
  const logo = brandInfo?.logo_data_url ?? null;
  const nav: [Route['name'], string, string][] = [['overview', '#/', 'Overview'], ['requests', '#/requests', 'Requests'], ['evidence', '#/evidence', 'Evidence'], ['account', '#/account', session ? 'Account' : 'Secure my access']];
  const current = route.name === 'fund' ? 'overview' : route.name;
  const fund = route.name === 'fund' ? (funds.data?.data as any[] | undefined)?.find((f) => f.ticker === route.arg) : null;

  return (
    <div class="pt" style={{ '--brand': brand, '--on-brand': onColor(brand) } as any}>
      <header class="pt-bar">
        <div class="pt-wrap">
          <div class="pt-brand">{brandName ? <>{logo ? <img class="pt-logo" src={logo} alt="" /> : <span class="pt-mono" aria-hidden="true">{initials(brandName)}</span>}<b>{brandName}</b></> : <b>Investor portal</b>}</div>
          {me.data ? <span class="pt-who">{me.data.investor.name}</span> : null}
        </div>
      </header>
      <nav class="pt-nav" aria-label="Portal">
        <div class="pt-wrap">{nav.map(([k, href, label]) => <a href={href} aria-current={current === k ? 'page' : undefined}>{label}</a>)}</div>
      </nav>
      {d?.sandbox ? <div class="pt-sandbox"><div class="pt-wrap">Sandbox: you are seeing what a client sees. Everything here is fictional.</div></div> : null}
      <main class="pt-main" id="main">
        <div class="pt-wrap">
          {me.error ? <Alert error={me.error} /> : !me.data ? <Spinner /> : (
            route.name === 'account' ? (session
              ? <AccountPage token={session} onSignedOut={() => { setSessionState(null); location.hash = '#/'; location.reload(); }} />
              : <section class="pt-section"><h2>Secure my access</h2><div class="pt-card"><CreateAccount linkToken={linkToken!} distributor={d?.name} onDone={signedIn} /></div></section>)
              : route.name === 'requests' ? <Requests api={api} />
              : route.name === 'evidence' ? <Evidence me={me.data} api={api} onChange={refresh} />
                : route.name === 'fund' ? (funds.error ? <Alert error={funds.error} /> : !funds.data ? <Spinner /> : fund ? <FundDetail f={fund} me={me.data} api={api} onChange={refresh} /> : (
                  <div class="pt-empty"><strong>This fund is not offered to you.</strong><a href="#/">Back to your funds</a></div>
                ))
                  : <Overview me={me.data} funds={funds} api={api} onChange={refresh} />
          )}
        </div>
      </main>
      <Footer sandbox={!!d?.sandbox} brand={brandInfo} />
    </div>
  );
}

// ---------- Overview ----------
function credentialLine(inv: any): [tone: 'ok' | 'no' | 'warn' | 'info', chip: string, text: string] {
  switch (inv.credential_status) {
    case 'active': return ['ok', 'Credential active', `Valid until ${fmtDate(inv.expires)}. Issued by ${String(inv.issuer ?? '').replace(/\s*\(relied on under share [^)]*\)/, '')}.`];
    case 'partly_lapsed': return ['warn', 'Partly lapsed', 'One or more classifications have lapsed. Submit current figures on the Evidence tab.'];
    case 'lapsed': return ['no', 'Lapsed', `Your credential lapsed on ${fmtDate(inv.expires)}. Ask your relationship manager to renew it.`];
    case 'withdrawn': return ['no', 'No longer shared', 'The credential this distributor relied on is no longer shared with them. Ask them to verify you directly.'];
    default: return ['info', 'No credential yet', 'Your distributor has not issued your eligibility credential yet. You can submit figures on the Evidence tab.'];
  }
}
const canDrawCard = (inv: any) => !!inv.credentialId && !!jurName[inv.residence] && !!bookingCenters[inv.booking] && inv.classifications.every((c: any) => !!classInfo[c.code]);

function fundChip(f: any) {
  if (f.open_requests) return <Chip tone="info">Request under review</Chip>;
  if (!f.eligible) return <Chip>Not available yet</Chip>;
  if (f.documents_outstanding) return <Chip tone="info">Documents to read</Chip>;
  return <Chip tone="ok">Eligible</Chip>;
}

function Overview({ me, funds, api, onChange }: { me: any; funds: any; api: Api; onChange: () => void }) {
  const inv = me.investor;
  const [tone, chip, text] = credentialLine(inv);
  const list: any[] = funds.data?.data ?? [];
  return (
    <>
      <h1>Welcome, {inv.short}</h1>
      <p class="pt-lede">Your eligibility record with {me.distributor.name}: which funds you can subscribe to, and why.</p>
      {me.shares.some((s: any) => s.status === 'pending') ? <div class="pt-alert note" role="status"><strong>{me.shares.filter((s: any) => s.status === 'pending').length === 1 ? 'A distributor is asking' : `${me.shares.filter((s: any) => s.status === 'pending').length} distributors are asking`} to rely on your credential.</strong> Review the request at the bottom of this page; nothing is shared until you approve.</div> : null}

      <section class="pt-card" aria-labelledby="cred-h">
        <div class="pt-card-h"><h2 id="cred-h">Your Laissez-passer</h2><Chip tone={tone}>{chip}</Chip></div>
        <p class="pt-small pt-muted">{text}</p>
        {canDrawCard(inv) ? (
          <div class="pt-cred-wrap"><Credential inv={inv as Investor} compact /></div>
        ) : inv.classifications.length ? (
          <ul class="pt-checks">{inv.classifications.map((c: any) => <li class={c.lapsed ? 'fail' : 'pass'}><i aria-hidden="true">{c.lapsed ? '×' : '✓'}</i><div><strong>{classLabel(c.code, c.label)}</strong><p>Verified {fmtDate(c.verified)}, valid until {fmtDate(c.expires)}{c.optIn ? ', opt-in recorded' : ''}.</p></div></li>)}</ul>
        ) : null}
        {inv.lzid ? <p class="pt-small" style={{ marginTop: '0.9rem', marginBottom: 0 }}>Network passport number <b class="pt-mono-t">{inv.lzid}</b>. Give it to another distributor to skip repeating onboarding there. You approve every share.</p> : null}
      </section>

      {me.holdings.length ? (
        <section class="pt-section" aria-labelledby="hold-h">
          <h2 id="hold-h">Your holdings</h2>
          <div class="pt-card">
            <dl class="pt-dl">{me.holdings.map((h: any) => <div><dt>{h.ticker}</dt><dd>{h.units.toLocaleString('en-US')} units{h.value !== null ? <span class="pt-muted"> ({fmtMoney(h.value, h.currency)})</span> : null}<div class="pt-small pt-muted">{h.fund}, held since {fmtDate(h.since)}</div></dd></div>)}</dl>
          </div>
        </section>
      ) : null}

      <section class="pt-section" aria-labelledby="funds-h">
        <h2 id="funds-h">Funds offered to you</h2>
        {funds.error ? <Alert error={funds.error} /> : !funds.data ? <Spinner label="Checking your eligibility" /> : !list.length ? <div class="pt-card pt-empty"><strong>No funds are offered yet.</strong>Your distributor adds funds here as they become available.</div> : (
          <div class="pt-stack">
            {list.map((f) => (
              <a class="pt-card pt-fund" href={`#/fund/${encodeURIComponent(f.ticker)}`}>
                <div class="pt-card-h"><h2>{f.name}</h2>{fundChip(f)}</div>
                <p class="pt-small pt-muted" style={{ margin: 0 }}>{f.summary}</p>
                <div class="pt-meta"><span>Minimum {fmtMoney(f.min_subscription, f.currency)}</span><span>Settles in {f.assets.join(' or ')}</span>{f.holding_units ? <span>You hold {f.holding_units.toLocaleString('en-US')} units</span> : null}</div>
              </a>
            ))}
          </div>
        )}
      </section>

      {me.shares.length ? <Shares shares={me.shares} api={api} onChange={onChange} /> : null}
    </>
  );
}

/** A consent request from another distributor, decided here with a typed name. */
function PendingShare({ s, api, onDone }: { s: any; api: Api; onDone: () => void }) {
  const detail = useLoad<any>(() => api(`/shares/${encodeURIComponent(s.id)}`), [s.id]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  const decide = async (decision: 'approve' | 'decline') => {
    setBusy(decision); setErr(null);
    try { setDone(await api(`/shares/${encodeURIComponent(s.id)}/${decision}`, { body: { name } })); onDone(); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const d = detail.data;
  if (done) return <div class={`pt-alert ${done.status === 'active' ? 'ok' : 'note'}`} role="status"><strong>{done.status === 'active' ? 'Approved.' : 'Declined.'}</strong> {done.message}</div>;
  return (
    <div class="pt-card" style={{ borderColor: 'var(--brand)' }}>
      <div class="pt-card-h"><h3 style={{ margin: 0 }}>{s.organization} asks to rely on your credential</h3><Chip tone="info">Waiting for you</Chip></div>
      <p class="pt-small" style={{ margin: '0.3rem 0 0.6rem' }}>Purpose: {s.purpose}{s.requested_by ? <span class="pt-muted">. Requested by {s.requested_by} on {fmtDate(s.created_at)}.</span> : null}{s.expires_at ? <span class="pt-muted"> Expires {fmtDate(s.expires_at)}.</span> : null}</p>
      {detail.error ? <Alert error={detail.error} /> : !d ? <Spinner /> : (
        <div class="pt-small">
          <p style={{ margin: '0 0 0.4rem' }}><b>What {d.requester.name} receives:</b> {d.shared.join('; ')}.</p>
          <p style={{ margin: '0 0 0.4rem' }}><b>What stays with {d.issuer.name}:</b> {d.not_shared.join('; ')}.</p>
          <p style={{ margin: '0 0 0.4rem' }}><b>Classifications shared:</b> {d.classifications.length ? d.classifications.map((c: any) => `${c.jurisdiction_name ?? c.jurisdiction ?? ''}: ${c.label} (valid to ${fmtDate(c.expires_on)})`).join('; ') : 'KYC only'}.</p>
          <p class="pt-muted" style={{ margin: '0 0 0.6rem' }}>They book you in {d.requester.booking_center.name}. {d.terms?.reliance}</p>
        </div>
      )}
      <form class="pt-form" onSubmit={(e) => e.preventDefault()}>
        <label class="pt-f"><span>Sign with your full name</span><input class="pt-sign" required minLength={2} maxLength={120} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} autocomplete="name" placeholder="Full name" /></label>
        <Alert error={err} />
        <div class="pt-row">
          <button type="button" class="pt-btn primary" disabled={!!busy || name.trim().length < 2 || !d} onClick={() => decide('approve')}>{busy === 'approve' ? 'Approving' : `Approve and share with ${s.organization}`}</button>
          <button type="button" class="pt-btn ghost" disabled={!!busy || name.trim().length < 2} onClick={() => decide('decline')}>{busy === 'decline' ? 'Declining' : 'Decline'}</button>
        </div>
        <p class="pt-small pt-muted" style={{ margin: 0 }}>You can withdraw consent at any time from this page. Nothing is shared until you approve.</p>
      </form>
    </div>
  );
}

function Shares({ shares, api, onChange }: { shares: any[]; api: Api; onChange: () => void }) {
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const withdraw = async (id: string) => {
    setBusy(true); setErr(null);
    try { await api(`/consent/withdraw/${id}`, { body: {} }); setAsking(null); onChange(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const pending = shares.filter((s) => s.status === 'pending');
  const rest = shares.filter((s) => s.status !== 'pending');
  return (
    <section class="pt-section" aria-labelledby="shares-h">
      <h2 id="shares-h">Distributors relying on your credential</h2>
      {pending.length ? <div class="pt-stack" style={{ marginBottom: '0.9rem' }}>{pending.map((s) => <PendingShare s={s} api={api} onDone={onChange} />)}</div> : null}
      {rest.length ? (
        <div class="pt-card">
          {rest.map((s) => (
            <div class="pt-doc-row">
              <div class="pt-doc-t">
                <b>{s.organization}</b>
                <span class="pt-small pt-muted">{s.purpose}{s.consent_at ? `. ${s.status === 'declined' ? 'Declined' : 'Approved'} ${fmtDate(s.consent_at)}.` : ''}</span>
              </div>
              <div class="pt-row">
                {s.status === 'active' ? <Chip tone="ok">Active</Chip> : <Chip>{s.status === 'declined' ? 'Declined' : 'Ended'}</Chip>}
                {s.status === 'active' ? (asking === s.id ? (
                  <>
                    <button type="button" class="pt-btn danger" disabled={busy} onClick={() => withdraw(s.id)}>Confirm withdrawal</button>
                    <button type="button" class="pt-btn ghost" onClick={() => setAsking(null)}>Keep</button>
                  </>
                ) : <button type="button" class="pt-btn ghost" onClick={() => setAsking(s.id)}>Withdraw consent</button>) : null}
              </div>
            </div>
          ))}
          <Alert error={err} />
        </div>
      ) : null}
    </section>
  );
}

// ---------- Fund detail ----------
function FundDetail({ f, me, api, onChange }: { f: any; me: any; api: Api; onChange: () => void }) {
  const required = f.documents.filter((x: any) => x.required);
  const optional = f.documents.filter((x: any) => !x.required);
  const docsDone = f.documents_outstanding === 0;
  return (
    <>
      <a class="pt-back" href="#/"><span aria-hidden="true">←</span> All funds</a>
      <h1>{f.name}</h1>
      <p class="pt-lede">{f.structure}. Issued by {f.issuer}.</p>
      <div class="pt-card">
        <dl class="pt-dl">
          <div><dt>Domicile</dt><dd>{f.domicile}</dd></div>
          <div><dt>Price per unit</dt><dd>{fmtMoney(f.nav, f.currency)}</dd></div>
          <div><dt>Minimum</dt><dd>{fmtMoney(f.min_subscription, f.currency)}</dd></div>
          <div><dt>Pay with</dt><dd>{f.assets.join(' or ')}{f.chains?.length ? <span class="pt-muted"> on {f.chains.join(', ')}</span> : null}</dd></div>
          <div><dt>Dealing</dt><dd>{f.dealing_frequency === 'daily' ? 'Every business day' : f.dealing_frequency === 'monthly' ? 'Monthly' : 'Quarterly'}{f.cutoff ? <span class="pt-muted">, cut-off {f.cutoff}</span> : null}</dd></div>
          {f.lockup_months ? <div><dt>Lock-up</dt><dd>{f.lockup_months} months from each subscription</dd></div> : null}
          {f.yield_bps ? <div><dt>Current yield</dt><dd>{(f.yield_bps / 100).toFixed(2)}% a year</dd></div> : null}
          {f.holding_units ? <div><dt>You hold</dt><dd>{f.holding_units.toLocaleString('en-US')} units</dd></div> : null}
        </dl>
      </div>

      <section class="pt-section" aria-labelledby="elig-h">
        <h2 id="elig-h">Your eligibility</h2>
        <div class="pt-card">
          <div class="pt-card-h"><p style={{ margin: 0, fontWeight: 560 }}>{f.summary}</p>{f.eligible ? <Chip tone="ok">Eligible</Chip> : <Chip tone="no">Not yet</Chip>}</div>
          <ul class="pt-checks" style={{ marginTop: '0.8rem' }}>
            {f.reasons.map((r: any) => (
              <li class={r.result}>
                <i aria-hidden="true">{r.result === 'pass' ? '✓' : '×'}</i>
                <div>
                  <strong>{r.label}</strong>
                  <p>{r.detail}{r.rule ? <span class="pt-muted"> ({r.rule})</span> : null}</p>
                  {r.next_step ? <p class="pt-next">{r.next_step}</p> : null}
                </div>
              </li>
            ))}
          </ul>
          {f.binding_rules.length ? <p class="pt-small pt-muted" style={{ margin: '0.9rem 0 0' }}>The rule that decides it: {f.binding_rules.join(' and ')}.</p> : null}
        </div>
      </section>

      <section class="pt-section" aria-labelledby="sub-h">
        <h2 id="sub-h">Subscribe</h2>
        {f.open_requests ? <div class="pt-alert note">You already have a request for this fund under review. <a href="#/requests">See its status</a>.</div> : null}
        <ol class="pt-steps">
          <li class="pt-card">
            <div class="pt-step-h"><span class={`pt-step-n ${docsDone ? 'done' : ''}`} aria-hidden="true">{docsDone ? '✓' : '1'}</span><h3 style={{ margin: 0 }}>Read and acknowledge the fund documents</h3></div>
            {!required.length ? <p class="pt-small pt-muted" style={{ margin: 0 }}>No document needs your acknowledgment for this fund where you live.</p> : required.map((doc: any) => <DocRow doc={doc} api={api} onDone={onChange} />)}
            {optional.length ? <><p class="pt-small pt-muted" style={{ margin: '0.9rem 0 0.3rem' }}>Also available to read:</p>{optional.map((doc: any) => <DocRow doc={doc} api={api} onDone={onChange} />)}</> : null}
          </li>
          <li class="pt-card">
            <div class="pt-step-h"><span class="pt-step-n" aria-hidden="true">2</span><h3 style={{ margin: 0 }}>Sign your subscription request</h3></div>
            {!f.eligible ? <p class="pt-small pt-muted" style={{ margin: 0 }}>You can sign a request once you are eligible for this fund. The reasons above say what is missing.</p>
              : !docsDone ? <p class="pt-small pt-muted" style={{ margin: 0 }}>Acknowledge the {f.documents_outstanding === 1 ? 'document' : `${f.documents_outstanding} documents`} above first.</p>
                : <SubscribeForm f={f} me={me} api={api} onDone={onChange} />}
          </li>
        </ol>
      </section>

      {f.holding_units > 0 ? (
        <section class="pt-section" aria-labelledby="hold-act-h">
          <h2 id="hold-act-h">Your {f.holding_units.toLocaleString('en-US')} units</h2>
          <p class="pt-small pt-muted" style={{ margin: '0 0 0.8rem' }}>Worth about {fmtMoney(f.holding_units * f.nav, f.currency)} at today's price. You can always redeem; a transfer goes to another client of {me.distributor.name} and is checked for their eligibility first.</p>
          <div class="pt-stack">
            <div class="pt-card">
              <h3 style={{ margin: '0 0 0.6rem' }}>Redeem</h3>
              <HoldingForm action="redeem" f={f} me={me} api={api} onDone={onChange} />
            </div>
            <div class="pt-card">
              <h3 style={{ margin: '0 0 0.6rem' }}>Transfer to another client</h3>
              <HoldingForm action="transfer" f={f} me={me} api={api} onDone={onChange} />
            </div>
          </div>
        </section>
      ) : null}
    </>
  );
}

/** Redemption or transfer request against units the client already holds. */
function HoldingForm({ action, f, me, api, onDone }: { action: 'redeem' | 'transfer'; f: any; me: any; api: Api; onDone: () => void }) {
  const maxAmount = Math.floor(f.holding_units * f.nav * 100) / 100;
  const [amount, setAmount] = useState('');
  const [asset, setAsset] = useState(f.assets[0]);
  const [counterparty, setCounterparty] = useState('');
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  const n = Number(amount);
  const units = n > 0 && f.nav ? Math.round((n / f.nav) * 100) / 100 : 0;
  const ok = n > 0 && n <= maxAmount + 0.005 && agree && name.trim().length >= 2 && (action !== 'transfer' || counterparty.trim().length >= 2);
  const statement = action === 'redeem' ? 'I request this redemption of my units at the next dealing price.' : 'I request this transfer of my units to the named client.';
  const submit = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { setDone(await api('/requests', { body: { action, ticker: f.ticker, amount: n, asset, counterparty: action === 'transfer' ? counterparty.trim() : undefined, signed_name: name, agree } })); onDone(); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  if (done) {
    return (
      <div class="pt-alert ok" role="status">
        <strong>Request signed and sent.</strong>
        <p style={{ margin: '0.4rem 0' }}>{action === 'redeem' ? `Redeem ${fmtMoney(done.amount, f.currency)} of ${f.name}, paid out in ${done.asset}.` : `Transfer ${fmtMoney(done.amount, f.currency)} of ${f.name} to ${done.counterparty?.name ?? counterparty}.`} Signed by {done.signature.signed_name} on {fmtWhen(done.signature.signed_at)}.</p>
        <p class="pt-hash" style={{ margin: '0 0 0.4rem' }}>Request fingerprint {done.signature.payload_sha256}</p>
        <p style={{ margin: 0 }}>{done.note} <a href="#/requests">Track it under Requests</a>.</p>
      </div>
    );
  }
  return (
    <form class="pt-form" onSubmit={submit}>
      <label class="pt-f"><span>Amount</span>
        <span class="pt-prefix"><em aria-hidden="true">{f.currency}</em><input type="number" inputMode="decimal" required min={0.01} max={maxAmount} step="0.01" value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value)} /></span>
        <small>Up to {fmtMoney(maxAmount, f.currency)}. About {units.toLocaleString('en-US')} of your {f.holding_units.toLocaleString('en-US')} units at today's price of {fmtMoney(f.nav, f.currency)}.{f.lockup_months ? ` Units still in their ${f.lockup_months}-month lock-up cannot move yet.` : ''}</small>
        <button type="button" class="pt-btn ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setAmount(String(maxAmount))}>Everything</button>
      </label>
      {action === 'transfer' ? (
        <label class="pt-f"><span>Receiving client</span>
          <input required minLength={2} maxLength={160} value={counterparty} onInput={(e) => setCounterparty((e.target as HTMLInputElement).value)} placeholder="Passport number (LZ-XXXX-XXXX-XXXX) or exact legal name" autocomplete="off" />
          <small>Another client of {me.distributor.name}. Your distributor checks that they may hold this fund before anything moves.</small>
        </label>
      ) : null}
      <label class="pt-f"><span>{action === 'redeem' ? 'Paid out in' : 'Settled in'}</span>
        <select value={asset} onChange={(e) => setAsset((e.target as HTMLSelectElement).value)}>{f.assets.map((a: string) => <option value={a}>{a}</option>)}</select>
      </label>
      <label class="pt-f"><span>Sign with your full name</span>
        <input class="pt-sign" required minLength={2} maxLength={120} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} autocomplete="name" placeholder={me.investor.kind === 'Individual' ? me.investor.name : 'Name of the authorized signatory'} />
      </label>
      <label class="pt-agree"><input type="checkbox" checked={agree} onChange={(e) => setAgree((e.target as HTMLInputElement).checked)} required /><span>{statement}</span></label>
      <Alert error={err} />
      <button type="submit" class="pt-btn primary block" disabled={busy || !ok}>{busy ? 'Signing' : action === 'redeem' ? `Sign and send redemption request${n > 0 ? ` for ${fmtMoney(n, f.currency)}` : ''}` : `Sign and send transfer request${n > 0 ? ` for ${fmtMoney(n, f.currency)}` : ''}`}</button>
      <p class="pt-small pt-muted" style={{ margin: 0 }}>{action === 'redeem' ? 'Your distributor reviews the request, applies any notice period or gate, and runs the pre-trade checks before settlement.' : 'Your distributor reviews the request and checks the receiving client before settlement.'}</p>
    </form>
  );
}

function DocText({ text }: { text: string }) {
  const blocks = String(text ?? '').replace(/\r\n/g, '\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return <>{blocks.map((b) => /^#{1,6}\s/.test(b) ? <h4>{b.replace(/^#{1,6}\s*/, '')}</h4> : <p>{b.split('\n').map((l, i) => (i ? <><br />{l}</> : l))}</p>)}</>;
}

function DocRow({ doc, api, onDone }: { doc: any; api: Api; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<any>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  const toggle = async () => {
    const next = !open; setOpen(next); setErr(null);
    if (next && !content) { try { setContent(await api(`/documents/${encodeURIComponent(doc.id)}`)); } catch (e) { setErr(e); } }
  };
  const ack = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await api(`/documents/${encodeURIComponent(doc.id)}/acknowledge`, { body: { signed_name: name } }); setDone(r); setOpen(false); onDone(); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const acknowledged = done?.acknowledged_at ?? doc.acknowledged_at;
  return (
    <div>
      <div class="pt-doc-row">
        <div class="pt-doc-t">
          <b>{doc.title}</b>
          <span class="pt-small pt-muted">Version {doc.version}{doc.doc_type ? `, ${doc.doc_type.replace(/_/g, ' ')}` : ''}{acknowledged ? `. Acknowledged ${fmtDate(acknowledged)}${(done?.signed_name ?? doc.signed_name) ? ` by ${done?.signed_name ?? doc.signed_name}` : ''}.` : doc.outdated_ack ? '. A new version was published since you last acknowledged it.' : ''}</span>
        </div>
        <div class="pt-row">
          {acknowledged ? <Chip tone="ok">Acknowledged</Chip> : doc.required ? <Chip tone="info">To read</Chip> : null}
          <button type="button" class="pt-btn" aria-expanded={open} onClick={toggle}>{open ? 'Close' : acknowledged || !doc.required ? 'Read' : 'Read and acknowledge'}</button>
        </div>
      </div>
      {open ? (
        <div class="pt-reader">
          {!content && !err ? <div style={{ padding: '0 1.1rem' }}><Spinner /></div> : content ? (
            <>
              <div class="pt-reader-body" tabIndex={0} aria-label={`${doc.title}, version ${doc.version}`}><DocText text={content.content} /></div>
              <div class="pt-reader-foot">
                <span class="pt-hash">SHA-256 {content.sha256}</span>
                {doc.required && !acknowledged ? (
                  <form class="pt-form" onSubmit={ack}>
                    <label class="pt-f"><span>Type your full name to acknowledge you have read version {doc.version}</span>
                      <input class="pt-sign" required minLength={2} maxLength={120} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} autocomplete="name" placeholder="Full name" />
                    </label>
                    <button type="submit" class="pt-btn primary" disabled={busy || name.trim().length < 2}>{busy ? 'Recording' : 'I have read this document'}</button>
                  </form>
                ) : null}
              </div>
            </>
          ) : null}
          <div style={{ padding: err ? '0 1.1rem 0.5rem' : 0 }}><Alert error={err} /></div>
        </div>
      ) : null}
    </div>
  );
}

function SubscribeForm({ f, me, api, onDone }: { f: any; me: any; api: Api; onDone: () => void }) {
  const [amount, setAmount] = useState(String(f.min_subscription || ''));
  const [asset, setAsset] = useState(f.assets[0]);
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  const n = Number(amount);
  const units = n > 0 && f.nav ? Math.round((n / f.nav) * 100) / 100 : 0;
  const submit = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { setDone(await api('/requests', { body: { ticker: f.ticker, amount: n, asset, signed_name: name, agree } })); onDone(); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  if (done) {
    return (
      <div class="pt-alert ok" role="status">
        <strong>Request signed and sent.</strong>
        <p style={{ margin: '0.4rem 0' }}>{fmtMoney(done.amount, f.currency)} into {f.name}, paid in {done.asset}. Signed by {done.signature.signed_name} on {fmtWhen(done.signature.signed_at)}.</p>
        <p class="pt-hash" style={{ margin: '0 0 0.4rem' }}>Request fingerprint {done.signature.payload_sha256}</p>
        <p style={{ margin: 0 }}>{done.note} <a href="#/requests">Track it under Requests</a>.</p>
      </div>
    );
  }
  return (
    <form class="pt-form" onSubmit={submit}>
      <label class="pt-f"><span>Amount</span>
        <span class="pt-prefix"><em aria-hidden="true">{f.currency}</em><input type="number" inputMode="decimal" required min={f.min_subscription} step="0.01" value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value)} /></span>
        <small>Minimum {fmtMoney(f.min_subscription, f.currency)}. About {units.toLocaleString('en-US')} units at today's price of {fmtMoney(f.nav, f.currency)}.</small>
      </label>
      <label class="pt-f"><span>Pay with</span>
        <select value={asset} onChange={(e) => setAsset((e.target as HTMLSelectElement).value)}>{f.assets.map((a: string) => <option value={a}>{a}</option>)}</select>
      </label>
      <label class="pt-f"><span>Sign with your full name</span>
        <input class="pt-sign" required minLength={2} maxLength={120} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} autocomplete="name" placeholder={me.investor.kind === 'Individual' ? me.investor.name : 'Name of the authorized signatory'} />
        <small>Typing your name is your electronic signature. We record it with the time and the fingerprint of every document you acknowledged.</small>
      </label>
      <label class="pt-agree"><input type="checkbox" checked={agree} onChange={(e) => setAgree((e.target as HTMLInputElement).checked)} required /><span>I have read the documents and request this subscription.</span></label>
      <Alert error={err} />
      <button type="submit" class="pt-btn primary block" disabled={busy || !agree || name.trim().length < 2 || !(n >= f.min_subscription)}>{busy ? 'Signing' : `Sign and send request for ${n > 0 ? fmtMoney(n, f.currency) : 'this subscription'}`}</button>
      <p class="pt-small pt-muted" style={{ margin: 0 }}>Nothing is paid now. Your distributor reviews the request, runs the pre-trade checks and confirms before settlement.</p>
    </form>
  );
}

// ---------- Requests ----------
const ACTION_WORD: Record<string, string> = { subscribe: 'subscription', redeem: 'redemption', transfer: 'transfer' };
function requestStatus(r: any): [tone: 'ok' | 'no' | 'warn' | 'info' | '', chip: string, text: string] {
  const what = ACTION_WORD[r.action] ?? 'request';
  if (r.status === 'submitted') return ['info', 'Under review', 'Waiting for your distributor to review it.'];
  if (r.status === 'rejected') return ['no', 'Not accepted', r.note ?? 'Your distributor did not accept this request.'];
  if (r.settled) return ['ok', 'Settled', r.action === 'redeem' ? 'The redemption settled. The proceeds were paid out.' : r.action === 'transfer' ? `The transfer settled. The units moved to ${r.counterparty_name ?? 'the receiving client'}.` : 'The subscription settled. The units are in your holdings.'];
  if (r.outcome === 'ALLOW') return ['ok', 'Approved', 'Approved and cleared the pre-trade checks. Your distributor settles it next.'];
  if (r.outcome) return ['warn', 'Approved, then refused', `The pre-trade check refused it: ${r.headline}`];
  return ['ok', 'Approved', r.note ?? 'Approved by your distributor.'];
}

function Requests({ api }: { api: Api }) {
  const r = useLoad<any>(() => api('/requests'), []);
  const rows: any[] = r.data?.data ?? [];
  return (
    <>
      <h1>Your requests</h1>
      <p class="pt-lede">Every subscription, redemption and transfer you signed here, with its review status.</p>
      {r.error ? <Alert error={r.error} /> : !r.data ? <Spinner /> : !rows.length ? (
        <div class="pt-card pt-empty"><strong>No requests yet.</strong>Open a fund you are eligible for to sign a subscription, or a fund you hold to redeem or transfer. <a href="#/">See your funds</a>.</div>
      ) : (
        <div class="pt-stack">
          {rows.map((x) => {
            const [tone, chip, text] = requestStatus(x);
            return (
              <article class="pt-card">
                <div class="pt-card-h"><h2>{x.action === 'redeem' ? `Redeem ${fmtMoney(x.amount, x.currency ?? 'USD')} from ${x.fund ?? x.ticker}` : x.action === 'transfer' ? `Transfer ${fmtMoney(x.amount, x.currency ?? 'USD')} of ${x.fund ?? x.ticker} to ${x.counterparty_name ?? 'another client'}` : `${fmtMoney(x.amount, x.currency ?? 'USD')} into ${x.fund ?? x.ticker}`}</h2><Chip tone={tone}>{chip}</Chip></div>
                <p class="pt-small" style={{ margin: '0 0 0.5rem' }}>{text}</p>
                <p class="pt-small pt-muted" style={{ margin: 0 }}>{x.action === 'redeem' ? 'Paid out in' : x.action === 'transfer' ? 'Settled in' : 'Paid in'} {x.asset}. Signed by {x.signed_name} on {fmtWhen(x.created_at)}.{x.decided_at ? ` Reviewed ${fmtWhen(x.decided_at)}.` : ''}</p>
                <p class="pt-hash" style={{ margin: '0.4rem 0 0' }}>Fingerprint {x.payload_sha256}</p>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}

// ---------- Evidence ----------
function Evidence({ me, api, onChange }: { me: any; api: Api; onChange: () => void }) {
  const inv = me.investor;
  const subject = subjectOf(inv.kind);
  const tests = TESTS.filter((t) => t.subject === subject && classInfo[t.code]);
  const preferred = tests.find((t) => classInfo[t.code].jur === inv.residence) ?? tests.find((t) => t.code === bookingCenters[inv.booking]?.requires) ?? tests[0];
  const [code, setCode] = useState(preferred?.code ?? '');
  const [values, setValues] = useState<Record<string, number | boolean>>({});
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  const past = useLoad<any>(() => api('/evidence'), [done?.id]);
  const test = tests.find((t) => t.code === code);
  const filled = test ? test.fields.some((fd) => values[fd.key] !== undefined && values[fd.key] !== false) : false;
  const pre = test && filled ? test.check(values) : null;
  const choose = (c: string) => { setCode(c); setValues({}); setDone(null); setErr(null); };
  const submit = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { setDone(await api('/evidence', { body: { class_code: code, evidence: values, reference: reference || undefined } })); setValues({}); setReference(''); onChange(); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const rows: any[] = past.data?.data ?? [];
  return (
    <>
      <h1>Evidence</h1>
      <p class="pt-lede">Send current figures so your distributor can confirm or renew a classification. They check the figures against your documents before anything changes.</p>
      {!tests.length ? <div class="pt-card pt-empty"><strong>No classification takes figures from the portal for your account type.</strong>Ask your relationship manager.</div> : (
        <form class="pt-card pt-form" onSubmit={submit}>
          <label class="pt-f"><span>Classification</span>
            <select value={code} onChange={(e) => choose((e.target as HTMLSelectElement).value)}>{tests.map((t) => <option value={t.code}>{classLabel(t.code)}</option>)}</select>
            {classInfo[code] ? <small>{classInfo[code].threshold} ({classInfo[code].rule})</small> : null}
          </label>
          {test?.fields.map((fd) => fd.kind === 'bool' ? (
            <label class="pt-agree"><input type="checkbox" checked={!!values[fd.key]} onChange={(e) => setValues({ ...values, [fd.key]: (e.target as HTMLInputElement).checked })} /><span>{fd.label}</span></label>
          ) : (
            <label class="pt-f"><span>{fd.label}</span>
              <span class="pt-prefix"><em aria-hidden="true">{fd.unit ?? ''}</em><input type="number" inputMode="decimal" min={0} step="1" value={values[fd.key] === undefined ? '' : String(values[fd.key])} onInput={(e) => { const v = (e.target as HTMLInputElement).value; const next = { ...values }; if (v === '') delete next[fd.key]; else next[fd.key] = Number(v); setValues(next); }} /></span>
            </label>
          ))}
          <label class="pt-f"><span>Where these figures come from</span>
            <input value={reference} maxLength={300} onInput={(e) => setReference((e.target as HTMLInputElement).value)} placeholder="For example: audited accounts for FY2025" />
          </label>
          {pre ? <div class={`pt-alert ${pre.pass ? 'ok' : 'note'}`} style={{ margin: 0 }}>{pre.pass ? 'Based on these figures you meet the threshold. ' : 'Based on these figures you do not meet the threshold yet. '}{pre.reason}</div> : null}
          <Alert error={err} />
          {done ? <div class="pt-alert ok" role="status" style={{ margin: 0 }}><strong>Sent for review.</strong> {done.note}</div> : null}
          <button type="submit" class="pt-btn primary" disabled={busy || !filled}>{busy ? 'Sending' : 'Send to my distributor'}</button>
        </form>
      )}
      <section class="pt-section" aria-labelledby="ev-h">
        <h2 id="ev-h">Sent so far</h2>
        {past.error ? <Alert error={past.error} /> : !past.data ? <Spinner /> : !rows.length ? <p class="pt-small pt-muted">Nothing sent yet.</p> : (
          <div class="pt-card">
            {rows.map((x) => (
              <div class="pt-doc-row">
                <div class="pt-doc-t"><b>{classLabel(x.class_code, x.label)}</b><span class="pt-small pt-muted">Sent {fmtWhen(x.created_at)}{x.reference ? `. ${x.reference}` : ''}{x.reviewed_at ? `. Reviewed ${fmtDate(x.reviewed_at)}.` : ''}</span></div>
                {x.status === 'submitted' ? <Chip tone="info">Under review</Chip> : x.status === 'accepted' ? <Chip tone="ok">Accepted</Chip> : <Chip tone="no">Not accepted</Chip>}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
