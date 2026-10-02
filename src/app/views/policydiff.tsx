// Side-by-side view of a fund policy change: jurisdictions added or removed, class changes inside a
// jurisdiction, minimum, cap and lock-up changes, and the holders whose standing changes.
// Used by the policy editor before "Propose change" and by the policy change list when a row is expanded.
import { money, JUR, CLASS_LABEL } from '../api';
import { Chip } from '../ui';

type DistIn = { jurisdiction: string; accepts: string[] }[] | Record<string, { accepts: string[] } | null | undefined> | null | undefined;
export type PolicyLike = { distribution?: DistIn; min_subscription?: number | null; minSubscription?: number | null; holder_cap?: number | null; holderCap?: number | null; lockup_months?: number | null; lockupMonths?: number | null } | null | undefined;
export type PolicyImpact = {
  removed?: string[]; added?: string[]; currency?: string; value_affected?: number;
  holders_affected?: { investor_id: string; name: string; from: string; to: string; units?: number; value?: number }[];
  note?: string;
} | null | undefined;

const distMap = (d: DistIn): Record<string, string[]> => {
  if (!d) return {};
  if (Array.isArray(d)) return Object.fromEntries(d.map((x) => [x.jurisdiction, x.accepts ?? []]));
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v).map(([j, v]) => [j, v!.accepts ?? []]));
};
const num = (p: PolicyLike, snake: 'min_subscription' | 'holder_cap' | 'lockup_months', camel: 'minSubscription' | 'holderCap' | 'lockupMonths'): number | null | undefined => {
  if (!p) return undefined;
  const v = p[snake] !== undefined ? p[snake] : p[camel];
  return v === undefined ? undefined : v;
};
const label = (code: string) => CLASS_LABEL[code] ?? code;
const jur = (j: string) => JUR[j] ?? j;

/** One line per changed term. `undefined` on either side means that side did not state the term. */
function Term({ name, before, after, fmt }: { name: string; before: number | null | undefined; after: number | null | undefined; fmt: (n: number | null) => string }) {
  if (after === undefined) return null;
  const same = before !== undefined && (before ?? null) === (after ?? null);
  return (
    <tr>
      <td>{name}</td>
      <td class="muted">{before === undefined ? 'not stated' : fmt(before)}</td>
      <td>{fmt(after)}{same || before === undefined ? null : <> <Chip tone="warn">Changed</Chip></>}</td>
    </tr>
  );
}

/**
 * Renders the difference between two policies. `before` is the policy in force (null when unknown, in which case
 * added and removed jurisdictions come from `impact`), `after` the proposed policy, `impact` the preview from
 * POST /v1/funds/:ticker/policy/preview (or the impact stored on a policy change).
 */
export function PolicyDiff({ before, after, impact, currency }: { before: PolicyLike; after: PolicyLike; impact?: PolicyImpact; currency?: string }) {
  const b = distMap(before?.distribution); const a = distMap(after?.distribution);
  const known = !!before;
  const added = known ? Object.keys(a).filter((j) => !b[j]) : (impact?.added ?? []);
  const removed = known ? Object.keys(b).filter((j) => !a[j]) : (impact?.removed ?? []);
  const classChanges = Object.keys(a).filter((j) => b[j]).map((j) => ({ j, plus: a[j].filter((c) => !b[j].includes(c)), minus: b[j].filter((c) => !a[j].includes(c)) })).filter((x) => x.plus.length || x.minus.length);
  const ccy = currency ?? impact?.currency ?? 'USD';
  const fmtMoney = (n: number | null) => (n == null ? 'none' : money(n, ccy));
  const fmtCap = (n: number | null) => (n == null ? 'No cap' : `${n.toLocaleString('en-US')} holders`);
  const fmtLock = (n: number | null) => (n == null ? 'No lock-up' : `${n} month${n === 1 ? '' : 's'}`);
  const minB = num(before, 'min_subscription', 'minSubscription'); const minA = num(after, 'min_subscription', 'minSubscription');
  const capB = num(before, 'holder_cap', 'holderCap'); const capA = num(after, 'holder_cap', 'holderCap');
  const lockB = num(before, 'lockup_months', 'lockupMonths'); const lockA = num(after, 'lockup_months', 'lockupMonths');
  const termsChanged = [[minB, minA], [capB, capA], [lockB, lockA]].some(([x, y]) => y !== undefined && (x === undefined || (x ?? null) !== (y ?? null)));
  const holders = impact?.holders_affected ?? [];
  const nothing = !added.length && !removed.length && !classChanges.length && !termsChanged && !holders.length;
  return (
    <div class="policy-diff">
      {nothing ? <p class="muted small">No change in jurisdictions, classes, terms or holder standing.</p> : null}
      {(added.length || removed.length || classChanges.length) ? (
        <div class="tw"><table class="t">
          <thead><tr><th>Jurisdiction</th><th>Before</th><th>After</th></tr></thead>
          <tbody>
            {removed.map((j) => <tr><td><strong>{jur(j)}</strong></td><td>{(b[j] ?? []).map(label).join(', ') || 'Offered'}</td><td><Chip tone="no">Removed</Chip><div class="small muted">Current holders move to redemption-only.</div></td></tr>)}
            {added.map((j) => <tr><td><strong>{jur(j)}</strong></td><td class="muted">Not offered</td><td><Chip tone="ok">Added</Chip> <span class="small">{(a[j] ?? []).map(label).join(', ')}</span></td></tr>)}
            {classChanges.map((x) => (
              <tr>
                <td><strong>{jur(x.j)}</strong></td>
                <td>{b[x.j].map(label).join(', ')}</td>
                <td>
                  {a[x.j].map(label).join(', ')}
                  <div class="small">
                    {x.plus.map((c) => <span><Chip tone="ok">+ {label(c)}</Chip> </span>)}
                    {x.minus.map((c) => <span><Chip tone="warn">- {label(c)}</Chip> </span>)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : null}
      {termsChanged ? (
        <div class="tw"><table class="t">
          <thead><tr><th>Term</th><th>Before</th><th>After</th></tr></thead>
          <tbody>
            <Term name="Minimum subscription" before={minB} after={minA} fmt={fmtMoney} />
            <Term name="Holder cap" before={capB} after={capA} fmt={fmtCap} />
            <Term name="Lock-up" before={lockB} after={lockA} fmt={fmtLock} />
          </tbody>
        </table></div>
      ) : null}
      {impact ? (
        holders.length ? (
          <div>
            <p><strong>{holders.length} holder{holders.length > 1 ? 's' : ''}</strong>{typeof impact.value_affected === 'number' ? <> with <strong>{money(impact.value_affected, ccy)}</strong></> : null} change standing.</p>
            <div class="tw"><table class="t">
              <thead><tr><th>Holder</th><th>From</th><th>To</th><th class="r">Value</th></tr></thead>
              <tbody>{holders.map((h) => <tr><td>{h.name}</td><td>{h.from}</td><td>{h.to}</td><td class="r">{typeof h.value === 'number' ? money(h.value, ccy) : ''}</td></tr>)}</tbody>
            </table></div>
          </div>
        ) : <p class="small muted">No existing holder in this workspace changes standing.</p>
      ) : null}
    </div>
  );
}
