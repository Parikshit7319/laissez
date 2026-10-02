// Laissez policy resolver (prototype). Deterministic: same inputs, same decision.
// Layers are evaluated in a fixed order and every requirement that applies must
// hold. Where two layers require different things in the same jurisdiction, the
// stricter one binds and the trace says which.

import {
  SIM_DATE, type Jur, type ClassCode, type Fund, type Investor, type BookingCenter,
  classInfo, bookingCenters, funds as FUNDS, investors as INVESTORS, jurName, sanctionedJurisdictions,
} from './data';

export type ClassMeta = { label: string; stamp: string; jur: Jur; rule: string; source: string; threshold: string };
/** A potential watchlist match. score is a 0 to 1 name similarity; source is the list (OFAC-SDN, UN, EU, UK). */
export type ScreenHit = { entry: string; program: string; score?: number; source?: string };
/** A fund document an investor must acknowledge before receiving units. */
export type DocReq = {
  id: string; ticker: string; title: string; docType: string; version: number; sha256: string;
  jurisdiction: string | null; audience: 'all' | 'retail' | 'professional'; required: boolean;
};
export type Notice = { units: number; dealingDate: string };
/** Everything the resolver reads. The demo uses the static defaults; the API loads it from the database. */
export type Ctx = {
  investors: Record<string, Investor>;
  funds: Record<string, Fund>;
  classInfo: Record<string, ClassMeta>;
  bookingCenters: Record<string, BookingCenter>;
  jurName: Record<string, string>;
  sanctioned: Record<string, string>;
  today: string;
  /** Name screening against a watchlist. Returns the matching entry, or null. */
  screen?: (name: string) => ScreenHit | null;
  /** Rule-pack versions in force, keyed by pack id ('SG/eligibility', 'global/sanctions', 'global/travel-rule'). */
  rulePacks?: Record<string, string>;
  /** Current instant (ISO 8601). Enables the dealing cut-off check. */
  now?: string;
  /** Required documents keyed by fund ticker. When undefined, the Documents layer is skipped. */
  documents?: Record<string, DocReq[]>;
  /** Acknowledgments: investor id to { document id: sha256 acknowledged }. */
  acks?: Record<string, Record<string, string>>;
  /** Fund assets under management in fund currency, keyed by ticker. Enables the redemption gate. */
  aum?: Record<string, number>;
  /** Value already redeeming in the current dealing period, keyed by ticker. */
  redeemedInPeriod?: Record<string, number>;
  /** Pending redemption notices keyed `${investorId}:${ticker}`. */
  notices?: Record<string, Notice[]>;
};
export const defaultCtx: Ctx = {
  investors: INVESTORS, funds: FUNDS, classInfo, bookingCenters, jurName, sanctioned: sanctionedJurisdictions as Record<string, string>, today: SIM_DATE,
};
// evaluate() is synchronous, so a module-level context is safe even in a shared runtime.
let C: Ctx = defaultCtx;

export type Action = 'subscribe' | 'transfer' | 'redeem';
export type WhatIf = 'expired' | 'sanctioned' | 'capFull' | 'dropUAE' | 'badAsset' | 'becameUS';

export const WHAT_IFS: { id: WhatIf; label: string; hint: string }[] = [
  { id: 'expired', label: 'Eligibility status expires', hint: 'Every classification on the investor’s credential lapses yesterday.' },
  { id: 'becameUS', label: 'Investor relocates to Texas', hint: 'The investor becomes a U.S. person under Regulation S.' },
  { id: 'sanctioned', label: 'Residence moves to a sanctioned country', hint: 'Residence changes to Iran, a comprehensive OFAC program.' },
  { id: 'capFull', label: 'Fund reaches its holder cap', hint: 'Only applies to funds with a beneficial-owner limit.' },
  { id: 'dropUAE', label: 'Issuer stops offering in the UAE', hint: 'The fund removes UAE (DIFC) from its distribution list.' },
  { id: 'badAsset', label: 'Pay with USDT', hint: 'Settlement in an asset the fund does not accept.' },
];

export type Order = {
  action: Action;
  investorId: string;
  fundId: string;
  amount: number; // in fund currency
  asset: string;
  counterpartyId?: string;
};

export type Layer = 'Credential' | 'Fund policy' | 'Residence law' | 'Booking-center licence' | 'Documents' | 'Fund terms' | 'Counterparty' | 'Transfer controls' | 'Global screens';
/** Display order for grouping checks by layer. */
export const LAYERS: Layer[] = ['Credential', 'Fund policy', 'Residence law', 'Booking-center licence', 'Documents', 'Fund terms', 'Transfer controls', 'Counterparty', 'Global screens'];
export type Result = 'pass' | 'fail' | 'na' | 'info';

export type Check = {
  id: string;
  layer: Layer;
  label: string;
  detail: string;
  result: Result;
  ruleRef?: string;
  source?: string;
  remedy?: string;
  binding?: boolean;
  subject?: string;
};

export type Requirement = { jur: Jur; code: ClassCode; optIn: boolean; layer: Layer; ruleRef: string; source: string; text: string };

export type Outcome = 'ALLOW' | 'DENY' | 'FREEZE';
export type Decision = {
  outcome: Outcome;
  headline: string;
  checks: Check[];
  resolved: { text: string; layer: Layer; ruleRef: string }[];
  remedies: string[];
  rulePacks: string[];
  redemptionOnly: boolean;
  units: number;
  notional: number;
  order: Order;
  investor: Investor;
  fund: Fund;
  counterparty?: Investor;
  appliedWhatIfs: WhatIf[];
  /** Dealing date for subscriptions and redemptions, when the fund has a cut-off and the context has a clock. */
  dealingDate?: string;
};

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const fmt = (n: number, cur = '') => `${cur}${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
export const money = (n: number, ccy: 'USD' | 'EUR') => (ccy === 'USD' ? '$' : '€') + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function addMonths(date: string, m: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + m);
  return d.toISOString().slice(0, 10);
}

function validClass(inv: Investor, code: ClassCode) {
  return inv.classifications.find((c) => c.code === code && c.expires >= C.today);
}
function anyClass(inv: Investor, code: ClassCode) {
  return inv.classifications.find((c) => c.code === code);
}

function applyWhatIfs(order: Order, whatIfs: WhatIf[]) {
  const investor = clone(C.investors[order.investorId]);
  const fund = clone(C.funds[order.fundId]);
  const o = clone(order);
  const applied: WhatIf[] = [];
  for (const w of whatIfs) {
    if (w === 'expired') {
      investor.classifications.forEach((c) => (c.expires = '2026-09-30'));
      applied.push(w);
    } else if (w === 'becameUS') {
      investor.usPerson = true; investor.residence = 'US'; investor.city = 'Austin, Texas';
      applied.push(w);
    } else if (w === 'sanctioned') {
      investor.residence = 'IR'; investor.city = 'Tehran';
      applied.push(w);
    } else if (w === 'capFull') {
      if (fund.holderCap) { fund.holders = fund.holderCap; applied.push(w); }
    } else if (w === 'dropUAE') {
      if (fund.distribution['AE-DIFC']) { delete fund.distribution['AE-DIFC']; applied.push(w); }
    } else if (w === 'badAsset') {
      o.asset = 'USDT'; applied.push(w);
    }
  }
  return { investor, fund, order: o, applied };
}

/** Eligibility of one party to receive units, across fund, residence and booking layers. */
function eligibilityChecks(inv: Investor, fund: Fund, layerPrefix: '' | 'Counterparty', isExistingHolder: boolean): { checks: Check[]; reqs: Requirement[] } {
  const checks: Check[] = [];
  const reqs: Requirement[] = [];
  const who = inv.short;
  const L = (l: Layer): Layer => (layerPrefix ? 'Counterparty' : l);

  // Fund policy: U.S. persons
  if (inv.usPerson) {
    if (fund.regS || !fund.usAccepts) {
      checks.push({ id: 'regS', layer: L('Fund policy'), subject: who, label: 'Non-U.S. persons only', result: 'fail',
        detail: `${fund.short} is sold under Regulation S. ${who} is a U.S. person by residence (${inv.city}).`,
        ruleRef: 'Reg S Rule 902(k)', source: 'reg-s', remedy: 'Offer a U.S. share class or a fund available to U.S. accredited investors.' });
      return { checks, reqs };
    }
  }

  // Fund policy: distribution list
  const dist = fund.distribution[inv.residence];
  if (!dist) {
    checks.push({ id: 'dist', layer: L('Fund policy'), subject: who, label: `Offered in ${C.jurName[inv.residence]}`, result: 'fail',
      detail: `The issuer has not approved ${fund.short} for investors resident in ${C.jurName[inv.residence]}.`,
      remedy: `Ask ${fund.issuer.replace(' (fictional)', '')} to add ${C.jurName[inv.residence]} to the distribution list.` });
    return { checks, reqs };
  }
  checks.push({ id: 'dist', layer: L('Fund policy'), subject: who, label: `Offered in ${C.jurName[inv.residence]}`, result: 'pass', detail: `Approved by the issuer for ${C.jurName[inv.residence]}. Basis: ${dist.basis}.` });

  // Fund policy: accepted classification
  const okFund = dist.accepts.find((c) => c === 'EU_RETAIL' ? true : !!validClass(inv, c));
  const fundNeed = dist.accepts.map((c) => `${C.classInfo[c].label}`).join(' or ');
  if (okFund) {
    const c = C.classInfo[okFund];
    checks.push({ id: 'fundClass', layer: L('Fund policy'), subject: who, label: `Investor class: ${fundNeed}`, result: 'pass',
      detail: okFund === 'EU_RETAIL' && !validClass(inv, 'EU_PRO') ? 'UCITS share class open to retail investors.' : `${who} holds ${c.label} status (${c.jur === inv.residence ? C.jurName[c.jur] : c.jur}).`,
      ruleRef: c.rule, source: c.source });
  } else {
    const lapsed = dist.accepts.map((c) => anyClass(inv, c)).find(Boolean);
    checks.push({ id: 'fundClass', layer: L('Fund policy'), subject: who, label: `Investor class: ${fundNeed}`, result: 'fail',
      detail: lapsed ? `${who}’s ${C.classInfo[lapsed.code].label} status expired on ${lapsed.expires}.` : `${who} has no ${fundNeed} status in ${C.jurName[inv.residence]}.`,
      ruleRef: C.classInfo[dist.accepts[0]].rule, source: C.classInfo[dist.accepts[0]].source,
      remedy: lapsed ? `Re-verify ${C.classInfo[lapsed.code].label} status with current evidence.` : `Only investors who qualify as ${fundNeed} can hold this fund in ${C.jurName[inv.residence]}.` });
  }

  // Residence law
  if (dist.lawRequires) {
    const code = dist.lawRequires;
    const needOptIn = code === 'SG_AI';
    const cl = validClass(inv, code);
    const pass = !!cl && (!needOptIn || !!cl.optIn);
    reqs.push({ jur: inv.residence, code, optIn: needOptIn, layer: L('Residence law'), ruleRef: dist.lawRef, source: dist.lawSource, text: dist.lawText });
    checks.push({ id: 'law', layer: L('Residence law'), subject: who, label: `${C.jurName[inv.residence]}: ${C.classInfo[code].label}${needOptIn ? ' with opt-in' : ''}`,
      result: pass ? 'pass' : 'fail',
      detail: pass ? `${dist.lawText} ${needOptIn ? `Opt-in recorded on ${cl!.optIn}.` : ''}`.trim() : dist.lawText,
      ruleRef: dist.lawRef, source: dist.lawSource,
      remedy: pass ? undefined : `Investor must qualify as ${C.classInfo[code].label} in ${C.jurName[inv.residence]}.` });
  } else {
    checks.push({ id: 'law', layer: L('Residence law'), subject: who, label: `${C.jurName[inv.residence]}: no investor-class restriction`, result: 'pass', detail: dist.lawText, ruleRef: dist.lawRef, source: dist.lawSource });
  }

  // Booking-center licence
  const bc = C.bookingCenters[inv.booking];
  if (bc?.requires) {
    const cl = validClass(inv, bc.requires);
    const optIn = bc.requires === 'SG_AI';
    const pass = !!cl && (!optIn || !!cl.optIn);
    reqs.push({ jur: bc.jur, code: bc.requires, optIn, layer: L('Booking-center licence'), ruleRef: bc.ruleRef, source: bc.source, text: bc.ruleText });
    checks.push({ id: 'booking', layer: L('Booking-center licence'), subject: who, label: `Booked in ${bc.name}: ${C.classInfo[bc.requires].label}`, result: pass ? 'pass' : 'fail',
      detail: bc.ruleText, ruleRef: bc.ruleRef, source: bc.source,
      remedy: pass ? undefined : `Classify the client as ${C.classInfo[bc.requires].label} under ${bc.ruleRef}, or book the order through a center whose rules the client meets.` });
  }

  // Holder cap applies to new holders only
  if (fund.holderCap) {
    if (isExistingHolder) {
      checks.push({ id: 'cap', layer: L('Fund policy'), subject: who, label: 'Beneficial-owner limit', result: 'pass', detail: `${who} is already a holder, so the count stays at ${fund.holders} of ${fund.holderCap}.`, ruleRef: 'ICA §3(c)(1)', source: 'ica-3c' });
    } else {
      const pass = fund.holders < fund.holderCap;
      checks.push({ id: 'cap', layer: L('Fund policy'), subject: who, label: 'Beneficial-owner limit', result: pass ? 'pass' : 'fail',
        detail: pass ? `${fund.holders} of ${fund.holderCap} beneficial owners. Adding ${who} makes ${fund.holders + 1}.` : `${fund.holders} of ${fund.holderCap} beneficial owners. A new holder would breach the Section 3(c)(1) limit.`,
        ruleRef: 'ICA §3(c)(1)', source: 'ica-3c', remedy: pass ? undefined : 'Place the order on the waitlist. It executes when an existing holder fully redeems.' });
    }
  }
  return { checks, reqs };
}

function resolve(reqs: Requirement[], checks: Check[]) {
  // Group by jurisdiction + class; opt-in variant is stricter than plain status.
  const byKey = new Map<string, Requirement>();
  for (const r of reqs) {
    const key = `${r.jur}:${r.code}`;
    const cur = byKey.get(key);
    if (!cur || (r.optIn && !cur.optIn)) byKey.set(key, r);
  }
  const resolved = [...byKey.values()].map((r) => ({
    text: `${C.classInfo[r.code].label}${r.optIn ? ' with opt-in' : ''} in ${C.jurName[r.jur]}`,
    layer: r.layer,
    ruleRef: r.ruleRef,
  }));
  // Mark the binding checks: the resolved requirement's source check
  for (const r of byKey.values()) {
    const target = checks.find((c) => c.layer === r.layer && (c.id === 'law' || c.id === 'booking') && c.label.includes(C.classInfo[r.code].label));
    if (target) target.binding = true;
  }
  return resolved;
}

// ---------- Screening text ----------
function hitText(h: ScreenHit): string {
  const prog = h.source && !h.program.startsWith(h.source) ? `${h.source}${h.program ? `: ${h.program}` : ''}` : h.program;
  return `Potential match with “${h.entry}” (${prog})${typeof h.score === 'number' ? `, similarity ${h.score.toFixed(2)}` : ''}`;
}
const issuerNameOf = (inv: Investor) => (inv.issuer ?? 'Aster & Vale').replace(/\s*\(relied on under share [^)]*\)\s*$/, '');

// ---------- Documents layer ----------
/** Documents the receiving party must acknowledge, each at its current hash. */
function documentChecks(p: Investor, fund: Fund): Check[] {
  const docs = C.documents?.[fund.ticker] ?? [];
  const who = p.short;
  const dist = fund.distribution[p.residence];
  const proForFund = (dist?.accepts ?? []).some((c) => c !== 'EU_RETAIL' && !!validClass(p, c));
  const retailOnly = !!dist?.accepts.includes('EU_RETAIL') && !proForFund;
  const professional = !retailOnly && p.classifications.some((c) => c.code !== 'EU_RETAIL' && c.expires >= C.today);
  const applies = docs.filter((d) => d.required
    && (d.jurisdiction == null || d.jurisdiction === p.residence)
    && (d.audience === 'all' || (d.audience === 'retail' && retailOnly) || (d.audience === 'professional' && professional)));
  if (!applies.length) {
    return [{ id: 'docs', layer: 'Documents', subject: who, label: 'Fund documents acknowledged', result: 'pass',
      detail: `No ${fund.short} document needs an acknowledgment from ${who} in ${C.jurName[p.residence] ?? p.residence}.` }];
  }
  return applies.map((d): Check => {
    const ack = C.acks?.[p.id]?.[d.id];
    const ok = ack === d.sha256;
    return {
      id: `doc:${d.id}`, layer: 'Documents', subject: who, label: `${d.title} v${d.version} acknowledged`, result: ok ? 'pass' : 'fail',
      detail: ok
        ? `${who} acknowledged version ${d.version} (SHA-256 ${d.sha256.slice(0, 12)}…).`
        : ack
          ? `${who} acknowledged a different version of ${d.title}. Version ${d.version} needs its own acknowledgment before ${who} receives units.`
          : `${who} has not acknowledged ${d.title} v${d.version}. It must be acknowledged before ${who} receives units.`,
      remedy: ok ? undefined : `Send ${d.title} v${d.version} to the investor in the portal, or record an attested acknowledgment.`,
    };
  });
}

// ---------- Fund terms: dealing calendar (business days are Monday to Friday) ----------
export type DealingFrequency = 'daily' | 'monthly' | 'quarterly';
function addDaysISO(d: string, n: number): string {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
const isBusinessDay = (d: string) => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w > 0 && w < 6; };
function nextBusinessDay(d: string): string {
  let x = addDaysISO(d, 1);
  while (!isBusinessDay(x)) x = addDaysISO(x, 1);
  return x;
}
/** Last business day of month m (1-12, may run past 12 into later years). */
function lastBusinessDay(y: number, m: number): string {
  const yy = y + Math.floor((m - 1) / 12);
  const mm = (((m - 1) % 12) + 12) % 12 + 1;
  let x = new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
  while (!isBusinessDay(x)) x = addDaysISO(x, -1);
  return x;
}
/**
 * The dealing date an order received on `date` gets. `open` is true when the order arrived before the
 * cut-off, so `date` itself still counts if it is a dealing day.
 */
export function dealingDateFor(freq: DealingFrequency, date: string, open: boolean): string {
  if (freq === 'daily') return isBusinessDay(date) && open ? date : nextBusinessDay(date);
  const y = Number(date.slice(0, 4)); const m = Number(date.slice(5, 7));
  const endM = freq === 'monthly' ? m : Math.ceil(m / 3) * 3;
  const cur = lastBusinessDay(y, endM);
  return date < cur || (date === cur && open) ? cur : lastBusinessDay(y, endM + (freq === 'monthly' ? 1 : 3));
}
/** Wall-clock date and time at the fund's cut-off time zone. Falls back to UTC for an unknown zone. */
export function fundClock(iso: string, tz: string): { date: string; hhmm: string; minutes: number; tz: string } | null {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  let zone = tz || 'UTC';
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: zone }).formatToParts(t); }
  catch { zone = 'UTC'; parts = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).formatToParts(t); }
  const g = (k: string) => parts.find((p) => p.type === k)?.value ?? '00';
  const h = Number(g('hour')) % 24; const mi = Number(g('minute'));
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hhmm: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`, minutes: h * 60 + mi, tz: zone };
}
const parseHHMM = (s?: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const FREQ_TEXT: Record<DealingFrequency, string> = {
  daily: 'The fund deals every business day.',
  monthly: 'The fund deals on the last business day of each month.',
  quarterly: 'The fund deals on the last business day of each quarter.',
};
const LIQUIDITY_NOTE = 'This is a liquidity term of the fund, separate from eligibility: redemption stays open on eligibility grounds.';
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Dealing cut-off, notice period and redemption gate. These are the fund's liquidity terms, not eligibility. */
function fundTermChecks(inv: Investor, fund: Fund, o: Order, units: number): { checks: Check[]; dealingDate?: string } {
  const checks: Check[] = [];
  const freq: DealingFrequency = fund.dealingFrequency === 'monthly' || fund.dealingFrequency === 'quarterly' ? fund.dealingFrequency : 'daily';
  const cut = parseHHMM(fund.cutoffTime);
  const clock = C.now && cut !== null ? fundClock(C.now, fund.cutoffTz ?? 'UTC') : null;
  const localDate = clock?.date ?? C.today;
  const beforeCutoff = clock ? clock.minutes < cut! : true;
  const dd = dealingDateFor(freq, localDate, beforeCutoff);
  let dealingDate: string | undefined;
  if (clock) {
    dealingDate = dd;
    checks.push({ id: 'dealing', layer: 'Fund terms', label: `Dealing cut-off ${fund.cutoffTime} (${clock.tz})`, result: 'info',
      detail: `${FREQ_TEXT[freq]} Received ${clock.date} at ${clock.hhmm} fund time, ${beforeCutoff ? 'before' : 'after'} the cut-off, so the order deals on ${dd} at that day's NAV.` });
  }
  if (o.action !== 'redeem') return { checks, dealingDate };

  const n = fund.noticeDays ?? 0;
  if (n > 0) {
    const fromToday = dealingDateFor(freq, addDaysISO(localDate, n), true);
    const earliest = fromToday > dd ? fromToday : dd;
    const covering = (C.notices?.[`${inv.id}:${fund.ticker}`] ?? []).filter((x) => x.dealingDate <= dd);
    const covered = r2(covering.reduce((s, x) => s + Number(x.units), 0));
    const pass = covered >= units;
    checks.push({ id: 'notice', layer: 'Fund terms', subject: inv.short, label: `${n}-day redemption notice`, result: pass ? 'pass' : 'fail',
      detail: pass
        ? `Notice on file for ${fmt(covered)} units dealing on or before ${dd}. It covers this redemption of ${fmt(units)} units.`
        : `Redemptions need ${n} days' notice. A notice filed today makes the earliest dealing date ${earliest}.${covered > 0 ? ` Notices on file cover ${fmt(covered)} of ${fmt(units)} units for ${dd}.` : ''} ${LIQUIDITY_NOTE}`,
      remedy: pass ? undefined : 'File a redemption notice.' });
  }

  const aum = C.aum?.[fund.ticker];
  if (fund.gatePct && aum != null && aum > 0) {
    const limit = r2((fund.gatePct / 100) * aum);
    const used = r2(C.redeemedInPeriod?.[fund.ticker] ?? 0);
    const headroom = Math.max(0, r2(limit - used));
    const pass = r2(used + o.amount) <= limit;
    const nextPeriod = dealingDateFor(freq, dd, false);
    const m = (x: number) => money(x, fund.currency);
    checks.push({ id: 'gate', layer: 'Fund terms', label: `Redemption gate: ${fund.gatePct}% of assets per dealing period`, result: pass ? 'pass' : 'fail',
      detail: pass
        ? `${m(r2(used + o.amount))} of the ${m(limit)} limit is used for the period dealing ${dd}, including this order. Assets are ${m(aum)}.`
        : `The fund caps redemptions at ${fund.gatePct}% of assets per dealing period: ${m(limit)} of ${m(aum)}. ${m(used)} is already redeeming for ${dd}, so ${m(headroom)} remains and this order is ${m(o.amount)}. ${LIQUIDITY_NOTE}`,
      remedy: pass ? undefined : headroom > 0 ? `Reduce the redemption to ${m(headroom)} or less, or place it in the next dealing period (${nextPeriod}).` : `Place the redemption in the next dealing period (${nextPeriod}).` });
  }
  return { checks, dealingDate };
}

export function evaluate(order: Order, whatIfs: WhatIf[] = [], ctx: Ctx = defaultCtx): Decision {
  C = ctx;
  const { investor: inv, fund, order: o, applied } = applyWhatIfs(order, whatIfs);
  const checks: Check[] = [];
  let reqs: Requirement[] = [];
  let dealingDate: string | undefined;
  const counterparty = o.counterpartyId ? clone(C.investors[o.counterpartyId]) : undefined;

  const units = Math.round((o.amount / fund.nav) * 100) / 100;
  const holding = inv.holdings[fund.id];

  // ---------- Credential layer ----------
  const hasCred = !!inv.credentialId;
  const credValid = hasCred && inv.expires >= C.today;
  const needsValid = o.action !== 'redeem';
  const issuerName = issuerNameOf(inv);
  const shareGone = !!inv.reliedShare && (inv.shareStatus === 'revoked' || inv.shareStatus === 'declined' || inv.shareStatus === 'credential_revoked');
  const sharePending = !!inv.reliedShare && inv.shareStatus === 'pending';
  if (shareGone || sharePending) {
    const why = inv.shareStatus === 'credential_revoked' ? `${issuerName} revoked it` : inv.shareStatus === 'declined' ? 'the client declined the share' : inv.shareStatus === 'pending' ? 'the client has not yet consented to the share' : 'the client withdrew the share';
    checks.push({ id: 'cred', layer: 'Credential', subject: inv.short, label: 'Laissez credential on file', result: needsValid ? 'fail' : 'info',
      detail: sharePending
        ? `The credential${inv.lzid ? ` ${inv.lzid}` : ''} from ${issuerName} cannot be relied on yet: ${why}.${needsValid ? '' : ' Not required to redeem.'}`
        : `The relied-on credential${inv.lzid ? ` ${inv.lzid}` : ''} from ${issuerName} is no longer valid: ${why}.${needsValid ? '' : ' Not required to redeem.'}`,
      remedy: needsValid ? (sharePending ? 'Ask the client to approve the share, or issue your own credential.' : 'Ask the client to share again, or issue your own credential.') : undefined });
  } else {
    const relied = inv.reliedShare ? ` Relied on under share ${inv.reliedShare}: ${issuerName} issued it and keeps the underlying KYC current.` : '';
    checks.push({ id: 'cred', layer: 'Credential', subject: inv.short, label: 'Laissez credential on file',
      result: credValid ? 'pass' : needsValid ? 'fail' : 'info',
      detail: credValid ? `${inv.credentialId}, issued by ${issuerName} on ${inv.issued}, valid to ${inv.expires}.${relied}` : !hasCred ? `No Laissez credential has been issued to ${inv.short}.${needsValid ? '' : ' Not required to redeem.'}` : `${inv.credentialId} lapsed on ${inv.expires}. Credentials are valid for 12 months (Laissez policy).${needsValid ? '' : ' Not required to redeem.'}`,
      remedy: credValid || !needsValid ? undefined : !hasCred ? 'Issue a credential: record the client’s classification in each relevant jurisdiction.' : 'Renew the credential: the distributor re-attests KYC and refreshes each classification.' });
  }

  const hit = C.screen?.(inv.name) ?? null;
  checks.push({ id: 'screen', layer: 'Credential', subject: inv.short, label: 'Sanctions name screening', result: hit ? 'fail' : 'pass',
    detail: hit ? `${hitText(hit)}. Screened at order time.` : 'No match against the screening list. Screened at order time.', ruleRef: 'OFAC', source: 'ofac',
    remedy: hit ? 'Units are frozen pending review. Compliance confirms or clears the match before anything settles.' : undefined });
  if (hit) return finish('FREEZE');

  const sanc = C.sanctioned[inv.residence];
  if (sanc) {
    checks.push({ id: 'sanc', layer: 'Global screens', subject: inv.short, label: 'Comprehensively sanctioned jurisdiction', result: 'fail', detail: sanc, ruleRef: 'OFAC country programs', source: 'ofac',
      remedy: 'Units are frozen in place. Compliance is alerted and files the required report. No settlement until a licence or legal determination exists.' });
    return finish('FREEZE');
  }

  // ---------- Action-specific ----------
  if (o.action === 'subscribe') {
    const r = eligibilityChecks(inv, fund, '', !!holding);
    checks.push(...r.checks); reqs = r.reqs;
    checks.push({ id: 'min', layer: 'Fund policy', subject: inv.short, label: `Minimum subscription ${money(fund.minSubscription, fund.currency)}`, result: o.amount >= fund.minSubscription ? 'pass' : 'fail',
      detail: `Order is ${money(o.amount, fund.currency)}.`, remedy: o.amount >= fund.minSubscription ? undefined : `Increase the order to at least ${money(fund.minSubscription, fund.currency)}.` });
    if (C.documents) checks.push(...documentChecks(inv, fund));
  }

  if (o.action === 'transfer') {
    const cp = counterparty!;
    // The receiving party is screened first: a match freezes the transfer before anything else is tested.
    const cpHit = C.screen?.(cp.name) ?? null;
    if (cpHit) {
      checks.push({ id: 'cpScreen', layer: 'Global screens', subject: cp.short, label: 'Counterparty sanctions screening', result: 'fail',
        detail: `${hitText(cpHit)}. Screened at order time.`, ruleRef: 'OFAC', source: 'ofac',
        remedy: 'Units are frozen pending review. Compliance confirms or clears the match before anything settles.' });
      return finish('FREEZE');
    }
    // Sender side
    checks.push({ id: 'holding', layer: 'Transfer controls', subject: inv.short, label: 'Sender holds enough units', result: holding && holding.units >= units ? 'pass' : 'fail',
      detail: holding ? `${fmt(holding.units)} units held since ${holding.since}; transferring ${fmt(units)}.` : `${inv.short} holds no ${fund.ticker}.`,
      remedy: holding && holding.units >= units ? undefined : 'Reduce the transfer to the available balance.' });
    if (fund.lockupMonths && holding) {
      const ends = addMonths(holding.since, fund.lockupMonths);
      const pass = ends <= C.today;
      checks.push({ id: 'lock', layer: 'Transfer controls', subject: inv.short, label: `${fund.lockupMonths}-month lock-up`, result: pass ? 'pass' : 'fail',
        detail: pass ? `Lock-up ended ${ends}.` : `Units acquired ${holding.since}. Lock-up ends ${ends}.`, remedy: pass ? undefined : `Transfers open on ${ends}.` });
    }
    const senderEligible = fund.distribution[inv.residence]?.accepts.some((c) => validClass(inv, c));
    checks.push({ id: 'senderStatus', layer: 'Transfer controls', subject: inv.short, label: 'Sender may transfer out', result: 'pass',
      detail: senderEligible ? `${inv.short} is an eligible holder.` : `${inv.short} is redemption-only, but outbound transfers to an eligible buyer are permitted. The buyer’s status is what the law tests.` });
    // Receiver side
    const r = eligibilityChecks(cp, fund, 'Counterparty', !!cp.holdings[fund.id]);
    checks.push(...r.checks); reqs = r.reqs;
    if (C.documents) checks.push(...documentChecks(cp, fund));
    if (o.amount >= 1000) {
      checks.push({ id: 'travel', layer: 'Global screens', label: 'Travel Rule data exchanged', result: 'pass',
        detail: `Originator (${inv.short}, booked ${C.bookingCenters[inv.booking]?.name ?? inv.booking}) and beneficiary (${cp.short}, booked ${C.bookingCenters[cp.booking]?.name ?? cp.booking}) details sent in IVMS101 format before settlement.`,
        ruleRef: 'FATF R.16', source: 'fatf-r16' });
    }
    checks.push({ id: 'cpScreen', layer: 'Global screens', subject: cp.short, label: 'Counterparty sanctions screening', result: 'pass', detail: 'No match against OFAC SDN, UN and EU consolidated lists.', ruleRef: 'OFAC', source: 'ofac' });
  }

  if (o.action === 'redeem') {
    checks.push({ id: 'holding', layer: 'Transfer controls', subject: inv.short, label: 'Investor holds enough units', result: holding && holding.units >= units ? 'pass' : 'fail',
      detail: holding ? `${fmt(holding.units)} units held since ${holding.since}; redeeming ${fmt(units)}.` : `${inv.short} holds no ${fund.ticker}.`,
      remedy: holding && holding.units >= units ? undefined : 'Reduce the redemption to the available balance.' });
    if (fund.lockupMonths && holding) {
      const ends = addMonths(holding.since, fund.lockupMonths);
      const pass = ends <= C.today;
      checks.push({ id: 'lock', layer: 'Transfer controls', subject: inv.short, label: `${fund.lockupMonths}-month lock-up`, result: pass ? 'pass' : 'fail',
        detail: pass ? `Lock-up ended ${ends}.` : `Units acquired ${holding.since}. Lock-up ends ${ends}.`, remedy: pass ? undefined : `Redemptions open on ${ends}.` });
    }
    const eligibleNow = !inv.usPerson || !!fund.usAccepts ? fund.distribution[inv.residence]?.accepts.some((c) => c === 'EU_RETAIL' || validClass(inv, c)) : false;
    checks.push({ id: 'redeemPolicy', layer: 'Fund policy', subject: inv.short, label: 'Redemption stays open', result: 'pass',
      detail: eligibleNow ? `${inv.short} is an eligible holder.` : `${inv.short} no longer meets the fund’s eligibility rules. Laissez keeps redemption open: holders whose status lapses can always exit, they just cannot add.` });
  }

  // ---------- Fund terms (subscriptions and redemptions) ----------
  if (o.action !== 'transfer') {
    const t = fundTermChecks(inv, fund, o, units);
    checks.push(...t.checks); dealingDate = t.dealingDate;
  }

  // ---------- Settlement asset (all actions) ----------
  const assetOk = fund.assets.includes(o.asset);
  checks.push({ id: 'asset', layer: 'Fund policy', label: `Settlement in ${o.asset}`, result: assetOk ? 'pass' : 'fail',
    detail: assetOk ? `${o.asset} is on the fund’s accepted settlement list (${fund.assets.join(', ')}).` : `${fund.short} settles only in ${fund.assets.join(' or ')}.`,
    remedy: assetOk ? undefined : `Settle in ${fund.assets.join(' or ')}.` });

  const failed = checks.some((c) => c.result === 'fail');
  return finish(failed ? 'DENY' : 'ALLOW');

  function finish(outcome: Outcome): Decision {
    const resolved = resolve(reqs, checks);
    const remedies = checks.filter((c) => c.result === 'fail' && c.remedy).map((c) => c.remedy!);
    const redemptionOnly = o.action === 'redeem' && checks.some((c) => c.id === 'redeemPolicy' && c.detail.includes('no longer'));
    const verb = o.action === 'subscribe' ? 'Subscription' : o.action === 'transfer' ? 'Transfer' : 'Redemption';
    const firstFail = checks.find((c) => c.result === 'fail');
    const nFail = checks.filter((c) => c.result === 'fail').length;
    const headline = outcome === 'ALLOW'
      ? redemptionOnly
        ? `${verb} allowed. ${inv.short} is redemption-only: ${inv.kind === 'Individual' ? 'they' : 'it'} can exit the fund but cannot add to it.`
        : `${verb} allowed. ${resolved.length ? `Binding rule${resolved.length > 1 ? 's' : ''}: ${resolved.map((r) => r.text).join(' and ')}.` : 'No investor-class restriction applies.'}`
      : outcome === 'FREEZE'
        ? `${verb} blocked and units frozen. ${firstFail?.detail ?? ''}`
        : `${verb} denied. ${firstFail?.detail ?? ''}${nFail > 1 ? ` ${nFail - 1} more check${nFail > 2 ? 's' : ''} failed.` : ''}`;
    const rulePacks = buildRulePacks(fund, inv, counterparty);
    const d: Decision = { outcome, headline, checks, resolved, remedies, rulePacks, redemptionOnly, units, notional: o.amount, order: o, investor: inv, fund, counterparty, appliedWhatIfs: applied };
    if (dealingDate) d.dealingDate = dealingDate;
    return d;
  }
}

const LAUNCH_PACKS: Record<string, string> = { SG: '2026.09.0', HK: '2026.04.2' };
function buildRulePacks(fund: Fund, inv: Investor, cp?: Investor): string[] {
  const packs = new Set<string>();
  // Only a pack-id map counts; a raw list of rule-pack rows (or nothing) falls back to the launch versions.
  const rp = C.rulePacks && typeof C.rulePacks === 'object' && !Array.isArray(C.rulePacks) ? C.rulePacks : undefined;
  const jurs: Jur[] = [inv.residence, C.bookingCenters[inv.booking]?.jur, ...(cp ? [cp.residence, C.bookingCenters[cp.booking]?.jur] : [])].filter((j): j is Jur => !!j);
  if (rp) {
    packs.add(`fund/${fund.ticker}@v${fund.policyVersion ?? 1}`);
    for (const j of jurs) { const v = rp[`${j}/eligibility`]; if (v) packs.add(`${j}/eligibility@${v}`); }
    if (rp['global/sanctions']) packs.add(`global/sanctions@${rp['global/sanctions']}`);
    if (rp['global/travel-rule']) packs.add(`global/travel-rule@${rp['global/travel-rule']}`);
    return [...packs];
  }
  packs.add(`fund/${fund.ticker}@2026.09.1`);
  for (const j of jurs) if (j !== 'IR') packs.add(`${j}/eligibility@${LAUNCH_PACKS[j] ?? '2026.07.0'}`);
  packs.add('global/sanctions@2026-10-01');
  packs.add('global/travel-rule@2026.07');
  return [...packs];
}

// ---------- Point-in-time snapshots ----------
/** Exactly the inputs evaluate() reads for one order, in JSON-safe form. Stored with each decision so it can be replayed. */
export type Snapshot = {
  v: 1;
  order: Order;
  whatIfs: WhatIf[];
  investors: Record<string, Investor>;
  funds: Record<string, Fund>;
  classInfo: Record<string, ClassMeta>;
  bookingCenters: Record<string, BookingCenter>;
  jurName: Record<string, string>;
  sanctioned: Record<string, string>;
  today: string;
  now: string | null;
  rulePacks: Record<string, string> | null;
  documents: Record<string, DocReq[]> | null;
  acks: Record<string, Record<string, string>> | null;
  aum: Record<string, number> | null;
  redeemedInPeriod: Record<string, number> | null;
  notices: Record<string, Notice[]> | null;
  /** Screening result for each involved name, as it was at decision time. */
  screen: Record<string, ScreenHit | null>;
};

const pick = <T,>(src: Record<string, T> | undefined, keys: Iterable<string>): Record<string, T> => {
  const out: Record<string, T> = {};
  if (!src) return out;
  for (const k of keys) if (k in src && src[k] !== undefined) out[k] = src[k];
  return out;
};

export function snapshotFor(order: Order, ctx: Ctx, whatIfs: WhatIf[] = []): Snapshot {
  const ids = [order.investorId, ...(order.counterpartyId ? [order.counterpartyId] : [])];
  const invs = ids.map((i) => ctx.investors[i]).filter(Boolean) as Investor[];
  const fund = ctx.funds[order.fundId];
  const ticker = fund?.ticker ?? order.fundId;
  const bookings = new Set(invs.map((i) => i.booking));
  // What-ifs can move residence to US or IR, so their names and sanctions entries travel with the snapshot.
  const jurs = new Set<string>(['US', 'IR', ...invs.map((i) => i.residence), ...Object.keys(fund?.distribution ?? {})]);
  for (const b of bookings) if (ctx.bookingCenters[b]) jurs.add(ctx.bookingCenters[b].jur);
  const classes = new Set<string>([...(fund?.usAccepts ?? []), ...invs.flatMap((i) => i.classifications.map((c) => c.code))]);
  for (const d of Object.values(fund?.distribution ?? {})) { d?.accepts.forEach((c) => classes.add(c)); if (d?.lawRequires) classes.add(d.lawRequires); }
  for (const b of bookings) { const r = ctx.bookingCenters[b]?.requires; if (r) classes.add(r); }
  const noticeKeys = invs.map((i) => `${i.id}:${ticker}`);
  const snap: Snapshot = {
    v: 1,
    order,
    whatIfs: [...whatIfs],
    investors: pick(ctx.investors, ids),
    funds: pick(ctx.funds, [order.fundId]),
    classInfo: pick(ctx.classInfo, classes),
    bookingCenters: pick(ctx.bookingCenters, bookings),
    jurName: pick(ctx.jurName, jurs),
    sanctioned: pick(ctx.sanctioned, jurs),
    today: ctx.today,
    now: ctx.now ?? null,
    rulePacks: ctx.rulePacks ? { ...ctx.rulePacks } : null,
    documents: ctx.documents ? pick(ctx.documents, [ticker]) : null,
    acks: ctx.acks ? pick(ctx.acks, ids) : null,
    aum: ctx.aum ? pick(ctx.aum, [ticker]) : null,
    redeemedInPeriod: ctx.redeemedInPeriod ? pick(ctx.redeemedInPeriod, [ticker]) : null,
    notices: ctx.notices ? pick(ctx.notices, noticeKeys) : null,
    screen: Object.fromEntries(invs.map((i) => [i.name, ctx.screen?.(i.name) ?? null])),
  };
  return JSON.parse(JSON.stringify(snap));
}

export function ctxFromSnapshot(snap: Snapshot): Ctx {
  const screens = snap.screen ?? {};
  return {
    investors: snap.investors, funds: snap.funds, classInfo: snap.classInfo, bookingCenters: snap.bookingCenters,
    jurName: snap.jurName, sanctioned: snap.sanctioned, today: snap.today,
    now: snap.now ?? undefined, rulePacks: snap.rulePacks ?? undefined, documents: snap.documents ?? undefined, acks: snap.acks ?? undefined,
    aum: snap.aum ?? undefined, redeemedInPeriod: snap.redeemedInPeriod ?? undefined, notices: snap.notices ?? undefined,
    screen: (name: string) => screens[name] ?? null,
  };
}

/** Re-runs a stored decision from its snapshot. Same snapshot, same checks and inputs hash. */
export function replaySnapshot(snap: Snapshot): Decision {
  return evaluate(snap.order, snap.whatIfs ?? [], ctxFromSnapshot(snap));
}

// ---------- Issuer view: simulated register and credential network ----------
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type RegisterRow = { jur: Jur; units: number };
export const REGISTER_MIX: Partial<Record<Jur, number>> = { SG: 71, HK: 58, CH: 31, DE: 22, 'AE-DIFC': 32 };
export const NETWORK_POOL: Partial<Record<Jur, number>> = { SG: 1140, HK: 860, CH: 312, DE: 455, 'AE-DIFC': 290 };

export function simulatedRegister(seed = 7): RegisterRow[] {
  const rnd = mulberry32(seed);
  const rows: RegisterRow[] = [];
  for (const [jur, n] of Object.entries(REGISTER_MIX) as [Jur, number][]) {
    for (let i = 0; i < n; i++) {
      // log-normal-ish balances between ~$100K and ~$40M
      const u = Math.exp(Math.log(100_000) + rnd() * rnd() * Math.log(400));
      rows.push({ jur, units: Math.round(u / 1000) * 1000 });
    }
  }
  return rows;
}

export function issuerImpact(offered: Jur[], register = simulatedRegister()) {
  const all = Object.keys(REGISTER_MIX) as Jur[];
  const removed = all.filter((j) => !offered.includes(j));
  const hit = register.filter((r) => removed.includes(r.jur));
  return {
    removed,
    holders: hit.length,
    units: hit.reduce((s, r) => s + r.units, 0),
    totalHolders: register.length,
    totalUnits: register.reduce((s, r) => s + r.units, 0),
    byJur: all.map((j) => ({ jur: j, holders: register.filter((r) => r.jur === j).length, units: register.filter((r) => r.jur === j).reduce((s, r) => s + r.units, 0), offered: offered.includes(j), network: NETWORK_POOL[j] ?? 0 })),
  };
}

export async function inputsHash(d: Decision): Promise<string> {
  // Fixed field order, so the hash survives a round trip through storage that reorders object keys.
  const o = d.order;
  const payload = JSON.stringify({ o: [o.action, o.investorId, o.fundId, o.amount, o.asset, o.counterpartyId ?? null], w: d.appliedWhatIfs, c: d.checks.map((c) => [c.id, c.result]), p: d.rulePacks });
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 2166136261;
    for (let i = 0; i < payload.length; i++) { h ^= payload.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0').repeat(8);
  }
}


/** Standing of an existing holder, independent of any order. */
export function holderStatus(inv: Investor, fund: Fund, ctx: Ctx = defaultCtx): { status: 'eligible' | 'redemption-only' | 'frozen'; reason: string } {
  if (ctx.sanctioned[inv.residence]) return { status: 'frozen', reason: ctx.sanctioned[inv.residence] };
  const hit = ctx.screen?.(inv.name);
  if (hit) return { status: 'frozen', reason: `Potential screening match: ${hit.entry}` };
  if (inv.usPerson && (fund.regS || !fund.usAccepts)) return { status: 'redemption-only', reason: 'U.S. person in a Regulation S fund.' };
  const dist = fund.distribution[inv.residence];
  if (!dist) return { status: 'redemption-only', reason: `${ctx.jurName[inv.residence] ?? inv.residence} is not on the fund's distribution list.` };
  const valid = (code: string) => inv.classifications.some((c) => c.code === code && c.expires >= ctx.today);
  if (!dist.accepts.some((c) => c === 'EU_RETAIL' || valid(c))) return { status: 'redemption-only', reason: 'No current classification the fund accepts.' };
  return { status: 'eligible', reason: 'Meets the fund policy for its jurisdiction.' };
}
