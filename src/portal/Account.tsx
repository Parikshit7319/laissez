/** @jsxImportSource preact */
// Portal accounts: create one from the distributor's link with a passkey, sign in without a link afterwards, add an
// authenticator app as a second factor. Sessions live in this browser tab only.
import { useEffect, useState } from 'preact/hooks';
import { call } from './client';
import { createPasskey, getPasskey, passkeysSupported } from '../app/webauthn';

export const SESSION_KEY = 'laissez-portal-session';
const memory: Record<string, string> = {};
export function getSession(): string | null { try { return sessionStorage.getItem(SESSION_KEY) ?? memory[SESSION_KEY] ?? null; } catch { return memory[SESSION_KEY] ?? null; } }
export function setSession(tok: string | null) {
  if (tok) { memory[SESSION_KEY] = tok; try { sessionStorage.setItem(SESSION_KEY, tok); } catch { /* storage blocked */ } }
  else { delete memory[SESSION_KEY]; try { sessionStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ } }
}
const auth = <T = any>(path: string, opts: { method?: string; body?: unknown; token?: string | null } = {}) => call<T>(`/v1/portal-auth${path}`, opts);

function Err({ e }: { e: any }) { return e ? <p class="pt-error" role="alert">{e.message ?? String(e)}</p> : null; }

/** Shown when the link carries a client who must create an account before the portal opens. */
export function CreateAccount({ linkToken, distributor, onDone }: { linkToken: string; distributor?: string; onDone: (session: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const o = await auth('/register/options', { body: {}, token: linkToken });
      const credential = await createPasskey(o.options);
      const r = await auth('/register/verify', { body: { challenge_id: o.challenge_id, credential }, token: linkToken });
      setSession(r.session_token); onDone(r.session_token);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <>
      <p class="pt-muted">{distributor ?? 'Your distributor'} asks you to secure your portal with a passkey: your device's fingerprint, face or PIN. There is no password. After this, you sign in at this page without a link.</p>
      {passkeysSupported() ? <button type="button" class="pt-btn primary" disabled={busy} onClick={create}>{busy ? 'Waiting for your device' : 'Create my account with a passkey'}</button> : <p class="pt-error">This browser cannot create passkeys. Use a current version of Safari, Chrome, Edge or Firefox.</p>}
      <Err e={err} />
    </>
  );
}

/** Passkey sign-in, then the six-digit code when the account has an authenticator app. */
export function SignIn({ onDone, note }: { onDone: (session: string) => void; note?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const signIn = async () => {
    setBusy(true); setErr(null);
    try {
      const o = await auth('/login/options', { body: {} });
      const credential = await getPasskey(o.options);
      const r = await auth('/login/verify', { body: { challenge_id: o.challenge_id, credential } });
      if (r.mfa_required) { setPending(r.session_token); return; }
      setSession(r.session_token); onDone(r.session_token);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const mfa = async (e: Event) => {
    e.preventDefault(); if (!pending) return;
    setBusy(true); setErr(null);
    try { await auth('/mfa', { body: { code }, token: pending }); setSession(pending); onDone(pending); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  if (pending) {
    return (
      <form class="pt-form" onSubmit={mfa}>
        <p class="pt-muted">Enter the six-digit code from your authenticator app.</p>
        <input class="pt-input" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))} aria-label="Six-digit code" autoFocus />
        <button type="submit" class="pt-btn primary" disabled={busy || code.length !== 6}>Continue</button>
        <Err e={err} />
      </form>
    );
  }
  return (
    <>
      {note ? <p class="pt-muted">{note}</p> : null}
      {passkeysSupported() ? <button type="button" class="pt-btn primary" disabled={busy} onClick={signIn}>{busy ? 'Waiting for your device' : 'Sign in with my passkey'}</button> : <p class="pt-error">This browser cannot use passkeys. Use a current version of Safari, Chrome, Edge or Firefox.</p>}
      <Err e={err} />
    </>
  );
}

/** The account page inside the portal: passkeys, authenticator app, sign out. */
export function AccountPage({ token, onSignedOut }: { token: string; onSignedOut: () => void }) {
  const [s, setS] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [setup, setSetup] = useState<{ secret: string; uri: string; svg?: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const load = () => auth('/session', { token }).then(setS).catch(setErr);
  useEffect(() => { load(); }, [token]);
  const startTotp = async () => {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await auth('/totp/setup', { body: {}, token });
      let svg: string | undefined;
      try { const mod: any = await import('qrcode-generator'); const qr = (mod.default ?? mod)(0, 'M'); qr.addData(r.uri); qr.make(); svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); } catch { /* the secret is shown as text */ }
      setSetup({ ...r, svg });
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const enable = async (e: Event) => { e.preventDefault(); setBusy(true); setErr(null); try { await auth('/totp/enable', { body: { code }, token }); setSetup(null); setCode(''); setNote('Authenticator app turned on. You will be asked for a code after each passkey sign-in.'); load(); } catch (x) { setErr(x); } finally { setBusy(false); } };
  const disable = async (e: Event) => { e.preventDefault(); setBusy(true); setErr(null); try { await auth('/totp/disable', { body: { code }, token }); setCode(''); setNote('Authenticator app turned off.'); load(); } catch (x) { setErr(x); } finally { setBusy(false); } };
  const addKey = async () => {
    setBusy(true); setErr(null);
    try { const o = await auth('/passkeys/options', { body: {}, token }); const credential = await createPasskey(o.options); await auth('/passkeys/verify', { body: { challenge_id: o.challenge_id, credential, label: 'Added passkey' }, token }); setNote('Passkey added.'); load(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const signOut = async () => { try { await auth('/logout', { body: {}, token }); } catch { /* already gone */ } setSession(null); onSignedOut(); };
  const [disabling, setDisabling] = useState(false);
  return (
    <section class="pt-section">
      <h2>Your account</h2>
      {note ? <p class="pt-ok" role="status">{note}</p> : null}
      <Err e={err} />
      {!s ? null : (
        <>
          <div class="pt-card">
            <h3>Passkeys</h3>
            <p class="pt-muted pt-small">You sign in with one of these. Add a second one on another device so you are never locked out.</p>
            <ul class="pt-list">{s.passkeys.map((k: any) => <li key={k.id}><b>{k.label}</b> <span class="pt-muted pt-small">added {new Date(k.created_at).toLocaleDateString('en-GB')}{k.last_used_at ? `, last used ${new Date(k.last_used_at).toLocaleDateString('en-GB')}` : ''}</span></li>)}</ul>
            <button type="button" class="pt-btn" disabled={busy} onClick={addKey}>Add a passkey</button>
          </div>
          <div class="pt-card">
            <h3>Authenticator app</h3>
            {s.totp_enabled ? (
              <>
                <p class="pt-muted pt-small">On. A six-digit code is required after each passkey sign-in.</p>
                {disabling ? <form class="pt-form" onSubmit={disable}><input class="pt-input" inputMode="numeric" maxLength={6} required value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))} aria-label="Current code" /><button type="submit" class="pt-btn danger" disabled={busy || code.length !== 6}>Turn off</button></form> : <button type="button" class="pt-btn ghost" onClick={() => setDisabling(true)}>Turn off</button>}
              </>
            ) : setup ? (
              <form class="pt-form" onSubmit={enable}>
                <p class="pt-muted pt-small">Scan this with Google Authenticator, 1Password, Authy or any TOTP app, then enter the code it shows.</p>
                {setup.svg ? <div class="pt-qr" dangerouslySetInnerHTML={{ __html: setup.svg }} /> : null}
                <p class="pt-small">Or type the key: <code>{setup.secret}</code></p>
                <input class="pt-input" inputMode="numeric" maxLength={6} required value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))} aria-label="Six-digit code" />
                <button type="submit" class="pt-btn primary" disabled={busy || code.length !== 6}>Turn on</button>
              </form>
            ) : (
              <>
                <p class="pt-muted pt-small">Off. Turn it on to require a code from your phone after your passkey.</p>
                <button type="button" class="pt-btn" disabled={busy} onClick={startTotp}>Set up an authenticator app</button>
              </>
            )}
          </div>
          <div class="pt-card">
            <h3>Sign out</h3>
            <p class="pt-muted pt-small">Ends this session on this device.</p>
            <button type="button" class="pt-btn" onClick={signOut}>Sign out</button>
          </div>
        </>
      )}
    </section>
  );
}
