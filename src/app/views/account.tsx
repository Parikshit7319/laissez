/** @jsxImportSource preact */
// Your own account, on the Security page: email confirmation, authenticator app, recovery path, terms, and your data
// (export and deletion). Organization-wide rules live on the Security policy page.
import { useState } from 'preact/hooks';
import { api, when } from '../api';
import { useApi, Btn, Chip, ErrorBox, Loading, Field, Card, Reveal, ConfirmBtn } from '../ui';
import { useMe } from '../auth';

async function qrSvg(text: string): Promise<string> {
  const mod: any = await import('qrcode-generator');
  const make = mod.default ?? mod;
  const q = make(0, 'M');
  q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function saveJson(name: string, data: unknown) {
  const b = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function AccountSecurity() {
  const { me, signOut } = useMe();
  // A recovery session can do one thing, add a passkey; the banner above the page says so.
  const s = useApi(me!.recovery_session ? null : '/v1/account/security');
  if (me!.recovery_session) return null;
  if (s.loading && !s.data) return <Card title="Your account"><Loading /></Card>;
  if (s.error) return <Card title="Your account"><ErrorBox error={s.error} onRetry={s.reload} /></Card>;
  const d = s.data;
  const pol = d.organization_policy;
  const rules: string[] = [];
  if (pol?.require_sso) rules.push('Members sign in through single sign-on');
  if (pol?.require_user_verification) rules.push('Passkeys must confirm it is you with a PIN, fingerprint or face');
  if (pol) rules.push(`Sessions last ${pol.session_hours} hours and end after ${pol.idle_minutes} idle minutes`);
  if (pol?.allowed_email_domains?.length) rules.push(`Email must end in ${pol.allowed_email_domains.join(', ')}`);
  if (pol?.session_ip_allowlist?.length) rules.push(`Sign-in is limited to ${pol.session_ip_allowlist.length} approved network${pol.session_ip_allowlist.length === 1 ? '' : 's'}`);
  return (
    <>
      <div class="grid2">
        <EmailCard d={d} reload={s.reload} />
        <TotpCard d={d} reload={s.reload} />
      </div>
      <div class="grid2">
        <Card title="How you get back in" actions={d.recovery.by_email ? <Chip tone="ok">Email recovery on</Chip> : <Chip tone="warn">No email recovery</Chip>}>
          <dl class="kv wide">
            <div><dt>Passkeys</dt><dd>{d.passkeys}{d.passkeys < 2 ? <span class="small muted"> Add a second one on another device.</span> : null}</dd></div>
            <div><dt>Recovery by email</dt><dd>{d.recovery.by_email ? (d.recovery.second_factor ? 'Needs a code from your authenticator app, no waiting period' : `Waiting period of ${d.recovery.wait_minutes >= 60 ? `${Math.round(d.recovery.wait_minutes / 60)} hours` : `${d.recovery.wait_minutes} minute${d.recovery.wait_minutes === 1 ? '' : 's'}`}, cancellable from the email`) : 'Set a real email address first'}</dd></div>
            <div><dt>Recovery codes</dt><dd><a href="#/settings/sessions">Manage on Sessions and recovery</a></dd></div>
            <div><dt>Sessions</dt><dd>{d.sessions} active</dd></div>
          </dl>
          <p class="small muted">Recovery signs in for two hours, only to add a passkey, and signs out every other session. Every recovery is written to the audit log and emailed to you.</p>
        </Card>
        <Card title="Terms and your data">
          <dl class="kv wide">
            <div><dt>Terms accepted</dt><dd>{d.terms.accepted_at ? `Version ${d.terms.accepted_version ?? 'unknown'}, ${when(d.terms.accepted_at)}` : 'Not recorded for this account'}</dd></div>
            <div><dt>Current terms</dt><dd>{d.terms.current_version}{d.terms.accepted_version && d.terms.accepted_version !== d.terms.current_version ? <> <Chip tone="warn">Newer than yours</Chip></> : null} <a href="../terms/" target="_blank" rel="noopener">Read</a></dd></div>
          </dl>
          <YourData email={d.email} signOut={signOut} />
        </Card>
      </div>
      {rules.length ? (
        <Card title={`Policy of ${me!.workspace.name}`} actions={<a class="small" href="#/settings/security-policy">Open the policy</a>}>
          <ul class="gate-list">{rules.map((r) => <li>{r}</li>)}</ul>
        </Card>
      ) : null}
    </>
  );
}

function EmailCard({ d, reload }: { d: any; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [res, setRes] = useState<any>(null);
  const send = async () => { setBusy(true); setErr(null); try { setRes(await api('/v1/auth/verify-email/resend', { body: {} })); reload(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return (
    <Card title="Email address" actions={d.email_verified ? <Chip tone="ok">Confirmed</Chip> : <Chip tone="warn">Not confirmed</Chip>}>
      <p><strong>{d.email}</strong></p>
      <p class="muted">We use it for security alerts, invites and account recovery. {d.email_verified ? 'It is confirmed.' : d.email_verification_required ? 'This deployment requires a confirmed address.' : 'Confirming it lets you recover the account by email.'}</p>
      {!d.email_verified ? <div class="form-actions"><Btn kind="primary" busy={busy} onClick={send}>Send a confirmation link</Btn></div> : null}
      {res?.dev_link ? <Reveal label="Confirmation link" value={res.dev_link} note={<>No mail provider is connected, so the link is shown here. <a href={res.dev_link}>Open it</a>.</>} /> : res?.sent ? <p class="ok-text" role="status">Sent. Open the link in the email.</p> : null}
      <ErrorBox error={err} />
    </Card>
  );
}

function TotpCard({ d, reload }: { d: any; reload: () => void }) {
  const [setup, setSetup] = useState<any>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const [done, setDone] = useState<string | null>(null);
  const on = d.totp.enabled;
  const start = async () => {
    setBusy('setup'); setErr(null); setDone(null);
    try { const r = await api('/v1/account/totp/setup', { body: {} }); setSetup(r); setQr(await qrSvg(r.uri).catch(() => null)); }
    catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const submit = async (kind: 'enable' | 'disable', e: Event) => {
    e.preventDefault(); setBusy(kind); setErr(null); setDone(null);
    try {
      await api(`/v1/account/totp/${kind}`, { body: { code: code.replace(/\s+/g, '') } });
      setCode(''); setSetup(null); setQr(null); setDone(kind === 'enable' ? 'Authenticator app is on. Recovery by email now needs its code.' : 'Authenticator app is off.'); reload();
    } catch (x) { setErr(x); } finally { setBusy(null); }
  };
  return (
    <Card title="Authenticator app" actions={on ? <Chip tone="ok">On</Chip> : <Chip>Off</Chip>}>
      <p class="muted">An app such as 1Password, Google Authenticator or Authy shows a six-digit code every 30 seconds. With it on, recovering your account by email needs a code and skips the waiting period, so a stranger who knows your email address cannot get in.</p>
      {on ? (
        <form class="form-grid one" onSubmit={(e) => submit('disable', e)}>
          <Field label="Current code, to turn it off"><input required inputMode="numeric" autoComplete="one-time-code" class="mono" value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} placeholder="123 456" /></Field>
          <div class="form-actions"><Btn type="submit" busy={busy === 'disable'}>Turn off authenticator app</Btn></div>
        </form>
      ) : setup ? (
        <form class="form-grid one" onSubmit={(e) => submit('enable', e)}>
          <div class="totp-setup">
            {qr ? <div class="qr" role="img" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: qr }} /> : null}
            <div>
              <p class="small">Scan the code with your app, or type this key in by hand.</p>
              <div class="reveal-row"><code class="break mono">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code></div>
              <p class="small muted">Time based, six digits, 30 seconds. It is not active until you confirm.</p>
            </div>
          </div>
          <Field label="Code from the app, to confirm"><input required inputMode="numeric" autoComplete="one-time-code" class="mono" value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} placeholder="123 456" /></Field>
          <div class="form-actions"><Btn type="submit" kind="primary" busy={busy === 'enable'}>Confirm and turn on</Btn><Btn kind="ghost" onClick={() => { setSetup(null); setQr(null); setCode(''); }}>Cancel</Btn></div>
        </form>
      ) : (
        <div class="form-actions"><Btn kind="primary" busy={busy === 'setup'} onClick={start}>Set up authenticator app</Btn></div>
      )}
      {done ? <p class="ok-text" role="status">{done}</p> : null}
      <ErrorBox error={err} />
    </Card>
  );
}

function YourData({ email, signOut }: { email: string; signOut: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<any>(null);
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState(false);
  const exportData = async () => {
    setBusy('export'); setErr(null);
    try { const r = await api('/v1/account/export'); saveJson('laissez-my-data.json', r); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  const remove = async () => {
    setBusy('delete'); setErr(null);
    try { await api('/v1/account', { method: 'DELETE', body: { confirm_email: typed.trim().toLowerCase() } }); await signOut(); } catch (e) { setErr(e); } finally { setBusy(null); }
  };
  return (
    <>
      <div class="form-actions"><Btn busy={busy === 'export'} onClick={exportData}>Download my data</Btn><Btn kind="ghost" onClick={() => setOpen(!open)}>{open ? 'Keep my account' : 'Delete my account'}</Btn></div>
      <p class="small muted">The download is one JSON file: your profile, memberships, passkey names, sessions and the audit entries you authored. Secrets are never included.</p>
      {open ? (
        <div class="reveal">
          <p><strong>Delete your account</strong></p>
          <p class="small">This removes your passkeys, sessions and memberships and strips your name and email from the user record. Audit entries your organizations already recorded stay, because the audit log is hash-linked and must stay intact. You cannot do this while you are the only administrator of an organization.</p>
          <Field label={`Type your email to confirm: ${email}`}><input autoComplete="off" value={typed} onInput={(e) => setTyped((e.target as HTMLInputElement).value)} placeholder={email} /></Field>
          <div class="form-actions"><ConfirmBtn confirm="Delete my account for good" disabled={typed.trim().toLowerCase() !== email.toLowerCase() || busy === 'delete'} onConfirm={remove}>Delete account</ConfirmBtn></div>
        </div>
      ) : null}
      <ErrorBox error={err} />
    </>
  );
}
