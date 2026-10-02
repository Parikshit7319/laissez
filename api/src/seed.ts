// Seeds a new sandbox with the fictional institutions from the demo.
// Dates are shifted so the sandbox always looks the way the demo looks on Oct 1, 2026.
import { investors, funds, SIM_DATE } from '../../src/proto/data';
import { type Sql, today, addDays, daysBetween } from './util';

function multi(table: string, cols: string[], rows: unknown[][]) {
  const params: unknown[] = [];
  const values = rows.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(', ')})`).join(', ');
  return { text: `insert into ${table} (${cols.join(', ')}) values ${values}`, params };
}

export function seedQueries(sql: Sql, ws: string) {
  const shift = daysBetween(SIM_DATE, today());
  const d = (x: string) => addDays(x, shift);
  const inv = Object.values(investors);
  const q: { text: string; params: unknown[] }[] = [];
  q.push(multi('investors', ['workspace_id', 'id', 'name', 'short_name', 'kind', 'residence', 'city', 'booking_center', 'us_person', 'wallet'],
    inv.map((i) => [ws, i.id, i.name, i.short, i.kind, i.residence, i.city, i.booking, i.usPerson, i.wallet])));
  q.push(multi('credentials', ['workspace_id', 'id', 'investor_id', 'issued_on', 'expires_on'],
    inv.map((i) => [ws, i.credentialId, i.id, d(i.issued), d(i.expires)])));
  const cls = inv.flatMap((i) => i.classifications.map((c) => [ws, i.credentialId, c.code, c.basis, d(c.verified), d(c.expires), c.optIn ? d(c.optIn) : null]));
  if (cls.length) q.push(multi('classifications', ['workspace_id', 'credential_id', 'class_code', 'basis', 'verified_on', 'expires_on', 'opt_in_on'], cls));
  const fs = Object.values(funds);
  q.push(multi('funds', ['workspace_id', 'ticker', 'name', 'short_name', 'domicile', 'structure', 'currency', 'nav', 'reg_s', 'us_accepts', 'min_subscription', 'holder_cap', 'holders', 'lockup_months', 'assets', 'chains', 'issuer'],
    fs.map((f) => [ws, f.ticker, f.name, f.short, f.domicile, f.structure, f.currency, f.nav, f.regS, f.usAccepts, f.minSubscription, f.holderCap, f.holders, f.lockupMonths, f.assets, f.chains, f.issuer])));
  q.push(multi('fund_distribution', ['workspace_id', 'ticker', 'jurisdiction', 'accepts', 'basis', 'law_requires', 'law_text', 'law_ref', 'law_source'],
    fs.flatMap((f) => Object.entries(f.distribution).map(([j, x]) => [ws, f.ticker, j, x!.accepts, x!.basis, x!.lawRequires, x!.lawText, x!.lawRef, x!.lawSource]))));
  q.push(multi('holdings', ['workspace_id', 'investor_id', 'ticker', 'units', 'since'],
    inv.flatMap((i) => Object.entries(i.holdings).map(([t, h]) => [ws, i.id, t, h!.units, d(h!.since)]))));
  return q.map((x) => sql.query(x.text, x.params));
}

/** Law rules to apply when an issuer adds a jurisdiction to a fund. Taken from the launch rule packs. */
export function lawDefaults(jur: string, regS: boolean) {
  const src = jur === 'US' ? funds.AGPC.distribution.US : funds.TWLF.distribution[jur as keyof typeof funds.TWLF.distribution];
  if (!src) return null;
  return { lawRequires: src.lawRequires, lawText: src.lawText, lawRef: src.lawRef, lawSource: src.lawSource, basis: jur === 'US' ? 'Rule 506(c) private placement' : regS ? 'Regulation S offer' : src.basis, accepts: src.accepts };
}
