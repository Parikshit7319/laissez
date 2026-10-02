/** @jsxImportSource preact */
import { rosette, band } from '../lib/guilloche';
import { classInfo, jurName, bookingCenters, SIM_DATE, type Investor, type Classification, type Jur } from './data';

const ISO3: Record<Jur, string> = { SG: 'SGP', HK: 'HKG', CH: 'CHE', DE: 'DEU', 'AE-DIFC': 'ARE', US: 'USA', IR: 'IRN' };

// ICAO 9303 check digit (weights 7, 3, 1)
function check(s: string): string {
  const val = (c: string) => (c >= '0' && c <= '9' ? +c : c >= 'A' && c <= 'Z' ? c.charCodeAt(0) - 55 : 0);
  const w = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += val(s[i]) * w[i % 3];
  return String(sum % 10);
}
const pad = (s: string, n: number) => (s + '<'.repeat(n)).slice(0, n);
const ymd = (d: string) => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);

export function mrz(inv: Investor): [string, string] {
  const name = inv.name.toUpperCase().replace(/[^A-Z ]/g, '').trim().replace(/\s+/g, '<');
  const l1 = pad(`LP<${ISO3[inv.residence]}${name}`, 44);
  const id = inv.credentialId.replace(/[^A-Z0-9]/g, '').slice(0, 9);
  const doc = pad(id, 9);
  const iss = ymd(inv.issued);
  const exp = ymd(inv.expires);
  const body = `${doc}${check(doc)}${ISO3[inv.residence]}${iss}${check(iss)}${inv.kind === 'Individual' ? 'I' : 'E'}${exp}${check(exp)}`;
  const l2 = pad(body, 42);
  return [l1, l2 + check(l2) + check(l1 + l2)];
}

const fmtDate = (d: string) => {
  const m = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${d.slice(8, 10)} ${m[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
};

export function Stamp({ c, idx, lapsed }: { c: Classification; idx: number; lapsed: boolean }) {
  const info = classInfo[c.code];
  const rot = [-8, 6, -3, 9][idx % 4];
  const id = `arc-${c.code}-${idx}`;
  const words = info.stamp.toUpperCase().split(' ');
  return (
    <div class={`stamp ${lapsed ? 'is-lapsed' : ''}`} style={{ transform: `rotate(${rot}deg)` }}>
      <svg viewBox="0 0 120 120" width="112" height="112" role="img" aria-label={`${jurName[info.jur]}: ${info.label}${c.optIn ? ', opt-in recorded' : ''}, verified ${c.verified}, valid to ${c.expires}${lapsed ? ', lapsed' : ''}`}>
        <defs>
          <path id={`${id}-t`} d="M 16 60 A 44 44 0 0 1 104 60" />
          <path id={`${id}-b`} d="M 14 60 A 46 46 0 0 0 106 60" />
        </defs>
        <circle cx="60" cy="60" r="56" fill="none" stroke="currentColor" stroke-width="2.2" />
        <circle cx="60" cy="60" r="51" fill="none" stroke="currentColor" stroke-width="0.8" />
        <circle cx="60" cy="60" r="34" fill="none" stroke="currentColor" stroke-width="0.8" />
        <text font-size="8.6" font-weight="700" letter-spacing="1.6" fill="currentColor"><textPath href={`#${id}-t`} startOffset="50%" text-anchor="middle">{jurName[info.jur].toUpperCase()}</textPath></text>
        <text font-size="7" font-weight="600" letter-spacing="1" fill="currentColor"><textPath href={`#${id}-b`} startOffset="50%" text-anchor="middle">{info.rule.toUpperCase()}</textPath></text>
        {words.length > 1 ? (
          <>
            <text x="60" y="56" text-anchor="middle" font-size="9" font-weight="700" fill="currentColor">{words[0]}</text>
            <text x="60" y="66" text-anchor="middle" font-size="9" font-weight="700" fill="currentColor">{words.slice(1).join(' ')}</text>
          </>
        ) : (
          <text x="60" y="62" text-anchor="middle" font-size="9" font-weight="700" fill="currentColor">{words[0]}</text>
        )}
        <text x="60" y="77" text-anchor="middle" font-size="6.4" font-weight="600" fill="currentColor">{fmtDate(c.verified)}</text>
        {c.optIn ? <text x="60" y="45" text-anchor="middle" font-size="6" font-weight="700" letter-spacing="1" fill="currentColor">OPT-IN</text> : null}
      </svg>
      {lapsed ? <span class="lapsed-mark" aria-hidden="true">Lapsed {c.expires}</span> : null}
    </div>
  );
}

export function Credential({ inv, compact = false }: { inv: Investor; compact?: boolean }) {
  const ros = rosette(220, 4, 2);
  const bnd = band(600, 26, 5, 9);
  const [l1, l2] = mrz(inv);
  const credLapsed = inv.expires < SIM_DATE;
  return (
    <article class={`credential ${compact ? 'compact' : ''}`} aria-label={`Laissez-passer for ${inv.name}`}>
      <svg class="cred-band" viewBox="0 0 600 26" preserveAspectRatio="none" aria-hidden="true">
        {bnd.map((d) => <path d={d} />)}
      </svg>
      <svg class="cred-rosette" viewBox="0 0 220 220" aria-hidden="true">
        {ros.map((d) => <path d={d} />)}
      </svg>
      <header class="cred-head">
        <span class="cred-title">Laissez-passer</span>
        <span class="cred-id">{inv.credentialId}</span>
      </header>
      <div class="cred-body">
        <dl class="cred-fields">
          <div><dt>Holder</dt><dd>{inv.name}</dd></div>
          <div><dt>Type</dt><dd>{inv.kind}</dd></div>
          <div><dt>Residence</dt><dd>{jurName[inv.residence]}{inv.usPerson ? ', U.S. person' : ''}</dd></div>
          <div><dt>Booked in</dt><dd>{bookingCenters[inv.booking].name}</dd></div>
          <div><dt>Valid</dt><dd class={credLapsed ? 'bad' : ''}>{inv.issued} to {inv.expires}{credLapsed ? ' (lapsed)' : ''}</dd></div>
          {!compact ? <div><dt>Wallet</dt><dd class="mono">{inv.wallet}</dd></div> : null}
        </dl>
        <div class="cred-stamps" aria-label="Eligibility stamps">
          {inv.classifications.length === 0 ? (
            <p class="no-stamps">No investor-class stamps. KYC only.</p>
          ) : (
            inv.classifications.map((c, i) => <Stamp c={c} idx={i} lapsed={c.expires < SIM_DATE} />)
          )}
        </div>
      </div>
      <div class="cred-mrz" aria-hidden="true"><div>{l1}</div><div>{l2}</div></div>
    </article>
  );
}
