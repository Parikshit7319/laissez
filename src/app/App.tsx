/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { AUTH_EVENT, day, hasCredential } from './api';
import { ErrorBox, Popover } from './ui';
import { AuthProvider, Gate, InviteScreen, NoAccess, ROLE_LABEL, ROLE_SHORT, SsoError, SsoExchange, useMe, type Role } from './auth';
import { isActive, matchRoute, navGroups } from './registry';
import '../styles/proto.css';
import '../styles/app.css';

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
  useEffect(() => setMenu(false), [route.path]);
  const m = matchRoute(route.path);
  const groups = navGroups();
  const ws = me!.workspace;
  let page;
  if (!m) page = <div class="empty-state"><strong>That page does not exist.</strong><a href="#/">Go to the overview</a></div>;
  else if (m.entry.perm && !can(m.entry.perm)) page = <NoAccess perm={m.entry.perm} title={m.entry.label ?? 'This page'} />;
  else { const C = m.entry.component; page = <C params={m.params} query={route.query} />; }
  return (
    <div class="shell">
      <a class="skip" href="#app-main" onClick={(e) => { e.preventDefault(); document.getElementById('app-main')?.focus(); }}>Skip to content</a>
      <aside class={`side ${menu ? 'open' : ''}`} aria-label="Sidebar">
        <div class="side-top"><a class="side-brand" href="../">Laissez</a><span class="test-pill">Test mode</span></div>
        <nav aria-label="App">
          {groups.map((g) => (
            <div class="nav-g">
              <span class="nav-h">{g.group}</span>
              {g.items.map((r) => <a href={`#${r.pattern}`} aria-current={isActive(r.pattern, route.path) ? 'page' : undefined}>{r.label}</a>)}
            </div>
          ))}
        </nav>
        <div class="side-foot">
          <p><span class="side-org">{ws.name}</span><br /><span>{isSandbox ? `Sandbox, deleted ${ws.expires_at ? day(ws.expires_at) : 'after 7 days'}` : 'Organization'}</span></p>
          {isSandbox ? <p class="side-fine">Fictional institutions and simulated settlement. Thresholds and legal references are real.</p> : null}
        </div>
      </aside>
      {menu ? <button class="scrim" aria-label="Close menu" onClick={() => setMenu(false)} /> : null}
      <div class="main-col">
        <div class="topbar">
          <button class="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>Menu</button>
          <span class="crumb">{ws.name}{isSandbox ? <span class="crumb-k">Sandbox</span> : null}</span>
          <span class="grow" />
          {isSandbox && me!.user ? <TeammateSwitcher /> : null}
          <AccountMenu />
        </div>
        <ActingBanner />
        <main class="content" id="app-main" tabIndex={-1} key={version}>{page}</main>
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
