/** @jsxImportSource preact */
// Organization security policy and organization verification.
import { useEffect, useState } from 'preact/hooks';
import { api, day, when } from '../api';
import { useApi, Head, Btn, Chip, ErrorBox, Loading, Field, Card } from '../ui';
import { useMe, PermBtn, PermNote } from '../auth';

const lines = (v: string) => v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

// ---------- Security policy ----------
export function SecurityPolicy() {
  const { isSandbox, reload } = useMe();
  const r = useApi('/v1/security-policy');
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (!r.data) return;
    const p = r.data.policy;
    setF({ require_sso: p.require_sso, require_user_verification: p.require_user_verification, portal_require_account: !!p.portal_require_account, session_hours: p.session_hours, idle_minutes: p.idle_minutes, domains: p.allowed_email_domains.join('\n'), networks: p.session_ip_allowlist.join('\n') });
  }, [r.data]);
  const set = (k: string, v: unknown) => { setF({ ...f, [k]: v }); setSaved(null); };
  const save = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null); setSaved(null);
    try {
      const x = await api('/v1/security-policy', { method: 'PUT', body: {
        require_sso: !!f.require_sso, require_user_verification: !!f.require_user_verification, portal_require_account: !!f.portal_require_account,
        session_hours: Number(f.session_hours), idle_minutes: Number(f.idle_minutes),
        allowed_email_domains: lines(f.domains), session_ip_allowlist: lines(f.networks),
      } });
      setSaved(x.sessions_shortened ? `Saved. ${x.sessions_shortened} existing session${x.sessions_shortened === 1 ? ' was' : 's were'} shortened to the new lifetime.` : 'Saved. It applies at the next request.');
      r.reload(); reload();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const d = r.data;
  return (
    <>
      <Head title="Security policy" sub="Rules for how people sign in to this organization. Every rule is audited, emailed to the administrators, and checked so you cannot lock yourself out." />
      <PermNote perm="members:admin" />
      {r.loading && !d ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : d && f ? (
        <>
          {!d.applies || isSandbox ? <div class="note">Policies apply to organizations. A sandbox always uses the defaults. Keep it as an organization under Organization to set them.</div> : null}
          <form class="form-grid one" onSubmit={save}>
            <fieldset class="plain-fs" disabled={!d.applies}>
              <Card title="Who can sign in" actions={d.is_default ? <Chip>Defaults</Chip> : <Chip tone="brass">Customized</Chip>}>
                <label class="check gate-check">
                  <input type="checkbox" checked={f.require_sso} disabled={!d.sso_enabled && !f.require_sso} onChange={(e) => set('require_sso', (e.target as HTMLInputElement).checked)} />
                  <span>Require single sign-on<span class="f-h">Members sign in through your identity provider only. Administrators keep passkeys as a way in if the provider is down.{d.sso_enabled ? '' : ' Connect an identity provider on the Single sign-on page first.'}</span></span>
                </label>
                <label class="check gate-check">
                  <input type="checkbox" checked={f.require_user_verification} onChange={(e) => set('require_user_verification', (e.target as HTMLInputElement).checked)} />
                  <span>Require a passkey that confirms the person<span class="f-h">The passkey must be unlocked with a PIN, fingerprint or face, not only by holding the device.</span></span>
                </label>
                <label class="check gate-check">
                  <input type="checkbox" checked={f.portal_require_account} onChange={(e) => set('portal_require_account', (e.target as HTMLInputElement).checked)} />
                  <span>Require investor portal accounts<span class="f-h">Clients create a passkey account from the link you send; afterwards the portal opens only to a signed-in account, with an authenticator app if they add one. Links alone stop working.</span></span>
                </label>
                <Field label="Allowed email domains" hint="One per line, for example example.com. Invites, sign-ups and sign-in are limited to them. Leave empty to allow any."><textarea rows={3} value={f.domains} placeholder={'example.com'} onInput={(e) => set('domains', (e.target as HTMLTextAreaElement).value)} /></Field>
              </Card>
              <Card title="Sessions">
                <div class="form-grid">
                  <Field label="Session lifetime, hours" hint="A session ends this long after sign-in. 1 to 168."><input type="number" min={1} max={168} required value={f.session_hours} onInput={(e) => set('session_hours', (e.target as HTMLInputElement).value)} /></Field>
                  <Field label="Idle timeout, minutes" hint="A session ends after this long without activity. 5 to 720."><input type="number" min={5} max={720} required value={f.idle_minutes} onInput={(e) => set('idle_minutes', (e.target as HTMLInputElement).value)} /></Field>
                </div>
                <p class="small muted">A shorter lifetime also applies to sessions that are open now.</p>
              </Card>
              <Card title="Approved networks">
                <Field label="Sign-in allowlist" hint="One address or CIDR per line, for example 203.0.113.0/24. People can sign in and use sessions only from these. Leave empty to allow any. API keys have their own allowlists."><textarea rows={3} class="mono" value={f.networks} placeholder={'203.0.113.0/24'} onInput={(e) => set('networks', (e.target as HTMLTextAreaElement).value)} /></Field>
                <p class="small muted">Your network address is <code>{d.your_network ?? 'unknown'}</code>. Saving a list that leaves it out is refused.</p>
              </Card>
            </fieldset>
            <div class="form-actions"><PermBtn perm="members:admin" type="submit" kind="primary" busy={busy} disabled={!d.applies}>Save policy</PermBtn>{saved ? <span class="ok-text" role="status">{saved}</span> : null}</div>
          </form>
          <ErrorBox error={err} />
        </>
      ) : null}
    </>
  );
}

// ---------- Organization verification ----------
const ENTITY: Record<string, string> = { bank: 'Bank', asset_manager: 'Asset manager', broker_dealer: 'Broker-dealer', transfer_agent: 'Transfer agent', fund_administrator: 'Fund administrator', fintech: 'Fintech or platform', other: 'Other regulated or institutional entity' };
const STATUS: Record<string, { tone: 'ok' | 'warn' | 'no' | 'muted'; label: string }> = {
  verified: { tone: 'ok', label: 'Verified' }, pending: { tone: 'warn', label: 'Under review' }, rejected: { tone: 'no', label: 'Not approved' }, unverified: { tone: 'muted', label: 'Not submitted' }, not_applicable: { tone: 'muted', label: 'Not needed' },
};

export function Verification() {
  const { isSandbox, reload } = useMe();
  const r = useApi('/v1/organization/verification');
  const [f, setF] = useState<any>({ legal_name: '', entity_type: 'asset_manager', registration_number: '', country: '', regulator: '', license_number: '', website: '', address: '', contact_name: '', contact_email: '', use_case: '', expected_annual_volume_usd: '', attest: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [sent, setSent] = useState<string | null>(null);
  const d = r.data;
  useEffect(() => {
    if (d?.profile) setF((x: any) => ({ ...x, ...d.profile, expected_annual_volume_usd: d.profile.expected_annual_volume_usd ?? '', attest: false }));
  }, [d]);
  const set = (k: string, v: unknown) => setF({ ...f, [k]: v });
  const submit = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(null); setSent(null);
    try {
      const body: Record<string, unknown> = { legal_name: f.legal_name, entity_type: f.entity_type, registration_number: f.registration_number, country: f.country, address: f.address, contact_name: f.contact_name, contact_email: f.contact_email, use_case: f.use_case, attest: !!f.attest };
      for (const k of ['regulator', 'license_number', 'website']) if (String(f[k] ?? '').trim()) body[k] = String(f[k]).trim();
      if (String(f.expected_annual_volume_usd).trim() !== '') body.expected_annual_volume_usd = Number(f.expected_annual_volume_usd);
      const x = await api('/v1/organization/verification', { method: 'PUT', body });
      setSent(x.note); r.reload(); reload();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const st = d ? STATUS[d.status] ?? STATUS.unverified : null;
  const editable = d && (d.status === 'unverified' || d.status === 'rejected');
  return (
    <>
      <Head title="Organization verification" sub="A business check before real money moves. Verified organizations can settle, create API keys and use the chain. Sandboxes are fictional and need none." actions={st ? <Chip tone={st.tone}>{st.label}</Chip> : null} />
      <PermNote perm="members:admin" />
      {r.loading && !d ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : d ? (
        <>
          {isSandbox || d.status === 'not_applicable' ? <div class="note">This is a sandbox. Verification applies to organizations; keep the sandbox as an organization first.</div> : null}
          {d.status === 'rejected' && d.note ? <div class="err" role="alert"><strong>The reviewer did not approve this submission.</strong><p>{d.note}</p><p class="small">Correct the details below and submit again.</p></div> : null}
          {d.status === 'pending' ? <div class="note" role="status">Submitted {d.submitted_at ? when(d.submitted_at) : ''}. Someone at Laissez reviews it, usually within one business day, and you get an email either way. You can look at what you sent below.</div> : null}
          {d.status === 'verified' ? <div class="note" role="status">Verified {d.verified_at ? day(d.verified_at) : ''}. To change the legal details, contact support.</div> : null}
          {!d.required && d.status !== 'verified' && d.status !== 'not_applicable' ? <p class="small muted">This deployment is in sandbox mode, so verification is not enforced yet. Production deployments hold settlements, API keys and chain actions until it is approved.</p> : null}
          {d.status !== 'not_applicable' ? (
            <form onSubmit={submit}>
              <fieldset class="plain-fs" disabled={!editable}>
                <Card title="Legal entity">
                  <div class="form-grid">
                    <Field label="Legal name"><input required minLength={2} maxLength={160} value={f.legal_name} onInput={(e) => set('legal_name', (e.target as HTMLInputElement).value)} placeholder="Harbourline Capital Pte. Ltd." /></Field>
                    <Field label="Type of entity"><select value={f.entity_type} onChange={(e) => set('entity_type', (e.target as HTMLSelectElement).value)}>{Object.entries(ENTITY).map(([k, v]) => <option value={k}>{v}</option>)}</select></Field>
                    <Field label="Registration number" hint="Company number, LEI or equivalent."><input required minLength={2} maxLength={60} value={f.registration_number} onInput={(e) => set('registration_number', (e.target as HTMLInputElement).value)} /></Field>
                    <Field label="Country of registration" hint="Two letters, for example SG, US, CH."><input required maxLength={2} minLength={2} style={{ textTransform: 'uppercase' }} value={f.country} onInput={(e) => set('country', (e.target as HTMLInputElement).value.toUpperCase())} placeholder="SG" /></Field>
                    <Field label="Regulator, if licensed"><input maxLength={120} value={f.regulator} onInput={(e) => set('regulator', (e.target as HTMLInputElement).value)} placeholder="Monetary Authority of Singapore" /></Field>
                    <Field label="Licence number"><input maxLength={80} value={f.license_number} onInput={(e) => set('license_number', (e.target as HTMLInputElement).value)} /></Field>
                    <Field label="Website"><input type="url" maxLength={200} value={f.website} onInput={(e) => set('website', (e.target as HTMLInputElement).value)} placeholder="https://harbourline.example" /></Field>
                  </div>
                  <Field label="Registered address"><textarea rows={2} required minLength={5} maxLength={300} value={f.address} onInput={(e) => set('address', (e.target as HTMLTextAreaElement).value)} /></Field>
                </Card>
                <Card title="Contact and use">
                  <div class="form-grid">
                    <Field label="Compliance contact"><input required minLength={2} maxLength={80} value={f.contact_name} onInput={(e) => set('contact_name', (e.target as HTMLInputElement).value)} /></Field>
                    <Field label="Contact email"><input type="email" required value={f.contact_email} onInput={(e) => set('contact_email', (e.target as HTMLInputElement).value)} /></Field>
                    <Field label="Expected value settled in a year, USD" hint="An estimate helps us size the plan."><input type="number" min={0} value={f.expected_annual_volume_usd} onInput={(e) => set('expected_annual_volume_usd', (e.target as HTMLInputElement).value)} /></Field>
                  </div>
                  <Field label="What will you use Laissez for?" hint="Which funds, which investors, which jurisdictions. A sentence or two."><textarea rows={4} required minLength={20} maxLength={1500} value={f.use_case} onInput={(e) => set('use_case', (e.target as HTMLTextAreaElement).value)} /></Field>
                  <label class="check gate-check"><input type="checkbox" checked={f.attest} onChange={(e) => set('attest', (e.target as HTMLInputElement).checked)} /><span>These details are accurate and I am authorised to act for this organization.<span class="f-h">The legal name is checked against the sanctions lists Laissez has loaded. A match goes to the reviewer; it does not reject the form.</span></span></label>
                </Card>
              </fieldset>
              {editable ? <div class="form-actions"><PermBtn perm="members:admin" type="submit" kind="primary" busy={busy} disabled={!f.attest}>{d.status === 'rejected' ? 'Submit again' : 'Submit for review'}</PermBtn></div> : null}
            </form>
          ) : null}
          {sent ? <p class="ok-text" role="status">{sent}</p> : null}
          <ErrorBox error={err} />
        </>
      ) : null}
    </>
  );
}
