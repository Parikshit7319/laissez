/** @jsxImportSource preact */
import { createContext } from 'preact';
import type { ComponentChildren } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { api, API_BASE, ApiError, adoptSession, clearCredentials, getSession, setKey, setSession, track } from './api';
import { Btn, ErrorBox, Field, Loading } from './ui';
import { createPasskey, getPasskey } from './webauthn';

// ---------- Roles and permissions (mirrors api/src/http.ts) ----------
export type Role = 'admin' | 'ops' | 'compliance' | 'legal' | 'issuer' | 'developer' | 'auditor';
export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrator', ops: 'Operations analyst', compliance: 'Compliance officer', legal: 'Legal reviewer', issuer: 'Issuer admin', developer: 'Developer', auditor: 'Auditor (read-only)',
};
/** Short labels for the sandbox teammate switcher. */
export const ROLE_SHORT: Record<Role, string> = { admin: 'Administrator', ops: 'Operations', compliance: 'Compliance', legal: 'Legal', issuer: 'Issuer admin', developer: 'Developer', auditor: 'Auditor' };
const ROLE_PERMS: Record<Role, string[]> = {
  admin: ['*'],
  ops: ['read', 'clients:write', 'orders:write', 'work:write'],
  compliance: ['read', 'clients:write', 'compliance:write', 'policy:approve', 'work:write', 'audit:export', 'rules:write', 'rules:approve'],
  legal: ['read', 'compliance:write', 'rules:approve'],
  issuer: ['read', 'funds:write', 'policy:approve'],
  developer: ['read', 'developer', 'keys:admin'],
  auditor: ['read', 'audit:export'],
};
const SCOPE_PERMS: Record<string, string[]> = {
  read: ['read', 'audit:export'], orders: ['orders:write'], clients: ['clients:write'], funds: ['funds:write'],
  compliance: ['compliance:write', 'work:write', 'rules:write'], developer: ['developer'], admin: ['keys:admin'],
};
const HUMAN_ONLY = new Set(['policy:approve', 'members:admin', 'rules:approve']);
export const PERM_TEXT: Record<string, string> = {
  'read': 'read this organization', 'clients:write': 'manage clients and credentials', 'orders:write': 'place orders or settle',
  'funds:write': 'change funds or propose policy changes', 'policy:approve': 'approve policy changes', 'compliance:write': 'make compliance decisions',
  'work:write': 'resolve work items', 'developer': 'manage webhooks', 'keys:admin': 'manage API keys', 'members:admin': 'manage members, single sign-on and branding', 'audit:export': 'export the audit log',
  'rules:write': 'author or edit custom rules', 'rules:approve': 'approve custom rules',
};

export type Me = {
  user?: { id: string; email: string; name: string; title?: string | null; fictional?: boolean };
  actor?: { kind: string; name: string; scopes?: string[] };
  acting_as?: { id: string; name: string; role: Role } | null;
  role?: Role; role_label?: string;
  workspace: { id: string; name: string; kind: 'sandbox' | 'org'; slug: string; brand_name?: string; brand_color?: string; expires_at?: string | null; sso_enabled?: boolean };
  organizations?: { workspace_id: string; name: string; kind: string; role: Role }[];
  teammates?: { id: string; name: string; title?: string; role: Role }[];
};

export function canDo(me: Me | null, perm: string): boolean {
  if (!me) return false;
  if (me.user && me.role) {
    const p = ROLE_PERMS[me.role] ?? [];
    return p.includes('*') || p.includes(perm);
  }
  if (me.actor?.kind === 'key') {
    if (HUMAN_ONLY.has(perm)) return false;
    return (me.actor.scopes ?? []).some((s) => SCOPE_PERMS[s]?.includes(perm));
  }
  return false;
}
export function whyNot(me: Me | null, perm: string): string {
  const what = PERM_TEXT[perm] ?? perm;
  if (!me) return `Sign in to ${what}.`;
  if (me.actor?.kind === 'key') return HUMAN_ONLY.has(perm) ? `Only a signed-in person can ${what}. Sign in with a passkey or single sign-on.` : `This API key cannot ${what}. Use a key with the right scope.`;
  const label = me.role ? ROLE_LABEL[me.role] : 'none';
  return `Your role, ${label}, cannot ${what}.${me.acting_as ? '' : ' Ask an administrator to change your role.'}`;
}

// ---------- Context ----------
type AuthState = {
  me: Me | null;
  isSandbox: boolean;
  /** The user id actions are recorded under: the teammate when acting as one, else you. */
  actorId: string | null;
  version: number;
  can: (perm: string) => boolean;
  why: (perm: string) => string;
  reload: () => Promise<void>;
  actAs: (userId: string | null) => Promise<void>;
  switchOrg: (workspaceId: string) => Promise<void>;
  signOut: () => Promise<void>;
};
const AuthCtx = createContext<AuthState>({
  me: null, isSandbox: false, actorId: null, version: 0, can: () => false, why: () => '',
  reload: async () => {}, actAs: async () => {}, switchOrg: async () => {}, signOut: async () => {},
});
export const useMe = () => useContext(AuthCtx);

export function AuthProvider({ children, onSignedOut }: { children: ComponentChildren; onSignedOut: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [version, setVersion] = useState(0);
  const load = async () => {
    try { setMe(await api<Me>('/v1/me')); setErr(null); }
    catch (e: any) { if (e.status !== 401) setErr(e); }
  };
  useEffect(() => { load(); }, []);
  const bump = () => setVersion((v) => v + 1);
  const state: AuthState = {
    me, version,
    isSandbox: me?.workspace?.kind === 'sandbox',
    actorId: me?.acting_as?.id ?? me?.user?.id ?? null,
    can: (p) => canDo(me, p),
    why: (p) => whyNot(me, p),
    reload: load,
    actAs: async (userId) => { await api('/v1/session/act-as', { body: { user_id: userId } }); await load(); bump(); },
    switchOrg: async (workspaceId) => { const r = await api('/v1/session/switch', { body: { workspace_id: workspaceId } }); setSession(r.session_token); await load(); bump(); location.hash = '#/'; },
    signOut: async () => { if (getSession()) await api('/v1/auth/logout', { body: {} }).catch(() => {}); clearCredentials(); onSignedOut(); },
  };
  if (!me) {
    return (
      <div class="boot">
        {err ? <div class="boot-card"><ErrorBox error={err} onRetry={load} /><button class="link" onClick={state.signOut}>Sign out</button></div> : <Loading label="Opening Laissez" />}
      </div>
    );
  }
  return <AuthCtx.Provider value={state}>{children}</AuthCtx.Provider>;
}

/** A button that is disabled, with the reason, when the current role lacks a permission. */
export function PermBtn({ perm, children, onClick, kind = 'default', disabled, busy, type = 'button' }: { perm: string; children: ComponentChildren; onClick?: () => void; kind?: 'default' | 'primary' | 'danger' | 'ghost'; disabled?: boolean; busy?: boolean; type?: 'button' | 'submit' }) {
  const { can, why } = useMe();
  const ok = can(perm);
  return <Btn kind={kind} type={type} onClick={onClick} disabled={!ok || disabled} busy={busy} title={ok ? undefined : why(perm)}>{children}</Btn>;
}
/** Visible explanation for disabled controls. Renders nothing when the role has the permission. */
export function PermNote({ perm }: { perm: string }) {
  const { can, why } = useMe();
  return can(perm) ? null : <p class="perm-note" role="note">{why(perm)}</p>;
}
export function NoAccess({ perm, title }: { perm: string; title: string }) {
  const { why } = useMe();
  return (
    <div class="noaccess">
      <h1>{title}</h1>
      <p>{why(perm)}</p>
      <a href="#/">Go to Check</a>
    </div>
  );
}

// ---------- Signed-out screens ----------
function Frame({ children }: { children: ComponentChildren }) {
  return (
    <div class="gate">
      <div class="gate-wrap">
        <div class="gate-intro">
          <a class="gate-brand" href="../">Laissez</a>
          <h1>Compliance and settlement for tokenized funds.</h1>
          <p>Check investor eligibility in every jurisdiction before a trade, settle both legs at once, and keep a signed record of which rule decided.</p>
          <dl class="gate-facts">
            <div><dt>7</dt><dd>rule layers checked on every order</dd></div>
            <div><dt>2</dt><dd>people to approve any policy change</dd></div>
            <div><dt>1</dt><dd>hash-chained audit log you can verify</dd></div>
          </dl>
          <p class="gate-foot">Institutions and people in the app are fictional. Thresholds and legal references are real.</p>
          <p class="gate-links"><a href="../demo/">Guided demo</a><a href="../developers/">Developers</a><a href="../privacy/">Privacy</a><a href="../terms/">Terms</a></p>
        </div>
        <div class="gate-card">{children}</div>
      </div>
    </div>
  );
}

const PASSKEY_LINE = 'Passkeys use Face ID, Touch ID, Windows Hello or a security key. Laissez has no passwords.';

async function passkeySignIn() {
  const o = await api('/v1/auth/login/options', { body: {}, auth: false });
  const credential = await getPasskey(o.options);
  const r = await api('/v1/auth/login/verify', { body: { challenge_id: o.challenge_id, credential }, auth: false });
  adoptSession(r.session_token, r.workspace_id);
  track('signed_in', { method: 'passkey' });
  return r;
}

async function startSso(email: string) {
  const url = `${API_BASE}/v1/auth/sso/start?email=${encodeURIComponent(email.trim())}&origin=${encodeURIComponent(location.origin)}`;
  // Check first, so an unknown domain shows a message here instead of a raw error page.
  try {
    const res = await fetch(url, { redirect: 'manual' });
    if (res.type !== 'opaqueredirect' && res.status >= 400) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, data?.error?.code ?? 'sso_failed', data?.error?.message ?? 'Single sign-on could not start. Check the email address and try again.');
    }
  } catch (e) { if (e instanceof ApiError) throw e; /* network or CORS: let the browser try directly */ }
  location.href = url;
}

export function Gate({ onReady, notice }: { onReady: () => void; notice?: string | null }) {
  const [mode, setMode] = useState<'start' | 'register'>('start');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const [sso, setSso] = useState(false);
  const [email, setEmail] = useState('');
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what); setErr(null);
    try { await fn(); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const openSandbox = () => run('sandbox', async () => {
    const r = await api('/v1/sandboxes', { body: {}, auth: false });
    setSession(r.session_token);
    setKey(r.api_key, { workspace: r.workspace });
    track('sandbox_opened');
    onReady();
  });
  if (mode === 'register') return <Frame><RegisterForm onBack={() => setMode('start')} onDone={onReady} /></Frame>;
  return (
    <Frame>
      {notice ? <div class="note">{notice}</div> : null}
      <h2 class="gate-h">Open a sandbox</h2>
      <p>You get a private copy of Laissez filled with fictional clients, funds and holdings: a Singapore family office, a Swiss pension fund, a Dubai holding company and more. Issue credentials, place orders, settle trades and change fund policies. Everything is saved to a real database.</p>
      <ul class="gate-list">
        <li>No sign-up. No personal data.</li>
        <li>It comes with three fictional teammates, so you can try two-person approval on your own.</li>
        <li>The sandbox and its key live for 7 days, then they are deleted.</li>
      </ul>
      <Btn kind="primary" class="b-wide" onClick={openSandbox} busy={busy === 'sandbox'}>{busy === 'sandbox' ? 'Opening your sandbox' : 'Open a sandbox'}</Btn>
      <div class="gate-or" role="separator"><span>Or use your organization account</span></div>
      <div class="gate-actions">
        <Btn onClick={() => run('passkey', async () => { await passkeySignIn(); onReady(); })} busy={busy === 'passkey'}>Sign in with a passkey</Btn>
        <Btn onClick={() => setSso(!sso)}>{sso ? 'Hide single sign-on' : 'Sign in with SSO'}</Btn>
        <Btn kind="ghost" onClick={() => { setErr(null); setMode('register'); }}>Create an account</Btn>
      </div>
      <p class="muted small"><a href="#/recover">Lost your passkeys?</a> Use a recovery code.</p>
      {sso ? (
        <form class="gate-sso" onSubmit={(e) => { e.preventDefault(); run('sso', () => startSso(email)); }}>
          <Field label="Work email" hint="We send you to your company's sign-in page.">
            <input type="email" required autoComplete="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} placeholder="you@yourcompany.com" />
          </Field>
          <Btn type="submit" kind="primary" busy={busy === 'sso'}>Continue to company sign-in</Btn>
        </form>
      ) : null}
      <ErrorBox error={err} />
      <p class="gate-fine">{PASSKEY_LINE}</p>
    </Frame>
  );
}

type Invite = { token: string; organization: string; role_label: string; email?: string };
function RegisterForm({ onBack, onDone, invite }: { onBack?: () => void; onDone: () => void; invite?: Invite }) {
  const [f, setF] = useState({ name: '', email: invite?.email ?? '', org_name: '', demo_data: true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const submit = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = { name: f.name.trim(), email: f.email.trim() };
      if (invite) body.invite_token = invite.token; else { body.org_name = f.org_name.trim(); body.demo_data = f.demo_data; }
      const o = await api('/v1/auth/register/options', { body, auth: false });
      const credential = await createPasskey(o.options);
      const r = await api('/v1/auth/register/verify', { body: { challenge_id: o.challenge_id, credential }, auth: false });
      adoptSession(r.session_token, r.workspace_id);
      track('account_created', { via: invite ? 'invite' : 'signup', demo_data: invite ? null : f.demo_data });
      onDone();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <>
      {onBack ? <button type="button" class="link gate-back" onClick={onBack}>Back</button> : null}
      <h2 class="gate-h">{invite ? `Join ${invite.organization}` : 'Create an account'}</h2>
      <p>{invite ? `You join as ${invite.role_label}. Your account is yours: you can belong to more than one organization.` : 'Your organization gets its own workspace. You become its administrator and can invite your team.'}</p>
      <form class="gate-form" onSubmit={submit}>
        <Field label="Your name"><input required minLength={2} autoComplete="name" value={f.name} onInput={(e) => set('name', (e.target as HTMLInputElement).value)} placeholder="Elena Marsh" /></Field>
        <Field label="Work email"><input type="email" required autoComplete="email" value={f.email} onInput={(e) => set('email', (e.target as HTMLInputElement).value)} placeholder="elena@harbourline.example" /></Field>
        {invite ? null : <Field label="Organization name"><input required minLength={2} autoComplete="organization" value={f.org_name} onInput={(e) => set('org_name', (e.target as HTMLInputElement).value)} placeholder="Harbourline Capital" /></Field>}
        {invite ? null : (
          <label class="check gate-check">
            <input type="checkbox" checked={f.demo_data} onChange={(e) => set('demo_data', (e.target as HTMLInputElement).checked)} />
            <span>Start with demo data<span class="f-h"> Fictional clients, funds and holdings, so the app is not empty on day one.</span></span>
          </label>
        )}
        <Btn type="submit" kind="primary" class="b-wide" busy={busy}>{busy ? 'Waiting for your passkey' : 'Create passkey and account'}</Btn>
      </form>
      <ErrorBox error={err} />
      <p class="gate-fine">Your browser asks you to create a passkey for Laissez. {PASSKEY_LINE}</p>
    </>
  );
}

export function InviteScreen({ token, signedIn, onJoined }: { token: string; signedIn: boolean; onJoined: () => void }) {
  const [inv, setInv] = useState<any>(null);
  const [loadErr, setLoadErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [create, setCreate] = useState(false);
  useEffect(() => { api(`/v1/auth/invites/${encodeURIComponent(token)}`, { auth: false }).then(setInv).catch(setLoadErr); }, [token]);
  const accept = async () => {
    const r = await api(`/v1/auth/invites/${encodeURIComponent(token)}/accept`, { body: {} });
    adoptSession(r.session_token, r.workspace_id);
    location.hash = '#/';
    onJoined();
  };
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setErr(null); try { await fn(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  if (loadErr) return <Frame><h2 class="gate-h">This invite does not work</h2><ErrorBox error={loadErr} /><p>Ask the person who invited you to send a new link. Invites work once and expire after 7 days.</p><a class="b b-default" href="#/">Go to sign in</a></Frame>;
  if (!inv) return <Frame><Loading label="Checking your invite" /></Frame>;
  const details: Invite = { token, organization: inv.organization, role_label: inv.role_label, email: inv.email };
  if (create) return <Frame><RegisterForm invite={details} onBack={() => setCreate(false)} onDone={() => { location.hash = '#/'; onJoined(); }} /></Frame>;
  return (
    <Frame>
      <h2 class="gate-h">Join {inv.organization}</h2>
      <p>{inv.invited_by ? `${inv.invited_by} invited you` : 'You are invited'} to join <strong>{inv.organization}</strong> on Laissez as <strong>{inv.role_label}</strong>.{inv.expires_at ? ` The invite expires ${new Date(inv.expires_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.` : ''}</p>
      {signedIn && getSession() ? (
        <div class="gate-actions">
          <Btn kind="primary" busy={busy} onClick={() => run(accept)}>Join {inv.organization}</Btn>
          <Btn kind="ghost" onClick={() => run(async () => { await api('/v1/auth/logout', { body: {} }).catch(() => {}); clearCredentials(); location.reload(); })}>Use a different account</Btn>
        </div>
      ) : (
        <>
          <Btn kind="primary" class="b-wide" onClick={() => { setErr(null); setCreate(true); }}>Create an account to join</Btn>
          <div class="gate-or" role="separator"><span>Already use Laissez?</span></div>
          <Btn class="b-wide" busy={busy} onClick={() => run(async () => { await passkeySignIn(); await accept(); })}>Sign in with a passkey and join</Btn>
        </>
      )}
      <ErrorBox error={err} />
      <p class="gate-fine">{PASSKEY_LINE}</p>
    </Frame>
  );
}

export function SsoExchange({ code, onReady }: { code: string; onReady: () => void }) {
  const [err, setErr] = useState<any>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; started.current = true;
    api('/v1/auth/sso/exchange', { body: { code }, auth: false })
      .then((r) => { adoptSession(r.session_token, r.workspace_id); track('signed_in', { method: 'sso' }); location.replace('#/'); onReady(); })
      .catch(setErr);
  }, [code]);
  return (
    <Frame>
      {err ? <><h2 class="gate-h">Single sign-on did not finish</h2><ErrorBox error={err} /><a class="b b-default" href="#/">Back to sign in</a></> : <Loading label="Signing you in" />}
    </Frame>
  );
}

export function SsoError({ message }: { message: string }) {
  let text = message;
  try { text = decodeURIComponent(message); } catch { /* keep raw */ }
  return (
    <Frame>
      <h2 class="gate-h">Single sign-on did not finish</h2>
      <div class="err" role="alert"><strong>{text || 'Your identity provider did not confirm the sign-in.'}</strong></div>
      <p>Try again from the sign-in page. If it keeps failing, ask your administrator to check the single sign-on settings in Laissez.</p>
      <a class="b b-primary" href="#/">Back to sign in</a>
    </Frame>
  );
}
