// Deploys the Laissez ERC-3643 settlement stack and wires every role.
//
// Usage (Base Sepolia):
//   CHAIN_RPC_URL=https://sepolia.base.org CHAIN_OPERATOR_KEY=0x... CHAIN_CLAIM_KEY=0x... CHAIN_CUSTODY_SEED=0x... \
//   [DATABASE_URL=postgres://...] node api/chain/deploy.mjs
//
// Writes api/chain/deployment.json (override with CHAIN_DEPLOYMENT_FILE). Each confirmed step is recorded, so an
// interrupted run resumes where it stopped. With DATABASE_URL set, the result is upserted into chain_config
// (key 'deployment') and each fund row gets its token and treasury address; without it the SQL is printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, encodeFunctionData, keccak256, encodeAbiParameters, zeroAddress, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HERE, FUNDS, CASH, CLAIM_TOPIC, DECIMALS, BASE_SEPOLIA, artifacts, countriesFor, treasuryWallet, identityInitCodeHash } from './lib.mjs';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const NETWORKS = { 84532: { network: 'base-sepolia', explorer: BASE_SEPOLIA.explorer }, 31337: { network: 'hardhat-local', explorer: null } };

export async function deploy({ rpcUrl, operatorKey, claimKey, custodySeed, outFile = path.join(HERE, 'deployment.json'), log = console.log, autoFundTestCash = true }) {
  if (!rpcUrl || !operatorKey || !claimKey || !custodySeed) throw new Error('Set CHAIN_RPC_URL, CHAIN_OPERATOR_KEY, CHAIN_CLAIM_KEY and CHAIN_CUSTODY_SEED.');
  const A = artifacts();
  const operator = privateKeyToAccount(operatorKey);
  const claimSigner = privateKeyToAccount(claimKey).address;
  const transport = http(rpcUrl, { retryCount: 3, timeout: 30_000 });
  const pub = createPublicClient({ transport });
  const chainId = await pub.getChainId();
  const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
  const wallet = createWalletClient({ account: operator, chain, transport });
  const net = NETWORKS[chainId] ?? { network: `chain-${chainId}`, explorer: null };

  let state = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
  if (state && (state.chainId !== chainId || getAddress(state.operator) !== operator.address)) {
    throw new Error(`${outFile} belongs to chain ${state.chainId} and operator ${state.operator}. Move it aside to deploy fresh.`);
  }
  state ??= { chainId, network: net.network, explorer: net.explorer, operator: operator.address, claimSigner, steps: {} };
  const save = () => fs.writeFileSync(outFile, JSON.stringify(state, null, 2));
  const balance = await pub.getBalance({ address: operator.address });
  log(`Deploying to chain ${chainId} as ${operator.address} (balance ${Number(balance) / 1e18} ETH).`);
  if (balance === 0n) throw new Error(`Operator ${operator.address} has no ETH on chain ${chainId}. Fund it first.`);

  // Resume safety: a recorded contract must still have code (a restarted local node loses everything).
  for (const [name, s] of Object.entries(state.steps)) {
    if (!s.address) continue;
    const code = await pub.getCode({ address: s.address });
    if (!code || code.length <= 2) throw new Error(`Step ${name} recorded ${s.address} but there is no code there. Delete ${outFile} and deploy again.`);
  }

  const confirm = async (name, hash) => {
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: chainId === 31337 ? 50 : 1_000 });
    if (r.status !== 'success') throw new Error(`Step ${name} reverted in ${hash}.`);
    return r;
  };
  const deployStep = async (name, contract, args = []) => {
    if (state.steps[name]?.address) return state.steps[name].address;
    const hash = await wallet.deployContract({ abi: A[contract].abi, bytecode: A[contract].bytecode, args });
    const r = await confirm(name, hash);
    state.steps[name] = { address: r.contractAddress, tx: hash, block: Number(r.blockNumber), gas: Number(r.gasUsed) };
    save();
    log(`  ${name.padEnd(34)} ${r.contractAddress}`);
    return r.contractAddress;
  };
  const callStep = async (name, address, contract, functionName, args = []) => {
    if (state.steps[name]) return;
    const hash = await wallet.writeContract({ address, abi: A[contract].abi, functionName, args });
    const r = await confirm(name, hash);
    state.steps[name] = { tx: hash, block: Number(r.blockNumber), gas: Number(r.gasUsed) };
    save();
    log(`  ${name.padEnd(34)} ok`);
  };

  // ONCHAINID: identity implementation, authority, factory, and the Laissez claim issuer.
  const identityImpl = await deployStep('identityImplementation', 'Identity', [operator.address, true]);
  const identityIA = await deployStep('identityImplementationAuthority', 'ImplementationAuthority', [identityImpl]);
  const idFactory = await deployStep('idFactory', 'IdFactory', [identityIA]);
  const claimIssuer = await deployStep('claimIssuer', 'ClaimIssuer', [operator.address]);
  await callStep('claimIssuer.addClaimKey', claimIssuer, 'ClaimIssuer', 'addKey', [keccak256(encodeAbiParameters([{ type: 'address' }], [claimSigner])), 3n, 1n]);

  // Shared compliance module (one proxy; it keeps allowed countries per compliance contract).
  const camImpl = await deployStep('countryAllowModuleImplementation', 'CountryAllowModule');
  const cam = await deployStep('countryAllowModule', 'ModuleProxy', [camImpl, encodeFunctionData({ abi: A.CountryAllowModule.abi, functionName: 'initialize' })]);

  // Laissez contracts.
  const cash = {};
  for (const [ccy, c] of Object.entries(CASH)) cash[ccy] = await deployStep(`cash.${ccy}`, 'LaissezCash', [c.name, c.symbol, operator.address]);
  const onboarder = await deployStep('onboarder', 'LaissezOnboarder', [idFactory, claimIssuer, operator.address]);
  const dvp = await deployStep('dvp', 'LaissezDvP', [operator.address, autoFundTestCash]);
  const auditAnchor = await deployStep('auditAnchor', 'AuditAnchor', [operator.address]);
  // Canonical Multicall3 exists on Base Sepolia; a bare local node gets a minimal compatible one.
  const canonicalCode = await pub.getCode({ address: MULTICALL3 });
  const multicall3 = canonicalCode && canonicalCode.length > 2 ? MULTICALL3 : await deployStep('multicall3', 'Multicall3Lite');
  await callStep('idFactory.transferOwnership', idFactory, 'IdFactory', 'transferOwnership', [onboarder]);
  for (const ccy of Object.keys(CASH)) {
    await callStep(`cash.${ccy}.operator.dvp`, cash[ccy], 'LaissezCash', 'setOperator', [dvp, true]);
    if (autoFundTestCash) await callStep(`cash.${ccy}.minter.dvp`, cash[ccy], 'LaissezCash', 'setMinter', [dvp, true]);
  }

  // One ERC-3643 suite per fund.
  const funds = {};
  for (const [ticker, f] of Object.entries(FUNDS)) {
    const p = (s) => `${ticker}.${s}`;
    const ctr = await deployStep(p('claimTopicsRegistry'), 'ClaimTopicsRegistry');
    await callStep(p('claimTopicsRegistry.init'), ctr, 'ClaimTopicsRegistry', 'init');
    await callStep(p('claimTopicsRegistry.addTopic'), ctr, 'ClaimTopicsRegistry', 'addClaimTopic', [CLAIM_TOPIC]);
    const tir = await deployStep(p('trustedIssuersRegistry'), 'TrustedIssuersRegistry');
    await callStep(p('trustedIssuersRegistry.init'), tir, 'TrustedIssuersRegistry', 'init');
    await callStep(p('trustedIssuersRegistry.trustLaissez'), tir, 'TrustedIssuersRegistry', 'addTrustedIssuer', [claimIssuer, [CLAIM_TOPIC]]);
    const irs = await deployStep(p('identityRegistryStorage'), 'IdentityRegistryStorage');
    await callStep(p('identityRegistryStorage.init'), irs, 'IdentityRegistryStorage', 'init');
    const ir = await deployStep(p('identityRegistry'), 'IdentityRegistry');
    await callStep(p('identityRegistry.init'), ir, 'IdentityRegistry', 'init', [tir, ctr, irs]);
    await callStep(p('identityRegistryStorage.bind'), irs, 'IdentityRegistryStorage', 'bindIdentityRegistry', [ir]);
    const mc = await deployStep(p('compliance'), 'ModularCompliance');
    await callStep(p('compliance.init'), mc, 'ModularCompliance', 'init');
    const token = await deployStep(p('token'), 'Token');
    await callStep(p('token.init'), token, 'Token', 'init', [ir, mc, f.name, f.symbol, DECIMALS, zeroAddress]);
    await callStep(p('compliance.addCountryModule'), mc, 'ModularCompliance', 'addModule', [cam]);
    const countries = countriesFor(f.jurisdictions);
    await callStep(p('compliance.allowCountries'), mc, 'ModularCompliance', 'callModuleFunction', [encodeFunctionData({ abi: A.CountryAllowModule.abi, functionName: 'batchAllowCountries', args: [countries] }), cam]);
    for (const [who, addr] of [['operator', operator.address], ['onboarder', onboarder]]) await callStep(p(`identityRegistry.agent.${who}`), ir, 'IdentityRegistry', 'addAgent', [addr]);
    for (const [who, addr] of [['operator', operator.address], ['onboarder', onboarder], ['dvp', dvp]]) await callStep(p(`token.agent.${who}`), token, 'Token', 'addAgent', [addr]);
    await callStep(p('token.unpause'), token, 'Token', 'unpause');
    funds[ticker] = {
      name: f.name, symbol: f.symbol, decimals: DECIMALS, currency: f.currency, cash: cash[f.currency], treasury: treasuryWallet(custodySeed, ticker),
      token, identityRegistry: ir, identityRegistryStorage: irs, claimTopicsRegistry: ctr, trustedIssuersRegistry: tir, compliance: mc,
      jurisdictions: f.jurisdictions, countries, block: state.steps[p('token')].block,
    };
  }

  const blocks = Object.values(state.steps).map((s) => s.block);
  state.deployment = {
    network: net.network, chainId, explorer: net.explorer, operator: operator.address, claimSigner, claimTopic: Number(CLAIM_TOPIC),
    contracts: { identityImplementation: identityImpl, identityImplementationAuthority: identityIA, idFactory, claimIssuer, countryAllowModuleImplementation: camImpl, countryAllowModule: cam, onboarder, dvp, auditAnchor, multicall3, cash },
    identityInitCodeHash: identityInitCodeHash(identityIA, idFactory),
    autoFundTestCash,
    funds,
    blocks: { start: Math.min(...blocks), end: Math.max(...blocks) },
    deployedAt: state.deployment?.deployedAt ?? new Date().toISOString(),
  };
  save();
  const totalGas = Object.values(state.steps).reduce((n, s) => n + (s.gas ?? 0), 0);
  log(`Deployment complete. ${Object.keys(state.steps).length} transactions, ${totalGas.toLocaleString('en-US')} gas, recorded in ${path.relative(process.cwd(), outFile)}.`);
  return state.deployment;
}

/** SQL that records the deployment for the API. */
export function deploymentSql(d) {
  const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const lines = [`insert into chain_config (key, value, updated_at) values ('deployment', ${lit(JSON.stringify(d))}::jsonb, now()) on conflict (key) do update set value = excluded.value, updated_at = now();`];
  for (const [t, f] of Object.entries(d.funds)) lines.push(`update funds set chain_token = ${lit(f.token)}, treasury_wallet = ${lit(f.treasury)} where ticker = ${lit(t)};`);
  return lines;
}

export async function recordInDatabase(databaseUrl, d) {
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(databaseUrl);
  for (const s of deploymentSql(d)) await sql.query(s);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  try {
    const d = await deploy({ rpcUrl: env.CHAIN_RPC_URL ?? BASE_SEPOLIA.rpc, operatorKey: env.CHAIN_OPERATOR_KEY, claimKey: env.CHAIN_CLAIM_KEY, custodySeed: env.CHAIN_CUSTODY_SEED, outFile: env.CHAIN_DEPLOYMENT_FILE ? path.resolve(env.CHAIN_DEPLOYMENT_FILE) : undefined });
    if (env.DATABASE_URL) { await recordInDatabase(env.DATABASE_URL, d); console.log('Recorded in chain_config and funds.'); }
    else { console.log('\nDATABASE_URL is not set. Run this SQL against the owner connection:\n'); console.log(deploymentSql(d).join('\n')); }
  } catch (e) {
    console.error(e.shortMessage ?? e.message);
    process.exit(1);
  }
}
