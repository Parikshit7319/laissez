// On-chain settlement for Laissez. Fund units are ERC-3643 (T-REX) tokens on Base Sepolia, and Laissez is the
// trusted claim issuer every fund's IdentityRegistry relies on (claim topic 10101). This module runs in the Worker
// and in Node jobs: it queues settlement jobs, onboards custodial investor wallets, sends the atomic DvP
// transaction, reconciles token balances against the register, and anchors audit log heads.
//
// Worker limits (free plan): 10 ms CPU and 50 subrequests per invocation. Every chain action is one transaction
// with an explicit gas limit (no estimate round trip), nonces come from Postgres, and reads are batched through
// Multicall3. Heavy or slow work falls back to the cron and to api/jobs/chain.ts.
import { encodeFunctionData, decodeFunctionResult, decodeAbiParameters, encodeAbiParameters, encodePacked, parseAbi, keccak256, toBytes, concat, getContractAddress, hexToBigInt, type Hex, type Address } from 'viem';
import { privateKeyToAccount, privateKeyToAddress, type PrivateKeyAccount } from 'viem/accounts';
import { adminSql, type Sql } from './db';
import { type Env, id as newId, today, ApiError } from './util';
import { emit } from './ctx';
import { auditQ, SYSTEM, type Actor } from './http';
import { noticeExecutionQueries } from './fundops-core';
import { travelRuleConfirmRaw } from './routes/travel';
import { isProduction } from './mode';
import { flag } from './flags';

// ---------- Constants and ABIs ----------
export const CLAIM_TOPIC = 10101n;
const DECIMALS = 6;
const DEFAULT_RPC = 'https://sepolia.base.org';
const MULTICALL3_CANONICAL = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;
const MAX_ATTEMPTS = 8;
const RECEIPT_WAIT_MS = 20_000;
/** Below this the operator wallet cannot pay for many more settlements on Base Sepolia. */
export const LOW_BALANCE_ETH = 0.002;
const NETWORK_LABEL: Record<string, string> = { 'base-sepolia': 'Base Sepolia', 'hardhat-local': 'Local Hardhat' };

/** ISO 3166-1 numeric codes stored in the on-chain identity registries. */
export const ISO_NUMERIC: Record<string, number> = { SG: 702, HK: 344, CH: 756, DE: 276, 'AE-DIFC': 784, 'AE-ADGM': 784, AE: 784, US: 840, GB: 826, JP: 392, LU: 442, IE: 372, IR: 364, CU: 192, KP: 408 };

const DVP_ABI = parseAbi([
  'function subscribe(address token, address investor, uint256 units, address cash, uint256 cashAmount, address treasury, bytes32 decisionHash)',
  'function transfer(address token, address from, address to, uint256 units, address cash, uint256 cashAmount, bytes32 decisionHash)',
  'function redeem(address token, address investor, uint256 units, address cash, uint256 cashAmount, address treasury, bytes32 decisionHash)',
  'function settledAt(bytes32 decisionHash) view returns (uint256)',
]);
const ONBOARDER_ABI = parseAbi([
  'struct Registration { address token; uint16 country; uint256 openingUnits; }',
  'function onboard(address wallet, string salt, bytes claimSignature, bytes claimData, Registration[] registrations) returns (address)',
]);
const TOKEN_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)', 'function mint(address to, uint256 amount)']);
const REGISTRY_ABI = parseAbi([
  'function contains(address wallet) view returns (bool)',
  'function isVerified(address wallet) view returns (bool)',
  'function investorCountry(address wallet) view returns (uint16)',
]);
const IDENTITY_ABI = parseAbi(['function getClaim(bytes32 claimId) view returns (uint256 topic, uint256 scheme, address issuer, bytes signature, bytes data, string uri)']);
const CLAIM_ISSUER_ABI = parseAbi(['function revokeClaim(bytes32 claimId, address identity) returns (bool)', 'function revokeClaimBySignature(bytes signature)', 'function isClaimRevoked(bytes signature) view returns (bool)']);
const COMPLIANCE_ABI = parseAbi(['function callModuleFunction(bytes callData, address module)']);
const COUNTRY_MODULE_ABI = parseAbi([
  'function batchAllowCountries(uint16[] countries)',
  'function batchDisallowCountries(uint16[] countries)',
  'function isCountryAllowed(address compliance, uint16 country) view returns (bool)',
]);
const SETTLED_TOPIC = keccak256(toBytes('Settled(bytes32,uint8,address,address,address,uint256,uint256)'));
const ANCHOR_ABI = parseAbi(['function anchor(bytes32 root, uint64 day, uint32 leaves)', 'function rootOf(uint64 day) view returns (bytes32)']);
const MULTICALL_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getBlockNumber() view returns (uint256)',
]);

/** Explicit gas limits, measured on a local node with headroom. */
const GAS = { onboardBase: 950_000n, onboardPerFund: 350_000n, subscribe: 500_000n, transfer: 500_000n, redeem: 320_000n, revoke: 200_000n, policyBase: 120_000n, policyPerCountry: 35_000n, anchor: 160_000n, mint: 320_000n };

// ---------- Deployment ----------
export type FundSuite = {
  name: string; symbol: string; decimals: number; currency: 'USD' | 'EUR'; cash: Address; treasury: Address; token: Address;
  identityRegistry: Address; identityRegistryStorage: Address; claimTopicsRegistry: Address; trustedIssuersRegistry: Address; compliance: Address;
  jurisdictions: string[]; countries: number[]; block: number;
};
export type Deployment = {
  network: string; chainId: number; explorer: string | null; operator: Address; claimSigner: Address; claimTopic: number;
  contracts: {
    identityImplementation: Address; identityImplementationAuthority: Address; idFactory: Address; claimIssuer: Address;
    countryAllowModuleImplementation: Address; countryAllowModule: Address; claimExpiryModule?: Address; onboarder: Address; dvp: Address; auditAnchor: Address;
    multicall3?: Address; cash: Record<string, Address>;
  };
  identityInitCodeHash: Hex; autoFundTestCash: boolean; funds: Record<string, FundSuite>; blocks: { start: number; end: number }; deployedAt: string;
};

let depCache: { at: number; value: Deployment | null } | null = null;
/** The last env seen, so loadDeployment (which has no env parameter) can apply the deployment mode. */
let currentEnv: Env | null = null;
export const rememberEnv = (env: Env | null | undefined) => { if (env) currentEnv = env; };
export async function loadDeployment(admin: Sql, fresh = false): Promise<Deployment | null> {
  if (!fresh && depCache && Date.now() - depCache.at < 60_000) return depCache.value;
  const rows = await admin`select value from chain_config where key = 'deployment'`;
  const value = (rows[0]?.value ?? null) as Deployment | null;
  // Test cash auto-mint is a sandbox convenience: production never reports or relies on it, whatever the deployment says.
  if (value && isProduction(currentEnv)) value.autoFundTestCash = false;
  depCache = { at: Date.now(), value };
  return value;
}
const invalidateDeployment = () => { depCache = null; };

export const networkLabel = (d: Deployment) => NETWORK_LABEL[d.network] ?? d.network;
export const txUrl = (d: Deployment | null, hash: string | null | undefined) => (d?.explorer && hash ? `${d.explorer}/tx/${hash}` : null);
export const addressUrl = (d: Deployment | null, addr: string | null | undefined) => (d?.explorer && addr ? `${d.explorer}/address/${addr}` : null);

// ---------- Keys, custody wallets, identities and claims ----------
const normKey = (k: string) => (k.startsWith('0x') ? k : `0x${k}`) as Hex;
let opAcct: { key: string; a: PrivateKeyAccount } | null = null;
let claimAcct: { key: string; a: PrivateKeyAccount } | null = null;
function operatorAccount(env: Env): PrivateKeyAccount {
  if (!env.CHAIN_OPERATOR_KEY) throw new Final('CHAIN_OPERATOR_KEY is not set, so Laissez cannot send transactions.');
  if (opAcct?.key !== env.CHAIN_OPERATOR_KEY) opAcct = { key: env.CHAIN_OPERATOR_KEY, a: privateKeyToAccount(normKey(env.CHAIN_OPERATOR_KEY)) };
  return opAcct.a;
}
function claimAccount(env: Env): PrivateKeyAccount {
  if (!env.CHAIN_CLAIM_KEY) throw new Final('CHAIN_CLAIM_KEY is not set, so Laissez cannot sign eligibility claims.');
  if (claimAcct?.key !== env.CHAIN_CLAIM_KEY) claimAcct = { key: env.CHAIN_CLAIM_KEY, a: privateKeyToAccount(normKey(env.CHAIN_CLAIM_KEY)) };
  return claimAcct.a;
}

const CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** keccak256(seed || label), re-hashed until it is a valid secp256k1 key. Matches api/chain/lib.mjs. */
function deriveKey(seed: string, label: string): Hex {
  let h = keccak256(concat([toBytes(seed), toBytes(label)]));
  while (hexToBigInt(h) === 0n || hexToBigInt(h) >= CURVE_N) h = keccak256(h);
  return h;
}
function custodySeed(env: Env): string {
  if (!env.CHAIN_CUSTODY_SEED) throw new Final('CHAIN_CUSTODY_SEED is not set, so Laissez cannot derive custodial wallets.');
  return env.CHAIN_CUSTODY_SEED;
}
/** Custodial investor wallet. It never needs gas: the onboarder and the DvP contract move assets as agents. */
export const investorWallet = (env: Env, ws: string, investorId: string): Address => privateKeyToAddress(deriveKey(custodySeed(env), `investor:${ws}:${investorId}`));
export const treasuryWallet = (env: Env, ticker: string): Address => privateKeyToAddress(deriveKey(custodySeed(env), `treasury:${ticker}`));
export const identitySalt = (ws: string, investorId: string) => `laissez:${ws}:${investorId}`;
/** CREATE2 address IdFactory.createIdentityWithManagementKeys will use, so the claim can be signed before the identity exists. */
export const predictIdentity = (d: Deployment, salt: string): Address =>
  getContractAddress({ opcode: 'CREATE2', from: d.contracts.idFactory, salt: keccak256(toBytes(`OID${salt}`)), bytecodeHash: d.identityInitCodeHash });
export const decisionHash = (ws: string, decisionId: string) => keccak256(toBytes(`laissez:decision:${ws}:${decisionId}`));
export const credentialHash = (lzid: string) => keccak256(toBytes(lzid));
const claimIdFor = (issuer: Address) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [issuer, CLAIM_TOPIC]));
const claimDataFor = (lzid: string, expiresOn: string | null) => {
  const exp = expiresOn ? Math.floor(Date.parse(`${expiresOn}T23:59:59Z`) / 1000) : 0;
  return encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint64' }], [credentialHash(lzid), BigInt(Number.isFinite(exp) ? exp : 0)]);
};
/** ONCHAINID ClaimIssuer.isClaimValid: EIP-191 signature over keccak256(abi.encode(identity, topic, data)). */
async function signClaim(env: Env, identity: Address, data: Hex): Promise<Hex> {
  const hash = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }], [identity, CLAIM_TOPIC, data]));
  return claimAccount(env).signMessage({ message: { raw: hash } });
}

export const toUnits = (n: number) => BigInt(Math.round(Number(n) * 10 ** DECIMALS));
export const fromUnits = (b: bigint) => Number(b) / 10 ** DECIMALS;
const countryOf = (jur: string | null | undefined) => (jur ? ISO_NUMERIC[jur] ?? 0 : 0);

// ---------- Errors ----------
/** A failure that retrying will not fix. */
class Final extends Error {}
class RpcError extends Error {
  constructor(message: string, public code?: number, public data?: string) { super(message); }
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

function decodeRevert(data?: string | null, message?: string): string {
  if (data && data.startsWith('0x08c379a0')) {
    try { return decodeAbiParameters([{ type: 'string' }], `0x${data.slice(10)}` as Hex)[0]; } catch { /* fall through */ }
  }
  if (data && data.startsWith('0x4e487b71')) return 'The contract hit an arithmetic or assertion error.';
  const m = message?.match(/reverted with reason string '([^']*)'/) ?? message?.match(/execution reverted: (.*)$/);
  if (m) return m[1];
  return message && /revert/i.test(message) ? 'The transaction reverted on-chain without a reason.' : (message ?? 'The transaction reverted on-chain.');
}

// ---------- JSON-RPC ----------
type Budget = { left: number };
type Chain = { url: string; dep: Deployment; budget: Budget };
function chainFor(env: Env, dep: Deployment, budget: Budget = { left: Number.POSITIVE_INFINITY }): Chain {
  return { url: env.CHAIN_RPC_URL || DEFAULT_RPC, dep, budget };
}
async function rpc<T = any>(ch: Chain, method: string, params: unknown[]): Promise<T> {
  ch.budget.left--;
  let res: Response;
  try {
    res = await fetch(ch.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new RpcError(`Could not reach the chain RPC: ${errText(e)}`);
  }
  const j: any = await res.json().catch(() => null);
  if (!j) throw new RpcError(`The chain RPC returned HTTP ${res.status} with no JSON body.`);
  if (j.error) {
    const data = typeof j.error.data === 'string' ? j.error.data : typeof j.error.data?.data === 'string' ? j.error.data.data : undefined;
    throw new RpcError(String(j.error.message ?? 'RPC error'), j.error.code, data);
  }
  return j.result as T;
}
async function ethCall(ch: Chain, to: Address, data: Hex, block: string = 'latest'): Promise<Hex> {
  return rpc<Hex>(ch, 'eth_call', [{ from: ch.dep.operator, to, data }, block]);
}
type Call = { target: Address; data: Hex };
async function multicall(ch: Chain, calls: Call[]): Promise<{ success: boolean; returnData: Hex }[]> {
  const out: { success: boolean; returnData: Hex }[] = [];
  const mc = ch.dep.contracts.multicall3 ?? MULTICALL3_CANONICAL;
  for (let i = 0; i < calls.length; i += 250) {
    const chunk = calls.slice(i, i + 250);
    const data = encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'aggregate3', args: [chunk.map((c) => ({ target: c.target, allowFailure: true, callData: c.data }))] });
    const raw = await ethCall(ch, mc, data);
    out.push(...(decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', data: raw }) as readonly { success: boolean; returnData: Hex }[]));
  }
  return out;
}
const mcBlock = (ch: Chain): Call => ({ target: ch.dep.contracts.multicall3 ?? MULTICALL3_CANONICAL, data: encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'getBlockNumber' }) });
function dec<T>(abi: any, functionName: string, r: { success: boolean; returnData: Hex } | undefined, fallback: T): T {
  if (!r?.success || r.returnData === '0x') return fallback;
  try { return decodeFunctionResult({ abi, functionName, data: r.returnData }) as T; } catch { return fallback; }
}

type Receipt = { status: 'success' | 'reverted'; blockNumber: number; gasUsed: bigint; hash: Hex };
async function getReceipt(ch: Chain, hash: Hex): Promise<Receipt | null> {
  const r: any = await rpc(ch, 'eth_getTransactionReceipt', [hash]);
  if (!r || !r.blockNumber) return null;
  return { status: r.status === '0x1' ? 'success' : 'reverted', blockNumber: Number(BigInt(r.blockNumber)), gasUsed: BigInt(r.gasUsed ?? '0x0'), hash };
}
/** Polls for a receipt every second, up to maxMs. Returns null when the transaction is not mined yet. */
async function waitReceipt(ch: Chain, hash: Hex, maxMs = RECEIPT_WAIT_MS): Promise<Receipt | null> {
  for (let waited = 0; ; waited += 1000) {
    const r = await getReceipt(ch, hash);
    if (r) return r;
    if (waited >= maxMs || ch.budget.left < 4) return null;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

// ---------- Nonces and sending ----------
let feeCache: { at: number; url: string; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null = null;
async function fees(ch: Chain) {
  if (feeCache && feeCache.url === ch.url && Date.now() - feeCache.at < 30_000) return feeCache;
  const gp = BigInt(await rpc<Hex>(ch, 'eth_gasPrice', []));
  const tip = gp / 2n > 0n ? gp / 2n : 1n;
  feeCache = { at: Date.now(), url: ch.url, maxFeePerGas: gp * 3n + tip, maxPriorityFeePerGas: tip };
  return feeCache;
}
async function chainNonce(ch: Chain, address: Address): Promise<number> {
  return Number(BigInt(await rpc<Hex>(ch, 'eth_getTransactionCount', [address, 'pending'])));
}
/** Reserves n consecutive nonces with one atomic update on the owner connection. Returns the first. */
async function takeNonces(ch: Chain, admin: Sql, address: Address, n: number): Promise<number> {
  const a = address.toLowerCase();
  let rows = await admin`update chain_nonces set nonce = nonce + ${n} where address = ${a} returning nonce`;
  if (!rows.length) {
    const pending = await chainNonce(ch, address);
    await admin`insert into chain_nonces (address, nonce) values (${a}, ${pending}) on conflict (address) do nothing`;
    rows = await admin`update chain_nonces set nonce = nonce + ${n} where address = ${a} returning nonce`;
  }
  return Number(rows[0].nonce) - n;
}
/** 'raise' never moves the counter backwards (nonce too low). 'reset' matches the chain exactly (closes a gap). */
async function resyncNonce(ch: Chain, admin: Sql, address: Address, mode: 'raise' | 'reset') {
  const pending = await chainNonce(ch, address);
  const a = address.toLowerCase();
  if (mode === 'raise') await admin`insert into chain_nonces (address, nonce) values (${a}, ${pending}) on conflict (address) do update set nonce = greatest(chain_nonces.nonce, excluded.nonce)`;
  else await admin`insert into chain_nonces (address, nonce) values (${a}, ${pending}) on conflict (address) do update set nonce = excluded.nonce`;
}
const isNonceError = (e: unknown) => /nonce too (low|high)|invalid nonce|nonce has already been used|already known|replacement transaction underpriced|known transaction/i.test(errText(e));

type TxReq = { to: Address; data: Hex; gas: bigint; label: string; investor?: string };
type Sent = { hash: Hex; label: string; to: Address; data: Hex; at: string; nonce: number; investor?: string };
/**
 * Signs and broadcasts the transactions with consecutive nonces, without waiting in between.
 * Returns what was broadcast; `error` is set when a later transaction could not be sent.
 */
async function sendAll(ch: Chain, admin: Sql, env: Env, txs: TxReq[]): Promise<{ sent: Sent[]; error?: unknown }> {
  const account = operatorAccount(env);
  const fee = await fees(ch);
  for (let attempt = 0; ; attempt++) {
    const first = await takeNonces(ch, admin, account.address, txs.length);
    const sent: Sent[] = [];
    try {
      for (let i = 0; i < txs.length; i++) {
        const t = txs[i];
        const raw = await account.signTransaction({ chainId: ch.dep.chainId, type: 'eip1559', to: t.to, data: t.data, gas: t.gas, nonce: first + i, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, value: 0n });
        const hash = keccak256(raw);
        try {
          await rpc(ch, 'eth_sendRawTransaction', [raw]);
        } catch (e) {
          // A development node (Hardhat) executes on submission and reports a revert as an error; the tx is still mined.
          if (!/revert/i.test(errText(e)) || isNonceError(e)) throw e;
        }
        sent.push({ hash, label: t.label, to: t.to, data: t.data, at: new Date().toISOString(), nonce: first + i, investor: t.investor });
      }
      return { sent };
    } catch (e) {
      if (!sent.length && isNonceError(e) && attempt === 0) {
        await resyncNonce(ch, admin, account.address, /too high/i.test(errText(e)) ? 'reset' : 'raise');
        continue;
      }
      // Close any gap the unsent transactions left, so later senders do not stall.
      await resyncNonce(ch, admin, account.address, 'reset').catch(() => {});
      if (sent.length) return { sent, error: e };
      throw e;
    }
  }
}
/** Replays a mined transaction as eth_call at its block to recover the revert reason. */
async function replayReason(ch: Chain, s: Sent, block: number): Promise<string> {
  try {
    await ethCall(ch, s.to, s.data, `0x${block.toString(16)}`);
    return 'The transaction reverted on-chain.';
  } catch (e) {
    return decodeRevert((e as RpcError).data, errText(e));
  }
}

// ---------- Jobs ----------
export type JobRow = { id: string; workspace_id: string | null; kind: string; ref: string | null; payload: any; status: string; attempts: number; tx_hashes: string[]; block: number | null; error: string | null; created_at: string };

async function insertJob(admin: Sql, ws: string | null, kind: string, ref: string | null, payload: unknown): Promise<string> {
  const jobId = newId('cjob', 12);
  await admin`insert into chain_jobs (id, workspace_id, kind, ref, payload) values (${jobId}, ${ws}, ${kind}, ${ref}, ${JSON.stringify(payload)})`;
  return jobId;
}
/** Runs work after the response when a Worker execution context exists; otherwise lets it run detached (Node). */
function later(c: any, p: Promise<unknown>) {
  const safe = p.catch((e) => console.error('chain job', e));
  try { c.executionCtx.waitUntil(safe); } catch { /* no execution context */ }
}
const adminOf = (c: any): Sql => { try { const a = c.get('admin'); if (a) return a; } catch { /* not set */ } return adminSql(c.env.DATABASE_URL); };

/** True only when the operator key is set, the chain_settlement flag is on for the organization, and a deployment is recorded in chain_config. */
export async function chainEnabled(c: any): Promise<boolean> {
  if (!c.env?.CHAIN_OPERATOR_KEY) return false;
  rememberEnv(c.env);
  if (!(await flag(c, 'chain_settlement'))) return false;
  try { return !!(await loadDeployment(adminOf(c))); } catch { return false; }
}

/**
 * Queues the on-chain settlement of a pending settlement row and starts it right away in the background.
 * The settlement row must exist with status 'pending' and the register must not be updated yet; the job
 * updates holdings in the same database transaction that marks the settlement settled.
 */
export async function queueSettlement(c: any, p: { settlementId: string; decision: any; units: number }): Promise<{ job_id: string | null }> {
  const admin = adminOf(c); const ws: string = c.get('ws');
  const d = p.decision;
  const payload = {
    settlement_id: p.settlementId, decision_id: d.id, action: d.action, investor_id: d.investor_id, counterparty_id: d.counterparty_id ?? null,
    ticker: d.ticker, amount: Number(d.amount), asset: d.asset, units: Number(p.units),
  };
  const jobId = await insertJob(admin, ws, 'settle', p.settlementId, payload);
  // The request already used some of the 50 subrequests; keep this pass to about 22 RPC calls plus a few queries.
  later(c, processChainJob(admin, c.env, jobId, { left: 22 }));
  return { job_id: jobId };
}

/** When an onboarded investor's credential is revoked, revokes the Laissez claim on-chain so isVerified turns false. */
export async function onCredentialRevoked(c: any, investorId: string): Promise<void> {
  if (!(await chainEnabled(c))) return;
  const admin = adminOf(c); const ws: string = c.get('ws');
  const [inv] = await admin`select i.chain_identity, i.chain_wallet, i.chain_onboarded_at,
      (select lzid from credentials where workspace_id = i.workspace_id and investor_id = i.id and status = 'revoked' order by revoked_at desc nulls last limit 1) as revoked_lzid
    from investors i where i.workspace_id = ${ws} and i.id = ${investorId}`;
  if (!inv?.chain_onboarded_at || !inv.chain_identity) return;
  const jobId = await insertJob(admin, ws, 'revoke_claim', investorId, { investor_id: investorId, identity: inv.chain_identity, wallet: inv.chain_wallet, lzid: inv.revoked_lzid ?? null });
  await processChainJob(admin, c.env, jobId, { left: 20 });
}

/**
 * When an onboarded investor gets a new credential (a renewal or a re-issue), publishes a fresh claim with the new
 * credential hash and expiry on the existing identity and revokes the old claim's signature, so isVerified stays true
 * past the old expiry. Investors not yet on-chain get their claim at first settlement instead.
 */
export async function onCredentialIssued(c: any, investorId: string): Promise<void> {
  if (!(await chainEnabled(c))) return;
  const admin = adminOf(c); const ws: string = c.get('ws');
  const [inv] = await admin`select i.chain_identity, i.chain_wallet, i.chain_onboarded_at, cr.lzid, cr.expires_on::text as expires_on
    from investors i
    left join lateral (select lzid, expires_on from credentials where workspace_id = i.workspace_id and investor_id = i.id and status = 'active' order by created_at desc limit 1) cr on true
    where i.workspace_id = ${ws} and i.id = ${investorId}`;
  if (!inv?.chain_onboarded_at || !inv.chain_identity || !inv.chain_wallet || !inv.lzid) return;
  const jobId = await insertJob(admin, ws, 're_issue_claim', investorId, { investor_id: investorId, identity: inv.chain_identity, wallet: inv.chain_wallet, lzid: inv.lzid, expires_on: inv.expires_on });
  await processChainJob(admin, c.env, jobId, { left: 20 });
}

/** After a fund policy is published, syncs the fund's CountryAllowModule with its distribution jurisdictions. */
export async function onPolicyPublished(c: any, ticker: string): Promise<void> {
  if (!(await chainEnabled(c))) return;
  const admin = adminOf(c);
  const dep = await loadDeployment(admin);
  if (!dep?.funds[ticker]) return;
  const jobId = await insertJob(admin, c.get('ws'), 'policy_sync', ticker, { ticker });
  await processChainJob(admin, c.env, jobId, { left: 20 });
}

/**
 * Retries queued jobs and jobs left running by a request that ended early. Used by the Worker cron and by
 * api/jobs/chain.ts. In a Worker it stops before the subrequest budget runs out.
 */
export async function processPendingChainJobs(env: Env, limit: number, opts: { admin?: Sql; budget?: number } = {}): Promise<void> {
  if (!env.CHAIN_OPERATOR_KEY || !env.DATABASE_URL) return;
  rememberEnv(env);
  const admin = opts.admin ?? adminSql(env.DATABASE_URL);
  const inWorker = typeof navigator !== 'undefined' && (navigator as any).userAgent === 'Cloudflare-Workers';
  const budget: Budget = { left: opts.budget ?? (inWorker ? 38 : Number.POSITIVE_INFINITY) };
  const jobs = await admin`select id from chain_jobs where status = 'queued' or (status = 'running' and updated_at < now() - interval '90 seconds') order by created_at limit ${limit}`;
  budget.left--;
  for (const j of jobs) {
    if (budget.left < 16) break;
    budget.left -= 6; // database round trips per job
    await processChainJob(admin, env, j.id, budget).catch((e) => console.error('chain job', j.id, e));
  }
}

/** Claims one job and runs it. Safe to call concurrently: only one caller wins the claim. */
export async function processChainJob(admin: Sql, env: Env, jobId: string, budget: Budget = { left: Number.POSITIVE_INFINITY }): Promise<JobRow | null> {
  rememberEnv(env);
  const [job] = (await admin`update chain_jobs set status = 'running', attempts = attempts + 1, updated_at = now()
    where id = ${jobId} and (status = 'queued' or (status = 'running' and updated_at < now() - interval '90 seconds')) returning *`) as JobRow[];
  if (!job) return null;
  const dep = await loadDeployment(admin);
  try {
    if (!dep) throw new Final('No chain deployment is recorded in chain_config.');
    const ch = chainFor(env, dep, budget);
    if (job.kind === 'settle') await runSettle(admin, ch, env, job);
    else if (job.kind === 'revoke_claim') await runRevoke(admin, ch, env, job);
    else if (job.kind === 're_issue_claim') await runReissue(admin, ch, env, job);
    else if (job.kind === 'policy_sync') await runPolicySync(admin, ch, env, job);
    else if (job.kind === 'break_demo') await runBreakDemo(admin, ch, env, job);
    else throw new Final(`Unknown chain job kind ${job.kind}.`);
  } catch (e) {
    // Never give up on a job with broadcast transactions because of a transient error: one may still be mined.
    const broadcast = !(e instanceof Final) && job.attempts >= MAX_ATTEMPTS
      ? ((await admin`select tx_hashes from chain_jobs where id = ${job.id}`)[0]?.tx_hashes ?? []).length > 0
      : false;
    const final = e instanceof Final || (job.attempts >= MAX_ATTEMPTS && !broadcast);
    const reason = errText(e);
    await admin`update chain_jobs set status = ${final ? 'failed' : 'queued'}, error = ${reason}, updated_at = now() where id = ${job.id}`;
    if (final && job.kind === 'settle' && dep) {
      await revertSettlement(admin, dep, job, { reason: e instanceof Final ? reason : `The chain did not confirm after ${job.attempts} attempts: ${reason}`, sent: [] }).catch((x) => console.error(x));
    }
  }
  const [after] = (await admin`select * from chain_jobs where id = ${job.id}`) as JobRow[];
  return after ?? null;
}

async function recordSent(admin: Sql, jobId: string, sent: Sent[]) {
  await admin`update chain_jobs set tx_hashes = ${sent.map((s) => s.hash)}, payload = payload || ${JSON.stringify({ sent })}::jsonb, updated_at = now() where id = ${jobId}`;
}
/** Leaves the job for a later pass, with its broadcast transactions recorded. */
async function requeue(admin: Sql, jobId: string, note: string) {
  await admin`update chain_jobs set status = 'queued', error = ${note}, updated_at = now() where id = ${jobId}`;
}
/** For a job that already broadcast: returns the last receipt, 'pending' while it is in the mempool, or null if it was dropped. */
async function resumeSent(ch: Chain, job: JobRow): Promise<Receipt | 'pending' | null> {
  const sent: Sent[] = job.payload?.sent ?? [];
  if (!sent.length) return null;
  const last = sent[sent.length - 1];
  const r = await getReceipt(ch, last.hash);
  if (r) return r;
  const tx = await rpc(ch, 'eth_getTransactionByHash', [last.hash]);
  return tx ? 'pending' : null;
}

// ---------- Settlement ----------
type Party = {
  id: string; residence: string; country: number; wallet: Address; identity: Address; onboarded: boolean; walletStored: boolean;
  lzid: string | null; expires: string | null; credActive: boolean; holdings: Record<string, number>;
  delta: number; needsVerify: boolean; onboardTx?: Sent;
};

async function runSettle(admin: Sql, ch: Chain, env: Env, job: JobRow) {
  const p = job.payload; const ws = job.workspace_id as string; const dep = ch.dep;
  const [stl] = await admin`select s.id, s.status, s.steps, s.chain from settlements s where s.workspace_id = ${ws} and s.id = ${p.settlement_id}`;
  if (!stl) throw new Final('The settlement no longer exists.');
  if (stl.status === 'reverted') { await admin`update chain_jobs set status = 'failed', error = 'The settlement was already reverted.', updated_at = now() where id = ${job.id}`; return; }
  if (stl.status === 'settled' && stl.chain?.tx_hash) { await admin`update chain_jobs set status = 'confirmed', updated_at = now() where id = ${job.id}`; return; }
  const applied = stl.status === 'settled';
  const fund = dep.funds[p.ticker];
  if (!fund) return settleOffChain(admin, dep, job, applied);
  const dh = decisionHash(ws, p.decision_id);

  // A previous pass already broadcast: finish from its receipt instead of sending again.
  const resumed = await resumeSent(ch, job);
  if (resumed === 'pending') return requeue(admin, job.id, 'Waiting for the transaction to be mined.');

  const ids: string[] = [p.investor_id, ...(p.counterparty_id ? [p.counterparty_id] : [])];
  const [invRows, holdRows] = await admin.transaction([
    admin`select i.id, i.residence, i.chain_wallet, i.chain_identity, i.chain_onboarded_at,
        coalesce(c.lzid, sc.lzid) as lzid, coalesce(c.expires_on, sc.expires_on)::text as expires_on, coalesce(c.status, sc.status) as cred_status
      from investors i
      left join lateral (select lzid, expires_on, status from credentials where workspace_id = i.workspace_id and investor_id = i.id order by (status = 'active') desc, created_at desc limit 1) c on true
      left join lateral (select cr.lzid, cr.expires_on, case when s.status = 'active' and cr.status = 'active' then 'active' else 'revoked' end as status
        from credential_shares s join credentials cr on cr.workspace_id = s.from_workspace and cr.id = s.credential_id where s.id = i.relied_share) sc on true
      where i.workspace_id = ${ws} and i.id = any(${ids})`,
    admin`select investor_id, ticker, units::float8 as units from holdings where workspace_id = ${ws} and investor_id = any(${ids})`,
  ]);
  const parties: Party[] = ids.map((pid, i) => {
    const r = invRows.find((x: any) => x.id === pid);
    if (!r) throw new Final(`Investor ${pid} no longer exists.`);
    const holdings: Record<string, number> = {};
    for (const h of holdRows) if (h.investor_id === pid) holdings[h.ticker] = Number(h.units);
    const salt = identitySalt(ws, pid);
    const receiving = (p.action === 'subscribe' && i === 0) || (p.action === 'transfer' && i === 1);
    return {
      id: pid, residence: r.residence, country: countryOf(r.residence),
      wallet: (r.chain_wallet ?? investorWallet(env, ws, pid)) as Address, walletStored: !!r.chain_wallet,
      identity: (r.chain_identity ?? predictIdentity(dep, salt)) as Address, onboarded: !!r.chain_onboarded_at,
      lzid: r.lzid ?? null, expires: r.expires_on ?? null, credActive: r.cred_status === 'active', holdings,
      delta: receiving ? Number(p.units) : -Number(p.units), needsVerify: receiving,
    };
  });

  if (resumed) return finishSettle(admin, ch, env, job, parties, fund, applied, resumed);

  // One read covers idempotency (already settled?) and the on-chain status of onboarded parties.
  const onboarded = parties.filter((x) => x.onboarded);
  const ir = fund.identityRegistry;
  const calls: Call[] = [{ target: dep.contracts.dvp, data: encodeFunctionData({ abi: DVP_ABI, functionName: 'settledAt', args: [dh] }) }];
  for (const x of onboarded) {
    calls.push({ target: ir, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'contains', args: [x.wallet] }) });
    calls.push({ target: ir, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'isVerified', args: [x.wallet] }) });
  }
  const needRead = onboarded.length > 0 || job.attempts > 1;
  const res = needRead ? await multicall(ch, calls) : [];
  const settledBlock = needRead ? dec<bigint>(DVP_ABI, 'settledAt', res[0], 0n) : 0n;
  if (settledBlock > 0n) {
    // An earlier pass settled it but its record was lost: find the Settled event and finish from that receipt.
    const logs: any[] = await rpc(ch, 'eth_getLogs', [{ address: dep.contracts.dvp, topics: [SETTLED_TOPIC, dh], fromBlock: `0x${settledBlock.toString(16)}`, toBlock: `0x${settledBlock.toString(16)}` }]);
    const hash = logs[0]?.transactionHash as Hex | undefined;
    const r = hash ? await getReceipt(ch, hash) : null;
    if (!r) throw new Final('This decision already settled on-chain, but the transaction could not be found. Run reconciliation.');
    job.payload = { ...job.payload, sent: [{ hash, label: 'dvp', to: dep.contracts.dvp, data: '0x', at: new Date().toISOString(), nonce: -1 }] };
    return finishSettle(admin, ch, env, job, parties, fund, applied, r);
  }

  const txs: TxReq[] = [];
  for (const x of parties) {
    const opening = Math.max(0, (x.holdings[p.ticker] ?? 0) - (applied ? x.delta : 0));
    let contains = false; let verified = false;
    if (x.onboarded) {
      const k = 1 + onboarded.indexOf(x) * 2;
      contains = dec<boolean>(REGISTRY_ABI, 'contains', res[k], false);
      verified = dec<boolean>(REGISTRY_ABI, 'isVerified', res[k + 1], false);
    }
    // Receiving units needs a claim from an active credential, and Laissez never publishes one for an inactive
    // credential: the chain then rejects the settlement. Minting an opening balance on a first registration also
    // needs a claim; a redemption-only holder gets one from the latest credential, revoked again after settlement.
    if (x.needsVerify && !verified && !x.credActive) continue;
    const needsClaim = !verified && (x.needsVerify || (!contains && opening > 0));
    if (contains && !needsClaim) continue;
    if (needsClaim && !x.lzid) {
      if (x.needsVerify) throw new Final(`${x.id} has no credential to put on-chain, so the receiving wallet cannot be verified.`);
      throw new Final(`${x.id} holds ${opening} ${p.ticker} on the register but has no credential, so the position cannot be minted on-chain before it moves.`);
    }
    const regs: { token: Address; country: number; openingUnits: bigint }[] = [];
    if (!contains) regs.push({ token: fund.token, country: x.country, openingUnits: toUnits(opening) });
    if (!x.onboarded && needsClaim) {
      // First onboarding: mirror the investor's other positions too, where the fund distributes to their country.
      for (const [t, units] of Object.entries(x.holdings)) {
        const f = dep.funds[t];
        if (t === p.ticker || !f || units <= 0 || !f.countries.includes(x.country)) continue;
        regs.push({ token: f.token, country: x.country, openingUnits: toUnits(units) });
      }
    }
    let sig: Hex = '0x'; let data: Hex = '0x';
    if (needsClaim && x.lzid) { data = claimDataFor(x.lzid, x.expires); sig = await signClaim(env, x.identity, data); }
    txs.push({
      to: dep.contracts.onboarder, label: 'onboard', investor: x.id, gas: GAS.onboardBase + GAS.onboardPerFund * BigInt(Math.max(1, regs.length)),
      data: encodeFunctionData({ abi: ONBOARDER_ABI, functionName: 'onboard', args: [x.wallet, identitySalt(ws, x.id), sig, data, regs] }),
    });
  }

  const dvpTx = buildDvp(dep, fund, p, parties, dh);
  if (!txs.length) {
    // Nothing to onboard: preflight so a doomed settlement costs no gas.
    try { await ethCall(ch, dvpTx.to, dvpTx.data); }
    catch (e) {
      const reverted = e instanceof RpcError && (!!e.data || /revert/i.test(e.message));
      if (!reverted) throw e;
      return revertSettlement(admin, dep, job, { reason: decodeRevert((e as RpcError).data, errText(e)), sent: [], parties, stage: 'preflight' });
    }
  }
  txs.push(dvpTx);
  const { sent, error } = await sendAll(ch, admin, env, txs);
  await recordSent(admin, job.id, sent);
  if (error || sent.length < txs.length) {
    // Onboarding went out but the DvP did not: wait for onboarding, then retry the DvP on the next pass.
    const last = sent[sent.length - 1];
    const r = last ? await waitReceipt(ch, last.hash) : null;
    if (r) await storeOnboarding(admin, ws, parties.filter((x) => sent.some((s) => s.investor === x.id && s.label === 'onboard')), r.status === 'success');
    await admin`update chain_jobs set status = 'queued', tx_hashes = '{}', payload = payload - 'sent', error = ${errText(error)}, updated_at = now() where id = ${job.id}`;
    return;
  }
  const r = await waitReceipt(ch, sent[sent.length - 1].hash);
  if (!r) return requeue(admin, job.id, 'Broadcast; waiting for the transaction to be mined.');
  job.payload = { ...job.payload, sent };
  return finishSettle(admin, ch, env, job, parties, fund, applied, r);
}

function buildDvp(dep: Deployment, fund: FundSuite, p: any, parties: Party[], dh: Hex): TxReq {
  const units = toUnits(p.units); const cash = fund.cash ?? dep.contracts.cash[fund.currency]; const amount = toUnits(p.amount);
  const [a, b] = parties;
  if (p.action === 'subscribe') return { to: dep.contracts.dvp, label: 'dvp', gas: GAS.subscribe, data: encodeFunctionData({ abi: DVP_ABI, functionName: 'subscribe', args: [fund.token, a.wallet, units, cash, amount, fund.treasury, dh] }) };
  if (p.action === 'redeem') return { to: dep.contracts.dvp, label: 'dvp', gas: GAS.redeem, data: encodeFunctionData({ abi: DVP_ABI, functionName: 'redeem', args: [fund.token, a.wallet, units, cash, amount, fund.treasury, dh] }) };
  if (p.action === 'transfer' && b) return { to: dep.contracts.dvp, label: 'dvp', gas: GAS.transfer, data: encodeFunctionData({ abi: DVP_ABI, functionName: 'transfer', args: [fund.token, a.wallet, b.wallet, units, cash, amount, dh] }) };
  throw new Final(`Cannot settle action ${p.action} on-chain.`);
}

async function storeOnboarding(admin: Sql, ws: string, parties: Party[], ok: boolean) {
  for (const x of parties) {
    if (ok) await admin`update investors set chain_wallet = ${x.wallet}, chain_identity = ${x.identity}, chain_onboarded_at = coalesce(chain_onboarded_at, now()) where workspace_id = ${ws} and id = ${x.id}`;
  }
}

function investorUpdates(admin: Sql, ws: string, parties: Party[], onboardedOk: Set<string>) {
  return parties.map((x) => onboardedOk.has(x.id)
    ? admin`update investors set chain_wallet = ${x.wallet}, chain_identity = ${x.identity}, chain_onboarded_at = coalesce(chain_onboarded_at, now()) where workspace_id = ${ws} and id = ${x.id}`
    : admin`update investors set chain_wallet = coalesce(chain_wallet, ${x.wallet}) where workspace_id = ${ws} and id = ${x.id}`);
}

async function finishSettle(admin: Sql, ch: Chain, env: Env, job: JobRow, parties: Party[], fund: FundSuite, applied: boolean, r: Receipt) {
  const p = job.payload; const ws = job.workspace_id as string; const dep = ch.dep;
  const sent: Sent[] = p.sent ?? [];
  const dvpSent = sent[sent.length - 1];
  const onboardSent = sent.slice(0, -1);
  // Onboarding transactions were mined before the DvP (lower nonces).
  const onboardReceipts = await Promise.all(onboardSent.map((s) => getReceipt(ch, s.hash)));
  const onboardedOk = new Set<string>(onboardSent.filter((s, i) => onboardReceipts[i]?.status === 'success' && s.investor).map((s) => s.investor as string));
  for (const x of parties) if (x.onboarded) onboardedOk.add(x.id);
  if (r.status !== 'success') {
    const reason = await replayReason(ch, dvpSent, r.blockNumber);
    return revertSettlement(admin, dep, job, { reason, sent, parties, receipt: r, onboardedOk, onboardReceipts });
  }
  const now = new Date().toISOString();
  const t = p.ticker; const u = Number(p.units);
  const q: any[] = [];
  if (!applied) {
    let holderDelta = 0; const day = today();
    for (const x of parties) {
      const held = x.holdings[t] ?? 0;
      if (x.delta > 0) {
        if (!held) holderDelta++;
        q.push(admin`insert into holdings (workspace_id, investor_id, ticker, units, since) values (${ws}, ${x.id}, ${t}, ${u}, ${day}) on conflict (workspace_id, investor_id, ticker) do update set units = holdings.units + excluded.units`);
      } else if (held - u <= 0.0001) {
        holderDelta--;
        q.push(admin`delete from holdings where workspace_id = ${ws} and investor_id = ${x.id} and ticker = ${t}`);
      } else {
        q.push(admin`update holdings set units = units - ${u} where workspace_id = ${ws} and investor_id = ${x.id} and ticker = ${t}`);
      }
    }
    if (holderDelta) q.push(admin`update funds set holders = greatest(0, holders + ${holderDelta}) where workspace_id = ${ws} and ticker = ${t}`);
    // A redemption consumes the pending notices that covered it, oldest first, in the same transaction.
    if (p.action === 'redeem') q.push(...(await noticeExecutionQueries(admin, ws, p.investor_id, t, u, '9999-12-31')));
  }
  const onboarding = onboardSent.map((s, i) => ({ investor_id: s.investor, tx_hash: s.hash, block: onboardReceipts[i]?.blockNumber ?? null, explorer_url: txUrl(dep, s.hash), wallet: parties.find((x) => x.id === s.investor)?.wallet, identity: parties.find((x) => x.id === s.investor)?.identity }));
  const chainInfo = {
    job_id: job.id, status: 'confirmed', network: dep.network, network_label: networkLabel(dep), chain_id: dep.chainId,
    tx_hash: r.hash, block: r.blockNumber, explorer_url: txUrl(dep, r.hash), gas_used: Number(r.gasUsed), decision_hash: decisionHash(ws, p.decision_id),
    contract: dep.contracts.dvp, token: fund.token, token_url: addressUrl(dep, fund.token),
    wallets: Object.fromEntries(parties.map((x) => [x.id, x.wallet])),
    onboarding_tx: onboarding[0]?.tx_hash ?? null, onboarding,
  };
  const legs = p.action === 'redeem' ? ['units_locked', 'atomic_payout'] : ['cash_locked', 'registry_confirmed', 'atomic_swap'];
  const steps = [
    { step: 'queued', at: new Date(job.created_at).toISOString() },
    ...onboarding.map((o) => ({ step: 'identity_onboarded', investor: o.investor_id, at: onboardSent.find((s) => s.hash === o.tx_hash)?.at ?? now, block: o.block, tx: o.tx_hash })),
    { step: 'submitted', at: dvpSent?.at ?? now, tx: r.hash },
    ...legs.map((step) => ({ step, at: now, block: r.blockNumber, tx: r.hash })),
    { step: 'final', at: now, block: r.blockNumber },
  ];
  q.push(admin`update settlements set status = 'settled', chain = ${JSON.stringify(chainInfo)}::jsonb,
      steps = jsonb_set(coalesce(steps, '{}'::jsonb) || ${JSON.stringify({ simulated: false, chain: networkLabel(dep) })}::jsonb, '{steps}', coalesce(steps->'steps', '[]'::jsonb) || ${JSON.stringify(steps)}::jsonb)
    where workspace_id = ${ws} and id = ${p.settlement_id}`);
  q.push(...investorUpdates(admin, ws, parties, onboardedOk));
  q.push(admin`update funds set chain_token = ${fund.token}, treasury_wallet = ${fund.treasury} where workspace_id = ${ws} and ticker = ${t}`);
  q.push(auditQ(admin, ws, SYSTEM, 'settlement.completed', p.settlement_id, { decision: p.decision_id, action: p.action, units: u, fund: t, simulated: false, network: dep.network, tx_hash: r.hash, block: r.blockNumber, onboarding_tx: chainInfo.onboarding_tx }));
  q.push(admin`update chain_jobs set status = 'confirmed', block = ${r.blockNumber}, error = null, updated_at = now() where id = ${job.id}`);
  await admin.transaction(q);
  await emit(admin, ws, 'settlement.completed', { id: p.settlement_id, decision: p.decision_id, units: u, fund: t, chain: { network: dep.network, tx_hash: r.hash, block: r.blockNumber, explorer_url: chainInfo.explorer_url } }).catch((e) => console.error(e));
  // Travel Rule: the beneficiary VASP receives the transaction id once the transfer is final on chain.
  if (p.action === 'transfer') await travelRuleConfirmRaw(env, admin, ws, p.decision_id, r.hash).catch((e) => console.error('travel rule confirmation', e));
  // A claim published from a credential that is no longer active (a redemption-only holder) is revoked right after.
  for (const x of parties) {
    if (!x.credActive && onboardSent.some((s) => s.investor === x.id)) {
      const revokeJob = await insertJob(admin, ws, 'revoke_claim', x.id, { investor_id: x.id, identity: x.identity, wallet: x.wallet, lzid: x.lzid });
      if (ch.budget.left > 12) await processChainJob(admin, env, revokeJob, ch.budget).catch((e) => console.error(e));
    }
  }
}

async function revertSettlement(admin: Sql, dep: Deployment, job: JobRow, o: { reason: string; sent: Sent[]; parties?: Party[]; receipt?: Receipt; onboardedOk?: Set<string>; onboardReceipts?: (Receipt | null)[]; stage?: string }) {
  const p = job.payload; const ws = job.workspace_id as string;
  const dvp = o.receipt;
  const onboardSent = o.sent.slice(0, -1);
  const chainInfo = {
    job_id: job.id, status: 'reverted', network: dep.network, network_label: networkLabel(dep), chain_id: dep.chainId, reason: o.reason, stage: o.stage ?? (dvp ? 'on-chain' : 'not sent'),
    tx_hash: dvp?.hash ?? null, block: dvp?.blockNumber ?? null, explorer_url: txUrl(dep, dvp?.hash), decision_hash: decisionHash(ws, p.decision_id),
    onboarding_tx: onboardSent[0]?.hash ?? null,
    onboarding: onboardSent.map((s, i) => ({ investor_id: s.investor, tx_hash: s.hash, explorer_url: txUrl(dep, s.hash), status: o.onboardReceipts?.[i]?.status ?? null })),
  };
  const now = new Date().toISOString();
  const q: any[] = [
    admin`update settlements set status = 'reverted', chain = ${JSON.stringify(chainInfo)}::jsonb,
        steps = jsonb_set(coalesce(steps, '{}'::jsonb) || ${JSON.stringify({ simulated: false, chain: networkLabel(dep), reason: o.reason })}::jsonb, '{steps}', coalesce(steps->'steps', '[]'::jsonb) || ${JSON.stringify([{ step: 'reverted', at: now, block: dvp?.blockNumber ?? null, tx: dvp?.hash ?? null, reason: o.reason }])}::jsonb)
      where workspace_id = ${ws} and id = ${p.settlement_id} and status = 'pending'`,
    auditQ(admin, ws, SYSTEM, 'settlement.reverted', p.settlement_id, { decision: p.decision_id, reason: o.reason, network: dep.network, tx_hash: dvp?.hash ?? null }),
    admin`update chain_jobs set status = 'failed', error = ${o.reason}, block = ${dvp?.blockNumber ?? null}, updated_at = now() where id = ${job.id}`,
  ];
  if (o.parties && o.onboardedOk) q.push(...investorUpdates(admin, ws, o.parties, o.onboardedOk));
  await admin.transaction(q);
  await emit(admin, ws, 'settlement.reverted', { id: p.settlement_id, decision: p.decision_id, reason: o.reason, chain: { network: dep.network, tx_hash: dvp?.hash ?? null } }).catch((e) => console.error(e));
}

/** A fund without an on-chain suite (for example one created in a sandbox) settles on the Laissez register only. */
async function settleOffChain(admin: Sql, dep: Deployment, job: JobRow, applied: boolean) {
  const p = job.payload; const ws = job.workspace_id as string; const t = p.ticker; const u = Number(p.units);
  const ids: string[] = [p.investor_id, ...(p.counterparty_id ? [p.counterparty_id] : [])];
  const hold = await admin`select investor_id, units::float8 as units from holdings where workspace_id = ${ws} and ticker = ${t} and investor_id = any(${ids})`;
  const held = (pid: string) => Number(hold.find((h: any) => h.investor_id === pid)?.units ?? 0);
  const q: any[] = []; let holderDelta = 0; const day = today();
  const credit = (pid: string) => { if (!held(pid)) holderDelta++; q.push(admin`insert into holdings (workspace_id, investor_id, ticker, units, since) values (${ws}, ${pid}, ${t}, ${u}, ${day}) on conflict (workspace_id, investor_id, ticker) do update set units = holdings.units + excluded.units`); };
  const debit = (pid: string) => { if (held(pid) - u <= 0.0001) { holderDelta--; q.push(admin`delete from holdings where workspace_id = ${ws} and investor_id = ${pid} and ticker = ${t}`); } else q.push(admin`update holdings set units = units - ${u} where workspace_id = ${ws} and investor_id = ${pid} and ticker = ${t}`); };
  if (!applied) {
    if (p.action === 'subscribe') credit(p.investor_id);
    if (p.action === 'redeem') debit(p.investor_id);
    if (p.action === 'transfer' && p.counterparty_id) { debit(p.investor_id); credit(p.counterparty_id); }
    if (holderDelta) q.push(admin`update funds set holders = greatest(0, holders + ${holderDelta}) where workspace_id = ${ws} and ticker = ${t}`);
  }
  const reason = `${t} has no token suite on ${networkLabel(dep)}, so it settled on the Laissez register only.`;
  const now = new Date().toISOString();
  q.push(admin`update settlements set status = 'settled', chain = ${JSON.stringify({ job_id: job.id, status: 'off_chain', network: null, reason })}::jsonb,
      steps = jsonb_set(coalesce(steps, '{}'::jsonb) || ${JSON.stringify({ simulated: true, chain: null, reason })}::jsonb, '{steps}', coalesce(steps->'steps', '[]'::jsonb) || ${JSON.stringify([{ step: 'register_updated', at: now }, { step: 'final', at: now }])}::jsonb)
    where workspace_id = ${ws} and id = ${p.settlement_id} and status = 'pending'`);
  q.push(auditQ(admin, ws, SYSTEM, 'settlement.completed', p.settlement_id, { decision: p.decision_id, action: p.action, units: u, fund: t, simulated: true, reason }));
  q.push(admin`update chain_jobs set status = 'confirmed', error = ${reason}, updated_at = now() where id = ${job.id}`);
  await admin.transaction(q);
  await emit(admin, ws, 'settlement.completed', { id: p.settlement_id, decision: p.decision_id, units: u, fund: t, chain: null }).catch((e) => console.error(e));
}

// ---------- Claim revocation, policy sync, break demo ----------
async function sendOne(admin: Sql, ch: Chain, env: Env, job: JobRow, tx: TxReq): Promise<Receipt | null> {
  const resumed = await resumeSent(ch, job);
  if (resumed === 'pending') { await requeue(admin, job.id, 'Waiting for the transaction to be mined.'); return null; }
  if (resumed) return resumed;
  const { sent } = await sendAll(ch, admin, env, [tx]);
  await recordSent(admin, job.id, sent);
  job.payload = { ...job.payload, sent };
  const r = await waitReceipt(ch, sent[0].hash);
  if (!r) await requeue(admin, job.id, 'Broadcast; waiting for the transaction to be mined.');
  return r;
}
async function confirmJob(admin: Sql, job: JobRow, r: Receipt | null, note: string | null, extra: any[] = []) {
  await admin.transaction([admin`update chain_jobs set status = 'confirmed', block = ${r?.blockNumber ?? null}, error = ${note}, updated_at = now() where id = ${job.id}`, ...extra]);
}
async function failedReceipt(ch: Chain, job: JobRow, r: Receipt): Promise<never> {
  const all: Sent[] = job.payload?.sent ?? [];
  const s: Sent | undefined = all.find((x) => x.hash === r.hash) ?? all[all.length - 1];
  throw new Final(s ? await replayReason(ch, s, r.blockNumber) : 'The transaction reverted on-chain.');
}

async function runRevoke(admin: Sql, ch: Chain, env: Env, job: JobRow) {
  const p = job.payload; const dep = ch.dep; const ws = job.workspace_id as string;
  const issuer = dep.contracts.claimIssuer; const cid = claimIdFor(issuer);
  if (!job.payload?.sent?.length) {
    const raw = await ethCall(ch, p.identity, encodeFunctionData({ abi: IDENTITY_ABI, functionName: 'getClaim', args: [cid] }));
    const [topic, , , signature, data] = decodeFunctionResult({ abi: IDENTITY_ABI, functionName: 'getClaim', data: raw }) as readonly [bigint, bigint, Address, Hex, Hex, string];
    if (topic === 0n || signature === '0x') return confirmJob(admin, job, null, 'No Laissez claim on this identity, nothing to revoke.');
    const [{ n }] = await admin`select count(*)::int as n from credentials where workspace_id = ${ws} and investor_id = ${p.investor_id} and status = 'active'`;
    if (p.lzid && n > 0) {
      const [hash] = decodeAbiParameters([{ type: 'bytes32' }, { type: 'uint64' }], data);
      if (hash !== credentialHash(p.lzid)) return confirmJob(admin, job, null, 'The on-chain claim belongs to a newer credential, so it stays.');
    }
    const revoked = decodeFunctionResult({ abi: CLAIM_ISSUER_ABI, functionName: 'isClaimRevoked', data: await ethCall(ch, issuer, encodeFunctionData({ abi: CLAIM_ISSUER_ABI, functionName: 'isClaimRevoked', args: [signature] })) });
    if (revoked) return confirmJob(admin, job, null, 'The claim was already revoked.');
  }
  const r = await sendOne(admin, ch, env, job, { to: issuer, label: 'revoke_claim', gas: GAS.revoke, data: encodeFunctionData({ abi: CLAIM_ISSUER_ABI, functionName: 'revokeClaim', args: [cid, p.identity] }) });
  if (!r) return;
  if (r.status !== 'success') return failedReceipt(ch, job, r);
  await confirmJob(admin, job, r, null, [auditQ(admin, ws, SYSTEM, 'credential.chain_claim_revoked', p.investor_id, { identity: p.identity, wallet: p.wallet, tx_hash: r.hash, block: r.blockNumber, network: dep.network })]);
}

/**
 * Re-issues the Laissez claim on an onboarded identity: a new signature over the new credential hash and expiry,
 * added through the onboarder (same claim id, so it replaces the old claim), and the old signature revoked at the
 * issuer so it cannot be presented again. Two transactions, sent together; the job resumes from the last receipt.
 */
async function runReissue(admin: Sql, ch: Chain, env: Env, job: JobRow) {
  const p = job.payload; const dep = ch.dep; const ws = job.workspace_id as string;
  const issuer = dep.contracts.claimIssuer; const cid = claimIdFor(issuer);
  const [cred] = await admin`select lzid, expires_on::text as expires_on, status from credentials where workspace_id = ${ws} and investor_id = ${p.investor_id} and status = 'active' order by created_at desc limit 1`;
  if (!cred || cred.lzid !== p.lzid) return confirmJob(admin, job, null, 'The credential changed again before the claim was re-issued; the newer job carries it.');
  let last: Receipt | null = null;
  const resumed = await resumeSent(ch, job);
  if (resumed === 'pending') return requeue(admin, job.id, 'Waiting for the transaction to be mined.');
  if (resumed) last = resumed;
  else {
    const raw = await ethCall(ch, p.identity, encodeFunctionData({ abi: IDENTITY_ABI, functionName: 'getClaim', args: [cid] }));
    const [topic, , , oldSig, oldData] = decodeFunctionResult({ abi: IDENTITY_ABI, functionName: 'getClaim', data: raw }) as readonly [bigint, bigint, Address, Hex, Hex, string];
    const data = claimDataFor(p.lzid, p.expires_on ?? cred.expires_on ?? null);
    if (topic !== 0n && oldData === data) return confirmJob(admin, job, null, 'The on-chain claim already carries this credential and expiry.');
    const sig = await signClaim(env, p.identity as Address, data);
    const txs: TxReq[] = [];
    if (topic !== 0n && oldSig !== '0x') {
      const revoked = decodeFunctionResult({ abi: CLAIM_ISSUER_ABI, functionName: 'isClaimRevoked', data: await ethCall(ch, issuer, encodeFunctionData({ abi: CLAIM_ISSUER_ABI, functionName: 'isClaimRevoked', args: [oldSig] })) });
      if (!revoked) txs.push({ to: issuer, label: 'revoke_old_claim', investor: p.investor_id, gas: GAS.revoke, data: encodeFunctionData({ abi: CLAIM_ISSUER_ABI, functionName: 'revokeClaimBySignature', args: [oldSig] }) });
    }
    txs.push({
      to: dep.contracts.onboarder, label: 're_issue_claim', investor: p.investor_id, gas: GAS.onboardBase,
      data: encodeFunctionData({ abi: ONBOARDER_ABI, functionName: 'onboard', args: [p.wallet as Address, identitySalt(ws, p.investor_id), sig, data, []] }),
    });
    const { sent, error } = await sendAll(ch, admin, env, txs);
    await recordSent(admin, job.id, sent);
    job.payload = { ...job.payload, sent };
    if (error || sent.length < txs.length) throw (error ?? new Error('Not every transaction was broadcast.'));
    last = await waitReceipt(ch, sent[sent.length - 1].hash);
    if (!last) return requeue(admin, job.id, 'Broadcast; waiting for the transaction to be mined.');
  }
  if (last.status !== 'success') return failedReceipt(ch, job, last);
  await confirmJob(admin, job, last, null, [auditQ(admin, ws, SYSTEM, 'credential.chain_claim_reissued', p.investor_id, { identity: p.identity, wallet: p.wallet, lzid: p.lzid, expires_on: p.expires_on ?? cred.expires_on ?? null, tx_hash: last.hash, block: last.blockNumber, network: dep.network })]);
}

async function runPolicySync(admin: Sql, ch: Chain, env: Env, job: JobRow) {
  const dep = ch.dep; const ticker: string = job.payload.ticker; const fund = dep.funds[ticker];
  if (!fund) throw new Final(`${ticker} has no on-chain suite.`);
  // The suite is shared by every organization that offers this fund, so the on-chain allow list is the union of
  // their distribution jurisdictions. Laissez still applies each organization's own policy before settlement.
  const rows = await admin`select distinct jurisdiction from fund_distribution where ticker = ${ticker}`;
  const jurisdictions = rows.map((r: any) => r.jurisdiction as string).sort();
  const want = [...new Set(jurisdictions.map(countryOf).filter((x) => x > 0))].sort((a, b) => a - b);
  const save = () => admin`update chain_config set value = jsonb_set(jsonb_set(value, ${`{funds,${ticker},countries}`}::text[], ${JSON.stringify(want)}::jsonb), ${`{funds,${ticker},jurisdictions}`}::text[], ${JSON.stringify(jurisdictions)}::jsonb), updated_at = now() where key = 'deployment'`;
  let last: Receipt | null = null;
  let added: number[] = job.payload.added ?? []; let removed: number[] = job.payload.removed ?? [];
  const resumed = await resumeSent(ch, job);
  if (resumed === 'pending') return requeue(admin, job.id, 'Waiting for the transaction to be mined.');
  if (resumed) last = resumed;
  else {
    const candidates = [...new Set([...Object.values(ISO_NUMERIC), ...fund.countries, ...want])].sort((a, b) => a - b);
    const res = await multicall(ch, candidates.map((code) => ({ target: dep.contracts.countryAllowModule, data: encodeFunctionData({ abi: COUNTRY_MODULE_ABI, functionName: 'isCountryAllowed', args: [fund.compliance, code] }) })));
    const allowed = candidates.filter((_, i) => dec<boolean>(COUNTRY_MODULE_ABI, 'isCountryAllowed', res[i], false));
    added = want.filter((x) => !allowed.includes(x));
    removed = allowed.filter((x) => !want.includes(x));
    if (!added.length && !removed.length) {
      await confirmJob(admin, job, null, 'Already in sync.', [save()]);
      invalidateDeployment();
      return;
    }
    const moduleCall = (data: Hex) => encodeFunctionData({ abi: COMPLIANCE_ABI, functionName: 'callModuleFunction', args: [data, dep.contracts.countryAllowModule] });
    const txs: TxReq[] = [];
    if (added.length) txs.push({ to: fund.compliance, label: 'allow_countries', gas: GAS.policyBase + GAS.policyPerCountry * BigInt(added.length), data: moduleCall(encodeFunctionData({ abi: COUNTRY_MODULE_ABI, functionName: 'batchAllowCountries', args: [added] })) });
    if (removed.length) txs.push({ to: fund.compliance, label: 'disallow_countries', gas: GAS.policyBase + GAS.policyPerCountry * BigInt(removed.length), data: moduleCall(encodeFunctionData({ abi: COUNTRY_MODULE_ABI, functionName: 'batchDisallowCountries', args: [removed] })) });
    const { sent, error } = await sendAll(ch, admin, env, txs);
    if (error) throw error;
    await admin`update chain_jobs set tx_hashes = ${sent.map((x) => x.hash)}, payload = payload || ${JSON.stringify({ sent, added, removed })}::jsonb, updated_at = now() where id = ${job.id}`;
    job.payload = { ...job.payload, sent, added, removed };
    last = await waitReceipt(ch, sent[sent.length - 1].hash);
    if (!last) return requeue(admin, job.id, 'Broadcast; waiting for the transaction to be mined.');
  }
  if (last.status !== 'success') return failedReceipt(ch, job, last);
  await confirmJob(admin, job, last, null, [save(), ...(job.workspace_id ? [auditQ(admin, job.workspace_id, SYSTEM, 'policy.chain_synced', ticker, { allowed: want, added, removed, tx_hash: last.hash, block: last.blockNumber, network: dep.network })] : [])]);
  invalidateDeployment();
}

async function runBreakDemo(admin: Sql, ch: Chain, env: Env, job: JobRow) {
  const p = job.payload; const fund = ch.dep.funds[p.ticker];
  if (!fund) throw new Final(`${p.ticker} has no on-chain suite.`);
  const r = await sendOne(admin, ch, env, job, { to: fund.token, label: 'break_demo', gas: GAS.mint, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'mint', args: [p.wallet, toUnits(p.units)] }) });
  if (!r) return;
  if (r.status !== 'success') return failedReceipt(ch, job, r);
  await confirmJob(admin, job, r, null, [auditQ(admin, job.workspace_id as string, SYSTEM, 'recon.break_simulated', p.investor_id, { ticker: p.ticker, units: p.units, wallet: p.wallet, tx_hash: r.hash, block: r.blockNumber, network: ch.dep.network })]);
}

/** Sandbox demo: the operator mints units straight to an investor's wallet without touching the register, which creates a real break. */
export async function simulateBreak(admin: Sql, env: Env, ws: string, investorId: string, ticker: string, units = 1000) {
  rememberEnv(env);
  if (isProduction(env)) throw new ApiError(404, 'not_found', 'Simulated breaks exist only in sandbox mode. This deployment runs in production mode.');
  const dep = await loadDeployment(admin);
  if (!dep) throw new ApiError(409, 'chain_not_configured', 'On-chain settlement is not configured, so there is nothing to reconcile.');
  if (!dep.funds[ticker]) throw new ApiError(404, 'not_found', `${ticker} has no on-chain token suite.`);
  const [inv] = await admin`select chain_wallet, chain_onboarded_at from investors where workspace_id = ${ws} and id = ${investorId}`;
  if (!inv) throw new ApiError(404, 'not_found', `No investor ${investorId}.`);
  if (!inv.chain_onboarded_at || !inv.chain_wallet) throw new ApiError(409, 'not_onboarded', `${investorId} is not on-chain yet. Settle a trade for this investor first, then simulate a break.`);
  const jobId = await insertJob(admin, ws, 'break_demo', investorId, { investor_id: investorId, ticker, wallet: inv.chain_wallet, units });
  const job = await processChainJob(admin, env, jobId, { left: 30 });
  return { job, tx_url: txUrl(dep, job?.tx_hashes?.[0]) };
}

// ---------- Job retry and cancellation ----------
/** Puts a failed (or stuck queued) job back on the queue and runs it now. Settlement jobs whose settlement already reverted are retried from the settlement instead. */
export async function retryChainJob(admin: Sql, env: Env, ws: string, jobId: string, actor: Actor): Promise<JobRow> {
  const [job] = (await admin`select * from chain_jobs where id = ${jobId} and workspace_id = ${ws}`) as JobRow[];
  if (!job) throw new ApiError(404, 'not_found', `No chain job ${jobId} in this organization.`);
  if (job.status === 'running') throw new ApiError(409, 'running', 'This job is running right now. Wait for it to finish.');
  if (job.status === 'confirmed') throw new ApiError(409, 'confirmed', 'This job already confirmed on chain. There is nothing to retry.');
  if (job.status === 'cancelled') throw new ApiError(409, 'cancelled', 'This job was cancelled. Request a new decision to settle again.');
  if (job.kind === 'settle') {
    const [stl] = await admin`select status from settlements where workspace_id = ${ws} and id = ${job.ref}`;
    if (stl && stl.status !== 'pending') throw new ApiError(409, 'settlement_not_pending', `The settlement is ${stl.status}. Retry it from the settlement page (POST /v1/settlements/${job.ref}/retry), which re-checks the decision first.`);
  }
  await admin.transaction([
    admin`update chain_jobs set status = 'queued', attempts = 0, error = null, retries = retries + 1, retried_at = now(), retried_by = ${actor.name}, updated_at = now() where id = ${job.id}`,
    auditQ(admin, ws, actor, 'chain_job.retried', job.id, { kind: job.kind, ref: job.ref, previous_error: job.error }),
  ]);
  const after = await processChainJob(admin, env, job.id, { left: 30 });
  return after ?? job;
}

/** Cancels a job that has not sent anything on chain. Returns the job, or throws when a transaction already went out. */
export async function cancelChainJob(admin: Sql, ws: string, jobId: string, actor: Actor, reason: string): Promise<JobRow> {
  const rows = (await admin`update chain_jobs set status = 'cancelled', error = ${reason}, cancelled_at = now(), cancelled_by = ${actor.name}, updated_at = now()
    where id = ${jobId} and workspace_id = ${ws} and status in ('queued', 'failed') and cardinality(tx_hashes) = 0 returning *`) as JobRow[];
  if (!rows.length) {
    const [job] = (await admin`select * from chain_jobs where id = ${jobId} and workspace_id = ${ws}`) as JobRow[];
    if (!job) throw new ApiError(404, 'not_found', `No chain job ${jobId} in this organization.`);
    if (job.tx_hashes?.length) throw new ApiError(409, 'already_sent', 'A transaction for this job is already on chain, so it cannot be cancelled. Wait for the receipt.');
    throw new ApiError(409, 'not_cancellable', `This job is ${job.status} and cannot be cancelled.`);
  }
  await auditQ(admin, ws, actor, 'chain_job.cancelled', jobId, { kind: rows[0].kind, ref: rows[0].ref, reason });
  return rows[0];
}

// ---------- Reconciliation ----------
/** Compares on-chain token balances of a workspace's onboarded investors with the register, and opens a work item per break. */
export async function runRecon(admin: Sql, ws: string, trigger: string, env?: Env, actor: Actor | null = null) {
  const dep = await loadDeployment(admin);
  if (!dep) throw new ApiError(409, 'chain_not_configured', 'On-chain settlement is not configured, so there is nothing to reconcile.');
  const ch = chainFor(env ?? ({} as Env), dep);
  const [invs, hold] = await admin.transaction([
    admin`select id, name, chain_wallet from investors where workspace_id = ${ws} and chain_onboarded_at is not null and chain_wallet is not null order by id`,
    admin`select investor_id, ticker, units::float8 as units from holdings where workspace_id = ${ws}`,
  ]);
  const [run] = await admin`insert into recon_runs (workspace_id, trigger) values (${ws}, ${trigger}) returning id, started_at`;
  const tickers = Object.keys(dep.funds);
  const calls: Call[] = [mcBlock(ch)];
  for (const i of invs) for (const t of tickers) {
    calls.push({ target: dep.funds[t].identityRegistry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'contains', args: [i.chain_wallet] }) });
    calls.push({ target: dep.funds[t].token, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'balanceOf', args: [i.chain_wallet] }) });
  }
  const res = invs.length ? await multicall(ch, calls) : [];
  const block = invs.length ? Number(dec<bigint>(MULTICALL_ABI, 'getBlockNumber', res[0], 0n)) : null;
  const positions: { investor_id: string; name: string; ticker: string; register: number; chain: number; on_chain: boolean }[] = [];
  invs.forEach((i: any, ii: number) => tickers.forEach((t, ti) => {
    const k = 1 + (ii * tickers.length + ti) * 2;
    const onChain = dec<boolean>(REGISTRY_ABI, 'contains', res[k], false);
    const chainUnits = fromUnits(dec<bigint>(TOKEN_ABI, 'balanceOf', res[k + 1], 0n));
    const register = Number(hold.find((h: any) => h.investor_id === i.id && h.ticker === t)?.units ?? 0);
    if (!onChain && chainUnits === 0 && register === 0) return;
    positions.push({ investor_id: i.id, name: i.name, ticker: t, register, chain: chainUnits, on_chain: onChain || chainUnits > 0 });
  }));
  const compared = positions.filter((x) => x.on_chain);
  const breaks = compared.filter((x) => Math.abs(x.chain - x.register) >= 0.005);
  const matched = compared.filter((x) => Math.abs(x.chain - x.register) < 0.005);
  const open = await admin`select id, investor_id, ticker from recon_breaks where workspace_id = ${ws} and status = 'open'`;
  const q: any[] = [];
  for (const b of breaks) {
    const existing = open.find((o: any) => o.investor_id === b.investor_id && o.ticker === b.ticker);
    const diff = +(b.chain - b.register).toFixed(2);
    const detail = `${b.name}: the ${b.ticker} token balance on ${networkLabel(dep)} is ${b.chain.toLocaleString('en-US')} units, the register shows ${b.register.toLocaleString('en-US')} (difference ${diff > 0 ? '+' : ''}${diff.toLocaleString('en-US')}). Investigate, then adjust the register or record the finding.`;
    if (existing) q.push(admin`update recon_breaks set run_id = ${run.id}, register_units = ${b.register}, chain_units = ${b.chain} where workspace_id = ${ws} and id = ${existing.id}`);
    else q.push(admin`insert into recon_breaks (workspace_id, id, run_id, investor_id, ticker, register_units, chain_units) values (${ws}, ${newId('brk', 12)}, ${run.id}, ${b.investor_id}, ${b.ticker}, ${b.register}, ${b.chain})`);
    q.push(admin`insert into work_items (workspace_id, id, kind, dedupe_key, title, detail, severity, investor_id, ticker, link)
      values (${ws}, ${newId('wi', 12)}, 'recon_break', ${`recon:${b.investor_id}:${b.ticker}`}, ${`Reconciliation break: ${b.name}, ${b.ticker}`}, ${detail}, 'high', ${b.investor_id}, ${b.ticker}, '#/reconciliation')
      on conflict (workspace_id, dedupe_key) where status = 'open' do update set detail = excluded.detail`);
  }
  // Positions that match again close their open breaks.
  for (const m of matched) {
    if (!open.some((o: any) => o.investor_id === m.investor_id && o.ticker === m.ticker)) continue;
    q.push(admin`update recon_breaks set status = 'resolved', resolution = 'cleared', note = 'Balances matched on a later run.', resolved_by = 'Laissez', resolved_at = now() where workspace_id = ${ws} and status = 'open' and investor_id = ${m.investor_id} and ticker = ${m.ticker}`);
    q.push(admin`update work_items set status = 'done', resolved_at = now(), resolved_by = 'Laissez' where workspace_id = ${ws} and status = 'open' and dedupe_key = ${`recon:${m.investor_id}:${m.ticker}`}`);
  }
  q.push(admin`update recon_runs set finished_at = now(), positions = ${compared.length}, breaks = ${breaks.length}, chain_block = ${block} where id = ${run.id}`);
  q.push(auditQ(admin, ws, actor, 'recon.completed', String(run.id), { trigger, positions: compared.length, breaks: breaks.length, block, network: dep.network }));
  await admin.transaction(q);
  return {
    run: { id: Number(run.id), trigger, started_at: run.started_at, positions: compared.length, breaks: breaks.length, chain_block: block, network: dep.network },
    positions: positions.map((x) => ({ ...x, status: !x.on_chain ? 'off_chain' : Math.abs(x.chain - x.register) < 0.005 ? 'matched' : 'break' })),
  };
}

/** Resolves a break: 'adjust_register' sets the holding to the current chain balance; 'investigated' records a note only. */
export async function resolveBreak(admin: Sql, env: Env, ws: string, breakId: string, resolution: 'adjust_register' | 'investigated', note: string | null, actor: Actor) {
  const [b] = await admin`select * from recon_breaks where workspace_id = ${ws} and id = ${breakId}`;
  if (!b) throw new ApiError(404, 'not_found', `No reconciliation break ${breakId}.`);
  if (b.status !== 'open') throw new ApiError(409, 'already_resolved', `Break ${breakId} is already resolved (${b.resolution}).`);
  const q: any[] = [];
  let chainUnits: number | null = null;
  if (resolution === 'adjust_register') {
    const dep = await loadDeployment(admin);
    const fund = dep?.funds[b.ticker];
    if (!dep || !fund) throw new ApiError(409, 'chain_not_configured', `${b.ticker} has no on-chain token suite.`);
    const [inv] = await admin`select chain_wallet from investors where workspace_id = ${ws} and id = ${b.investor_id}`;
    const raw = await ethCall(chainFor(env, dep), fund.token, encodeFunctionData({ abi: TOKEN_ABI, functionName: 'balanceOf', args: [inv.chain_wallet] }));
    chainUnits = Math.round(fromUnits(decodeFunctionResult({ abi: TOKEN_ABI, functionName: 'balanceOf', data: raw }) as bigint) * 100) / 100;
    const [h] = await admin`select units::float8 as units from holdings where workspace_id = ${ws} and investor_id = ${b.investor_id} and ticker = ${b.ticker}`;
    const before = Number(h?.units ?? 0);
    if (chainUnits <= 0) {
      q.push(admin`delete from holdings where workspace_id = ${ws} and investor_id = ${b.investor_id} and ticker = ${b.ticker}`);
      if (h) q.push(admin`update funds set holders = greatest(0, holders - 1) where workspace_id = ${ws} and ticker = ${b.ticker}`);
    } else {
      q.push(admin`insert into holdings (workspace_id, investor_id, ticker, units, since) values (${ws}, ${b.investor_id}, ${b.ticker}, ${chainUnits}, ${today()}) on conflict (workspace_id, investor_id, ticker) do update set units = excluded.units`);
      if (!h) q.push(admin`update funds set holders = holders + 1 where workspace_id = ${ws} and ticker = ${b.ticker}`);
    }
    q.push(auditQ(admin, ws, actor, 'recon.register_adjusted', breakId, { investor: b.investor_id, ticker: b.ticker, from: before, to: chainUnits, note }));
  } else {
    q.push(auditQ(admin, ws, actor, 'recon.break_investigated', breakId, { investor: b.investor_id, ticker: b.ticker, note }));
  }
  q.push(admin`update recon_breaks set status = 'resolved', resolution = ${resolution}, note = ${note}, resolved_by = ${actor.name}, resolved_at = now() where workspace_id = ${ws} and id = ${breakId}`);
  q.push(admin`update work_items set status = 'done', resolved_at = now(), resolved_by = ${actor.name} where workspace_id = ${ws} and status = 'open' and dedupe_key = ${`recon:${b.investor_id}:${b.ticker}`}`);
  await admin.transaction(q);
  return { id: breakId, status: 'resolved', resolution, note, register_units: resolution === 'adjust_register' ? chainUnits : Number(b.register_units), chain_units: chainUnits ?? Number(b.chain_units) };
}

// ---------- Audit anchoring ----------
/** Leaf for one workspace's audit head: keccak256(abi.encodePacked(bytes16 workspaceId, uint64 seq, bytes32 headHash)). */
export const anchorLeaf = (workspaceId: string, seq: number | bigint, headHash: string): Hex =>
  keccak256(encodePacked(['bytes16', 'uint64', 'bytes32'], [`0x${workspaceId.replace(/-/g, '')}` as Hex, BigInt(seq), (headHash.startsWith('0x') ? headHash : `0x${headHash}`) as Hex]));
const hashPair = (a: Hex, b: Hex) => (hexToBigInt(a) < hexToBigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));
/** Merkle tree with sorted pairs; an odd node moves up unchanged. */
export function merkleTree(leaves: Hex[]): { root: Hex; proofs: Hex[][] } {
  if (!leaves.length) throw new Error('No leaves.');
  const levels: Hex[][] = [leaves.slice()];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1]; const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  const proofs = leaves.map((_, idx) => {
    const proof: Hex[] = []; let i = idx;
    for (let l = 0; l < levels.length - 1; l++) { const sib = i ^ 1; if (sib < levels[l].length) proof.push(levels[l][sib]); i >>= 1; }
    return proof;
  });
  return { root: levels[levels.length - 1][0], proofs };
}
/** Checks a leaf against a root with its proof (same rule as AuditAnchor.verify on-chain). */
export const verifyProof = (root: string, leaf: string, proof: string[]) => proof.reduce<Hex>((acc, p) => hashPair(acc, p as Hex), leaf as Hex).toLowerCase() === root.toLowerCase();
const dayNumber = (date: string) => BigInt(date.replace(/-/g, ''));

/** Anchors today's audit heads of every workspace in one Merkle root. Idempotent per UTC day. */
export async function anchorAudit(admin: Sql, env: Env) {
  const dep = await loadDeployment(admin);
  if (!dep) throw new Error('No chain deployment is recorded in chain_config.');
  const ch = chainFor(env, dep);
  const date = today();
  let [anchor] = await admin`select * from audit_anchors where anchor_date = ${date}`;
  if (anchor?.status === 'confirmed') return { ...anchor, explorer_url: txUrl(dep, anchor.tx_hash), already: true };
  if (!anchor) {
    const heads = await admin`select distinct on (e.workspace_id) e.workspace_id::text as ws_id, e.seq, e.hash from audit_events e where e.seq is not null and e.hash is not null order by e.workspace_id, e.seq desc`;
    if (!heads.length) throw new Error('No audit events to anchor.');
    const leaves = heads.map((h: any) => anchorLeaf(h.ws_id, h.seq, h.hash));
    const { root, proofs } = merkleTree(leaves);
    const rows = heads.map((h: any, i: number) => ({ w: h.ws_id, s: Number(h.seq), h: h.hash, l: leaves[i], p: proofs[i] }));
    const [a] = await admin`insert into audit_anchors (anchor_date, merkle_root, leaves, status) values (${date}, ${root}, ${leaves.length}, 'pending') on conflict (anchor_date) do nothing returning *`;
    if (!a) return anchorAudit(admin, env);
    await admin`insert into audit_anchor_leaves (anchor_id, workspace_id, seq, head_hash, leaf, proof)
      select ${a.id}, (x->>'w')::uuid, (x->>'s')::bigint, x->>'h', x->>'l', x->'p' from jsonb_array_elements(${JSON.stringify(rows)}::jsonb) x`;
    anchor = a;
  }
  const day = dayNumber(date);
  if (anchor.tx_hash) {
    const r = await getReceipt(ch, anchor.tx_hash);
    if (r?.status === 'success') {
      await admin`update audit_anchors set status = 'confirmed', block = ${r.blockNumber} where id = ${anchor.id}`;
      return { ...anchor, status: 'confirmed', block: r.blockNumber, explorer_url: txUrl(dep, anchor.tx_hash) };
    }
    if (!r) {
      const tx = await rpc(ch, 'eth_getTransactionByHash', [anchor.tx_hash]);
      if (tx) return { ...anchor, status: 'pending', explorer_url: txUrl(dep, anchor.tx_hash) };
    }
  }
  const onChain = decodeFunctionResult({ abi: ANCHOR_ABI, functionName: 'rootOf', data: await ethCall(ch, dep.contracts.auditAnchor, encodeFunctionData({ abi: ANCHOR_ABI, functionName: 'rootOf', args: [day] })) }) as Hex;
  if (BigInt(onChain) !== 0n) {
    const ok = onChain.toLowerCase() === String(anchor.merkle_root).toLowerCase();
    await admin`update audit_anchors set status = ${ok ? 'confirmed' : 'conflict'} where id = ${anchor.id}`;
    return { ...anchor, status: ok ? 'confirmed' : 'conflict' };
  }
  const { sent } = await sendAll(ch, admin, env, [{ to: dep.contracts.auditAnchor, label: 'anchor', gas: GAS.anchor, data: encodeFunctionData({ abi: ANCHOR_ABI, functionName: 'anchor', args: [anchor.merkle_root as Hex, day, Number(anchor.leaves)] }) }]);
  const hash = sent[0].hash;
  await admin`update audit_anchors set tx_hash = ${hash} where id = ${anchor.id}`;
  const r = await waitReceipt(ch, hash, 60_000);
  if (!r) return { ...anchor, tx_hash: hash, status: 'pending', explorer_url: txUrl(dep, hash) };
  if (r.status !== 'success') {
    await admin`update audit_anchors set status = 'failed', block = ${r.blockNumber} where id = ${anchor.id}`;
    throw new Error(`The anchor transaction reverted: ${await replayReason(ch, sent[0], r.blockNumber)}`);
  }
  await admin`update audit_anchors set status = 'confirmed', block = ${r.blockNumber} where id = ${anchor.id}`;
  return { ...anchor, tx_hash: hash, block: r.blockNumber, status: 'confirmed', explorer_url: txUrl(dep, hash) };
}

// ---------- Read models for the routes ----------
export async function chainOverview(admin: Sql, env: Env) {
  rememberEnv(env);
  const dep = await loadDeployment(admin);
  const enabled = !!env.CHAIN_OPERATOR_KEY && !!dep;
  if (!dep) return { enabled: false, configured: { operator_key: !!env.CHAIN_OPERATOR_KEY, deployment: false }, message: 'No contracts are deployed yet. Settlements run on the simulated register until they are.' };
  let balance: number | null = null;
  try { balance = Number(BigInt(await rpc<Hex>(chainFor(env, dep), 'eth_getBalance', [dep.operator, 'latest']))) / 1e18; } catch { balance = null; }
  const c = dep.contracts;
  const contracts = [
    { key: 'claimIssuer', name: 'Laissez claim issuer (ONCHAINID)', address: c.claimIssuer, role: `Trusted issuer for claim topic ${dep.claimTopic}. Signs eligibility claims onto investor identities.` },
    { key: 'idFactory', name: 'Identity factory (ONCHAINID)', address: c.idFactory, role: 'Creates one identity contract per investor, owned by the onboarder.' },
    { key: 'onboarder', name: 'LaissezOnboarder', address: c.onboarder, role: 'Creates the identity, adds the claim, registers it and mints opening balances in one transaction.' },
    { key: 'dvp', name: 'LaissezDvP', address: c.dvp, role: 'Settles subscribe, transfer and redeem atomically against test cash.' },
    { key: 'countryAllowModule', name: 'CountryAllowModule (T-REX)', address: c.countryAllowModule, role: 'Blocks transfers to countries outside each fund distribution list.' },
    ...(c.claimExpiryModule ? [{ key: 'claimExpiryModule', name: 'ClaimExpiryModule', address: c.claimExpiryModule, role: `Blocks transfers and mints to a wallet whose claim ${dep.claimTopic} has expired. Redemptions still pass.` }] : []),
    { key: 'auditAnchor', name: 'AuditAnchor', address: c.auditAnchor, role: 'Holds one Merkle root per day over the audit log head of every organization.' },
    ...Object.entries(c.cash).map(([ccy, address]) => ({ key: `cash.${ccy}`, name: `LaissezCash t${ccy}`, address, role: 'Test cash with no value, used for the payment leg.' })),
  ].map((x) => ({ ...x, url: addressUrl(dep, x.address) }));
  return {
    enabled, network: dep.network, network_label: networkLabel(dep), chain_id: dep.chainId, explorer: dep.explorer, deployed_at: dep.deployedAt, blocks: dep.blocks,
    operator: { address: dep.operator, balance_eth: balance, url: addressUrl(dep, dep.operator), funded: balance !== null && balance > 0, low: balance !== null && balance < LOW_BALANCE_ETH, low_threshold_eth: LOW_BALANCE_ETH },
    claim_signer: dep.claimSigner, claim_topic: dep.claimTopic, contracts,
    funds: Object.entries(dep.funds).map(([ticker, f]) => ({
      ticker, name: f.name, currency: f.currency, token: f.token, token_url: addressUrl(dep, f.token), identity_registry: f.identityRegistry,
      compliance: f.compliance, treasury: f.treasury, cash: f.cash, countries: f.countries, jurisdictions: f.jurisdictions,
    })),
  };
}

export async function investorChainView(admin: Sql, env: Env, ws: string, investorId: string) {
  const [inv] = await admin`select id, name, residence, chain_wallet, chain_identity, chain_onboarded_at from investors where workspace_id = ${ws} and id = ${investorId}`;
  if (!inv) throw new ApiError(404, 'not_found', `No investor ${investorId}.`);
  const dep = await loadDeployment(admin);
  if (!dep) return { investor_id: inv.id, enabled: false, wallet: inv.chain_wallet, identity: inv.chain_identity, onboarded_at: inv.chain_onboarded_at, funds: [], cash: [] };
  const wallet: Address | null = inv.chain_wallet ?? (env.CHAIN_CUSTODY_SEED ? investorWallet(env, ws, investorId) : null);
  const hold = await admin`select ticker, units::float8 as units from holdings where workspace_id = ${ws} and investor_id = ${investorId}`;
  const tickers = Object.keys(dep.funds);
  const ccys = Object.keys(dep.contracts.cash);
  let res: { success: boolean; returnData: Hex }[] = [];
  const ch = chainFor(env, dep);
  if (wallet) {
    const calls: Call[] = [mcBlock(ch)];
    for (const t of tickers) {
      const f = dep.funds[t];
      calls.push({ target: f.identityRegistry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'contains', args: [wallet] }) });
      calls.push({ target: f.identityRegistry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'isVerified', args: [wallet] }) });
      calls.push({ target: f.identityRegistry, data: encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'investorCountry', args: [wallet] }) });
      calls.push({ target: f.token, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'balanceOf', args: [wallet] }) });
    }
    for (const ccy of ccys) calls.push({ target: dep.contracts.cash[ccy], data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'balanceOf', args: [wallet] }) });
    res = await multicall(ch, calls);
  }
  const funds = tickers.map((t, i) => {
    const k = 1 + i * 4;
    const chainUnits = fromUnits(dec<bigint>(TOKEN_ABI, 'balanceOf', res[k + 3], 0n));
    const register = Number(hold.find((h: any) => h.ticker === t)?.units ?? 0);
    const registered = dec<boolean>(REGISTRY_ABI, 'contains', res[k], false);
    return {
      ticker: t, token: dep.funds[t].token, token_url: addressUrl(dep, dep.funds[t].token), registered, verified: dec<boolean>(REGISTRY_ABI, 'isVerified', res[k + 1], false),
      country: dec<number>(REGISTRY_ABI, 'investorCountry', res[k + 2], 0), chain_units: chainUnits, register_units: register,
      matches: !registered ? null : Math.abs(chainUnits - register) < 0.005,
    };
  });
  const cashStart = 1 + tickers.length * 4;
  return {
    investor_id: inv.id, name: inv.name, enabled: !!env.CHAIN_OPERATOR_KEY, network: dep.network, network_label: networkLabel(dep),
    wallet, wallet_url: addressUrl(dep, wallet), identity: inv.chain_identity, identity_url: addressUrl(dep, inv.chain_identity), onboarded_at: inv.chain_onboarded_at,
    expected_country: countryOf(inv.residence), block: res.length ? Number(dec<bigint>(MULTICALL_ABI, 'getBlockNumber', res[0], 0n)) : null,
    funds, cash: ccys.map((ccy, i) => ({ currency: ccy, symbol: `t${ccy}`, address: dep.contracts.cash[ccy], balance: fromUnits(dec<bigint>(TOKEN_ABI, 'balanceOf', res[cashStart + i], 0n)) })),
  };
}
