// Identity verification card on a client's page: start a provider check in the browser, see outcomes, open sealed
// evidence with a recorded purpose. Documents never pass through Laissez.
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, when } from '../api';
import { useApi, Btn, Chip, ErrorBox, Loading, Empty, Field, Card } from '../ui';
import { useMe, PermBtn } from '../auth';

const TONE: Record<string, 'ok' | 'no' | 'warn' | 'muted' | 'info'> = { approved: 'ok', rejected: 'no', retry: 'warn', pending: 'info', started: 'muted', expired: 'muted' };
const LABEL: Record<string, string> = { approved: 'Approved', rejected: 'Rejected', retry: 'Needs another attempt', pending: 'Under review', started: 'Started', expired: 'Expired' };

declare global { interface Window { snsWebSdk?: any } }

async function loadSdk(src: string): Promise<any> {
  if (window.snsWebSdk) return window.snsWebSdk;
  await new Promise<void>((resolve, reject) => { const s = document.createElement('script'); s.src = src; s.async = true; s.onload = () => resolve(); s.onerror = () => reject(new Error('The verification SDK could not be loaded.')); document.head.appendChild(s); });
  return window.snsWebSdk;
}

export function KycCard({ investorId }: { investorId: string }) {
  const { can } = useMe();
  const info = useApi('/v1/kyc');
  const r = useApi(`/v1/investors/${investorId}/kyc/checks`, [investorId]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const [note, setNote] = useState<string | null>(null);
  const [live, setLive] = useState<{ check_id: string; sdk_token: string } | null>(null);
  const [evidence, setEvidence] = useState<{ id: string; purpose: string; data?: any } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const rows = r.data?.data ?? [];
  const configured = info.data?.configured === true;

  useEffect(() => {
    if (!live || !box.current) return;
    let cancelled = false;
    (async () => {
      try {
        const sdk = await loadSdk(info.data?.sdk);
        if (cancelled || !sdk) return;
        const refresh = async () => (await api<{ sdk_token: string }>(`/v1/investors/${investorId}/kyc/checks`, { body: {} })).sdk_token;
        sdk.init(live.sdk_token, refresh).withConf({ lang: 'en' }).withOptions({ addViewportTag: false, adaptIframeHeight: true })
          .on('idCheck.onApplicantSubmitted', () => { setNote('Submitted. The provider is reviewing; the result arrives here when it is done.'); r.reload(); })
          .on('idCheck.onApplicantStatusChanged', () => r.reload())
          .build().launch(box.current);
      } catch (e) { setErr(e); }
    })();
    return () => { cancelled = true; };
  }, [live?.check_id]);

  const start = async () => { setBusy(true); setErr(null); setNote(null); try { const x = await api(`/v1/investors/${investorId}/kyc/checks`, { body: {} }); setLive(x); r.reload(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const refresh = async (id: string) => { setBusy(true); setErr(null); try { const x = await api(`/v1/investors/${investorId}/kyc/checks/${id}/refresh`, { body: {} }); setNote(`Status: ${LABEL[x.status] ?? x.status}.`); r.reload(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const open = async (e: Event) => {
    e.preventDefault(); if (!evidence) return;
    setBusy(true); setErr(null);
    try { const x = await api(`/v1/investors/${investorId}/kyc/checks/${evidence.id}/evidence?purpose=${encodeURIComponent(evidence.purpose)}`); setEvidence({ ...evidence, data: x }); } catch (x) { setErr(x); } finally { setBusy(false); }
  };

  return (
    <Card title="Identity verification" actions={configured ? <PermBtn perm="clients:write" kind="primary" busy={busy} onClick={start}>{rows.some((x: any) => ['started', 'pending', 'retry'].includes(x.status)) ? 'Continue check' : 'Start identity check'}</PermBtn> : undefined}>
      {info.loading && !info.data ? <Loading /> : !configured ? (
        <p class="muted small">No identity provider is connected to this deployment, so credentials rest on the evidence typed into the form. Connecting Sumsub (document and liveness checks) takes two API secrets; see the runbook under Switching on identity verification.</p>
      ) : (
        <p class="muted small">Document and liveness checks run in the client's browser through the provider's SDK. Laissez stores the outcome, and keeps the provider's full record sealed; opening it needs a reason and is logged.</p>
      )}
      {note ? <p class="ok-text" role="status">{note}</p> : null}
      <ErrorBox error={err} />
      {live ? <div ref={box} style={{ minHeight: '420px', border: '1px solid var(--line)', borderRadius: '10px', overflow: 'hidden', marginBottom: '0.75rem' }} aria-label="Identity verification" /> : null}
      {r.loading && !r.data ? <Loading /> : rows.length ? (
        <div class="tw"><table class="t">
          <thead><tr><th>Started</th><th>Level</th><th>Status</th><th>Evidence</th><th></th></tr></thead>
          <tbody>{rows.map((x: any) => (
            <tr>
              <td class="muted nowrap">{when(x.created_at)}</td>
              <td>{x.level}</td>
              <td><Chip tone={TONE[x.status] ?? 'muted'}>{LABEL[x.status] ?? x.status}</Chip>{x.outcome?.reject_labels?.length ? <div class="small muted">{x.outcome.reject_labels.join(', ')}</div> : null}{x.outcome?.document_types?.length ? <div class="small muted">{x.outcome.document_types.join(', ')}</div> : null}</td>
              <td class="small">{x.evidence_ref ? <code class="break">{x.evidence_ref}</code> : <span class="muted">none yet</span>}{x.evidence_sha256 ? <div class="muted break" title="SHA-256 of the sealed record">{x.evidence_sha256.slice(0, 16)}...</div> : null}</td>
              <td class="nowrap"><PermBtn perm="clients:write" kind="ghost" busy={busy} onClick={() => refresh(x.id)}>Refresh</PermBtn>{x.evidence_sha256 && can('compliance:write') ? <Btn kind="ghost" onClick={() => setEvidence(evidence?.id === x.id ? null : { id: x.id, purpose: '' })}>Open evidence</Btn> : null}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : configured ? <Empty title="No checks yet">Start a check to send this client through document and liveness verification.</Empty> : null}
      {evidence ? (
        <form class="form-grid" onSubmit={open} style={{ marginTop: '0.75rem' }}>
          <Field label="Why are you opening this record?" hint="Written to the evidence access log with your name and the time."><input required minLength={4} value={evidence.purpose} onInput={(e) => setEvidence({ ...evidence, purpose: (e.target as HTMLInputElement).value })} placeholder="Periodic review, regulator request, dispute" /></Field>
          <div class="form-actions"><Btn type="submit" kind="primary" busy={busy}>Open</Btn><Btn kind="ghost" onClick={() => setEvidence(null)}>Close</Btn></div>
          {evidence.data ? <pre class="small" style={{ gridColumn: '1 / -1', maxHeight: '320px', overflow: 'auto' }}>{JSON.stringify(evidence.data.evidence, null, 2)}</pre> : null}
        </form>
      ) : null}
    </Card>
  );
}
