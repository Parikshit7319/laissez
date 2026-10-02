// Shared Node helpers for the Laissez chain scripts: artifacts, fund suites, custody keys, claims and Merkle proofs.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, encodePacked, keccak256, toBytes, concat, getContractAddress, hexToBigInt, numberToHex } from 'viem';
import { privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const CLAIM_TOPIC = 10101n;
export const DECIMALS = 6;
export const BASE_SEPOLIA = { id: 84532, name: 'Base Sepolia', network: 'base-sepolia', rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org' };

/** ISO 3166-1 numeric codes for Laissez jurisdiction codes. */
export const ISO_NUMERIC = { SG: 702, HK: 344, CH: 756, DE: 276, 'AE-DIFC': 784, 'AE-ADGM': 784, AE: 784, US: 840, GB: 826, JP: 392, LU: 442, IE: 372, IR: 364, CU: 192, KP: 408 };

/** One ERC-3643 suite per fund. Countries are the fund's distribution jurisdictions in src/proto/data.ts. */
export const FUNDS = {
  TWLF: { name: 'Tidewell Treasury Liquidity Fund, Tokenized Class T', symbol: 'TWLF', currency: 'USD', jurisdictions: ['SG', 'HK', 'CH', 'DE', 'AE-DIFC'] },
  NMEL: { name: 'Northmere Euro Liquidity UCITS, Tokenized Class TK', symbol: 'NMEL', currency: 'EUR', jurisdictions: ['DE', 'CH', 'SG', 'HK'] },
  AGPC: { name: 'Ashgrove Private Credit Fund LP, Tokenized Interests', symbol: 'AGPC', currency: 'USD', jurisdictions: ['SG', 'HK', 'CH', 'DE', 'AE-DIFC', 'US'] },
};
export const CASH = {
  USD: { name: 'Laissez Test USD (test asset, no value)', symbol: 'tUSD' },
  EUR: { name: 'Laissez Test EUR (test asset, no value)', symbol: 'tEUR' },
};
export const countriesFor = (jurs) => [...new Set(jurs.map((j) => ISO_NUMERIC[j]).filter(Boolean))].sort((a, b) => a - b);

// ---------- Artifacts ----------
const TREX = {
  Token: 'contracts/token/Token.sol/Token.json',
  IdentityRegistry: 'contracts/registry/implementation/IdentityRegistry.sol/IdentityRegistry.json',
  IdentityRegistryStorage: 'contracts/registry/implementation/IdentityRegistryStorage.sol/IdentityRegistryStorage.json',
  ClaimTopicsRegistry: 'contracts/registry/implementation/ClaimTopicsRegistry.sol/ClaimTopicsRegistry.json',
  TrustedIssuersRegistry: 'contracts/registry/implementation/TrustedIssuersRegistry.sol/TrustedIssuersRegistry.json',
  ModularCompliance: 'contracts/compliance/modular/ModularCompliance.sol/ModularCompliance.json',
  CountryAllowModule: 'contracts/compliance/modular/modules/CountryAllowModule.sol/CountryAllowModule.json',
  ModuleProxy: 'contracts/compliance/modular/modules/ModuleProxy.sol/ModuleProxy.json',
};
const OID = {
  Identity: 'contracts/Identity.sol/Identity.json',
  ImplementationAuthority: 'contracts/proxy/ImplementationAuthority.sol/ImplementationAuthority.json',
  IdentityProxy: 'contracts/proxy/IdentityProxy.sol/IdentityProxy.json',
  IdFactory: 'contracts/factory/IdFactory.sol/IdFactory.json',
  ClaimIssuer: 'contracts/ClaimIssuer.sol/ClaimIssuer.json',
};
let cache = null;
export function artifacts() {
  if (cache) return cache;
  const out = {};
  const trexRoot = path.dirname(require.resolve('@tokenysolutions/t-rex/package.json'));
  const oidRoot = path.dirname(require.resolve('@onchain-id/solidity/package.json'));
  for (const [n, p] of Object.entries(TREX)) { const a = JSON.parse(fs.readFileSync(path.join(trexRoot, 'artifacts', p), 'utf8')); out[n] = { abi: a.abi, bytecode: a.bytecode }; }
  for (const [n, p] of Object.entries(OID)) { const a = JSON.parse(fs.readFileSync(path.join(oidRoot, 'artifacts', p), 'utf8')); out[n] = { abi: a.abi, bytecode: a.bytecode }; }
  const own = path.join(HERE, 'artifacts.json');
  if (!fs.existsSync(own)) throw new Error('api/chain/artifacts.json is missing. Run: node api/chain/compile.mjs');
  for (const [n, c] of Object.entries(JSON.parse(fs.readFileSync(own, 'utf8')).contracts)) out[n] = { abi: c.abi, bytecode: c.bytecode };
  cache = out;
  return out;
}

// ---------- Custody keys ----------
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const seedBytes = (seed) => (/^0x[0-9a-fA-F]+$/.test(seed) ? toBytes(seed) : toBytes(seed, { size: undefined }));
/** keccak256(seed || label), re-hashed until it is a valid secp256k1 private key. */
export function deriveKey(seed, label) {
  if (!seed) throw new Error('CHAIN_CUSTODY_SEED is not set.');
  let h = keccak256(concat([seedBytes(seed), toBytes(label)]));
  while (hexToBigInt(h) === 0n || hexToBigInt(h) >= N) h = keccak256(h);
  return h;
}
export const investorKey = (seed, ws, investorId) => deriveKey(seed, `investor:${ws}:${investorId}`);
export const treasuryKey = (seed, ticker) => deriveKey(seed, `treasury:${ticker}`);
export const investorWallet = (seed, ws, investorId) => privateKeyToAddress(investorKey(seed, ws, investorId));
export const treasuryWallet = (seed, ticker) => privateKeyToAddress(treasuryKey(seed, ticker));
export const identitySalt = (ws, investorId) => `laissez:${ws}:${investorId}`;

// ---------- Identities and claims ----------
export function identityInitCodeHash(identityImplementationAuthority, idFactory) {
  const proxy = artifacts().IdentityProxy.bytecode;
  return keccak256(concat([proxy, encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [identityImplementationAuthority, idFactory])]));
}
/** CREATE2 address of the identity IdFactory.createIdentityWithManagementKeys will deploy for this salt. */
export function predictIdentity(idFactory, initCodeHash, salt) {
  return getContractAddress({ opcode: 'CREATE2', from: idFactory, salt: keccak256(toBytes(`OID${salt}`)), bytecodeHash: initCodeHash });
}
export const claimData = (credentialHash, expiresAt) => encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint64' }], [credentialHash, BigInt(expiresAt)]);
export const credentialHash = (lzid) => keccak256(toBytes(lzid));
/** Matches ClaimIssuer.isClaimValid: EIP-191 signature over keccak256(abi.encode(identity, topic, data)). */
export async function signClaim(claimKey, identity, data, topic = CLAIM_TOPIC) {
  const hash = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }], [identity, topic, data]));
  return privateKeyToAccount(claimKey).signMessage({ message: { raw: hash } });
}
export const claimId = (issuer, topic = CLAIM_TOPIC) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [issuer, topic]));

// ---------- Merkle (sorted pairs, odd node promoted) ----------
export const anchorLeaf = (workspaceId, seq, headHash) =>
  keccak256(encodePacked(['bytes16', 'uint64', 'bytes32'], [('0x' + workspaceId.replace(/-/g, '')), BigInt(seq), (headHash.startsWith('0x') ? headHash : '0x' + headHash)]));
const pair = (a, b) => (hexToBigInt(a) < hexToBigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));
export function merkle(leaves) {
  if (!leaves.length) throw new Error('No leaves.');
  const levels = [leaves.slice()];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1]; const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? pair(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  const proofs = leaves.map((_, idx) => {
    const proof = []; let i = idx;
    for (let l = 0; l < levels.length - 1; l++) { const sib = i ^ 1; if (sib < levels[l].length) proof.push(levels[l][sib]); i >>= 1; }
    return proof;
  });
  return { root: levels[levels.length - 1][0], proofs };
}
export const verifyProof = (root, leaf, proof) => proof.reduce((acc, p) => pair(acc, p), leaf) === root;

export const units6 = (n) => BigInt(Math.round(Number(n) * 10 ** DECIMALS));
export const fromUnits6 = (b) => Number(b) / 10 ** DECIMALS;
export { numberToHex };
