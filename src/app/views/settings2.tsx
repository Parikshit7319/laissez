/** @jsxImportSource preact */
// Organization settings, part two: the email outbox, sessions and recovery codes, provisioning (SSO group mapping
// and SCIM), the organization lifecycle (keep a sandbox, export, delete) and the usage block on the API keys page.
import { useEffect, useState } from 'preact/hooks';
import { api, adoptSession, when, day } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Loading, Empty, Field, Card, Copy, Reveal, ConfirmBtn } from '../ui';
import { useMe, PermBtn, PermNote, ROLE_LABEL, type Role } from '../auth';
import { createPasskey } from '../webauthn';

const ROLES = Object.keys(ROLE_LABEL) as Role[];
const COUNTRY = (code?: string | null) => {
  if (!code) return null;
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code; } catch { return code; }
};
const KIND_LABEL: Record<string, string> = { invite: 'Invite', consent_request: 'Consent request', portal_access: 'Portal access', work_digest: 'Work queue digest', api_key_new_network: 'API key alert', new_device: 'New sign-in alert' };
const STATUS_TONE: Record<string, 'ok' | 'warn' | 'no'> = { sent: 'ok', outbox: 'warn', failed: 'no' };

// ---------- Outbox ----------
export function Outbox() {
  const { isSandbox } = useMe();
  const r = useApi('/v1/outbox');
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  useEffect(() => {
    if (!open) { setMsg(null); return; }
    setMsg(null); setErr(null);
    api(`/v1/outbox/${open}`).then(setMsg).catch(setErr);
  }, [open]);
  const rows = r.data?.data ?? [];
  return (
    <>
      <Head title="Outbox" sub={r.data?.provider ? 'Every email Laissez sent on behalf of this organization, kept here for reference.' : isSandbox ? 'Sandboxes have no mail provider, so every email Laissez would send lands here instead. Open one to use its link as the recipient would.' : 'No mail provider is connected to this deployment, so every email lands here. Set RESEND_API_KEY and EMAIL_FROM on the API to send for real.'} actions={<Btn kind="ghost" onClick={r.reload}>Refresh</Btn>} />
      <ErrorBox error={err} />
      <div class="grid2">
        <Card pad={false}>
          {r.loading && !r.data ? <div class="pad"><Loading /></div> : r.error ? <div class="pad"><ErrorBox error={r.error} onRetry={r.reload} /></div> : rows.length ? (
            <div class="tw"><table class="t">
              <thead><tr><th>To</th><th>Subject</th><th>Status</th><th>Sent</th></tr></thead>
              <tbody>{rows.map((m: any) => (
                <tr aria-selected={open === m.id ? 'true' : undefined} style={open === m.id ? { background: 'rgba(31,58,51,.06)' } : undefined}>
                  <td><button type="button" class="link" onClick={() => setOpen(m.id)}><strong>{m.to_email}</strong></button><div class="small muted">{KIND_LABEL[m.kind] ?? m.kind}</div></td>
                  <td>{m.subject}</td>
                  <td><Chip tone={STATUS_TONE[m.status] ?? 'muted'}>{m.status === 'outbox' ? 'In outbox' : m.status === 'sent' ? 'Sent' : 'Failed'}</Chip>{m.error ? <div class="small muted">{m.error}</div> : null}</td>
                  <td class="muted nowrap">{when(m.created_at)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <div class="pad"><Empty title="Nothing sent yet">Invites, consent requests, portal links, security alerts and the daily work queue digest appear here.</Empty></div>}
        </Card>
        <Card title={msg ? msg.subject : 'Preview'} actions={msg ? <Chip tone={STATUS_TONE[msg.status] ?? 'muted'}>{msg.status === 'outbox' ? 'In outbox' : msg.status}</Chip> : null}>
          {!open ? <p class="muted">Choose a message to read it. Links in the preview work; in a sandbox that is how you act as the recipient.</p> : !msg && !err ? <Loading /> : msg ? (
            <>
              <dl class="kv wide">
                <div><dt>To</dt><dd>{msg.to_email}</dd></div>
                <div><dt>Kind</dt><dd>{KIND_LABEL[msg.kind] ?? msg.kind}</dd></div>
                <div><dt>Created</dt><dd>{when(msg.created_at)}</dd></div>
                {msg.provider_id ? <div><dt>Provider id</dt><dd><code>{msg.provider_id}</code></dd></div> : null}
              </dl>
              {msg.link ? <Reveal label="Link in this email" value={msg.link} note={<a href={msg.link} target="_blank" rel="noopener">Open the link as the recipient would</a>} /> : null}
              <iframe title={`Preview of ${msg.subject}`} sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc={msg.html} style={{ width: '100%', height: '520px', border: '1px solid var(--line, #ddd6c9)', borderRadius: '10px', background: '#f1eee8' }} />
              <details><summary class="small muted">Plain text version</summary><pre class="json" style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</pre></details>
            </>
          ) : null}
        </Card>
      </div>
    </>
  );
}

// ---------- Sessions and recovery codes ----------
const METHOD: Record<string, string> = { passkey: 'Passkey', sso: 'Single sign-on', sandbox: 'Sandbox', switch: 'Organization switch', invite: 'Invite', recovery: 'Recovery code' };
function uaFallback(ua = '') {
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ua ? 'Browser' : 'Unknown browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return { browser: b, os };
}

export function Sessions() {
  const { me, isSandbox, signOut } = useMe();
  const isKey = !me!.user;
  const s = useApi(isKey ? null : '/v1/sessions');
  const [err, setErr] = useState<any>(null);
  const [done, setDone] = useState<string | null>(null);
  const revoke = async (id: string) => { setErr(null); try { await api(`/v1/sessions/${id}`, { method: 'DELETE' }); s.reload(); } catch (e) { setErr(e); } };
  const revokeAll = async () => { setErr(null); setDone(null); try { const r = await api('/v1/sessions/revoke-all', { body: {} }); setDone(`${r.revoked} other session${r.revoked === 1 ? '' : 's'} signed out.`); s.reload(); } catch (e) { setErr(e); } };
  if (isKey) return <><Head title="Sessions" /><div class="note">You are using an API key, not a signed-in session. Sessions belong to people.</div></>;
  const rows = s.data?.data ?? [];
  return (
    <>
      <Head title="Sessions and recovery" sub="Every device signed in to your account, where it last connected from, and the recovery codes that get you back in if you lose your passkeys." actions={<ConfirmBtn kind="default" confirm="Sign out everywhere else" onConfirm={revokeAll} disabled={rows.length <= 1}>Sign out other sessions</ConfirmBtn>} />
      {(me as any).recovery_session ? <div class="note" role="alert">You signed in with a recovery code. This session lasts one hour and can only add a passkey. <a href="#/settings/security">Add a passkey now</a>, then sign in with it.</div> : null}
      <ErrorBox error={err} />
      {done ? <p class="ok-text" role="status">{done}</p> : null}
      <Card title="Signed-in sessions" pad={false}>
        {s.loading && !s.data ? <div class="pad"><Loading /></div> : s.error ? <div class="pad"><ErrorBox error={s.error} onRetry={s.reload} /></div> : (
          <div class="tw"><table class="t">
            <thead><tr><th>Device</th><th>Location</th><th>Signed in with</th><th>Organization</th><th>Last seen</th><th>Ends</th><th /></tr></thead>
            <tbody>{rows.map((x: any) => {
              const f = uaFallback(x.user_agent);
              const browser = x.browser ?? f.browser; const os = x.os ?? f.os;
              return (
                <tr>
                  <td><strong>{browser}{os ? ` on ${os}` : ''}</strong>{x.current ? <Chip tone="brass">This browser</Chip> : null}<div class="small muted">Signed in {when(x.created_at)}</div></td>
                  <td>{x.country ? <>{x.city ? `${x.city}, ` : ''}{COUNTRY(x.country)}</> : <span class="muted">Unknown</span>}</td>
                  <td>{METHOD[x.method] ?? x.method}</td>
                  <td>{x.organization}</td>
                  <td class="muted nowrap">{when(x.last_seen_at)}</td>
                  <td class="muted nowrap">{day(x.expires_at)}</td>
                  <td>{x.current ? <Btn kind="ghost" onClick={signOut}>Sign out</Btn> : <ConfirmBtn kind="ghost" confirm="Sign out that session" onConfirm={() => revoke(x.id)}>Revoke</ConfirmBtn>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>
      <p class="small muted">Location comes from the network address at sign-in and is approximate. A sign-in from a network your account has never used triggers an email alert.</p>
      {isSandbox ? null : <RecoveryCodes />}
    </>
  );
}

function RecoveryCodes() {
  const r = useApi('/v1/auth/recovery-codes');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const generate = async () => {
    setBusy(true); setErr(null);
    try { const x = await api('/v1/auth/recovery-codes/generate', { body: {} }); setCodes(x.codes); r.reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const d = r.data;
  return (
    <Card title="Recovery codes" actions={d ? (d.unused ? <Chip tone="ok">{d.unused} of {d.total} left</Chip> : <Chip tone="warn">None</Chip>) : null}>
      <p class="muted">If you lose every passkey, a recovery code and your email sign you in for one hour, long enough to add a new passkey. Each code works once.</p>
      {d?.generated_at ? <p class="small muted">Generated {when(d.generated_at)}. Generating again replaces every unused code.</p> : null}
      <ErrorBox error={err} />
      {codes ? (
        <div class="reveal" role="status">
          <span class="f-l">Your recovery codes. Shown once.</span>
          <div class="scopes">{codes.map((c) => <code class="mono" style={{ padding: '8px 10px', border: '1px solid var(--line, #ddd6c9)', borderRadius: '8px' }}>{c}</code>)}</div>
          <div class="row-inline tight"><Copy text={codes.join('\n')} label="Copy all" /><Btn kind="ghost" onClick={() => { const b = new Blob([`Laissez recovery codes\n\n${codes.join('\n')}\n`], { type: 'text/plain' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'laissez-recovery-codes.txt'; a.click(); }}>Download</Btn></div>
          <p class="small muted">Store them in a password manager or print them. Laissez keeps only hashes and cannot show them again.</p>
        </div>
      ) : null}
      <div class="form-actions"><Btn kind={d?.unused ? 'default' : 'primary'} busy={busy} onClick={generate}>{d?.unused ? 'Generate new codes' : 'Generate recovery codes'}</Btn></div>
    </Card>
  );
}

/** Signed-out recovery sign-in. Mount it from App.tsx at #/recover. */
export function RecoverySignIn({ onReady }: { onReady: () => void }) {
  const [f, setF] = useState({ email: '', code: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const submit = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await api('/v1/auth/recovery', { body: { email: f.email.trim(), code: f.code.trim() }, auth: false });
      adoptSession(r.session_token, r.workspace_id);
      location.hash = '#/settings/security';
      onReady();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <div class="gate"><div class="gate-wrap"><div class="gate-card">
      <h2 class="gate-h">Sign in with a recovery code</h2>
      <p>Use this when you have lost every passkey. You get one hour to add a new passkey, then sign in with it.</p>
      <form class="gate-form" onSubmit={submit}>
        <Field label="Email"><input type="email" required autoComplete="email" value={f.email} onInput={(e) => setF({ ...f, email: (e.target as HTMLInputElement).value })} /></Field>
        <Field label="Recovery code"><input required class="mono" autoComplete="one-time-code" value={f.code} placeholder="XXXX-XXXX-XXXX" onInput={(e) => setF({ ...f, code: (e.target as HTMLInputElement).value })} /></Field>
        <Btn type="submit" kind="primary" class="b-wide" busy={busy}>Continue</Btn>
      </form>
      <ErrorBox error={err} />
      <p class="gate-fine"><a href="#/">Back to sign in</a></p>
    </div></div></div>
  );
}

// ---------- Provisioning: SSO group mapping and SCIM ----------
export function Provisioning() {
  const { isSandbox, can } = useMe();
  const admin = can('members:admin');
  return (
    <>
      <Head title="Provisioning" sub="Map identity provider groups to Laissez roles, and let your identity provider create and remove members through SCIM." />
      <PermNote perm="members:admin" />
      <div class="grid2">
        <GroupMapping admin={admin} />
        <ScimToken admin={admin} isSandbox={isSandbox} />
      </div>
    </>
  );
}

function GroupMapping({ admin }: { admin: boolean }) {
  const r = useApi('/v1/sso/groups');
  const [claim, setClaim] = useState('groups');
  const [rows, setRows] = useState<{ group: string; role: Role }[]>([]);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (r.data) { setClaim(r.data.group_claim ?? 'groups'); setRows(r.data.group_roles ?? []); } }, [r.data]);
  const save = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null); setSaved(false);
    try { await api('/v1/sso/groups', { method: 'PUT', body: { group_claim: claim.trim() || 'groups', group_roles: rows.filter((x) => x.group.trim()).map((x) => ({ group: x.group.trim(), role: x.role })) } }); setSaved(true); r.reload(); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  if (r.loading && !r.data) return <Card title="Group to role mapping"><Loading /></Card>;
  if (r.error) return <Card title="Group to role mapping"><ErrorBox error={r.error} onRetry={r.reload} /></Card>;
  return (
    <Card title="Group to role mapping" actions={rows.length ? <Chip tone="ok">{rows.length} rule{rows.length === 1 ? '' : 's'}</Chip> : <Chip>Default role only</Chip>}>
      <p class="muted">When someone signs in through single sign-on, the first group below that they belong to sets their role, and their membership is updated to match. People in none of these groups keep their role, or join with the default role.</p>
      {!r.data.configured ? <div class="note">Connect an identity provider on the Single sign-on page first.</div> : null}
      <form class="form-grid one" onSubmit={save}>
        <fieldset class="plain-fs" disabled={!admin || !r.data.configured}>
          <Field label="Group claim" hint="The ID token claim that carries group names. Okta and Entra ID send groups; Google Workspace needs a custom claim."><input value={claim} maxLength={60} onInput={(e) => { setClaim((e.target as HTMLInputElement).value); setSaved(false); }} placeholder="groups" /></Field>
          <div class="tw"><table class="t">
            <thead><tr><th>Group</th><th>Role</th><th /></tr></thead>
            <tbody>
              {rows.map((x, i) => (
                <tr>
                  <td><input value={x.group} maxLength={120} aria-label={`Group ${i + 1}`} placeholder="laissez-compliance" onInput={(e) => { const v = (e.target as HTMLInputElement).value; setRows(rows.map((y, j) => (j === i ? { ...y, group: v } : y))); setSaved(false); }} /></td>
                  <td><select value={x.role} aria-label={`Role for group ${i + 1}`} onChange={(e) => { const v = (e.target as HTMLSelectElement).value as Role; setRows(rows.map((y, j) => (j === i ? { ...y, role: v } : y))); setSaved(false); }}>{ROLES.map((ro) => <option value={ro}>{ROLE_LABEL[ro]}</option>)}</select></td>
                  <td><Btn kind="ghost" onClick={() => { setRows(rows.filter((_, j) => j !== i)); setSaved(false); }}>Remove</Btn></td>
                </tr>
              ))}
              {!rows.length ? <tr><td colSpan={3} class="muted">No rules yet. Everyone joins with the default role from the Single sign-on page.</td></tr> : null}
            </tbody>
          </table></div>
          <div class="row-inline tight"><Btn kind="ghost" onClick={() => setRows([...rows, { group: '', role: 'ops' }])} disabled={rows.length >= 50}>Add a group</Btn><span class="small muted">Order matters: the first matching group wins.</span></div>
        </fieldset>
        <div class="form-actions"><PermBtn perm="members:admin" type="submit" kind="primary" busy={busy} disabled={!r.data.configured}>Save mapping</PermBtn>{saved ? <span class="ok-text" role="status">Saved. It applies at the next sign-in.</span> : null}</div>
      </form>
      <ErrorBox error={err} />
    </Card>
  );
}

function ScimToken({ admin, isSandbox }: { admin: boolean; isSandbox: boolean }) {
  const r = useApi('/v1/scim');
  const [fresh, setFresh] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const generate = async () => { setBusy(true); setErr(null); try { setFresh(await api('/v1/scim/token', { body: {} })); r.reload(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const revoke = async () => { setErr(null); try { await api('/v1/scim/token', { method: 'DELETE' }); setFresh(null); r.reload(); } catch (e) { setErr(e); } };
  const d = r.data;
  return (
    <Card title="SCIM provisioning" actions={d ? (d.configured ? <Chip tone="ok">Token active</Chip> : <Chip>Not set up</Chip>) : null}>
      {r.loading && !d ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : (
        <>
          <p class="muted">Your identity provider creates members, updates their names and roles, and removes them when they leave. Removing a member also signs out their sessions. SCIM 2.0, Users resource, bearer token.</p>
          <Field label="SCIM base URL"><div class="reveal-row"><code class="break">{d.base_url}</code><Copy text={d.base_url} /></div></Field>
          <dl class="kv wide">
            <div><dt>Supported</dt><dd>GET, POST /Users, GET, PUT, PATCH, DELETE /Users/:id, filter userName eq, ServiceProviderConfig</dd></div>
            <div><dt>Token</dt><dd>{d.configured ? `Created ${when(d.token_created_at)}` : 'None'}</dd></div>
            <div><dt>Members provisioned</dt><dd>{d.provisioned_members}</dd></div>
          </dl>
          {isSandbox ? <div class="note">SCIM is for organizations. Keep this sandbox as an organization to turn it on.</div> : null}
          {fresh ? <Reveal label="SCIM bearer token" value={fresh.token} note="Paste it into your identity provider now. It is shown once. Generating another token replaces it." /> : null}
          <div class="form-actions">
            <PermBtn perm="members:admin" kind="primary" busy={busy} onClick={generate} disabled={isSandbox || !admin}>{d.configured ? 'Generate a new token' : 'Generate token'}</PermBtn>
            {d.configured && admin ? <ConfirmBtn kind="ghost" confirm="Revoke the SCIM token" onConfirm={revoke}>Revoke</ConfirmBtn> : null}
          </div>
          <ErrorBox error={err} />
        </>
      )}
    </Card>
  );
}

// ---------- Organization lifecycle ----------
function download(name: string, data: unknown) {
  const b = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function Organization() {
  const { me, isSandbox } = useMe();
  return (
    <>
      <Head title={isSandbox ? 'Keep or export this sandbox' : 'Organization'} sub={isSandbox ? 'A sandbox is deleted after 7 days. Keep it as a real organization, with your account as its first administrator, or take the data with you.' : `Export everything in ${me!.workspace.name}, or delete the organization for good.`} />
      {isSandbox ? <div class="grid2"><KeepSandbox /><ExportCard /></div> : <><SettlementMode /><div class="grid2"><ExportCard /><DeleteOrg /></div></>}
    </>
  );
}

/** Full: Laissez decides and settles. Decide-only: Laissez decides and keeps the evidence; the customer settles on its own rails. */
function SettlementMode() {
  const { me, can, reload } = useMe();
  const mode = me!.workspace.settlement_mode ?? 'full';
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const set = async (next: 'full' | 'decide_only') => {
    setBusy(true); setErr(null); setSaved(null);
    try { await api('/v1/organization', { method: 'PATCH', body: { settlement_mode: next } }); await reload(); setSaved(next); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Card title="Settlement mode" actions={<Chip tone={mode === 'decide_only' ? 'warn' : 'ok'}>{mode === 'decide_only' ? 'Decide-only' : 'Full'}</Chip>}>
      <p class="muted">{mode === 'decide_only'
        ? 'Laissez returns decisions and signed evidence. Settlement, batch settlement and chain actions are closed, and your operations team settles on your own rails. Pre-trade checks, credentials, monitoring and the audit log work as before.'
        : 'Laissez decides and settles both legs. Switch to decide-only when your bank settles on its own rails and wants Laissez for eligibility, evidence and monitoring only. Changing the mode asks for your passkey.'}</p>
      {!can('members:admin') ? <PermNote perm="members:admin" /> : null}
      <div class="form-actions">
        {mode === 'decide_only'
          ? <PermBtn perm="members:admin" kind="primary" busy={busy} onClick={() => set('full')}>Switch to full settlement</PermBtn>
          : <PermBtn perm="members:admin" kind="primary" busy={busy} onClick={() => set('decide_only')}>Switch to decide-only</PermBtn>}
      </div>
      {saved ? <p class="ok-text" role="status">Settlement mode is now {saved === 'decide_only' ? 'decide-only' : 'full'}. Recorded in the audit log.</p> : null}
      <ErrorBox error={err} />
    </Card>
  );
}

function ExportCard() {
  const { me, isSandbox, can } = useMe();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [done, setDone] = useState<any>(null);
  const run = async () => {
    setBusy(true); setErr(null); setDone(null);
    try {
      const d = await api(isSandbox ? '/v1/sandbox/export' : '/v1/organization/export');
      download(`laissez-${d.workspace?.slug ?? 'export'}.json`, d);
      setDone(d.counts);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const perm = isSandbox ? 'read' : 'members:admin';
  return (
    <Card title={isSandbox ? 'Export sandbox' : 'Export organization'}>
      <p class="muted">{isSandbox ? 'One JSON file with clients, credentials, classifications, funds, distribution rules, holdings, decisions, settlements, policy changes and the audit log with its hash chain.' : 'One JSON file with every client, fund, decision and settlement, plus members, API key metadata (never the keys), webhook endpoints (never the secrets), work items and the audit log with its hash chain.'}</p>
      {!isSandbox && !can(perm) ? <PermNote perm={perm} /> : null}
      <div class="form-actions"><PermBtn perm={perm} kind="primary" busy={busy} onClick={run}>Download JSON</PermBtn></div>
      {done ? <p class="ok-text" role="status">Exported {Object.entries(done).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ')}.</p> : null}
      <ErrorBox error={err} />
      {isSandbox ? <p class="small muted">The export is a record, not a backup you can restore. Keep the sandbox as an organization if you want to carry on working in it.</p> : <p class="small muted">Exports are recorded in the audit log. {me!.workspace.name} keeps working as before.</p>}
    </Card>
  );
}

function KeepSandbox() {
  const { me, reload } = useMe();
  const st = useApi('/v1/sandbox/convert');
  const [f, setF] = useState({ name: me!.user?.name && me!.user.name !== 'You (guest)' ? me!.user.name : '', email: me!.user?.email && !me!.user.email.endsWith('.sandbox') ? me!.user.email : '', org: me!.workspace.name.replace(/ sandbox$/i, '') });
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const steps = st.data?.steps ?? { profile: false, passkey: false };
  const saveProfile = async (e: Event) => {
    e.preventDefault(); setBusy('profile'); setErr(null);
    try { await api('/v1/me', { method: 'PATCH', body: { name: f.name.trim(), email: f.email.trim() } }); await reload(); st.reload(); } catch (x) { setErr(x); } finally { setBusy(null); }
  };
  const addPasskey = async () => {
    setBusy('passkey'); setErr(null);
    try {
      const o = await api('/v1/passkeys/options', { body: {} });
      const credential = await createPasskey(o.options);
      await api('/v1/passkeys/verify', { body: { challenge_id: o.challenge_id, credential, name: 'First passkey' } });
      st.reload();
    } catch (x) { setErr(x); } finally { setBusy(null); }
  };
  const convert = async () => {
    setBusy('convert'); setErr(null);
    try { const r = await api('/v1/sandbox/convert', { body: { org_name: f.org.trim() } }); setResult(r); await reload(); } catch (x) { setErr(x); } finally { setBusy(null); }
  };
  if (result) {
    return (
      <Card title="This is your organization now">
        <p>{result.workspace.name} no longer expires. {result.removed_teammates} fictional teammates were removed; the fictional clients and funds stay until you delete them. The demo identity provider is disconnected.</p>
        <ul class="gate-list">
          <li><a href="#/settings/members">Invite your team</a></li>
          <li><a href="#/settings/sso">Connect your identity provider</a></li>
          <li><a href="#/settings/api-keys">Create production API keys</a></li>
        </ul>
      </Card>
    );
  }
  return (
    <Card title="Keep this sandbox as an organization" actions={st.data?.ready ? <Chip tone="ok">Ready</Chip> : <Chip>2 steps</Chip>}>
      <PermNote perm="members:admin" />
      <ErrorBox error={err} />
      <ol class="steps-num">
        <li>
          <strong>Your name and work email</strong> {steps.profile ? <Chip tone="ok">Done</Chip> : null}
          <p class="small muted">The organization needs an owner who can sign back in. Your sandbox guest identity becomes a real account.</p>
          <form class="form-grid" onSubmit={saveProfile}>
            <Field label="Your name"><input required minLength={2} value={f.name} onInput={(e) => setF({ ...f, name: (e.target as HTMLInputElement).value })} placeholder="Elena Marsh" /></Field>
            <Field label="Work email"><input type="email" required value={f.email} onInput={(e) => setF({ ...f, email: (e.target as HTMLInputElement).value })} placeholder="elena@harbourline.example" /></Field>
            <div class="form-actions"><Btn type="submit" kind={steps.profile ? 'default' : 'primary'} busy={busy === 'profile'}>{steps.profile ? 'Update' : 'Save'}</Btn></div>
          </form>
        </li>
        <li>
          <strong>A passkey</strong> {steps.passkey ? <Chip tone="ok">Done</Chip> : null}
          <p class="small muted">Face ID, Touch ID, Windows Hello or a security key. Without one there is no way back in after this browser session ends.</p>
          <Btn kind={steps.profile && !steps.passkey ? 'primary' : 'default'} disabled={!steps.profile} busy={busy === 'passkey'} onClick={addPasskey}>{busy === 'passkey' ? 'Waiting for your device' : steps.passkey ? `Add another (${st.data?.passkeys} so far)` : 'Add a passkey'}</Btn>
        </li>
        <li>
          <strong>Name the organization</strong>
          <Field label="Organization name"><input required minLength={2} maxLength={80} value={f.org} onInput={(e) => setF({ ...f, org: (e.target as HTMLInputElement).value })} placeholder="Harbourline Capital" /></Field>
          <PermBtn perm="members:admin" kind="primary" disabled={!st.data?.ready || f.org.trim().length < 2} busy={busy === 'convert'} onClick={convert}>Keep as an organization</PermBtn>
          <p class="small muted">The sandbox stops expiring, gets a new address, loses its three fictional teammates and the demo identity provider. Data, API keys and the audit log carry over.</p>
        </li>
      </ol>
    </Card>
  );
}

function DeleteOrg() {
  const { me, can, signOut } = useMe();
  const [name, setName] = useState('');
  const [exported, setExported] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const w = me!.workspace;
  const run = async () => {
    setBusy(true); setErr(null);
    try { setResult(await api('/v1/organization', { method: 'DELETE', body: { confirm_name: name.trim() } })); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  if (result) {
    return (
      <Card title={`${result.name} was deleted`}>
        <p>Everything in it is gone. A deletion record keeps the name, who deleted it and the hash of the final export: <code class="break">{result.export_sha256}</code></p>
        <p class="small muted">{result.note}</p>
        <div class="form-actions">
          {result.remaining_organizations?.length ? <Btn kind="primary" onClick={() => location.reload()}>Continue in another organization</Btn> : <Btn kind="primary" onClick={signOut}>Sign out</Btn>}
        </div>
      </Card>
    );
  }
  return (
    <Card title="Delete this organization">
      <p class="muted">Removes every client, fund, holding, decision, settlement, member, API key, webhook and the audit log. The members lose access immediately. This cannot be undone.</p>
      <PermNote perm="members:admin" />
      <fieldset class="plain-fs" disabled={!can('members:admin')}>
        <label class="check"><input type="checkbox" checked={exported} onChange={(e) => setExported((e.target as HTMLInputElement).checked)} /> I have downloaded the export, or I do not need it.</label>
        <Field label={`Type the organization name to confirm: ${w.name}`}><input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder={w.name} autoComplete="off" /></Field>
      </fieldset>
      <div class="form-actions"><ConfirmBtn confirm={`Delete ${w.name} for good`} disabled={!can('members:admin') || !exported || name.trim() !== w.name || busy} onConfirm={run}>Delete organization</ConfirmBtn></div>
      <ErrorBox error={err} />
      <p class="small muted">Laissez keeps a deletion record (name, who, when, hash of the final export) and nothing else.</p>
    </Card>
  );
}

// ---------- API keys page: usage and last used from ----------
export function KeysExtras({ data }: { data: any }) {
  if (!data) return null;
  const u = data.usage;
  const keys: any[] = data.data ?? [];
  const pct = u ? Math.min(100, Math.round((u.used / Math.max(1, u.quota)) * 100)) : 0;
  const withUse = keys.filter((k) => k.last_used_from);
  return (
    <div class="grid2">
      {u ? (
        <Card title="Usage this month" actions={<Chip tone={pct >= 100 ? 'no' : pct >= 80 ? 'warn' : 'ok'}>{pct}% of quota</Chip>}>
          <dl class="kv wide">
            <div><dt>Requests</dt><dd>{u.used.toLocaleString('en-US')} of {u.quota.toLocaleString('en-US')}</dd></div>
            <div><dt>Resets</dt><dd>{day(u.resets_at)}</dd></div>
            <div><dt>Per-minute limits</dt><dd>{u.rate_limits.key_per_minute} per API key, {u.rate_limits.session_per_minute} per signed-in session</dd></div>
          </dl>
          <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Monthly quota used" style={{ height: '8px', borderRadius: '4px', background: 'rgba(0,0,0,.08)', overflow: 'hidden' }}><div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? '#a23b2a' : pct >= 80 ? '#b8975a' : '#1f3a33' }} /></div>
          <p class="small muted">Every authenticated request counts, from keys and from people. Responses carry X-RateLimit-Limit, X-RateLimit-Remaining and X-RateLimit-Reset; a 429 carries Retry-After. Past the quota the API answers 429 quota_exceeded until the month resets.</p>
        </Card>
      ) : null}
      <Card title="Last used from">
        {withUse.length ? (
          <div class="tw"><table class="t">
            <thead><tr><th>Key</th><th>Where</th><th>Client</th><th>Networks seen</th></tr></thead>
            <tbody>{withUse.map((k) => (
              <tr>
                <td><strong>{k.name}</strong><div class="small muted"><code>{k.prefix}…</code> {k.last_used_at ? when(k.last_used_at) : ''}</div></td>
                <td>{k.last_used_from.country ? COUNTRY(k.last_used_from.country) : <span class="muted">Unknown</span>}{k.last_used_from.network ? <div class="small muted">network {k.last_used_from.network}</div> : null}</td>
                <td class="small">{k.last_used_from.user_agent ? k.last_used_from.user_agent.slice(0, 60) : <span class="muted">Unknown</span>}</td>
                <td>{k.known_networks}{k.known_networks >= 20 ? <span class="small muted"> (max)</span> : null}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <p class="muted">No key has been used yet. Once one is, this shows the country, the client and how many distinct networks it has called from.</p>}
        <p class="small muted">The first call from a network the key has not used before is written to the audit log as api_key.new_network and emailed to every administrator. Restrict a key to known addresses with an IP allowlist.</p>
      </Card>
    </div>
  );
}
