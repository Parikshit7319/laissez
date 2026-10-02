/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { AUTH_EVENT, day, hasCredential } from './api';
import { ErrorBox, Popover } from './ui';
import { RecoverySignIn } from './views/settings2';
import { AuthProvider, Gate, InviteScreen, NoAccess, ROLE_LABEL, ROLE_SHORT, SsoError, SsoExchange, useMe, type Role } from './auth';
import { isActive, matchRoute, navGroups } from './registry';
import { NotificationBell } from './views/notifications';
import { Search } from '../components/Search';
import { Checklist, markTeammateSwitched } from '../components/Checklist';
import '../styles/proto.css';
import '../styles/app.css';

const COLLAPSE_KEY = 'laissez-nav-collapsed';
const readCollapsed = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}'); } catch { return {}; } };
const writeCollapsed = (v: Record<string, boolean>) => { try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(v)); } catch { /* ignore */ } };
const inField = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable); };
/** Two-key shortcuts: g then a letter. */
const GO: Record<string, string> = { o: '/', n: '/orders/new', c: '/clients', d: '/decisions', s: '/settlements', f: '/funds', w: '/work', a: '/audit' };

type Route = { path: string; parts: string[]; query: URLSearchParams };
const parse = (): Route => {
  const h = (location.hash || '#/').slice(1);
  const [p, q] = h.split('?');
  return { path: p || '/', parts: (p || '/').split('/').filter(Boolean), query: new URLSearchParams(q ?? '') };
};

export default function App() {
  const [route, setRoute] = useState<Route>(parse);
  const [ready, setReady] = useState<boolean>(hasCredential);
  const [notice, setNotice] = useState<string | null>(null);
  const [session, setSessionN] = useState(0);
  useEffect(() => {
    const on = () => { setRoute(parse()); window.scrollTo(0, 0); };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    const on = () => { setReady(false); setNotice('Your session has ended. Sign in again, or open a new sandbox.'); };
    addEventListener(AUTH_EVENT, on);
    return () => removeEventListener(AUTH_EVENT, on);
  }, []);
  const onReady = () => { setNotice(null); setReady(true); setSessionN((n) => n + 1); };
  const [a, b] = route.parts;
  // Routes that work before, or instead of, the signed-in shell.
  if (a === 'invite' && b) return <InviteScreen token={b} signedIn={ready} onJoined={onReady} />;
  if (a === 'recover' && !ready) return <RecoverySignIn onReady={onReady} />;
  if (a === 'sso' && b) return <SsoExchange code={b} onReady={onReady} />;
  if (a === 'sso-error') return <SsoError message={(location.hash.split('/sso-error/')[1] ?? '').split('?')[0]} />;
  if (!ready) return <Gate onReady={onReady} notice={notice} />;
  return (
    <AuthProvider key={session} onSignedOut={() => { setNotice(null); setReady(false); location.hash = '#/'; }}>
      <Shell route={route} />
    </AuthProvider>
  );
}

function Shell({ route }: { route: Route }) {
  const { me, isSandbox, version, can } = useMe();
  const [menu, setMenu] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  const [help, setHelp] = useState(false);
  useEffect(() => setMenu(false), [route.path]);
  useEffect(() => { if (me?.acting_as) markTeammateSwitched(); }, [me?.acting_as?.id]);
  // Keyboard shortcuts: / focuses search (handled in Search), g then a letter navigates, ? lists them.
  useEffect(() => {
    let pending: number | null = null;
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || inField(e.target)) return;
      if (e.key === 'Escape') { setHelp(false); return; }
      if (e.key === '?') { e.preventDefault(); setHelp((h) => !h); return; }
      if (pending !== null) {
        clearTimeout(pending); pending = null;
        const to = GO[e.key.toLowerCase()];
        if (to) { e.preventDefault(); location.hash = '#' + to; }
        return;
      }
      if (e.key === 'g') { pending = window.setTimeout(() => { pending = null; }, 900); }
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, []);
  const m = matchRoute(route.path);
  const groups = navGroups();
  const ws = me!.workspace;
  const toggle = (g: string) => { const next = { ...collapsed, [g]: !collapsed[g] }; setCollapsed(next); writeCollapsed(next); };
  let page;
  if (!m) page = <div class="empty-state"><strong>That page does not exist.</strong><a href="#/">Go to the overview</a></div>;
  else if (m.entry.perm && !can(m.entry.perm)) page = <NoAccess perm={m.entry.perm} title={m.entry.label ?? 'This page'} />;
  else { const C = m.entry.component; page = <C params={m.params} query={route.query} />; }
  const showChecklist = route.path === '/' && isSandbox;
  return (
    <div class="shell">
      <a class="skip" href="#app-main" onClick={(e) => { e.preventDefault(); document.getElementById('app-main')?.focus(); }}>Skip to content</a>
      <aside id="app-side" class={`side ${menu ? 'open' : ''}`} aria-label="Sidebar">
        <div class="side-top">
          <a class="side-brand" href="../"><svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true"><defs><clipPath id="sb-a"><circle cx="12" cy="16" r="9.5" /></clipPath></defs><circle cx="20" cy="16" r="9.5" fill="#0f5c4a" clip-path="url(#sb-a)" /><circle cx="12" cy="16" r="9.5" fill="none" stroke="currentColor" stroke-width="1.5" /><circle cx="20" cy="16" r="9.5" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>Laissez</a>
          {isSandbox ? <span class="test-pill">Sandbox</span> : null}
          <button type="button" class="side-close" aria-label="Close menu" onClick={() => setMenu(false)}>×</button>
        </div>
        <Search groups={groups} onPick={() => setMenu(false)} />
        <nav aria-label="App">
          {groups.map((g) => {
            const open = !collapsed[g.group];
            const active = g.items.some((r) => isActive(r.pattern, route.path));
            const id = `nav-${g.group.toLowerCase().replace(/\s+/g, '-')}`;
            return (
              <div class={`nav-g ${open || active ? 'open' : ''}`}>
                <button type="button" class="nav-h" aria-expanded={open || active} aria-controls={id} onClick={() => toggle(g.group)}>
                  <span>{g.group}</span><i class="nav-caret" aria-hidden="true" />
                </button>
                <div id={id} class="nav-items" hidden={!(open || active)}>
                  {g.items.map((r) => <a href={`#${r.pattern}`} aria-current={isActive(r.pattern, route.path) ? 'page' : undefined}>{r.label}</a>)}
                </div>
              </div>
            );
          })}
        </nav>
        <div class="side-foot">
          <a class="side-help" href="../demo/"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.3-.8.6-.8 1.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /><circle cx="8" cy="11.6" r="0.8" fill="currentColor" /></svg>Help: guided demo</a>
          <button type="button" class="side-keys" onClick={() => setHelp(true)}>Keyboard shortcuts <kbd>?</kbd></button>
          <p><span class="side-org">{ws.name}</span><br /><span>{isSandbox ? `Sandbox, deleted ${ws.expires_at ? day(ws.expires_at) : 'after 7 days'}` : 'Organization'}</span></p>
          {isSandbox ? <p class="side-fine">Fictional institutions and simulated settlement. Thresholds and legal references are real.</p> : null}
        </div>
      </aside>
      {menu ? <button class="scrim" aria-label="Close menu" onClick={() => setMenu(false)} /> : null}
      <div class="main-col">
        <div class="topbar">
          <button class="menu" aria-expanded={menu} aria-controls="app-side" onClick={() => setMenu(!menu)}>Menu</button>
          <span class="crumb">{ws.name}{isSandbox ? <span class="crumb-k">Sandbox</span> : null}</span>
          <span class="grow" />
          {isSandbox && me!.user ? <TeammateSwitcher /> : null}
          <NotificationBell />
          <AccountMenu />
        </div>
        <ActingBanner />
        <main class="content" id="app-main" tabIndex={-1} key={version}>
          {showChecklist ? <Checklist workspaceId={ws.id} actingAs={!!me!.acting_as} canOrder={can('orders:write')} canPropose={can('funds:write')} /> : null}
          {page}
        </main>
      </div>
      {help ? <ShortcutsDialog onClose={() => setHelp(false)} /> : null}
    </div>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => { const el = document.getElementById('sc-close'); el?.focus(); }, []);
  const rows: [string, string][] = [['/', 'Search pages'], ['g then o', 'Overview'], ['g then n', 'New order'], ['g then c', 'Clients'], ['g then d', 'Decisions'], ['g then s', 'Settlements'], ['g then f', 'Funds'], ['g then w', 'Work queue'], ['g then a', 'Audit log'], ['?', 'This list'], ['Esc', 'Close menus']];
  return (
    <div class="sc-wrap" role="presentation" onClick={onClose}>
      <div class="sc" role="dialog" aria-modal="true" aria-labelledby="sc-h" onClick={(e) => e.stopPropagation()}>
        <div class="sc-head"><h2 id="sc-h">Keyboard shortcuts</h2><button id="sc-close" type="button" class="b b-ghost" onClick={onClose}>Close</button></div>
        <dl class="sc-list">{rows.map(([k, v]) => <div><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}</dl>
        <p class="small muted">Shortcuts do nothing while you are typing in a field. Open the search with / and press Enter to go to the first match.</p>
      </div>
    </div>
  );
}

const initials = (name = '') => name.replace(/\(.*?\)/g, '').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || 'Y';
const firstName = (name = '') => name.split(/\s+/)[0];

function TeammateSwitcher() {
  const { me, actAs } = useMe();
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const cur = me!.acting_as;
  const pick = async (id: string | null, close: () => void) => {
    setBusy(true); setErr(null);
    try { await actAs(id); close(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const label = cur ? `${cur.name}, ${ROLE_SHORT[cur.role] ?? cur.role}` : me!.user!.name;
  return (
    <Popover class="actas" ariaLabel={`Acting as ${label}. Change teammate`} label={<><span class="actas-l">Acting as</span><span class="actas-v">{label}</span><span class="caret" aria-hidden="true" /></>}>
      {(close) => (
        <div class="menu-body" role="group" aria-label="Acting as">
          <p class="menu-h">Acting as</p>
          <p class="menu-hint">Sandbox only. Switch teammate to try two-person approval.</p>
          <ul class="menu-list">
            <li><button type="button" aria-current={!cur ? 'true' : undefined} disabled={busy} onClick={() => pick(null, close)}><span>{me!.user!.name}</span><em>{ROLE_SHORT[(me!.organizations ?? []).find((o) => o.workspace_id === me!.workspace.id)?.role ?? 'admin']}</em></button></li>
            {(me!.teammates ?? []).map((t) => (
              <li><button type="button" aria-current={cur?.id === t.id ? 'true' : undefined} disabled={busy} onClick={() => pick(t.id, close)}><span>{t.name}</span><em>{ROLE_SHORT[t.role] ?? t.role}</em></button></li>
            ))}
          </ul>
          <ErrorBox error={err} />
        </div>
      )}
    </Popover>
  );
}

function ActingBanner() {
  const { me, actAs } = useMe();
  const [busy, setBusy] = useState(false);
  const a = me!.acting_as;
  if (!a) return null;
  return (
    <div class="acting" role="status">
      <span>You are acting as <strong>{a.name}</strong>, {ROLE_LABEL[a.role] ?? a.role}. The audit log records these actions under {firstName(a.name)}'s name.</span>
      <button class="acting-btn" disabled={busy} onClick={async () => { setBusy(true); try { await actAs(null); } finally { setBusy(false); } }}>Switch back to you</button>
    </div>
  );
}

function AccountMenu() {
  const { me, isSandbox, switchOrg, signOut } = useMe();
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const user = me!.user;
  const ws = me!.workspace;
  const orgs = me!.organizations ?? [];
  const ownRole = orgs.find((o) => o.workspace_id === ws.id)?.role as Role | undefined;
  const name = user?.name ?? me!.actor?.name ?? 'API key';
  const doSwitch = async (id: string, close: () => void) => {
    setBusy(id); setErr(null);
    try { await switchOrg(id); close(); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  return (
    <Popover class="acct" ariaLabel={`Account menu for ${name}`} label={<><span class="avatar" aria-hidden="true">{initials(name)}</span><span class="acct-n">{name}</span><span class="caret" aria-hidden="true" /></>}>
      {(close) => (
        <div class="menu-body">
          <div class="acct-head">
            <strong>{name}</strong>
            {user?.email && !user.email.endsWith('.sandbox') ? <span>{user.email}</span> : null}
            <span>{ownRole ? ROLE_LABEL[ownRole] : me!.role_label ?? 'API key access'} at {ws.name}</span>
          </div>
          {orgs.length > 1 ? (
            <div class="menu-sec">
              <p class="menu-h">Switch organization</p>
              <ul class="menu-list">
                {orgs.map((o) => (
                  <li><button type="button" aria-current={o.workspace_id === ws.id ? 'true' : undefined} disabled={!!busy || o.workspace_id === ws.id} onClick={() => doSwitch(o.workspace_id, close)}>
                    <span>{o.name}</span><em>{o.kind === 'sandbox' ? 'Sandbox' : ROLE_SHORT[o.role] ?? o.role}</em>
                  </button></li>
                ))}
              </ul>
            </div>
          ) : null}
          <div class="menu-sec">
            <a class="menu-a" href="#/settings/security" onClick={close}>Security settings</a>
            <button type="button" class="menu-a" onClick={() => { close(); signOut(); }}>{isSandbox ? 'Sign out of this sandbox' : 'Sign out'}</button>
          </div>
          {isSandbox ? <p class="menu-hint">Signing out forgets this sandbox in this browser. It is deleted when it expires.</p> : null}
          <ErrorBox error={err} />
        </div>
      )}
    </Popover>
  );
}
