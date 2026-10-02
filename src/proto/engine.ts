// Laissez policy resolver (prototype). Deterministic: same inputs, same decision.
// Layers are evaluated in a fixed order and every requirement that applies must
// hold. Where two layers require different things in the same jurisdiction, the
// stricter one binds and the trace says which.

import {
  SIM_DATE, type Jur, type ClassCode, type Fund, type Investor, type FundId, type InvestorId,
  classInfo, bookingCenters, funds as FUNDS, investors as INVESTORS, jurName, sanctionedJurisdictions,
} from './data';

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
  investorId: InvestorId;
  fundId: FundId;
  amount: number; // in fund currency
  asset: string;
  counterpartyId?: InvestorId;
};

export type Layer = 'Credential' | 'Fund policy' | 'Residence law' | 'Booking-center licence' | 'Counterparty' | 'Transfer controls' | 'Global screens';
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
  return inv.classifications.find((c) => c.code === code && c.expires >= SIM_DATE);
}
function anyClass(inv: Investor, code: ClassCode) {
  return inv.classifications.find((c) => c.code === code);
}

function applyWhatIfs(order: Order, whatIfs: WhatIf[]) {
  const investor = clone(INVESTORS[order.investorId]);
  const fund = clone(FUNDS[order.fundId]);
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
    checks.push({ id: 'dist', layer: L('Fund policy'), subject: who, label: `Offered in ${jurName[inv.residence]}`, result: 'fail',
      detail: `The issuer has not approved ${fund.short} for investors resident in ${jurName[inv.residence]}.`,
      remedy: `Ask ${fund.issuer.replace(' (fictional)', '')} to add ${jurName[inv.residence]} to the distribution list.` });
    return { checks, reqs };
  }
  checks.push({ id: 'dist', layer: L('Fund policy'), subject: who, label: `Offered in ${jurName[inv.residence]}`, result: 'pass', detail: `Approved by the issuer for ${jurName[inv.residence]}. Basis: ${dist.basis}.` });

  // Fund policy: accepted classification
  const okFund = dist.accepts.find((c) => c === 'EU_RETAIL' ? true : !!validClass(inv, c));
  const fundNeed = dist.accepts.map((c) => `${classInfo[c].label}`).join(' or ');
  if (okFund) {
    const c = classInfo[okFund];
    checks.push({ id: 'fundClass', layer: L('Fund policy'), subject: who, label: `Investor class: ${fundNeed}`, result: 'pass',
      detail: okFund === 'EU_RETAIL' && !validClass(inv, 'EU_PRO') ? 'UCITS share class open to retail investors.' : `${who} holds ${c.label} status (${c.jur === inv.residence ? jurName[c.jur] : c.jur}).`,
      ruleRef: c.rule, source: c.source });
  } else {
    const lapsed = dist.accepts.map((c) => anyClass(inv, c)).find(Boolean);
    checks.push({ id: 'fundClass', layer: L('Fund policy'), subject: who, label: `Investor class: ${fundNeed}`, result: 'fail',
      detail: lapsed ? `${who}’s ${classInfo[lapsed.code].label} status expired on ${lapsed.expires}.` : `${who} has no ${fundNeed} status in ${jurName[inv.residence]}.`,
      ruleRef: classInfo[dist.accepts[0]].rule, source: classInfo[dist.accepts[0]].source,
      remedy: lapsed ? `Re-verify ${classInfo[lapsed.code].label} status with current evidence.` : `Only investors who qualify as ${fundNeed} can hold this fund in ${jurName[inv.residence]}.` });
  }

  // Residence law
  if (dist.lawRequires) {
    const code = dist.lawRequires;
    const needOptIn = code === 'SG_AI';
    const cl = validClass(inv, code);
    const pass = !!cl && (!needOptIn || !!cl.optIn);
    reqs.push({ jur: inv.residence, code, optIn: needOptIn, layer: L('Residence law'), ruleRef: dist.lawRef, source: dist.lawSource, text: dist.lawText });
    checks.push({ id: 'law', layer: L('Residence law'), subject: who, label: `${jurName[inv.residence]}: ${classInfo[code].label}${needOptIn ? ' with opt-in' : ''}`,
      result: pass ? 'pass' : 'fail',
      detail: pass ? `${dist.lawText} ${needOptIn ? `Opt-in recorded on ${cl!.optIn}.` : ''}`.trim() : dist.lawText,
      ruleRef: dist.lawRef, source: dist.lawSource,
      remedy: pass ? undefined : `Investor must qualify as ${classInfo[code].label} in ${jurName[inv.residence]}.` });
  } else {
    checks.push({ id: 'law', layer: L('Residence law'), subject: who, label: `${jurName[inv.residence]}: no investor-class restriction`, result: 'pass', detail: dist.lawText, ruleRef: dist.lawRef, source: dist.lawSource });
  }

  // Booking-center licence
  const bc = bookingCenters[inv.booking];
  if (bc.requires) {
    const cl = validClass(inv, bc.requires);
    const optIn = bc.requires === 'SG_AI';
    const pass = !!cl && (!optIn || !!cl.optIn);
    reqs.push({ jur: bc.jur, code: bc.requires, optIn, layer: L('Booking-center licence'), ruleRef: bc.ruleRef, source: bc.source, text: bc.ruleText });
    checks.push({ id: 'booking', layer: L('Booking-center licence'), subject: who, label: `Booked in ${bc.name}: ${classInfo[bc.requires].label}`, result: pass ? 'pass' : 'fail',
      detail: bc.ruleText, ruleRef: bc.ruleRef, source: bc.source,
      remedy: pass ? undefined : `Classify the client as ${classInfo[bc.requires].label} under ${bc.ruleRef}, or book the order through a center whose rules the client meets.` });
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
    text: `${classInfo[r.code].label}${r.optIn ? ' with opt-in' : ''} in ${jurName[r.jur]}`,
    layer: r.layer,
    ruleRef: r.ruleRef,
  }));
  // Mark the binding checks: the resolved requirement's source check
  for (const r of byKey.values()) {
    const target = checks.find((c) => c.layer === r.layer && (c.id === 'law' || c.id === 'booking') && c.label.includes(classInfo[r.code].label));
    if (target) target.binding = true;
  }
  return resolved;
}

export function evaluate(order: Order, whatIfs: WhatIf[] = []): Decision {
  const { investor: inv, fund, order: o, applied } = applyWhatIfs(order, whatIfs);
  const checks: Check[] = [];
  let reqs: Requirement[] = [];
  const counterparty = o.counterpartyId ? clone(INVESTORS[o.counterpartyId]) : undefined;
  if (counterparty && applied.includes('dropUAE')) { /* fund already modified */ }

  const units = Math.round((o.amount / fund.nav) * 100) / 100;
  const holding = inv.holdings[fund.id];

  // ---------- Credential layer ----------
  const credValid = inv.expires >= SIM_DATE;
  const needsValid = o.action !== 'redeem';
  checks.push({ id: 'cred', layer: 'Credential', subject: inv.short, label: 'Laissez credential on file',
    result: credValid ? 'pass' : needsValid ? 'fail' : 'info',
    detail: credValid ? `${inv.credentialId}, issued by Aster & Vale on ${inv.issued}, valid to ${inv.expires}.` : `${inv.credentialId} lapsed on ${inv.expires}. Credentials are valid for 12 months (Laissez policy).${needsValid ? '' : ' Not required to redeem.'}`,
    remedy: credValid || !needsValid ? undefined : 'Renew the credential: the distributor re-attests KYC and refreshes each classification.' });

  checks.push({ id: 'screen', layer: 'Credential', subject: inv.short, label: 'Sanctions name screening', result: 'pass', detail: 'No match against OFAC SDN, UN and EU consolidated lists. Screened at order time.', ruleRef: 'OFAC', source: 'ofac' });

  const sanc = sanctionedJurisdictions[inv.residence];
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
  }

  if (o.action === 'transfer') {
    const cp = counterparty!;
    // Sender side
    checks.push({ id: 'holding', layer: 'Transfer controls', subject: inv.short, label: 'Sender holds enough units', result: holding && holding.units >= units ? 'pass' : 'fail',
      detail: holding ? `${fmt(holding.units)} units held since ${holding.since}; transferring ${fmt(units)}.` : `${inv.short} holds no ${fund.ticker}.`,
      remedy: holding && holding.units >= units ? undefined : 'Reduce the transfer to the available balance.' });
    if (fund.lockupMonths && holding) {
      const ends = addMonths(holding.since, fund.lockupMonths);
      const pass = ends <= SIM_DATE;
      checks.push({ id: 'lock', layer: 'Transfer controls', subject: inv.short, label: `${fund.lockupMonths}-month lock-up`, result: pass ? 'pass' : 'fail',
        detail: pass ? `Lock-up ended ${ends}.` : `Units acquired ${holding.since}. Lock-up ends ${ends}.`, remedy: pass ? undefined : `Transfers open on ${ends}.` });
    }
    const senderEligible = fund.distribution[inv.residence]?.accepts.some((c) => validClass(inv, c));
    checks.push({ id: 'senderStatus', layer: 'Transfer controls', subject: inv.short, label: 'Sender may transfer out', result: 'pass',
      detail: senderEligible ? `${inv.short} is an eligible holder.` : `${inv.short} is redemption-only, but outbound transfers to an eligible buyer are permitted. The buyer’s status is what the law tests.` });
    // Receiver side
    const r = eligibilityChecks(cp, fund, 'Counterparty', !!cp.holdings[fund.id]);
    checks.push(...r.checks); reqs = r.reqs;
    if (o.amount >= 1000) {
      checks.push({ id: 'travel', layer: 'Global screens', label: 'Travel Rule data exchanged', result: 'pass',
        detail: `Originator (${inv.short}, booked ${bookingCenters[inv.booking].name}) and beneficiary (${cp.short}, booked ${bookingCenters[cp.booking].name}) details sent in IVMS101 format before settlement.`,
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
      const pass = ends <= SIM_DATE;
      checks.push({ id: 'lock', layer: 'Transfer controls', subject: inv.short, label: `${fund.lockupMonths}-month lock-up`, result: pass ? 'pass' : 'fail',
        detail: pass ? `Lock-up ended ${ends}.` : `Units acquired ${holding.since}. Lock-up ends ${ends}.`, remedy: pass ? undefined : `Redemptions open on ${ends}.` });
    }
    const eligibleNow = !inv.usPerson || !!fund.usAccepts ? fund.distribution[inv.residence]?.accepts.some((c) => c === 'EU_RETAIL' || validClass(inv, c)) : false;
    checks.push({ id: 'redeemPolicy', layer: 'Fund policy', subject: inv.short, label: 'Redemption stays open', result: 'pass',
      detail: eligibleNow ? `${inv.short} is an eligible holder.` : `${inv.short} no longer meets the fund’s eligibility rules. Laissez keeps redemption open: holders whose status lapses can always exit, they just cannot add.` });
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
    return { outcome, headline, checks, resolved, remedies, rulePacks, redemptionOnly, units, notional: o.amount, order: o, investor: inv, fund, counterparty, appliedWhatIfs: applied };
  }
}

function buildRulePacks(fund: Fund, inv: Investor, cp?: Investor): string[] {
  const packs = new Set<string>();
  packs.add(`fund/${fund.ticker}@2026.09.1`);
  const add = (j: Jur) => { if (j === 'IR') return; packs.add(`${j}/eligibility@${j === 'SG' ? '2026.09.0' : j === 'HK' ? '2026.04.2' : '2026.07.0'}`); };
  add(inv.residence); add(bookingCenters[inv.booking].jur);
  if (cp) { add(cp.residence); add(bookingCenters[cp.booking].jur); }
  packs.add('global/sanctions@2026-10-01');
  packs.add('global/travel-rule@2026.07');
  return [...packs];
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
  const payload = JSON.stringify({ o: d.order, w: d.appliedWhatIfs, c: d.checks.map((c) => [c.id, c.result]), p: d.rulePacks });
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 2166136261;
    for (let i = 0; i < payload.length; i++) { h ^= payload.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0').repeat(8);
  }
}
