/** @jsxImportSource preact */
// First-run checklist for the sandbox Home page. Progress is read from the API where it can be
// (orders, settlements, policy changes) and from a local flag for the teammate switch.
import { useEffect, useState } from 'preact/hooks';
import { api } from '../app/api';

const HIDE_KEY = 'laissez-checklist-hidden';
const TEAMMATE_KEY = 'laissez-checklist-teammate';
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
/** Called by the shell when the person acts as a teammate, so the last step completes. */
export const markTeammateSwitched = () => ls.set(TEAMMATE_KEY, '1');

type Step = { id: string; label: string; hint: string; href: string; done: boolean };

export function Checklist({ workspaceId, actingAs, canOrder, canPropose }: { workspaceId: string; actingAs: boolean; canOrder: boolean; canPropose: boolean }) {
  const [hidden, setHidden] = useState(() => ls.get(HIDE_KEY) === workspaceId);
  const [state, setState] = useState<{ orders: number; settled: number; proposals: number } | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([api('/v1/metrics').catch(() => null), api('/v1/policy-changes').catch(() => null)]).then(([m, p]) => {
      if (!live) return;
      const settled = Array.isArray(m?.settled_value) ? m.settled_value.reduce((s: number, x: any) => s + (x.n ?? 0), 0) : 0;
      setState({ orders: m?.totals?.decisions ?? 0, settled, proposals: Array.isArray(p?.data) ? p.data.length : 0 });
    });
    return () => { live = false; };
  }, [workspaceId]);
  if (actingAs) markTeammateSwitched();
  if (hidden) return null;
  const teammate = actingAs || ls.get(TEAMMATE_KEY) === '1';
  const steps: Step[] = [
    { id: 'sandbox', label: 'Open a sandbox', hint: 'Done. This is yours for 7 days.', href: '#/', done: true },
    { id: 'order', label: 'Place an order', hint: canOrder ? 'Pick a client and a fund. The decision names every rule it checked.' : 'Your role cannot place orders; switch to an operations teammate.', href: '#/orders/new?investor=lumen&fund=TWLF&amount=2000000', done: (state?.orders ?? 0) > 0 },
    { id: 'settle', label: 'Settle it', hint: 'Open an allowed decision and press Settle. Both legs move or neither does.', href: '#/decisions', done: (state?.settled ?? 0) > 0 },
    { id: 'policy', label: 'Propose a policy change', hint: canPropose ? 'Remove a jurisdiction from a fund and read the impact preview first.' : 'Act as the issuer admin teammate to propose one.', href: '#/funds', done: (state?.proposals ?? 0) > 0 },
    { id: 'teammate', label: 'Invite or switch teammate', hint: 'Use Acting as in the top bar to approve your own proposal as someone else, or invite a colleague.', href: '#/settings/members', done: teammate },
  ];
  const done = steps.filter((s) => s.done).length;
  const allDone = done === steps.length;
  const hide = () => { ls.set(HIDE_KEY, workspaceId); setHidden(true); };
  return (
    <section class={`checklist ${allDone ? 'all-done' : ''}`} aria-labelledby="cl-h">
      <div class="cl-head">
        <div>
          <h2 id="cl-h">{allDone ? 'You have done the whole loop.' : 'Get to a settled cross-border order'}</h2>
          <p>{allDone ? 'Order, settlement, policy change and a second approver. The guided demo explains why each step is built the way it is.' : `${done} of ${steps.length} done. About ten minutes in total.`}</p>
        </div>
        <div class="cl-actions">
          <a class="b b-ghost" href="../demo/">Help: guided demo</a>
          <button type="button" class="b b-ghost" onClick={hide} aria-label="Hide this checklist">Hide</button>
        </div>
      </div>
      <div class="cl-bar" aria-hidden="true"><span style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <ol class="cl-steps">
        {steps.map((s) => (
          <li class={s.done ? 'done' : ''}>
            <span class="cl-mark" aria-hidden="true">{s.done ? <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6.5l2.3 2.3L9.5 3.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg> : null}</span>
            <div>
              {s.done ? <span class="cl-label">{s.label}<span class="sr"> (done)</span></span> : <a class="cl-label" href={s.href}>{s.label}</a>}
              <p>{s.hint}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
