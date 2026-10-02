// End-to-end test of api/src/chain.ts and api/src/routes/chain.ts against a local Hardhat node and a throwaway
// Postgres loaded with the real migrations. Started by api/chain/e2e-test.mjs, which provides the environment.
import { Hono } from 'hono';
import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem';
import * as chain from '../../src/chain';
import { routes } from '../../src/routes/chain';
import { seedQueries } from '../../src/seed';
import { newPool, pgSql } from './pg-sql.mjs';

const proc = (globalThis as any).process;
const E = proc.env;
const env: any = {
  DATABASE_URL: E.E2E_PG_URL, DATABASE_URL_TENANT: E.E2E_PG_URL, ALLOWED_ORIGINS: 'http://localhost', MAX_ACTIVE_SANDBOXES: '10', APP_URL: '', API_URL: '',
  CHAIN_RPC_URL: E.CHAIN_RPC_URL, CHAIN_OPERATOR_KEY: E.CHAIN_OPERATOR_KEY, CHAIN_CLAIM_KEY: E.CHAIN_CLAIM_KEY, CHAIN_CUSTODY_SEED: E.CHAIN_CUSTODY_SEED,
};
const pool = newPool(E.E2E_PG_URL);
const admin: any = pgSql(pool);
const pub = createPublicClient({ transport: http(E.CHAIN_RPC_URL) });
const REG = parseAbi(['function isVerified(address) view returns (bool)']);
const CAM = parseAbi(['function isCountryAllowed(address compliance, uint16 country) view returns (bool)']);
const TOK = parseAbi(['function balanceOf(address) view returns (uint256)']);
const ANCHOR = parseAbi(['function verify(uint64 day, bytes32 leaf, bytes32[] proof) view returns (bool)']);

let pass = 0; let fail = 0;
async function step(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); pass++; console.log(`PASS  ${name}${d ? `  (${d})` : ''}`); }
  catch (e: any) { fail++; console.log(`FAIL  ${name}\n      ${e?.message ?? e}`); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const ws = crypto.randomUUID();
const actor = { kind: 'user', id: 'u_e2e', name: 'Ana Ruiz', role: 'admin' };
const pending: Promise<unknown>[] = [];
const ctx = (vars: Record<string, unknown> = {}, waitUntil: (p: Promise<unknown>) => void = (p) => { pending.push(p); }) => {
  const v: Record<string, unknown> = { sql: admin, admin, ws, wsKind: 'sandbox', actor, version: '2026-10-02', ...vars };
  return { env, get: (k: string) => v[k], executionCtx: { waitUntil } };
};
const drain = async () => { while (pending.length) await pending.shift(); };
const rid = () => Math.random().toString(36).slice(2, 10);
const units = async (inv: string, t: string) => Number((await admin`select units::float8 as u from holdings where workspace_id = ${ws} and investor_id = ${inv} and ticker = ${t}`)[0]?.u ?? 0);

async function placeSettlement(action: string, investor: string, counterparty: string | null, ticker: string, amount: number) {
  const [f] = await admin`select nav::float8 as nav from funds where workspace_id = ${ws} and ticker = ${ticker}`;
  const u = Math.round((amount / f.nav) * 100) / 100;
  const decId = `dec_${rid()}`; const stlId = `stl_${rid()}`;
  const [dec] = await admin`insert into decisions (workspace_id, id, action, investor_id, counterparty_id, ticker, amount, asset, outcome, headline, checks, resolved, remedies, rule_packs, units, inputs_sha256)
    values (${ws}, ${decId}, ${action}, ${investor}, ${counterparty}, ${ticker}, ${amount}, 'USDC', 'ALLOW', 'Allowed (e2e)', '[]', '[]', '[]', '{}', ${u}, 'e2e') returning *`;
  await admin`insert into settlements (workspace_id, id, decision_id, status, steps) values (${ws}, ${stlId}, ${decId}, 'pending', ${JSON.stringify({ simulated: false, steps: [{ step: 'decision_signed', at: new Date().toISOString() }] })})`;
  return { dec, stlId, u };
}
async function settle(action: string, investor: string, counterparty: string | null, ticker: string, amount: number) {
  const { dec, stlId, u } = await placeSettlement(action, investor, counterparty, ticker, amount);
  const { job_id } = await chain.queueSettlement(ctx(), { settlementId: stlId, decision: dec, units: u });
  await drain();
  const [stl] = await admin`select * from settlements where workspace_id = ${ws} and id = ${stlId}`;
  const [job] = await admin`select * from chain_jobs where id = ${job_id}`;
  return { stl, job, u };
}

// Routes behind a stand-in for the authentication middleware.
const app = new Hono<any>();
app.use('*', async (c, next) => { for (const [k, v] of Object.entries({ sql: admin, admin, ws, wsKind: c.req.header('x-ws-kind') ?? 'sandbox', actor, version: '2026-10-02' })) c.set(k, v); await next(); });
app.onError((err: any, c) => c.json({ error: { code: err.code ?? 'error', message: err.message } }, err.status ?? 500));
app.route('/v1', routes);
const execCtx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {}, props: {} } as any;
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }, env, execCtx);
  return { status: res.status, j: (await res.json()) as any };
};

try {
  await admin`insert into workspaces (id, name, kind) values (${ws}, 'E2E sandbox', 'sandbox')`;
  await admin.transaction(seedQueries(admin, ws));
  const dep = (await chain.loadDeployment(admin, true))!;
  const tw = dep.funds.TWLF;

  await step('chainEnabled is true with an operator key and a recorded deployment', async () => {
    assert(await chain.chainEnabled(ctx()), 'chainEnabled returned false');
    assert(!(await chain.chainEnabled({ ...ctx(), env: { ...env, CHAIN_OPERATOR_KEY: undefined } })), 'enabled without a key');
  });

  await step('Subscribe: Lumen onboards (identity, claim, TWLF and AGPC opening balances) and settles 2,000,000 TWLF', async () => {
    const { stl, job } = await settle('subscribe', 'lumen', null, 'TWLF', 2_000_000);
    assert(stl.status === 'settled', `settlement is ${stl.status}: ${JSON.stringify(stl.chain)}`);
    assert(job.status === 'confirmed', `job is ${job.status}: ${job.error}`);
    assert(stl.chain.tx_hash && stl.chain.onboarding_tx && stl.chain.block > 0, 'chain info missing');
    assert(stl.steps.steps.some((s: any) => s.step === 'identity_onboarded') && stl.steps.steps[0].step === 'decision_signed', 'steps missing');
    assert((await units('lumen', 'TWLF')) === 5_250_000, 'register not updated');
    const v = await chain.investorChainView(admin, env, ws, 'lumen');
    const t = v.funds.find((f) => f.ticker === 'TWLF')!; const a = v.funds.find((f) => f.ticker === 'AGPC')!;
    assert(t.chain_units === 5_250_000 && t.verified && t.country === 702, `TWLF on-chain ${JSON.stringify(t)}`);
    assert(a.chain_units === 400_000 && a.registered, `AGPC opening not mirrored ${JSON.stringify(a)}`);
    const [inv] = await admin`select chain_wallet, chain_identity, chain_onboarded_at from investors where workspace_id = ${ws} and id = 'lumen'`;
    assert(inv.chain_onboarded_at && inv.chain_identity && inv.chain_wallet === v.wallet, 'investor chain columns not stored');
    return `tx ${stl.chain.tx_hash.slice(0, 12)}..., block ${stl.chain.block}`;
  });

  await step('Transfer: Qamar onboards with a 750,000 opening balance and receives 500,000 TWLF from Lumen', async () => {
    const { stl } = await settle('transfer', 'lumen', 'qamar', 'TWLF', 500_000);
    assert(stl.status === 'settled', `settlement is ${stl.status}: ${JSON.stringify(stl.chain)}`);
    assert((await units('lumen', 'TWLF')) === 4_750_000 && (await units('qamar', 'TWLF')) === 1_250_000, 'register not updated');
    const q = (await chain.investorChainView(admin, env, ws, 'qamar')).funds.find((f) => f.ticker === 'TWLF')!;
    assert(q.chain_units === 1_250_000 && q.matches, `on-chain ${JSON.stringify(q)}`);
  });

  await step('Redeem: no onboarding needed, preflight passes, Qamar redeems 100,000 TWLF', async () => {
    const { stl } = await settle('redeem', 'qamar', null, 'TWLF', 100_000);
    assert(stl.status === 'settled' && !stl.chain.onboarding_tx, `settlement is ${stl.status}`);
    assert((await units('qamar', 'TWLF')) === 1_150_000, 'register not updated');
  });

  let qWallet: Address;
  await step('Credential revoked: onCredentialRevoked revokes the claim and Qamar is no longer verified on-chain', async () => {
    await admin`update credentials set status = 'revoked', revoked_at = now() where workspace_id = ${ws} and investor_id = 'qamar'`;
    await chain.onCredentialRevoked(ctx(), 'qamar');
    const [job] = await admin`select * from chain_jobs where workspace_id = ${ws} and kind = 'revoke_claim' order by created_at desc limit 1`;
    assert(job?.status === 'confirmed', `revoke job ${job?.status}: ${job?.error}`);
    qWallet = (await admin`select chain_wallet from investors where workspace_id = ${ws} and id = 'qamar'`)[0].chain_wallet;
    assert(!(await pub.readContract({ address: tw.identityRegistry, abi: REG, functionName: 'isVerified', args: [qWallet] })), 'still verified');
    return `tx ${job.tx_hashes[0].slice(0, 12)}...`;
  });

  await step('A transfer to the revoked investor is rejected by the chain and the settlement reverts, register untouched', async () => {
    const { stl, job } = await settle('transfer', 'lumen', 'qamar', 'TWLF', 10_000);
    assert(stl.status === 'reverted', `settlement is ${stl.status}`);
    assert(/not verified/.test(stl.chain.reason), `reason: ${stl.chain.reason}`);
    assert(job.status === 'failed', `job ${job.status}`);
    assert((await units('lumen', 'TWLF')) === 4_750_000 && (await units('qamar', 'TWLF')) === 1_150_000, 'register changed');
    return stl.chain.reason;
  });

  await step('Redemption is never blocked: the revoked investor still redeems 50,000 TWLF', async () => {
    const { stl } = await settle('redeem', 'qamar', null, 'TWLF', 50_000);
    assert(stl.status === 'settled', `settlement is ${stl.status}: ${stl.chain?.reason}`);
    assert((await units('qamar', 'TWLF')) === 1_100_000, 'register not updated');
  });

  await step('Redemption-only holder never onboarded: claim from the lapsed credential mints the position, redeem burns, claim is revoked after', async () => {
    await admin`update credentials set status = 'revoked', revoked_at = now() where workspace_id = ${ws} and investor_id = 'kestrel'`;
    const { stl, u } = await settle('redeem', 'kestrel', null, 'NMEL', 1_000_000);
    assert(stl.status === 'settled' && stl.chain.onboarding_tx, `settlement is ${stl.status}: ${stl.chain?.reason}`);
    await chain.processPendingChainJobs(env, 5, { admin });
    const [job] = await admin`select * from chain_jobs where workspace_id = ${ws} and kind = 'revoke_claim' and ref = 'kestrel'`;
    assert(job?.status === 'confirmed' && job.tx_hashes.length === 1, `revoke job ${job?.status}: ${job?.error}`);
    const v = await chain.investorChainView(admin, env, ws, 'kestrel');
    const nm = v.funds.find((f) => f.ticker === 'NMEL')!;
    assert(Math.abs(nm.chain_units - (5_000_000 - u)) < 0.005 && nm.matches && !nm.verified, JSON.stringify(nm));
    return `minted 5,000,000, burned ${u.toLocaleString('en-US')}, claim revoked`;
  });

  await step('Policy published: adding the US to TWLF allows country 840 on-chain; removing it disallows it again', async () => {
    const [d] = await admin`select * from fund_distribution where workspace_id = ${ws} and ticker = 'TWLF' and jurisdiction = 'SG'`;
    await admin`insert into fund_distribution (workspace_id, ticker, jurisdiction, accepts, basis, law_requires, law_text, law_ref, law_source) values (${ws}, 'TWLF', 'US', ${['US_AI']}, 'Rule 506(c)', 'US_AI', ${d.law_text}, ${d.law_ref}, ${d.law_source})`;
    await chain.onPolicyPublished(ctx(), 'TWLF');
    assert(await pub.readContract({ address: dep.contracts.countryAllowModule, abi: CAM, functionName: 'isCountryAllowed', args: [tw.compliance, 840] }), 'US not allowed after sync');
    const fresh = (await chain.loadDeployment(admin, true))!;
    assert(fresh.funds.TWLF.countries.includes(840), 'chain_config not updated');
    await admin`delete from fund_distribution where workspace_id = ${ws} and ticker = 'TWLF' and jurisdiction = 'US'`;
    await chain.onPolicyPublished(ctx(), 'TWLF');
    assert(!(await pub.readContract({ address: dep.contracts.countryAllowModule, abi: CAM, functionName: 'isCountryAllowed', args: [tw.compliance, 840] })), 'US still allowed');
    const jobs = await admin`select status, tx_hashes from chain_jobs where workspace_id = ${ws} and kind = 'policy_sync' order by created_at`;
    assert(jobs.length === 2 && jobs.every((j: any) => j.status === 'confirmed' && j.tx_hashes.length === 1), JSON.stringify(jobs));
  });

  await step('Reconciliation is clean after real settlements', async () => {
    const r = await chain.runRecon(admin, ws, 'manual', env, actor as any);
    assert(r.run.breaks === 0 && r.run.positions >= 3, JSON.stringify(r.run));
    return `${r.run.positions} positions, block ${r.run.chain_block}`;
  });

  let breakId = '';
  await step('Simulated break: operator mints 1,000 TWLF to Lumen on-chain only; recon finds it and opens a work item', async () => {
    const out = await chain.simulateBreak(admin, env, ws, 'lumen', 'TWLF');
    assert(out.job?.status === 'confirmed', `break job ${out.job?.status}: ${out.job?.error}`);
    const r = await chain.runRecon(admin, ws, 'manual', env, actor as any);
    assert(r.run.breaks === 1, JSON.stringify(r.run));
    const [b] = await admin`select * from recon_breaks where workspace_id = ${ws} and status = 'open'`;
    assert(b && Number(b.chain_units) === 4_751_000 && Number(b.register_units) === 4_750_000, JSON.stringify(b));
    const [w] = await admin`select * from work_items where workspace_id = ${ws} and kind = 'recon_break' and status = 'open'`;
    assert(w?.dedupe_key === 'recon:lumen:TWLF', 'no work item');
    const again = await chain.runRecon(admin, ws, 'manual', env, actor as any);
    const open = await admin`select count(*)::int as n from recon_breaks where workspace_id = ${ws} and status = 'open'`;
    assert(again.run.breaks === 1 && open[0].n === 1, 'duplicate break on re-run');
    breakId = b.id;
  });

  await step('Resolve with adjust_register: the register takes the chain balance and the work item closes', async () => {
    const res = await chain.resolveBreak(admin, env, ws, breakId, 'adjust_register', 'Mint confirmed with the transfer agent.', actor as any);
    assert(res.register_units === 4_751_000, JSON.stringify(res));
    assert((await units('lumen', 'TWLF')) === 4_751_000, 'holding not adjusted');
    const [w] = await admin`select status from work_items where workspace_id = ${ws} and dedupe_key = 'recon:lumen:TWLF' order by created_at desc limit 1`;
    assert(w.status === 'done', 'work item still open');
    const [a] = await admin`select * from audit_events where workspace_id = ${ws} and type = 'recon.register_adjusted'`;
    assert(a, 'no audit event');
    const r = await chain.runRecon(admin, ws, 'manual', env, actor as any);
    assert(r.run.breaks === 0, 'still breaking');
  });

  await step('Worker died before processing: processPendingChainJobs picks the queued job up (Sorell subscribes AGPC)', async () => {
    const { dec, stlId, u } = await placeSettlement('subscribe', 'sorell', null, 'AGPC', 300_000);
    // The job row exists but the request that queued it ended before processing it.
    const payload = { settlement_id: stlId, decision_id: dec.id, action: 'subscribe', investor_id: 'sorell', counterparty_id: null, ticker: 'AGPC', amount: 300_000, asset: 'USDC', units: u };
    await admin`insert into chain_jobs (id, workspace_id, kind, ref, payload) values (${`cjob_${rid()}`}, ${ws}, 'settle', ${stlId}, ${JSON.stringify(payload)})`;
    await chain.processPendingChainJobs(env, 5, { admin });
    const [stl] = await admin`select * from settlements where workspace_id = ${ws} and id = ${stlId}`;
    assert(stl.status === 'settled', `settlement is ${stl.status}`);
    const v = await chain.investorChainView(admin, env, ws, 'sorell');
    const ag = v.funds.find((f) => f.ticker === 'AGPC')!; const nm = v.funds.find((f) => f.ticker === 'NMEL')!;
    assert(ag.matches && nm.chain_units === 12_000_000, `AGPC ${JSON.stringify(ag)} NMEL ${JSON.stringify(nm)}`);
  });

  await step('A fund with no on-chain suite settles on the register only', async () => {
    await admin`insert into funds (workspace_id, ticker, name, short_name, domicile, structure, currency, nav, reg_s, min_subscription, holders, assets, chains, issuer)
      select workspace_id, 'ZZTF', 'Test fund', 'Test fund', domicile, structure, currency, nav, reg_s, min_subscription, 0, assets, chains, issuer from funds where workspace_id = ${ws} and ticker = 'TWLF'`;
    const { stl } = await settle('subscribe', 'lumen', null, 'ZZTF', 100_000);
    assert(stl.status === 'settled' && stl.chain.status === 'off_chain', JSON.stringify(stl.chain));
    assert((await units('lumen', 'ZZTF')) === 100_000, 'register not updated');
  });

  await step('Audit anchor: Merkle root over every workspace head goes on-chain and the proof verifies there', async () => {
    const a: any = await chain.anchorAudit(admin, env);
    assert(a.status === 'confirmed' && a.tx_hash, JSON.stringify(a));
    const [leaf] = await admin`select l.*, a.anchor_date::text as d, a.merkle_root from audit_anchor_leaves l join audit_anchors a on a.id = l.anchor_id where l.workspace_id = ${ws}`;
    assert(chain.verifyProof(leaf.merkle_root, leaf.leaf, leaf.proof), 'off-chain proof failed');
    const ok = await pub.readContract({ address: dep.contracts.auditAnchor, abi: ANCHOR, functionName: 'verify', args: [BigInt(leaf.d.replace(/-/g, '')), leaf.leaf as Hex, leaf.proof as Hex[]] });
    assert(ok, 'on-chain verify failed');
    const again: any = await chain.anchorAudit(admin, env);
    assert(again.already === true, 'second anchor on the same day was not idempotent');
    return `root ${String(a.merkle_root).slice(0, 14)}..., ${a.leaves} leaves`;
  });

  await step('Routes: /chain, /chain/investors/:id, /chain/jobs, /reconciliation, /audit-anchors, sandbox-only guard', async () => {
    const o = await call('GET', '/v1/chain');
    assert(o.status === 200 && o.j.enabled && o.j.contracts.length >= 7 && o.j.operator.balance_eth > 0, JSON.stringify(o.j).slice(0, 300));
    const i = await call('GET', '/v1/chain/investors/lumen');
    assert(i.status === 200 && i.j.funds.find((f: any) => f.ticker === 'TWLF').matches === true, JSON.stringify(i.j).slice(0, 300));
    const j = await call('GET', '/v1/chain/jobs');
    assert(j.status === 200 && j.j.data.length >= 8 && !j.j.data[0].payload.sent, 'jobs missing');
    const run = await call('POST', '/v1/reconciliation/run');
    assert(run.status === 201 && run.j.run.breaks === 0, JSON.stringify(run.j).slice(0, 300));
    const rec = await call('GET', '/v1/reconciliation');
    assert(rec.status === 200 && rec.j.runs.length >= 4 && rec.j.breaks.length >= 1, 'reconciliation list');
    const an = await call('GET', '/v1/audit-anchors');
    assert(an.status === 200 && an.j.data[0]?.proof_valid === true, JSON.stringify(an.j).slice(0, 300));
    const guard = await call('POST', '/v1/reconciliation/simulate-break', { investor_id: 'lumen', ticker: 'TWLF' }, { 'x-ws-kind': 'org' });
    assert(guard.status === 403, `org workspace got ${guard.status}`);
    const bad = await call('POST', '/v1/reconciliation/breaks/brk_nope/resolve', { resolution: 'investigated' });
    assert(bad.status === 404, `missing break got ${bad.status}`);
  });

  await step('Nonce counter in Postgres matches the operator pending nonce on-chain', async () => {
    const [n] = await admin`select nonce from chain_nonces where address = ${dep.operator.toLowerCase()}`;
    const onChain = await pub.getTransactionCount({ address: dep.operator, blockTag: 'pending' });
    assert(Number(n.nonce) === onChain, `db ${n.nonce} vs chain ${onChain}`);
    return `nonce ${onChain}`;
  });

  await step('Audit trail: settlement, revocation, policy sync and recon events are on the hash chain', async () => {
    const rows = await admin`select type from audit_events where workspace_id = ${ws}`;
    const types = new Set(rows.map((r: any) => r.type));
    for (const t of ['settlement.completed', 'settlement.reverted', 'credential.chain_claim_revoked', 'policy.chain_synced', 'recon.completed', 'recon.break_simulated', 'recon.register_adjusted']) assert(types.has(t), `missing ${t}`);
  });
} finally {
  await drain().catch(() => {});
  await pool.end();
}
console.log(`\n${pass}/${pass + fail} end-to-end steps passed.`);
proc.exit(fail ? 1 : 0);
