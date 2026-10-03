/** @jsxImportSource preact */
// Screens for account confirmation and email recovery. The first three work signed out; VerifyPending replaces the app
// shell for a signed-in person whose address is not confirmed yet (production, or any deployment that sends mail).
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, adoptSession, authConfig, when, type AuthConfig } from './api';
import { Btn, ErrorBox, Field, Loading, Reveal } from './ui';
import { Frame, takePendingVerification, useMe } from './auth';
import { Turnstile } from './turnstile';

const waitText = (min: number) => (min >= 120 ? `${Math.round(min / 60)} hours` : min >= 60 ? 'an hour' : min === 1 ? 'a minute' : `${min} minutes`);

// ---------- Confirm an address from the emailed link: #/verify-email/:token ----------
export function VerifyEmailScreen({ token, signedIn, onDone }: { token: string; signedIn: boolean; onDone: () => void }) {
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [err, setErr] = useState<any>(null);
  const [email, setEmail] = useState('');
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; started.current = true;
    api('/v1/auth/verify-email', { body: { token }, auth: false })
      .then((r) => { setEmail(r.email); setState('done'); })
      .catch((e) => { setErr(e); setState('failed'); });
  }, [token]);
  return (
    <Frame>
      {state === 'working' ? <Loading label="Confirming your email address" /> : null}
      {state === 'done' ? (
        <>
          <h2 class="gate-h">Email address confirmed</h2>
          <p><strong>{email}</strong> is confirmed.{signedIn ? ' You can carry on where you left off.' : ' Sign in with your passkey to continue.'}</p>
          <Btn kind="primary" class="b-wide" onClick={() => { location.hash = '#/'; if (signedIn) onDone(); }}>{signedIn ? 'Open Laissez' : 'Go to sign in'}</Btn>
        </>
      ) : null}
      {state === 'failed' ? (
        <>
          <h2 class="gate-h">This link does not work</h2>
          <ErrorBox error={err} />
          <p>Confirmation links work once and expire after a day. Sign in and Laissez asks you to confirm again; you can send yourself a new link from that screen.</p>
          <a class="b b-primary" href="#/">Go to sign in</a>
        </>
      ) : null}
    </Frame>
  );
}

// ---------- Signed in, address not confirmed ----------
export function VerifyPending() {
  const { me, reload, signOut } = useMe();
  const first = useRef(takePendingVerification());
  const [dev, setDev] = useState<string | null>(first.current?.dev_link ?? null);
  const [sent, setSent] = useState<boolean>(first.current?.sent ?? false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const [change, setChange] = useState(false);
  const [email, setEmail] = useState('');
  const current = me!.user?.email ?? '';
  // Coming back from the mail app: look again as soon as the tab is visible.
  useEffect(() => {
    const on = () => { if (document.visibilityState === 'visible') reload(); };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  const run = async (what: string, fn: () => Promise<void>) => { setBusy(what); setErr(null); try { await fn(); } catch (e) { setErr(e); } finally { setBusy(null); } };
  const resend = () => run('resend', async () => {
    const r = await api('/v1/auth/verify-email/resend', { body: {} });
    if (r.verified) { await reload(); return; }
    setSent(r.sent); setDev(r.dev_link ?? null);
  });
  const changeAddress = (e: Event) => {
    e.preventDefault();
    run('change', async () => {
      const r = await api('/v1/me', { method: 'PATCH', body: { email: email.trim() } });
      setChange(false); setSent(!!r.verification_sent);
      // The new link is created in the background; ask for it so a deployment without mail can show it.
      const x = await api('/v1/auth/verify-email/resend', { body: {} }).catch(() => null);
      if (x) { setSent(x.sent); setDev(x.dev_link ?? null); }
      await reload();
    });
  };
  return (
    <Frame>
      <h2 class="gate-h">Confirm your email address</h2>
      <p>{sent ? <>We sent a confirmation link to <strong>{current}</strong>. Open it, then come back to this page.</> : <>Confirm <strong>{current}</strong> to use {me!.workspace.name}. We use it for security alerts and to get you back in if you lose your passkeys.</>}</p>
      {dev ? <Reveal label="Confirmation link" value={dev} note={<>This deployment has no mail provider, so the link is shown here instead of sent. <a href={dev}>Open it now</a>.</>} /> : null}
      <div class="gate-actions">
        <Btn kind="primary" busy={busy === 'resend'} onClick={resend}>{sent ? 'Send another link' : 'Send the confirmation link'}</Btn>
        <Btn onClick={() => run('check', reload)} busy={busy === 'check'}>I confirmed it</Btn>
        <Btn kind="ghost" onClick={() => setChange(!change)}>Wrong address?</Btn>
      </div>
      {change ? (
        <form class="gate-sso" onSubmit={changeAddress}>
          <Field label="Correct email address" hint="We send the new address a link and tell the old one about the change."><input type="email" required autoComplete="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} placeholder="you@yourcompany.com" /></Field>
          <Btn type="submit" kind="primary" busy={busy === 'change'}>Change address</Btn>
        </form>
      ) : null}
      <ErrorBox error={err} />
      <p class="gate-fine">Until the address is confirmed you can only look at your account, ask for another link and sign out. <button type="button" class="link" onClick={signOut}>Sign out</button></p>
    </Frame>
  );
}

// ---------- Ask for a recovery email: #/recover/email ----------
export function EmailRecoveryStart() {
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [email, setEmail] = useState('');
  const [ts, setTs] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [done, setDone] = useState<{ message: string; wait_minutes: number } | null>(null);
  useEffect(() => { authConfig().then(setCfg); }, []);
  const needsCheck = !!cfg?.turnstile_site_key;
  const submit = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { setDone(await api('/v1/auth/recover/start', { body: { email: email.trim(), ...(needsCheck ? { turnstile_token: ts } : {}) }, auth: false })); }
    catch (x) { setErr(x); setTs(null); setNonce((n) => n + 1); } finally { setBusy(false); }
  };
  return (
    <Frame>
      {done ? (
        <>
          <h2 class="gate-h">Check your email</h2>
          <p>{done.message}</p>
          <ul class="gate-list">
            <li>{done.wait_minutes > 0 ? `The link opens after a waiting period of ${waitText(done.wait_minutes)}. If you have an authenticator app set up, there is no wait, and you enter its six-digit code instead.` : 'The link opens straight away.'}</li>
            <li>The same email has a cancel link. If you did not ask for this, use it and tell your administrator.</li>
            <li>Recovery signs you in for two hours, only to add a new passkey, and signs out every other session.</li>
          </ul>
          <a class="b b-default" href="#/">Back to sign in</a>
        </>
      ) : (
        <>
          <h2 class="gate-h">Recover your account by email</h2>
          <p>Use this when you have lost every passkey and have no recovery code. We email a link to the address on your account. To protect you if someone else asks, the link opens after a waiting period unless you have an authenticator app.</p>
          <form class="gate-form" onSubmit={submit}>
            <Field label="Email on your account"><input type="email" required autoComplete="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} placeholder="elena@harbourline.example" /></Field>
            {needsCheck ? <Turnstile siteKey={cfg!.turnstile_site_key!} nonce={nonce} onToken={setTs} onError={(m) => setErr(new Error(m))} /> : null}
            <Btn type="submit" kind="primary" class="b-wide" busy={busy} disabled={needsCheck && !ts}>Email me a recovery link</Btn>
          </form>
          <ErrorBox error={err} />
          <p class="gate-fine">We never say whether an address has an account. <a href="#/recover">Use a recovery code instead</a> · <a href="#/">Back to sign in</a></p>
        </>
      )}
    </Frame>
  );
}

// ---------- The emailed recovery link: #/recover/:token ----------
export function RecoveryLink({ token, onReady }: { token: string; onReady: () => void }) {
  const [info, setInfo] = useState<any>(null);
  const [loadErr, setLoadErr] = useState<any>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const [now, setNow] = useState(Date.now());
  const load = () => api(`/v1/auth/recover/${encodeURIComponent(token)}`, { auth: false }).then((r) => { setInfo(r); setLoadErr(null); }).catch(setLoadErr);
  useEffect(() => { load(); }, [token]);
  // While the link is waiting, tick once a second and look again when it should have opened.
  useEffect(() => {
    if (info?.state !== 'waiting') return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [info?.state]);
  useEffect(() => { if (info?.state === 'waiting' && now >= new Date(info.available_at).getTime()) load(); }, [now]);
  const complete = async (e: Event) => {
    e.preventDefault(); setBusy('complete'); setErr(null);
    try {
      const r = await api('/v1/auth/recover/' + encodeURIComponent(token) + '/complete', { body: info.needs_code ? { code: code.trim() } : {}, auth: false });
      adoptSession(r.session_token, r.workspace_id);
      location.hash = '#/settings/security';
      onReady();
    } catch (x) { setErr(x); load(); } finally { setBusy(null); }
  };
  if (loadErr) return <Frame><h2 class="gate-h">This recovery link does not work</h2><ErrorBox error={loadErr} /><p>Ask for a new one. Links work once and expire a day after they open.</p><a class="b b-primary" href="#/recover/email">Ask for a new link</a></Frame>;
  if (!info) return <Frame><Loading label="Checking your recovery link" /></Frame>;
  const left = Math.max(0, new Date(info.available_at).getTime() - now);
  const clock = `${Math.floor(left / 3_600_000)}h ${String(Math.floor(left / 60_000) % 60).padStart(2, '0')}m ${String(Math.floor(left / 1000) % 60).padStart(2, '0')}s`;
  return (
    <Frame>
      {info.state === 'waiting' ? (
        <>
          <h2 class="gate-h">Waiting period</h2>
          <p>Recovery for <strong>{info.email}</strong> was requested. The link opens at <strong>{when(info.available_at)}</strong>. The wait gives the real owner time to stop a stranger who knows the address.</p>
          <p class="gate-clock" role="timer" aria-live="off">{clock}</p>
          <p class="small muted">Keep this page open or come back to this link later. You can also cancel the request.</p>
          <CancelRecovery token={token} onCancelled={load} />
        </>
      ) : null}
      {info.state === 'ready' ? (
        <>
          <h2 class="gate-h">Recover {info.name ? `${info.name.split(' ')[0]}'s` : 'your'} account</h2>
          <p>You are about to sign in to <strong>{info.email}</strong> for two hours. This session can only add a new passkey, and every other session on the account is signed out.</p>
          <form class="gate-form" onSubmit={complete}>
            {info.needs_code ? <Field label="Six-digit code from your authenticator app" hint="Codes change every 30 seconds and work once."><input required inputMode="numeric" pattern="[0-9 ]{6,8}" autoComplete="one-time-code" class="mono" value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} placeholder="123 456" /></Field> : null}
            <Btn type="submit" kind="primary" class="b-wide" busy={busy === 'complete'}>Sign in and add a passkey</Btn>
          </form>
          <ErrorBox error={err} />
          <CancelRecovery token={token} onCancelled={load} label="This was not me: cancel" />
        </>
      ) : null}
      {info.state === 'used' ? <><h2 class="gate-h">This link was already used</h2><p>Sign in with the passkey you added. If you still cannot, ask for a new recovery link.</p><div class="gate-actions"><a class="b b-primary" href="#/">Sign in</a><a class="b b-default" href="#/recover/email">Ask for a new link</a></div></> : null}
      {info.state === 'cancelled' ? <><h2 class="gate-h">This request was cancelled</h2><p>Nobody can use this link. If you still need to recover the account, ask for a new one.</p><div class="gate-actions"><a class="b b-primary" href="#/recover/email">Ask for a new link</a><a class="b b-default" href="#/">Back to sign in</a></div></> : null}
      {info.state === 'expired' ? <><h2 class="gate-h">This link expired</h2><p>Recovery links last a day after they open. Ask for a new one.</p><a class="b b-primary" href="#/recover/email">Ask for a new link</a></> : null}
    </Frame>
  );
}

function CancelRecovery({ token, onCancelled, label = 'Cancel this request' }: { token: string; onCancelled: () => void; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const go = async () => { setBusy(true); setErr(null); try { await api(`/v1/auth/recover/${encodeURIComponent(token)}/cancel`, { body: {}, auth: false }); onCancelled(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return <><div class="form-actions"><Btn kind="ghost" busy={busy} onClick={go}>{label}</Btn></div><ErrorBox error={err} /></>;
}

// ---------- The cancel link in the email: #/recover/:token/cancel ----------
export function RecoveryCancel({ token }: { token: string }) {
  const [state, setState] = useState<'ask' | 'done' | 'late'>('ask');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const go = async () => {
    setBusy(true); setErr(null);
    try { const r = await api(`/v1/auth/recover/${encodeURIComponent(token)}/cancel`, { body: {}, auth: false }); setState(r.cancelled ? 'done' : 'late'); }
    catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Frame>
      {state === 'ask' ? (
        <>
          <h2 class="gate-h">Cancel this recovery request?</h2>
          <p>Someone asked to recover your Laissez account by email. If that was not you, cancel it now. The link stops working and the request is recorded in your organization's audit log.</p>
          <Btn kind="primary" class="b-wide" busy={busy} onClick={go}>Yes, cancel the request</Btn>
          <ErrorBox error={err} />
          <p class="gate-fine">If it was you, close this page and keep the other link. After cancelling, review your passkeys under Security once you can sign in.</p>
        </>
      ) : null}
      {state === 'done' ? <><h2 class="gate-h">Request cancelled</h2><p>The recovery link no longer works. If you are worried that someone knows your email address, tell your administrator and set up an authenticator app under Security, which then protects recovery.</p><a class="b b-primary" href="#/">Back to sign in</a></> : null}
      {state === 'late' ? <><h2 class="gate-h">Nothing left to cancel</h2><p>This request was already used, cancelled or expired. If the account was recovered and that was not you, sign in if you can and open Security and Sessions to review it, then tell your administrator.</p><a class="b b-primary" href="#/">Back to sign in</a></> : null}
    </Frame>
  );
}
