// runMonitor against an in-memory stand-in for the database: checks holder standings, the work items it
// opens and closes, screening hits it records, and that the whole run uses a bounded number of queries.
// Run from api/: npx tsx jobs/__tests__/monitor.test.ts
import assert from 'node:assert/strict';
import { runMonitor } from '../../src/monitor';
import { addDays, today } from '../../src/util';
import type { Sql } from '../../src/db';

const t0 = today();
const WS = '11111111-1111-4111-8111-111111111111';
const cred = (id: string, expires: string) => ({ cred_id: id, issued_on: addDays(t0, -300), expires_on: expires, lzid: null, issuer_name: 'Aster & Vale Private Bank' });
const inv = (id: string, name: string, residence: string, extra: Record<string, unknown> = {}) => ({
  id, name, short_name: name.split(' ').slice(0, 2).join(' '), kind: 'Corporate', residence, city: '', booking_center: 'SG', us_person: false, wallet: '0x0', chain_wallet: null, relied_share: null, ...extra,
});
const INVESTORS = [
  inv('lumen', 'Lumen Family Office Pte. Ltd.', 'SG', cred('C-L', addDays(t0, 10))),
  inv('kestrel', 'Kestrel Ridge Partners LP', 'US', { us_person: true, ...cred('C-K', addDays(t0, 200)) }),
  inv('blocked', 'Blocked Example Trading LLC', 'SG', cred('C-B', addDays(t0, 200))),
  inv('lapsed', 'Meitan Holdings Ltd', 'SG', cred('C-M', addDays(t0, -1))),
  inv('fine', 'Sorell Pension Fund', 'SG', cred('C-S', addDays(t0, 300))),
];
const CLASSES = [
  { credential_id: 'C-L', class_code: 'SG_AI', basis: 'x', verified_on: addDays(t0, -300), expires_on: addDays(t0, 10), opt_in_on: null },
  { credential_id: 'C-B', class_code: 'SG_AI', basis: 'x', verified_on: addDays(t0, -300), expires_on: addDays(t0, 200), opt_in_on: null },
  { credential_id: 'C-M', class_code: 'SG_AI', basis: 'x', verified_on: addDays(t0, -300), expires_on: addDays(t0, -1), opt_in_on: null },
  { credential_id: 'C-S', class_code: 'SG_AI', basis: 'x', verified_on: addDays(t0, -300), expires_on: addDays(t0, 300), opt_in_on: null },
];
const HOLDINGS = ['lumen', 'kestrel', 'blocked', 'lapsed', 'fine'].map((id) => ({ investor_id: id, ticker: 'TWLF', units: 1000, since: '2026-01-01' }));
const FUNDS = [{ ticker: 'TWLF', name: 'Tidewell Treasury Liquidity Fund', short_name: 'Tidewell', domicile: 'BVI', structure: 'MMF', currency: 'USD', navf: 1, reg_s: true, us_accepts: null, minf: 100000, holder_cap: null, holders: 5, lockup_months: null, assets: ['USDC'], chains: ['base'], issuer: 'Tidewell', policy_version: 1, gatef: null, yieldf: null }];
const DIST = [{ ticker: 'TWLF', jurisdiction: 'SG', accepts: ['SG_AI'], basis: 'Restricted scheme', law_requires: 'SG_AI', law_text: 'x', law_ref: 'SFA s305', law_source: 'sfa' }];
const STATE = {
  statuses: [
    { investor_id: 'kestrel', ticker: 'TWLF', status: 'eligible', reason: 'Meets the fund policy for its jurisdiction.' },
    { investor_id: 'lumen', ticker: 'TWLF', status: 'eligible', reason: 'Meets the fund policy for its jurisdiction.' },
    { investor_id: 'fine', ticker: 'TWLF', status: 'frozen', reason: 'old' },
    { investor_id: 'lumen', ticker: 'AGPC', status: 'eligible', reason: 'sold out since' },
  ],
  items: [
    { id: 'wi_fine', kind: 'holder_status', dedupe_key: 'status:fine:TWLF:frozen', investor_id: 'fine' },
    { id: 'wi_oldrenew', kind: 'credential_expiring', dedupe_key: `renew:fine:${addDays(t0, 5)}`, investor_id: 'fine' },
    { id: 'wi_keep', kind: 'credential_expiring', dedupe_key: `renew:lumen:${addDays(t0, 10)}`, investor_id: 'lumen' },
  ],
  dismissed: [],
  hits: [],
  hooked: false,
};

type Call = { text: string; params: any[] };
const calls: Call[] = [];
let tx: Call[] = [];
function respond(text: string, params: any[]): any[] {
  if (/from investor_classes/.test(text)) return [{ code: 'SG_AI', label: 'Accredited investor', stamp: 'AI', jurisdiction: 'SG', rule_ref: 'SFA s4A', source_id: 'sfa', threshold: 'x' }];
  if (/from booking_centers/.test(text)) return [];
  if (/from jurisdictions/.test(text)) return [{ code: 'SG', name: 'Singapore' }, { code: 'US', name: 'United States' }];
  if (/from rule_packs/.test(text)) return [];
  if (/from investors i/.test(text)) return INVESTORS;
  if (/from classifications/.test(text)) return CLASSES;
  if (/from holdings/.test(text)) return HOLDINGS;
  if (/from funds/.test(text)) return FUNDS;
  if (/from fund_distribution/.test(text)) return DIST;
  if (/as statuses/.test(text)) return [STATE];
  if (/from unnest\(/.test(text) && /sanctions_entries/.test(text)) {
    const names: string[] = params[0];
    return names.filter((n) => n.startsWith('Blocked')).map((n) => ({ screened: n, source: 'LAISSEZ-TEST', source_uid: 'T-1', name: 'Blocked Example Trading LLC', primary_name: 'Blocked Example Trading LLC', programs: 'Sample list (fictional)', score: 1 }));
  }
  if (/insert into screening_hits|insert into holder_status|delete from holder_status/.test(text)) return [];
  if (/with closed as/.test(text)) return [{ id: '42', items_opened: params[1].length, items_closed: params[15].length }];
  throw new Error(`Unexpected query: ${text.slice(0, 120)}`);
}
const lazy = (text: string, params: any[]) => {
  const call = { text, params };
  return { __call: call, then(res: any, rej: any) { calls.push(call); return Promise.resolve().then(() => respond(text, params)).then(res, rej); } };
};
const fake: any = (strings: TemplateStringsArray, ...values: any[]) => lazy(strings.reduce((s, part, i) => s + (i ? `$${i}` : '') + part, ''), values);
fake.query = (text: string, params: any[] = []) => lazy(text, params);
fake.transaction = async (qs: any[]) => { tx = qs.map((q) => q.__call); calls.push(...tx); return tx.map((c) => respond(c.text, c.params)); };

const summary = await runMonitor(fake as Sql, WS, 'test');
const run = tx.find((c) => /with closed as/.test(c.text))!;
const [, , kinds, keys, titles, details, sevs, invs] = run.params;
const opened = (keys as string[]).map((k, i) => ({ key: k, kind: kinds[i], title: titles[i], detail: details[i], severity: sevs[i], investor: invs[i] }));
const upsert = tx.find((c) => /insert into holder_status/.test(c.text))!;
const statusOf = (id: string) => upsert.params[3][upsert.params[1].indexOf(id)];

let failures = 0;
const check = (name: string, fn: () => void) => { try { fn(); console.log(`  ok   ${name}`); } catch (e: any) { failures++; console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); } };
console.log('runMonitor');
check('summary counts', () => {
  assert.equal(summary.run_id, 42);
  assert.equal(summary.holders_checked, 5);
  // kestrel eligible to redemption-only, blocked new frozen, lapsed new redemption-only, fine frozen to eligible
  assert.equal(summary.changes, 4);
  assert.equal(summary.items_closed, 2);
});
check('standings', () => {
  assert.equal(statusOf('kestrel'), 'redemption-only');
  assert.equal(statusOf('blocked'), 'frozen');
  assert.equal(statusOf('lapsed'), 'redemption-only');
  assert.equal(statusOf('fine'), 'eligible');
  assert.equal(upsert.params[1].indexOf('lumen'), -1, 'an unchanged eligible holder is not rewritten');
});
check('a holding that no longer exists is removed from holder_status', () => {
  const del = tx.find((c) => /delete from holder_status/.test(c.text))!;
  assert.deepEqual([del.params[1], del.params[2]], [['lumen'], ['AGPC']]);
});
check('work items opened', () => {
  const byKey = Object.fromEntries(opened.map((o) => [o.key, o]));
  assert.equal(byKey['status:kestrel:TWLF:redemption-only'].severity, 'high');
  assert.equal(byKey['status:blocked:TWLF:frozen'].severity, 'high');
  assert.equal(byKey['status:lapsed:TWLF:redemption-only'].severity, 'high');
  assert.equal(byKey[`renew:lumen:${addDays(t0, 10)}`].severity, 'medium');
  assert.match(byKey[`renew:lumen:${addDays(t0, 10)}`].detail, /in 10 days/);
  assert.equal(byKey[`lapsed:lapsed:${addDays(t0, -1)}`].severity, 'high');
  assert.equal(byKey['hit:LAISSEZ-TEST:T-1:Blocked Example Trading LLC'].kind, 'screening_hit');
  assert.equal(opened.length, 6);
  for (const o of opened) assert.ok(!/[\u2013\u2014]/.test(o.title + o.detail), `no dashes in copy: ${o.title}`);
});
check('work items closed when the condition is gone', () => {
  assert.deepEqual(run.params[15], ['wi_fine', 'wi_oldrenew']);
});
check('new screening match is recorded once, with monitoring context', () => {
  const hits = calls.filter((c) => /insert into screening_hits/.test(c.text));
  assert.equal(hits.length, 1);
  assert.ok(hits[0].params.includes('monitoring'));
});
check('query budget: reads in one parallel round, one screening query, one write transaction', () => {
  // Globals (4, cached for a minute in the Worker), investors (3), funds (2), state (1), screening (1).
  const reads = calls.filter((c) => !/insert into|with closed as|delete from/.test(c.text));
  assert.ok(reads.length <= 11, `${reads.length} reads`);
  assert.equal(tx.length, 3);
});
console.log(failures ? `\n${failures} failed` : '\nall passed');
if (failures) process.exit(1);
