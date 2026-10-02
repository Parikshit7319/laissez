/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { api, getKey, setKey, when } from './api';
import { Btn, ErrorBox, Field } from './ui';
import { Overview, Clients, ClientDetail, IssueCredential, NewOrder, DecisionDetail, Decisions, Settlements, Bulk } from './views/distributor';
import { Funds, FundDetail, PolicyChanges, CreateFund } from './views/issuer';
import { RuleLibrary, Screening, RuleDrafts, AuditLog, ReceiptChecker } from './views/compliance';
import { Explorer, Webhooks, Keys } from './views/developers';
import '../styles/proto.css';
import '../styles/app.css';

type Route = { path: string; parts: string[]; params: URLSearchParams };
const parse = (): Route => {
  const h = (location.hash || '#/').slice(1);
  const [p, q] = h.split('?');
  return { path: p || '/', parts: (p || '/').split('/').filter(Boolean), params: new URLSearchParams(q ?? '') };
};

const NAV: { group: string; items: [string, string][] }[] = [
  { group: 'Distributor', items: [['/', 'Overview'], ['/clients', 'Clients'], ['/orders/new', 'New order'], ['/decisions', 'Decisions'], ['/settlements', 'Settlements'], ['/bulk', 'Bulk check']] },
  { group: 'Issuer', items: [['/funds', 'Funds'], ['/policy-changes', 'Policy changes']] },
  { group: 'Compliance', items: [['/rules', 'Rule library'], ['/screening', 'Screening'], ['/drafts', 'Change agent'], ['/audit', 'Audit log'], ['/receipts', 'Receipt checker']] },
  { group: 'Developers', items: [['/explorer', 'API explorer'], ['/webhooks', 'Webhooks'], ['/keys', 'Sandbox and keys']] },
];

function view(r: Route) {
  const [a, b, c] = r.parts;
  if (!a) return <Overview />;
  if (a === 'clients' && b && c === 'credential') return <IssueCredential id={b} />;
  if (a === 'clients' && b) return <ClientDetail id={b} />;
  if (a === 'clients') return <Clients />;
  if (a === 'orders') return <NewOrder params={r.params} />;
  if (a === 'decisions' && b) return <DecisionDetail id={b} />;
  if (a === 'decisions') return <Decisions />;
  if (a === 'settlements') return <Settlements />;
  if (a === 'bulk') return <Bulk />;
  if (a === 'funds' && b === 'new') return <CreateFund />;
  if (a === 'funds' && b) return <FundDetail ticker={b} />;
  if (a === 'funds') return <Funds />;
  if (a === 'policy-changes') return <PolicyChanges />;
  if (a === 'rules') return <RuleLibrary />;
  if (a === 'screening') return <Screening />;
  if (a === 'drafts') return <RuleDrafts />;
  if (a === 'audit') return <AuditLog />;
  if (a === 'receipts') return <ReceiptChecker />;
  if (a === 'explorer') return <Explorer />;
  if (a === 'webhooks') return <Webhooks />;
  if (a === 'keys') return <Keys />;
  return <div class="empty-state"><strong>That page does not exist.</strong><a href="#/">Go to the overview</a></div>;
}

function Gate({ onReady }: { onReady: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [existing, setExisting] = useState('');
  const open = async () => {
    setBusy(true); setErr(null);
    try { const r = await api('/v1/sandboxes', { body: {}, auth: false }); setKey(r.api_key, r.workspace); onReady(); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const useExisting = async (e: Event) => {
    e.preventDefault(); setErr(null);
    setKey(existing.trim());
    try { await api('/v1/workspace'); onReady(); } catch (x) { setKey(null); setErr(x); }
  };
  return (
    <div class="gate">
      <div class="gate-card">
        <a class="gate-brand" href="../">Laissez</a>
        <h1>Open a sandbox</h1>
        <p>You get a private copy of Laissez filled with fictional clients, funds and holdings: a Singapore family office, a Swiss pension fund, a Dubai holding company and more. Issue credentials, place orders, settle trades and change fund policies. Everything is saved to a real database.</p>
        <ul>
          <li>No sign-up. No personal data.</li>
          <li>The sandbox and its key live for 7 days, then they are deleted.</li>
          <li>Accounts and team access come in a later release.</li>
        </ul>
        <Btn kind="primary" onClick={open} disabled={busy}>{busy ? 'Opening your sandbox' : 'Open a sandbox'}</Btn>
        <ErrorBox error={err} />
        <details class="gate-more">
          <summary>I already have a sandbox key</summary>
          <form class="row-inline" onSubmit={useExisting}><Field label="Sandbox key"><input value={existing} onInput={(e) => setExisting((e.target as HTMLInputElement).value)} placeholder="lz_test_..." /></Field><Btn type="submit">Use key</Btn></form>
        </details>
      </div>
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState<Route>(parse);
  const [ready, setReady] = useState<boolean>(() => !!getKey());
  const [ws, setWs] = useState<any>(null);
  const [menu, setMenu] = useState(false);
  useEffect(() => { const on = () => { setRoute(parse()); setMenu(false); window.scrollTo(0, 0); }; addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  useEffect(() => {
    if (!ready) return;
    api('/v1/workspace').then(setWs).catch((e) => { if (e.status === 401) { setKey(null); setReady(false); } });
  }, [ready]);
  if (!ready) return <Gate onReady={() => setReady(true)} />;
  const active = (p: string) => (p === '/' ? route.path === '/' : route.path.startsWith(p));
  return (
    <div class="shell">
      <aside class={`side ${menu ? 'open' : ''}`}>
        <div class="side-top"><a class="side-brand" href="../">Laissez</a><span class="test-pill">Test mode</span></div>
        <nav aria-label="App">{NAV.map((g) => <div class="nav-g"><span class="nav-h">{g.group}</span>{g.items.map(([p, l]) => <a href={`#${p}`} aria-current={active(p) ? 'page' : undefined}>{l}</a>)}</div>)}</nav>
        <div class="side-foot">
          {ws ? <p>{ws.name}<br /><span>Expires {when(ws.expires_at)}</span></p> : null}
          <button class="link" onClick={() => { if (confirmLeave()) { setKey(null); setReady(false); location.hash = '#/'; } }}>Leave sandbox</button>
        </div>
      </aside>
      <div class="main-col">
        <div class="topbar"><button class="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>Menu</button><span class="banner">Sandbox: fictional institutions and simulated settlement. Thresholds and legal references are real.</span></div>
        <main class="content" id="app-main">{view(route)}</main>
      </div>
    </div>
  );
}
// window.confirm is unavailable in some embedded viewers; leaving is reversible with the key, so default to true there.
function confirmLeave() { try { return window.confirm('Leave this sandbox? Keep your key if you want to come back.'); } catch { return true; } }
