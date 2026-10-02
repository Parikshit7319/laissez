/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { api, getKey, when, day } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Loading, Empty, Field, Card, Copy, Reveal, ConfirmBtn } from '../ui';
import { useMe, PermBtn, PermNote, ROLE_LABEL, type Role } from '../auth';
import { createPasskey } from '../webauthn';
import { KeysExtras } from './settings2';

const ROLE_HELP: Record<Role, string> = {
  admin: 'Everything, including members, single sign-on and keys',
  ops: 'Clients, credentials, orders and settlement',
  compliance: 'Clients, screening, rule drafts, policy approval and audit export',
  issuer: 'Funds, policy proposals and policy approval',
  developer: 'Webhooks and API keys, read access to the rest',
  auditor: 'Read everything and export the audit log',
};
const ROLES = Object.keys(ROLE_LABEL) as Role[];

// ---------- Members ----------
export function Members() {
  const { me, can, isSandbox } = useMe();
  const admin = can('members:admin');
  const r = useApi('/v1/members');
  const inv = useApi(admin ? '/v1/invites' : null);
  const [err, setErr] = useState<any>(null);
  const [f, setF] = useState({ email: '', role: 'ops' as Role });
  const [link, setLink] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const roles: { id: Role; label: string }[] = r.data?.roles ?? ROLES.map((id) => ({ id, label: ROLE_LABEL[id] }));
  const setRole = async (id: string, role: string) => {
    setErr(null);
    try { await api(`/v1/members/${id}`, { method: 'PATCH', body: { role } }); r.reload(); } catch (e) { setErr(e); r.reload(); }
  };
  const remove = async (id: string) => { setErr(null); try { await api(`/v1/members/${id}`, { method: 'DELETE' }); r.reload(); } catch (e) { setErr(e); } };
  const invite = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null); setLink(null);
    try { setLink(await api('/v1/invites', { body: { email: f.email.trim(), role: f.role } })); setF({ ...f, email: '' }); inv.reload(); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const revoke = async (id: string) => { setErr(null); try { await api(`/v1/invites/${id}`, { method: 'DELETE' }); inv.reload(); } catch (e) { setErr(e); } };
  const pending = (inv.data?.data ?? []).filter((i: any) => !i.accepted_at && new Date(i.expires_at).getTime() > Date.now());
  return (
    <>
      <Head title="Members" sub={isSandbox ? 'People in this sandbox. The three teammates are fictional, so you can try two-person approval on your own.' : `People who can sign in to ${me!.workspace.name}, and what each role allows.`} />
      <PermNote perm="members:admin" />
      <ErrorBox error={err} />
      <Card pad={false}>
        {r.loading && !r.data ? <div class="pad"><Loading /></div> : r.error ? <div class="pad"><ErrorBox error={r.error} onRetry={r.reload} /></div> : (
          <div class="tw"><table class="t">
            <thead><tr><th>Person</th><th>Role</th><th>Last sign-in</th><th /></tr></thead>
            <tbody>{r.data.data.map((m: any) => {
              const self = m.id === me!.user?.id;
              return (
                <tr>
                  <td>
                    <div class="person"><strong>{m.name}</strong>{self ? <Chip tone="brass">You</Chip> : null}{m.fictional ? <Chip tone="info">Fictional</Chip> : null}</div>
                    <div class="small muted">{m.title ? `${m.title}. ` : ''}{m.email && !m.email.endsWith('.sandbox') ? m.email : ''}</div>
                  </td>
                  <td>
                    {admin ? (
                      <select class="sm" value={m.role} aria-label={`Role for ${m.name}`} onChange={(e) => setRole(m.id, (e.target as HTMLSelectElement).value)}>
                        {roles.map((x) => <option value={x.id}>{x.label}</option>)}
                      </select>
                    ) : <span>{ROLE_LABEL[m.role as Role] ?? m.role_label ?? m.role}</span>}
                    <div class="small muted">{ROLE_HELP[m.role as Role]}</div>
                  </td>
                  <td class="muted nowrap">{m.last_login_at ? when(m.last_login_at) : m.fictional ? 'Fictional' : 'Never'}</td>
                  <td>{admin && !self ? <ConfirmBtn confirm={`Remove ${m.name.split(' ')[0]}`} onConfirm={() => remove(m.id)}>Remove</ConfirmBtn> : null}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>
      {admin ? (
        <div class="grid2">
          <Card title="Invite someone">
            <form class="form-grid" onSubmit={invite}>
              <Field label="Work email"><input type="email" required value={f.email} onInput={(e) => setF({ ...f, email: (e.target as HTMLInputElement).value })} placeholder="colleague@yourcompany.com" /></Field>
              <Field label="Role"><select value={f.role} onChange={(e) => setF({ ...f, role: (e.target as HTMLSelectElement).value as Role })}>{roles.map((x) => <option value={x.id}>{x.label}</option>)}</select></Field>
              <p class="span2 small muted">{ROLE_HELP[f.role]}.</p>
              <div class="form-actions"><Btn type="submit" kind="primary" busy={busy}>Create invite link</Btn></div>
            </form>
            {link ? <Reveal label={`Invite link for ${link.email}`} value={link.link} note={<>{link.note ?? 'It is shown once, works once and expires in 7 days.'} {link.email_status && link.email_status !== 'sent' ? <a href="#/settings/outbox">See it in the Outbox.</a> : null}</>} /> : null}
          </Card>
          <Card title="Pending invites" pad={false}>
            {inv.loading && !inv.data ? <div class="pad"><Loading /></div> : pending.length ? (
              <div class="tw"><table class="t">
                <thead><tr><th>Email</th><th>Role</th><th>Expires</th><th /></tr></thead>
                <tbody>{pending.map((i: any) => <tr><td>{i.email}</td><td>{ROLE_LABEL[i.role as Role] ?? i.role}</td><td class="muted nowrap">{day(i.expires_at)}</td><td><ConfirmBtn kind="ghost" confirm="Revoke invite" onConfirm={() => revoke(i.id)}>Revoke</ConfirmBtn></td></tr>)}</tbody>
              </table></div>
            ) : <div class="pad"><Empty title="No pending invites">Links you create appear here until they are used or expire.</Empty></div>}
          </Card>
        </div>
      ) : null}
    </>
  );
}

// ---------- Single sign-on ----------
export function SingleSignOn() {
  const { isSandbox, can } = useMe();
  const r = useApi('/v1/sso');
  const admin = can('members:admin');
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const d = r.data;
  const cfg = d.config;
  const tryIt = () => { location.href = `${d.start_url}&origin=${encodeURIComponent(location.origin)}`; };
  if (isSandbox) {
    return (
      <>
        <Head title="Single sign-on" sub="Sandboxes come connected to a demo identity provider, so you can see the whole OpenID Connect flow without setting anything up." actions={<Btn kind="primary" onClick={tryIt}>Try single sign-on</Btn>} />
        <div class="grid2">
          <Card title="Demo identity provider" actions={cfg?.enabled ? <Chip tone="ok">Enabled</Chip> : <Chip>Off</Chip>}>
            {cfg ? (
              <dl class="kv wide">
                <div><dt>Name</dt><dd>{cfg.label}</dd></div>
                <div><dt>Issuer</dt><dd><code class="break">{cfg.issuer}</code></dd></div>
                <div><dt>Client ID</dt><dd><code>{cfg.client_id}</code></dd></div>
                <div><dt>Email domain</dt><dd>{cfg.email_domain}</dd></div>
                <div><dt>New people join as</dt><dd>{ROLE_LABEL[cfg.default_role as Role] ?? cfg.default_role}</dd></div>
              </dl>
            ) : <Empty title="No identity provider connected" />}
            <p class="small muted">Read-only in sandboxes. Create an account to connect Okta, Microsoft Entra ID, Google Workspace or any OpenID Connect provider.</p>
          </Card>
          <Card title="What happens when you try it">
            <ol class="steps-num">
              <li>Laissez sends you to the demo identity provider with a PKCE challenge.</li>
              <li>You pick one of its fictional people and sign in.</li>
              <li>Laissez checks the signed ID token, its issuer, audience and nonce.</li>
              <li>First-time people join this sandbox as {ROLE_LABEL[cfg?.default_role as Role] ?? 'the default role'}, and the audit log records it.</li>
            </ol>
            <p class="small muted">You come back signed in as that person. Your guest session is replaced, so keep this tab if you want to compare.</p>
          </Card>
        </div>
      </>
    );
  }
  return (
    <>
      <Head title="Single sign-on" sub="Let your team sign in with your company identity provider over OpenID Connect. People who sign in for the first time join with the default role." actions={cfg?.enabled ? <Btn onClick={tryIt}>Test sign-in</Btn> : null} />
      <PermNote perm="members:admin" />
      <div class="grid2">
        <SsoForm cfg={cfg} admin={admin} onSaved={r.reload} />
        <Card title="Values for your identity provider">
          <Field label="Redirect URI" hint="Paste this into your identity provider when you register Laissez as an application.">
            <div class="reveal-row"><code class="break">{d.redirect_uri}</code><Copy text={d.redirect_uri} /></div>
          </Field>
          <Field label="Sign-in link" hint="Bookmark or share this. It starts single sign-on for this organization directly.">
            <div class="reveal-row"><code class="break">{d.start_url}</code><Copy text={d.start_url} /></div>
          </Field>
          <p class="small muted">Scopes requested: openid, email, profile. Laissez uses the authorization code flow with PKCE and verifies the ID token signature against your provider's published keys.</p>
        </Card>
      </div>
    </>
  );
}

function SsoForm({ cfg, admin, onSaved }: { cfg: any; admin: boolean; onSaved: () => void }) {
  const [f, setF] = useState({ issuer: cfg?.issuer ?? '', client_id: cfg?.client_id ?? '', client_secret: '', email_domain: cfg?.email_domain ?? '', default_role: (cfg?.default_role ?? 'auditor') as Role, enabled: cfg?.enabled ?? true });
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const set = (k: string, v: unknown) => { setF({ ...f, [k]: v }); setSaved(false); };
  const save = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = { issuer: f.issuer.trim(), client_id: f.client_id.trim(), email_domain: f.email_domain.trim().toLowerCase(), default_role: f.default_role, enabled: f.enabled };
      if (f.client_secret) body.client_secret = f.client_secret;
      await api('/v1/sso', { method: 'PUT', body });
      setSaved(true); setF({ ...f, client_secret: '' }); onSaved();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Card title="Identity provider" actions={cfg ? (cfg.enabled ? <Chip tone="ok">Enabled</Chip> : <Chip>Off</Chip>) : <Chip>Not set up</Chip>}>
      <form class="form-grid one" onSubmit={save}>
        <fieldset class="plain-fs" disabled={!admin}>
          <Field label="Issuer URL" hint="Laissez reads /.well-known/openid-configuration from here."><input type="url" required value={f.issuer} onInput={(e) => set('issuer', (e.target as HTMLInputElement).value)} placeholder="https://yourcompany.okta.com" /></Field>
          <Field label="Client ID"><input required value={f.client_id} onInput={(e) => set('client_id', (e.target as HTMLInputElement).value)} placeholder="0oa8f2k1laissez" /></Field>
          <Field label="Client secret" hint={cfg?.has_secret ? 'A secret is saved and encrypted. Leave this empty to keep it.' : 'Stored encrypted. Never shown again.'}><input type="password" autoComplete="off" value={f.client_secret} required={!cfg?.has_secret} onInput={(e) => set('client_secret', (e.target as HTMLInputElement).value)} placeholder={cfg?.has_secret ? 'Saved' : ''} /></Field>
          <Field label="Email domain" hint="Only people with this domain can sign in through single sign-on."><input required value={f.email_domain} onInput={(e) => set('email_domain', (e.target as HTMLInputElement).value)} placeholder="yourcompany.com" /></Field>
          <Field label="Default role for new people"><select value={f.default_role} onChange={(e) => set('default_role', (e.target as HTMLSelectElement).value)}>{ROLES.map((x) => <option value={x}>{ROLE_LABEL[x]}</option>)}</select></Field>
          <label class="check"><input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', (e.target as HTMLInputElement).checked)} /> Allow sign-in through this identity provider</label>
        </fieldset>
        <div class="form-actions"><PermBtn perm="members:admin" type="submit" kind="primary" busy={busy}>Save single sign-on</PermBtn>{saved ? <span class="ok-text" role="status">Saved. Laissez reached your identity provider.</span> : null}</div>
      </form>
      <ErrorBox error={err} />
    </Card>
  );
}

// ---------- Security ----------
function device(ua = '') {
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ua ? 'Browser' : 'Unknown browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${b} on ${os}` : b;
}
const METHOD: Record<string, string> = { passkey: 'Passkey', sso: 'Single sign-on', sandbox: 'Sandbox', switch: 'Organization switch', invite: 'Invite' };

export function Security() {
  const { me, isSandbox, signOut } = useMe();
  const isKey = !me!.user;
  const s = useApi(isKey ? null : '/v1/sessions');
  const p = useApi(isKey || isSandbox ? null : '/v1/passkeys');
  const [err, setErr] = useState<any>(null);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const revoke = async (id: string) => { setErr(null); try { await api(`/v1/sessions/${id}`, { method: 'DELETE' }); s.reload(); } catch (e) { setErr(e); } };
  const addPasskey = async () => {
    // Every passkey gets a name, so they can be told apart later. Ask when the field was left empty.
    let label = name.trim();
    if (!label) { const typed = window.prompt('Name this passkey, for example "Work laptop" or "YubiKey".', 'Work laptop'); if (typed === null) return; label = typed.trim() || 'Passkey'; }
    setAdding(true); setErr(null); setAdded(false);
    try {
      const o = await api('/v1/passkeys/options', { body: {} });
      const credential = await createPasskey(o.options);
      await api('/v1/passkeys/verify', { body: { challenge_id: o.challenge_id, credential, name: label.slice(0, 60) } });
      setName(''); setAdded(true); p.reload();
    } catch (e) { setErr(e); } finally { setAdding(false); }
  };
  const removePasskey = async (id: string) => { setErr(null); try { await api(`/v1/passkeys/${id}`, { method: 'DELETE' }); p.reload(); } catch (e) { setErr(e); } };
  if (isKey) return <><Head title="Security" /><div class="note">You are using an API key, not a signed-in session. Sessions and passkeys belong to people. Sign in with a passkey or single sign-on to manage them.</div></>;
  return (
    <>
      <Head title="Security" sub="Where you are signed in, and the passkeys that can sign you in. Laissez has no passwords to leak or reset." />
      <ErrorBox error={err} />
      <p class="small muted">Locations, signing out everywhere else and recovery codes are on <a href="#/settings/sessions">Sessions and recovery</a>.</p>
      <Card title="Signed-in sessions" pad={false}>
        {s.loading && !s.data ? <div class="pad"><Loading /></div> : s.error ? <div class="pad"><ErrorBox error={s.error} onRetry={s.reload} /></div> : (
          <div class="tw"><table class="t">
            <thead><tr><th>Device</th><th>Signed in with</th><th>Organization</th><th>Last active</th><th>Ends</th><th /></tr></thead>
            <tbody>{s.data.data.map((x: any) => (
              <tr>
                <td><strong>{device(x.user_agent)}</strong>{x.current ? <Chip tone="brass">This browser</Chip> : null}</td>
                <td>{METHOD[x.method] ?? x.method}</td>
                <td>{x.organization}</td>
                <td class="muted nowrap">{when(x.last_seen_at)}</td>
                <td class="muted nowrap">{day(x.expires_at)}</td>
                <td>{x.current ? <Btn kind="ghost" onClick={signOut}>Sign out</Btn> : <ConfirmBtn kind="ghost" confirm="Sign out that session" onConfirm={() => revoke(x.id)}>Revoke</ConfirmBtn>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {isSandbox ? (
        <Card title="Passkeys">
          <p class="muted">Passkeys belong to accounts. In a sandbox this browser holds your session, so there is nothing to add. Create an account to sign in with Face ID, Touch ID, Windows Hello or a security key.</p>
        </Card>
      ) : (
        <Card title="Passkeys" actions={<span class="muted small">Face ID, Touch ID, Windows Hello or a security key</span>}>
          {p.loading && !p.data ? <Loading /> : p.error ? <ErrorBox error={p.error} onRetry={p.reload} /> : (
            <div class="tw"><table class="t">
              <thead><tr><th>Name</th><th>Added</th><th>Last used</th><th /></tr></thead>
              <tbody>{p.data.data.map((k: any) => (
                <tr>
                  <td><strong>{k.name}</strong><div class="small muted">{(k.transports ?? []).includes('internal') ? 'Built into a device' : (k.transports ?? []).some((t: string) => ['usb', 'nfc', 'ble'].includes(t)) ? 'Security key' : (k.transports ?? []).includes('hybrid') ? 'Phone' : 'Passkey'}</div></td>
                  <td class="muted nowrap">{day(k.created_at)}</td>
                  <td class="muted nowrap">{k.last_used_at ? when(k.last_used_at) : 'Never'}</td>
                  <td><ConfirmBtn kind="ghost" disabled={p.data.data.length <= 1} title={p.data.data.length <= 1 ? 'Add another passkey before removing your only one.' : undefined} confirm="Remove passkey" onConfirm={() => removePasskey(k.id)}>Remove</ConfirmBtn></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          <div class="row-inline">
            <Field label="Name for the new passkey" hint="So you can tell them apart later."><input value={name} maxLength={60} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Work laptop" /></Field>
            <Btn kind="primary" busy={adding} onClick={addPasskey}>{adding ? 'Waiting for your device' : 'Add a passkey'}</Btn>
          </div>
          {added ? <p class="ok-text" role="status">Passkey added. You can sign in with it now.</p> : null}
          {p.data && p.data.data.length <= 1 ? <p class="small muted">You have one passkey. Add a second, on another device or a security key, so losing one device does not lock you out.</p> : null}
        </Card>
      )}
    </>
  );
}

// ---------- API keys ----------
const SCOPES: { id: string; label: string }[] = [
  { id: 'read', label: 'Read everything in the organization' },
  { id: 'orders', label: 'Create decisions and settlements' },
  { id: 'clients', label: 'Manage clients, credentials and shares' },
  { id: 'funds', label: 'Manage funds, NAV, documents and policy proposals' },
  { id: 'compliance', label: 'Screening dispositions, monitoring, work items' },
  { id: 'developer', label: 'Webhooks' },
  { id: 'admin', label: 'Manage API keys' },
];
const SCOPE_NAME: Record<string, string> = { read: 'Read', orders: 'Orders', clients: 'Clients', funds: 'Funds', compliance: 'Compliance', developer: 'Webhooks', admin: 'Key admin' };

export function ApiKeys() {
  const { me, isSandbox } = useMe();
  const r = useApi('/v1/api-keys');
  const [err, setErr] = useState<any>(null);
  const [fresh, setFresh] = useState<{ title: string; key: string; note: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const stored = getKey()?.slice(0, 12);
  const rotate = async (k: any) => {
    setErr(null); setFresh(null);
    try {
      const x = await api(`/v1/api-keys/${k.id}/rotate`, { body: {} });
      const until = x.old_key_expires_at ?? x.previous_expires_at ?? x.old_expires_at ?? x.grace_until ?? x.rotated?.expires_at;
      setFresh({ title: `New key for ${k.name ?? k.prefix}`, key: x.api_key ?? x.key, note: until ? `Store it now. It is shown once. The old key (${k.prefix}…) stops working ${when(until)}.` : `Store it now. It is shown once. The old key (${k.prefix}…) stops working when its grace period ends.` });
      r.reload();
    } catch (e) { setErr(e); }
  };
  const revoke = async (id: string) => { setErr(null); try { await api(`/v1/api-keys/${id}`, { method: 'DELETE' }); r.reload(); } catch (e) { setErr(e); } };
  const status = (k: any) => {
    if (k.expires_at && new Date(k.expires_at).getTime() < Date.now()) return <Chip tone="no">Expired</Chip>;
    if (k.expires_at) return <span class="nowrap">{day(k.expires_at)}</span>;
    return <span class="muted">Never</span>;
  };
  return (
    <>
      <Head title="API keys" sub="Keys start with lz_test_. Laissez stores only a hash, so a key is shown once. Scope each key to what its system needs." actions={<PermBtn perm="keys:admin" kind="primary" onClick={() => setCreating(true)}>Create key</PermBtn>} />
      {isSandbox ? <div class="note">This sandbox, {me!.workspace.name}, and its keys are deleted {me!.workspace.expires_at ? day(me!.workspace.expires_at) : 'after 7 days'}. API keys can propose policy changes but never approve them: approval needs a signed-in person.</div> : null}
      {creating ? <CreateKey onDone={(k) => { setCreating(false); if (k) { setFresh({ title: `New key: ${k.name}`, key: k.api_key, note: 'Store it now. It is shown once.' }); r.reload(); } }} /> : null}
      {fresh ? <Card><Reveal label={fresh.title} value={fresh.key} note={fresh.note} /></Card> : null}
      <ErrorBox error={err} />
      <Card pad={false}>
        {r.loading && !r.data ? <div class="pad"><Loading /></div> : r.error ? <div class="pad"><ErrorBox error={r.error} onRetry={r.reload} /></div> : (r.data?.data ?? []).length ? (
          <div class="tw"><table class="t">
            <thead><tr><th>Key</th><th>Scopes</th><th>IP allowlist</th><th>Expires</th><th>Last used</th><th /></tr></thead>
            <tbody>{r.data.data.map((k: any) => (
              <tr>
                <td><strong>{k.name ?? 'Key'}</strong>{stored && stored === k.prefix ? <Chip tone="brass">Used by the API explorer</Chip> : null}{r.data.data.some((x: any) => x.rotated_from === k.id) ? <Chip tone="warn">Replaced, retiring</Chip> : k.rotated_from ? <Chip tone="info">Rotated</Chip> : null}<div><code>{k.prefix}…</code> <span class="small muted">created {day(k.created_at)}</span></div></td>
                <td>{(k.scopes ?? []).length ? (k.scopes as string[]).map((s) => <Chip title={SCOPES.find((x) => x.id === s)?.label}>{SCOPE_NAME[s] ?? s}</Chip>) : <span class="muted">All</span>}</td>
                <td class="small">{(k.ip_allowlist ?? []).length ? (k.ip_allowlist as string[]).map((c) => <div><code>{c}</code></div>) : <span class="muted">Any address</span>}</td>
                <td>{status(k)}</td>
                <td class="muted nowrap">{k.last_used_at ? when(k.last_used_at) : 'Never'}</td>
                <td><div class="row-inline tight acts">
                  <PermBtn perm="keys:admin" kind="ghost" onClick={() => rotate(k)}>Rotate</PermBtn>
                  <ConfirmBtn kind="ghost" confirm="Revoke now" onConfirm={() => revoke(k.id)}>Revoke</ConfirmBtn>
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <div class="pad"><Empty title="No keys yet">Create a key for each system that calls Laissez.</Empty></div>}
      </Card>
      <p class="small muted">Rotate gives you a new key and keeps the old one working for a short overlap, so you can deploy without downtime. Revoke stops a key immediately.</p>
      <KeysExtras data={r.data} />
    </>
  );
}

function CreateKey({ onDone }: { onDone: (k?: any) => void }) {
  const [f, setF] = useState({ name: '', scopes: ['read'] as string[], ips: '', expiry: '90' });
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (s: string) => setF({ ...f, scopes: f.scopes.includes(s) ? f.scopes.filter((x) => x !== s) : [...f.scopes, s] });
  const ipList = f.ips.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const badIp = ipList.find((c) => !/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(c));
  const submit = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { onDone(await api('/v1/api-keys', { body: { name: f.name.trim(), scopes: f.scopes, ip_allowlist: ipList.length ? ipList : null, expires_in_days: f.expiry === 'never' ? null : Number(f.expiry) } })); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Card title="Create an API key">
      <form class="form-grid" onSubmit={submit}>
        <Field label="Name" hint="What uses this key, for example the order management system."><input required maxLength={60} value={f.name} onInput={(e) => setF({ ...f, name: (e.target as HTMLInputElement).value })} placeholder="Order management system" /></Field>
        <Field label="Expires"><select value={f.expiry} onChange={(e) => setF({ ...f, expiry: (e.target as HTMLSelectElement).value })}><option value="never">Never</option><option value="30">In 30 days</option><option value="90">In 90 days</option><option value="365">In 365 days</option></select></Field>
        <div class="span2"><span class="f-l">Scopes</span>
          <div class="scopes">{SCOPES.map((s) => <label class={`scope ${f.scopes.includes(s.id) ? 'on' : ''}`}><input type="checkbox" checked={f.scopes.includes(s.id)} onChange={() => toggle(s.id)} /><span><b>{SCOPE_NAME[s.id]}</b><em>{s.label}</em></span></label>)}</div>
        </div>
        <div class="span2"><Field label="IP allowlist" hint={badIp ? `${badIp} is not an IP address or CIDR range.` : 'One IP address or CIDR range per line. Leave empty to allow any address.'}><textarea class="mono" rows={3} value={f.ips} onInput={(e) => setF({ ...f, ips: (e.target as HTMLTextAreaElement).value })} placeholder={'203.0.113.0/24\n2001:db8::/32'} /></Field></div>
        <div class="form-actions"><Btn type="submit" kind="primary" busy={busy} disabled={!f.scopes.length || !!badIp}>Create key</Btn><Btn kind="ghost" onClick={() => onDone()}>Cancel</Btn>{!f.scopes.length ? <span class="muted small">Choose at least one scope.</span> : null}</div>
      </form>
      <ErrorBox error={err} />
    </Card>
  );
}

// ---------- Branding ----------
function readableOn(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? '#171512' : '#ffffff';
}

export function Branding() {
  const { me, can, reload } = useMe();
  const w = me!.workspace;
  const [f, setF] = useState({ brand_name: w.brand_name ?? w.name, brand_color: w.brand_color ?? '#1f3a33' });
  const [hex, setHex] = useState(f.brand_color);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const admin = can('members:admin');
  useEffect(() => setHex(f.brand_color), [f.brand_color]);
  const save = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null); setSaved(false);
    try { await api('/v1/organization', { method: 'PATCH', body: { brand_name: f.brand_name.trim(), brand_color: f.brand_color } }); await reload(); setSaved(true); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const fg = readableOn(f.brand_color);
  return (
    <>
      <Head title="Branding" sub="How your name and color appear to investors in the investor portal and on documents Laissez generates for you." />
      <PermNote perm="members:admin" />
      <div class="grid2">
        <Card title="Brand">
          <form class="form-grid one" onSubmit={save}>
            <fieldset class="plain-fs" disabled={!admin}>
              <Field label="Brand name" hint="Shown to investors. Usually your legal or trading name."><input required minLength={2} maxLength={80} value={f.brand_name} onInput={(e) => { setF({ ...f, brand_name: (e.target as HTMLInputElement).value }); setSaved(false); }} /></Field>
              <Field label="Brand color" hint="Pick a dark or saturated color. Text on it switches between white and black for contrast.">
                <div class="color-row">
                  <input type="color" value={f.brand_color} aria-label="Brand color picker" onInput={(e) => { setF({ ...f, brand_color: (e.target as HTMLInputElement).value }); setSaved(false); }} />
                  <input class="mono" value={hex} maxLength={7} aria-label="Brand color hex value" onInput={(e) => { const v = (e.target as HTMLInputElement).value; setHex(v); if (/^#[0-9a-fA-F]{6}$/.test(v)) { setF({ ...f, brand_color: v.toLowerCase() }); setSaved(false); } }} />
                </div>
              </Field>
            </fieldset>
            <div class="form-actions"><PermBtn perm="members:admin" type="submit" kind="primary" busy={busy}>Save branding</PermBtn>{saved ? <span class="ok-text" role="status">Saved. The investor portal uses it now.</span> : null}</div>
          </form>
          <ErrorBox error={err} />
        </Card>
        <Card title="Investor portal preview">
          <div class="portal-prev" aria-label="Preview of the investor portal header">
            <div class="pp-bar" style={{ background: f.brand_color, color: fg }}>
              <span class="pp-name">{f.brand_name || 'Your brand'}</span>
              <span class="pp-nav"><span>Holdings</span><span>Documents</span><span>Statements</span></span>
            </div>
            <div class="pp-body">
              <p class="pp-k">Good morning, Wen Li</p>
              <div class="pp-row"><span>Tidewell Liquidity Fund</span><b>$2,000,000.00</b></div>
              <div class="pp-row"><span>Credential</span><span class="pp-chip" style={{ background: f.brand_color, color: fg }}>Active to Oct 2027</span></div>
              <p class="pp-foot">Powered by Laissez</p>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
