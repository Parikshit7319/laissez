// Tests for the import parser and validators (api/src/import-core.ts). No database: the organization's reference
// data is injected through the Lookups interface. Run with: npm run test:import
import assert from 'node:assert/strict';
import { findTest } from '../src/proto/thresholds';
import { parseCsv, parseInput, previewImport, templateCsv, detectFormat, holdingKey, TEMPLATES, type Lookups, type ClientData, type CredentialData } from '../api/src/import-core';

const TODAY = '2026-10-02';
const base = (): Lookups => ({
  jurisdictions: { SG: 'Singapore', HK: 'Hong Kong', CH: 'Switzerland', DE: 'Germany', US: 'United States', IR: 'Iran', GLOBAL: 'Global' },
  sanctioned: { IR: 'OFAC Iranian Transactions and Sanctions Regulations' },
  bookingCenters: { SG: { name: 'Singapore', jurisdiction: 'SG' }, HK: { name: 'Hong Kong', jurisdiction: 'HK' }, ZRH: { name: 'Zurich', jurisdiction: 'CH' }, NY: { name: 'New York', jurisdiction: 'US' } },
  classes: { SG_AI: { label: 'Accredited investor', jurisdiction: 'SG' }, HK_PI: { label: 'Professional investor', jurisdiction: 'HK' }, EU_PRO: { label: 'Professional client', jurisdiction: 'DE' } },
  funds: { TWLF: { name: 'Tidewell Treasury Liquidity Fund' }, AGPC: { name: 'Argent Private Credit' } },
  investors: [
    { id: 'inv_lumen', name: 'Lumen Family Office Pte. Ltd.', kind: 'Single-family office', external_id: 'CRM-1', residence: 'SG', city: 'Singapore', booking_center: 'HK', us_person: false, email: null, wallet: '0xaaaa', credential_id: 'LP-SG-0001-0001' },
    { id: 'inv_meitan', name: 'Mei Tan', kind: 'Individual', external_id: null, residence: 'HK', city: 'Hong Kong', booking_center: 'HK', us_person: false, email: null, wallet: '0xbbbb' },
    { id: 'inv_dup1', name: 'Twin Holdings', kind: 'Corporate', external_id: null, residence: 'SG', city: 'Singapore', booking_center: 'SG', us_person: false },
    { id: 'inv_dup2', name: 'Twin Holdings', kind: 'Corporate', external_id: null, residence: 'SG', city: 'Singapore', booking_center: 'SG', us_person: false },
  ],
  holdings: { [holdingKey('inv_lumen', 'TWLF')]: 125000, [holdingKey('inv_meitan', 'AGPC')]: 40000 },
  findTest, today: TODAY,
});

let n = 0;
const test = (name: string, fn: () => void) => { try { fn(); n++; } catch (e) { console.error(`FAIL  ${name}`); throw e; } };
const only = (rows: { status: string }[], status: string) => rows.filter((r) => r.status === status);

// ---------- CSV parser ----------
test('parses quotes, embedded commas, doubled quotes, CRLF and a BOM', () => {
  const text = '﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n2,"multi\nline",3\r\n\r\n';
  const rows = parseCsv(text);
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['2', 'multi\nline', '3']]);
});
test('LF files and trailing commas', () => {
  assert.deepEqual(parseCsv('a,b\n1,\n,2\n'), [['a', 'b'], ['1', ''], ['', '2']]);
});
test('templates parse back to their own columns', () => {
  for (const type of ['clients', 'credentials', 'holdings'] as const) {
    const p = parseInput(type, 'csv', templateCsv(type));
    assert.deepEqual(p.errors, [], `${type}: ${p.errors.join(' ')}`);
    assert.deepEqual(p.columns, TEMPLATES[type].columns);
    assert.equal(p.rows.length, TEMPLATES[type].example.length);
  }
});
test('header names are normalized (case, spaces, dashes)', () => {
  const p = parseInput('holdings', 'csv', 'Client External Id,TICKER,Units,since\nCRM-1,TWLF,1,2026-01-01\n');
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.columns, ['client_external_id', 'ticker', 'units', 'since']);
});
test('missing required columns are reported by name', () => {
  const p = parseInput('clients', 'csv', 'external_id,name\nA,B\n');
  assert.equal(p.errors.length, 1);
  assert.match(p.errors[0], /Missing required columns: residence, city, booking_center/);
});
test('a file that is not a header row is refused with the expected columns', () => {
  const p = parseInput('clients', 'csv', 'Harbour Lane,Corporate,SG\n');
  assert.match(p.errors[0], /must be a header row/);
});
test('too many values on a row is an error that names the row', () => {
  const p = parseInput('holdings', 'csv', 'client_external_id,ticker,units\nCRM-1,TWLF,1,extra\n');
  assert.match(p.errors[0], /Row 1 has 4 values for 3 columns/);
});
test('unknown columns are ignored with a warning; evidence_ columns are not unknown for credentials', () => {
  const p = parseInput('credentials', 'csv', 'client_external_id,class_code,evidence_net_assets,colour\nCRM-1,SG_AI,20000000,blue\n');
  assert.deepEqual(p.errors, []);
  assert.equal(p.warnings.length, 1);
  assert.match(p.warnings[0], /Ignored column: colour/);
});
test('empty file and header-only file', () => {
  assert.match(parseInput('clients', 'csv', '   ').errors[0], /empty/);
  assert.match(parseInput('clients', 'csv', TEMPLATES.clients.columns.join(',') + '\n').errors[0], /no data rows/);
});

// ---------- JSON ----------
test('JSON array, {rows}, and bad shapes', () => {
  const ok = parseInput('holdings', 'json', JSON.stringify([{ client_external_id: 'CRM-1', ticker: 'TWLF', units: 10 }]));
  assert.deepEqual(ok.errors, []); assert.equal(ok.rows.length, 1);
  const wrapped = parseInput('holdings', 'json', JSON.stringify({ rows: [{ client_external_id: 'CRM-1', ticker: 'TWLF', units: 10 }] }));
  assert.deepEqual(wrapped.errors, []);
  assert.match(parseInput('holdings', 'json', '{"a":1}').errors[0], /array of objects/);
  assert.match(parseInput('holdings', 'json', '[1, 2]').errors[0], /Item 1 is not an object/);
  assert.match(parseInput('holdings', 'json', '[{').errors[0], /not valid JSON/);
});
test('format detection', () => {
  assert.equal(detectFormat('﻿  [{"a":1}]'), 'json');
  assert.equal(detectFormat('a,b\n1,2'), 'csv');
});

// ---------- Clients ----------
test('clients: create, update by external_id, name fallback with warning, skip when unchanged', () => {
  const csv = [
    'external_id,name,kind,residence,city,booking_center,us_person,email,wallet',
    'CRM-9,New Co Ltd,Corporate,SG,Singapore,SG,no,ops@newco.example,',
    'CRM-1,Lumen Family Office Pte. Ltd.,Single-family office,SG,Singapore,HK,false,,0xaaaa',
    'CRM-1b,Lumen Family Office Pte. Ltd.,Single-family office,SG,Singapore,HK,false,,0xaaaa',
    'CRM-2,mei tan,Individual,HK,Hong Kong,HK,false,,',
  ].join('\n');
  const p = previewImport('clients', 'csv', csv, base());
  assert.deepEqual(p.errors, []);
  assert.equal(p.totals.rows, 4);
  const [create, same, conflict, byName] = p.rows;
  assert.equal(create.status, 'create');
  assert.equal(same.status, 'skip'); assert.match(same.messages[0], /Already up to date/);
  assert.equal(conflict.status, 'error'); assert.match(conflict.messages.join(' '), /already has external id CRM-1/);
  assert.equal(byName.status, 'update'); assert.equal(byName.match?.by, 'name'); assert.equal(byName.match?.investor_id, 'inv_meitan');
  assert.match(byName.messages.join(' '), /Matched by name/);
  assert.deepEqual(byName.changes, ['name', 'external_id']);
});
test('clients: unknown jurisdiction, GLOBAL, unknown booking center, bad email, bad us_person', () => {
  const csv = [
    'external_id,name,kind,residence,city,booking_center,us_person,email,wallet',
    'A1,Alpha,Corporate,XX,Town,SG,false,,',
    'A2,Beta,Corporate,GLOBAL,Town,SG,false,,',
    'A3,Gamma,Corporate,SG,Town,LON,false,,',
    'A4,Delta,Corporate,SG,Town,SG,maybe,not-an-email,',
  ].join('\n');
  const p = previewImport('clients', 'csv', csv, base());
  assert.equal(p.totals.error, 4);
  assert.match(p.rows[0].messages[0], /Residence XX is not a supported jurisdiction. Supported: CH, DE, HK, SG, US/);
  assert.match(p.rows[1].messages[0], /Residence GLOBAL is not a supported jurisdiction/);
  assert.match(p.rows[2].messages[0], /Booking center LON does not exist. Known: HK, NY, SG, ZRH/);
  assert.match(p.rows[3].messages.join(' '), /us_person "maybe" is not a yes\/no value/);
  assert.match(p.rows[3].messages.join(' '), /email "not-an-email" is not a valid address/);
});
test('clients: sanctioned residence is refused per row with the program named', () => {
  const p = previewImport('clients', 'csv', 'external_id,name,kind,residence,city,booking_center\nS1,Pars Trading,Corporate,IR,Tehran,SG\nS2,Fine Co,Corporate,SG,Singapore,SG\n', base());
  assert.equal(p.rows[0].status, 'error');
  assert.match(p.rows[0].messages[0], /Refused: Iran is under comprehensive sanctions. OFAC Iranian Transactions and Sanctions Regulations. Laissez does not create clients resident there/);
  assert.equal(p.rows[1].status, 'create');
});
test('clients: duplicate external ids in the file, and a US residence sets us_person', () => {
  const p = previewImport('clients', 'csv', 'external_id,name,kind,residence,city,booking_center\nD1,One,Corporate,US,Houston,NY\nD1,Two,Corporate,SG,Singapore,SG\n', base());
  assert.equal(p.rows[0].status, 'create');
  assert.equal((p.rows[0].data as ClientData).us_person, true);
  assert.equal(p.rows[1].status, 'error');
  assert.match(p.rows[1].messages[0], /Duplicate external_id D1: first seen on row 1/);
});
test('clients: an ambiguous name match is an error that lists the candidates', () => {
  const p = previewImport('clients', 'csv', 'external_id,name,kind,residence,city,booking_center\nT1,Twin Holdings,Corporate,SG,Singapore,SG\n', base());
  assert.equal(p.rows[0].status, 'error');
  assert.match(p.rows[0].messages[0], /2 existing clients are named "Twin Holdings" \(inv_dup1, inv_dup2\)/);
});
test('clients: an approval-gated change is skipped with the reason', () => {
  const l = base();
  l.gate = (kind, payload) => (kind === 'investor.update' && (payload.changed_fields as string[]).includes('residence') ? 'Changing residence affects eligibility, so it needs a second person.' : null);
  const p = previewImport('clients', 'csv', 'external_id,name,kind,residence,city,booking_center\nCRM-1,Lumen Family Office Pte. Ltd.,Single-family office,CH,Zurich,ZRH\n', l);
  assert.equal(p.rows[0].status, 'skip');
  assert.match(p.rows[0].messages.join(' '), /needs a second person/);
});
test('clients: JSON input with native booleans', () => {
  const p = previewImport('clients', 'json', JSON.stringify([{ external_id: 'J1', name: 'Json Co', residence: 'SG', city: 'Singapore', booking_center: 'SG', us_person: true }]), base());
  assert.equal(p.rows[0].status, 'create');
  assert.equal((p.rows[0].data as ClientData).us_person, true);
  assert.equal((p.rows[0].data as ClientData).kind, 'Corporate');
});

// ---------- Credentials ----------
test('credentials: evidence JSON passes the SG_AI entity test and carries the dates', () => {
  const csv = 'client_external_id,class_code,evidence,evidence_ref,verified_on,expires_on,opt_in_on\nCRM-1,SG_AI,"{""net_assets"": 25000000, ""opt_in"": true}",KYC 2026-03,2026-03-14,2027-03-14,2026-03-14\n';
  const p = previewImport('credentials', 'csv', csv, base());
  assert.deepEqual(p.errors, []);
  const r = p.rows[0];
  assert.equal(r.status, 'create', r.messages.join(' '));
  const d = r.data as CredentialData;
  assert.deepEqual(d.evidence, { net_assets: 25000000, opt_in: true });
  assert.equal(d.verified_on, '2026-03-14'); assert.equal(d.expires_on, '2027-03-14'); assert.equal(d.opt_in_on, '2026-03-14');
  assert.match(r.messages.join(' '), /exceed S\$10M/);
  assert.match(r.messages.join(' '), /Replaces the active credential LP-SG-0001-0001/);
});
test('credentials: flattened evidence_ columns, opt_in_on implies opt_in, defaults for dates', () => {
  const csv = 'client_external_id,class_code,evidence_net_assets,opt_in_on\nCRM-1,SG_AI,"12,000,000",2026-09-01\n';
  const p = previewImport('credentials', 'csv', csv, base());
  const r = p.rows[0];
  assert.equal(r.status, 'create', r.messages.join(' '));
  const d = r.data as CredentialData;
  assert.deepEqual(d.evidence, { net_assets: 12000000, opt_in: true });
  assert.equal(d.verified_on, TODAY); assert.equal(d.expires_on, '2027-10-02');
});
test('credentials: threshold failure message names the figure and the rule', () => {
  const csv = 'client_external_id,class_code,evidence\nCRM-1,SG_AI,"{""net_assets"": 5000000, ""opt_in"": true}"\n';
  const r = previewImport('credentials', 'csv', csv, base()).rows[0];
  assert.equal(r.status, 'error');
  assert.match(r.messages[0], /Threshold not met: Net assets of S\$5,000,000 do not exceed S\$10,000,000 \(SFA s4A\(1\)\(a\)\(ii\)\)/);
});
test('credentials: opt-in missing fails with the opt-in reason', () => {
  const r = previewImport('credentials', 'csv', 'client_external_id,class_code,evidence_net_assets\nCRM-1,SG_AI,25000000\n', base()).rows[0];
  assert.equal(r.status, 'error');
  assert.match(r.messages[0], /has not opted in/);
});
test('credentials: individual test is picked from the client kind; entity-only class refused for an individual', () => {
  const l = base();
  const ok = previewImport('credentials', 'csv', 'client_external_id,class_code,evidence_portfolio\nMei Tan,HK_PI,9000000\n', l).rows[0];
  assert.equal(ok.status, 'create', ok.messages.join(' '));
  assert.equal(ok.match?.by, 'name');
  assert.match(ok.messages.join(' '), /matched by name to inv_meitan/);
  const no = previewImport('credentials', 'csv', 'client_external_id,class_code,evidence_balance_sheet\nMei Tan,EU_PRO,50000000\n', l).rows[0];
  assert.equal(no.status, 'error');
  assert.match(no.messages.join(' '), /Professional client \(EU_PRO\) is not available to an individual/);
});
test('credentials: unknown class, unknown client, bad dates, expired, future verification', () => {
  const csv = [
    'client_external_id,class_code,evidence,verified_on,expires_on',
    'CRM-1,XX_YY,{},,',
    'CRM-404,SG_AI,"{""net_assets"": 25000000, ""opt_in"": true}",,',
    'CRM-1,SG_AI,"{""net_assets"": 25000000, ""opt_in"": true}",2026-13-01,',
    'CRM-1,SG_AI,"{""net_assets"": 25000000, ""opt_in"": true}",2025-01-01,2025-12-31',
    'CRM-1,SG_AI,"{""net_assets"": 25000000, ""opt_in"": true}",2027-01-01,2028-01-01',
    'CRM-1,SG_AI,not json,,',
  ].join('\n');
  const p = previewImport('credentials', 'csv', csv, base());
  assert.equal(p.totals.error, 6);
  assert.match(p.rows[0].messages[0], /Unknown classification XX_YY. Known: EU_PRO, HK_PI, SG_AI/);
  assert.match(p.rows[1].messages[0], /No client with external id CRM-404/);
  assert.match(p.rows[2].messages[0], /verified_on "2026-13-01" is not a date/);
  assert.match(p.rows[3].messages.join(' '), /expires_on 2025-12-31 has already passed/);
  assert.match(p.rows[4].messages[0], /verified_on 2027-01-01 is in the future/);
  assert.match(p.rows[5].messages[0], /evidence is not a JSON object/);
});
test('credentials: duplicate class for one client, and the approval gate skips a whole client', () => {
  const l = base();
  l.gate = (kind, payload) => (kind === 'credential.issue' && String(payload.investor_kind).toLowerCase() === 'individual' ? 'Credentials for individuals with a classification need a second person.' : null);
  const csv = 'client_external_id,class_code,evidence_portfolio\nMei Tan,HK_PI,9000000\nMei Tan,HK_PI,9000000\nCRM-1,HK_PI,9000000\n';
  const p = previewImport('credentials', 'csv', csv, l);
  assert.equal(p.rows[0].status, 'skip'); assert.match(p.rows[0].messages.join(' '), /Not issued: Credentials for individuals/);
  assert.equal(p.rows[1].status, 'error'); assert.match(p.rows[1].messages.join(' '), /Duplicate: HK_PI for this client already appears on row 1/);
  assert.equal(p.rows[2].status, 'create');
});
test('credentials: JSON input with an evidence object', () => {
  const p = previewImport('credentials', 'json', JSON.stringify([{ client_external_id: 'CRM-1', class_code: 'hk_pi', evidence: { portfolio: 10_000_000 }, verified_on: '2026-06-01' }]), base());
  assert.equal(p.rows[0].status, 'create', p.rows[0].messages.join(' '));
  assert.equal((p.rows[0].data as CredentialData).class_code, 'HK_PI');
});

// ---------- Holdings ----------
test('holdings: create, update with difference, skip when equal, removal, and errors', () => {
  const csv = [
    'client_external_id,ticker,units,since',
    'CRM-1,AGPC,"1,000.5",2026-01-15',
    'CRM-1,TWLF,130000,',
    'Mei Tan,AGPC,40000,2026-04-01',
    'Mei Tan,TWLF,0,',
    'CRM-1,TWLF,0,',
    'CRM-1,NOPE,5,',
    'CRM-1,AGPC,-3,',
    'CRM-1,AGPC,abc,2026-02-30',
  ].join('\n');
  const p = previewImport('holdings', 'csv', csv, base());
  assert.deepEqual(p.errors, []);
  const [create, update, same, zeroNew, dupRemove, badFund, negative, bad] = p.rows;
  assert.equal(create.status, 'create'); assert.equal(create.register_units, null);
  assert.equal(update.status, 'update'); assert.match(update.messages[0], /Register shows 125,000, file has 130,000 \(difference \+5,000\)/); assert.equal(update.register_units, 125000);
  assert.equal(same.status, 'skip'); assert.match(same.messages.join(' '), /Register already shows 40,000 units/);
  assert.equal(zeroNew.status, 'skip'); assert.match(zeroNew.messages.join(' '), /nothing to record/);
  assert.equal(dupRemove.status, 'error'); assert.match(dupRemove.messages[0], /Duplicate: TWLF for this client already appears on row 2/);
  assert.equal(badFund.status, 'error'); assert.match(badFund.messages[0], /No fund NOPE in this organization. Funds: AGPC, TWLF/);
  assert.equal(negative.status, 'error'); assert.match(negative.messages[0], /negative/);
  assert.equal(bad.status, 'error'); assert.match(bad.messages.join(' '), /units "abc" is not a number/); assert.match(bad.messages.join(' '), /since "2026-02-30" is not a date/);
  assert.deepEqual(p.totals, { rows: 8, create: 1, update: 1, skip: 2, error: 4 });
});
test('holdings: removal of an existing position is an update', () => {
  const r = previewImport('holdings', 'csv', 'client_external_id,ticker,units\nCRM-1,TWLF,0\n', base()).rows[0];
  assert.equal(r.status, 'update');
  assert.match(r.messages[0], /Removes the holding; the register shows 125,000 units/);
});
test('holdings: 1,200 rows validate in one pass', () => {
  const l = base();
  l.investors = Array.from({ length: 1200 }, (_, i) => ({ id: `inv_${i}`, name: `Client ${i}`, kind: 'Corporate', external_id: `X-${i}` }));
  const csv = 'client_external_id,ticker,units\n' + l.investors.map((i, k) => `${i.external_id},TWLF,${k + 1}`).join('\n');
  const t0 = Date.now();
  const p = previewImport('holdings', 'csv', csv, l);
  assert.equal(p.totals.create, 1200);
  assert.ok(Date.now() - t0 < 2000, 'validation took too long');
});

console.log(`${n} import tests passed`);
