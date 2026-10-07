// Checks a Laissez audit anchor against the chain without trusting the Laissez API.
//
//   node api/chain/verify-anchor.mjs <anchors.json> --workspace <organization id> --contract <AuditAnchor address> [--rpc <url>]
//
// <anchors.json> is the response of GET /v1/audit-anchors saved to a file ("-" reads standard input). For every anchor the
// script, using only an RPC node:
//   1. recomputes the leaf from your organization id, the audit sequence number and the head hash,
//   2. folds the proof into a root and compares it with the root in the file,
//   3. reads rootOf(day) from the AuditAnchor contract and compares it with that root,
//   4. calls AuditAnchor.verify(day, leaf, proof) on-chain,
//   5. when the file names the transaction, checks that it succeeded and sits in the block the file claims.
// Exit code 0 when every anchor passes, 1 when any fails, 2 on bad input.
//
// What this proves: the audit log head you hold existed by the anchored day, and the root was published by the contract.
// Check the head itself against your log with GET /v1/audit-events/verify, which recomputes every hash in order.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPublicClient, http, parseAbi, hexToBigInt, concat, keccak256 } from 'viem';
import { anchorLeaf } from './lib.mjs';

const ABI = parseAbi([
  'function rootOf(uint64 day) view returns (bytes32)',
  'function verify(uint64 day, bytes32 leaf, bytes32[] proof) view returns (bool)',
]);
const lower = (h) => String(h ?? '').toLowerCase();
const pair = (a, b) => (hexToBigInt(a) < hexToBigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));
export const foldProof = (leaf, proof) => proof.reduce((acc, p) => pair(acc, p), leaf);
export const dayNumber = (date) => BigInt(String(date).slice(0, 10).replace(/-/g, ''));

/** Verifies one row of GET /v1/audit-anchors. Returns { ok, checks: [{ name, ok, detail }] }. */
export async function verifyAnchorRow({ client, contract, workspaceId, row }) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
  const proof = row.proof ?? [];
  const day = dayNumber(row.anchor_date);

  let leaf;
  try { leaf = anchorLeaf(workspaceId, row.seq, row.head_hash); } catch (e) { add('leaf recomputed from organization, seq and head hash', false, e.shortMessage ?? e.message); return { ok: false, checks }; }
  add('leaf recomputed from organization, seq and head hash', lower(leaf) === lower(row.leaf), lower(leaf) === lower(row.leaf) ? '' : 'the leaf in the file does not match your organization id, seq and head hash');

  const root = foldProof(leaf, proof);
  add('proof folds to the root in the file', lower(root) === lower(row.merkle_root), lower(root) === lower(row.merkle_root) ? '' : `computed ${root}`);

  const onChain = await client.readContract({ address: contract, abi: ABI, functionName: 'rootOf', args: [day] });
  const none = /^0x0*$/.test(onChain);
  add('contract holds the same root for that day', !none && lower(onChain) === lower(row.merkle_root), none ? `nothing is anchored for ${row.anchor_date}` : lower(onChain) === lower(row.merkle_root) ? '' : `chain has ${onChain}`);

  const accepted = await client.readContract({ address: contract, abi: ABI, functionName: 'verify', args: [day, leaf, proof] });
  add('AuditAnchor.verify accepts leaf and proof', accepted === true);

  if (row.tx_hash) {
    const r = await client.getTransactionReceipt({ hash: row.tx_hash }).catch(() => null);
    add('anchor transaction succeeded', !!r && r.status === 'success', r ? '' : 'transaction not found on this chain');
    if (r && row.block != null) add('transaction is in the block the file names', Number(r.blockNumber) === Number(row.block), `chain says block ${r.blockNumber}`);
  }
  return { ok: checks.every((c) => c.ok), checks };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const file = a._[0];
  if (!file || !a.workspace || !a.contract) {
    console.error('Usage: node api/chain/verify-anchor.mjs <anchors.json | -> --workspace <organization id> --contract <AuditAnchor address> [--rpc <url>]');
    process.exit(2);
  }
  let body;
  try { body = JSON.parse(file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`Could not read ${file}: ${e.message}`); process.exit(2); }
  const rows = Array.isArray(body) ? body : body.data;
  if (!Array.isArray(rows)) { console.error('The file must be the response of GET /v1/audit-anchors, or a list of its rows.'); process.exit(2); }
  const rpc = a.rpc ?? process.env.CHAIN_RPC_URL ?? 'https://sepolia.base.org';
  const client = createPublicClient({ transport: http(rpc, { retryCount: 2, timeout: 20_000 }) });
  const contract = a.contract ?? body.contract;
  const chainId = await client.getChainId().catch((e) => { console.error(`Cannot reach ${rpc}: ${e.shortMessage ?? e.message}`); process.exit(2); });
  console.log(`Chain ${chainId}, contract ${contract}, ${rows.length} anchor(s).`);
  let failed = 0;
  for (const row of rows) {
    const r = await verifyAnchorRow({ client, contract, workspaceId: a.workspace, row });
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${String(row.anchor_date).slice(0, 10)}  seq ${row.seq}  root ${String(row.merkle_root).slice(0, 14)}...`);
    for (const c of r.checks.filter((x) => !x.ok)) console.log(`      ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
    if (!r.ok) failed++;
  }
  console.log(failed ? `\n${failed} anchor(s) failed.` : '\nEvery anchor verified against the chain.');
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
