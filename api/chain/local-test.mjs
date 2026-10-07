// Proof that the Laissez contracts work: starts a local Hardhat node, deploys the full stack, onboards investors,
// settles subscribe, transfer and redeem, revokes a claim and shows the next transfer to that investor reverts
// on-chain, syncs a policy change, re-issues the claim, and anchors an audit root.
// Usage: node api/chain/local-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPublicClient, createWalletClient, http, keccak256, toBytes, encodeFunctionData, parseEventLogs, BaseError, ContractFunctionRevertedError } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { compile } from './compile.mjs';
import { deploy } from './deploy.mjs';
import { startNode, DEV_KEYS } from './localnode.mjs';
import { verifyAnchorRow } from './verify-anchor.mjs';
import { artifacts, investorWallet, identitySalt, predictIdentity, claimData, credentialHash, signClaim, claimId, anchorLeaf, merkle, verifyProof, units6, fromUnits6, ISO_NUMERIC } from './lib.mjs';

const results = [];
const step = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${e.shortMessage ?? e.message}`);
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const reason = (e) => {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r) return r.reason ?? r.data?.errorName ?? r.shortMessage;
    return e.shortMessage;
  }
  return e.message;
};

compile();
const A = artifacts();
const node = await startNode(8546);
try {
  const seed = '0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'laissez-chain-')), 'deployment.json');
  const operator = privateKeyToAccount(DEV_KEYS.operator);
  const chain = { id: 31337, name: 'hardhat', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [node.url] } } };
  const pub = createPublicClient({ chain, transport: http(node.url), pollingInterval: 50 });
  const wallet = createWalletClient({ account: operator, chain, transport: http(node.url) });
  const send = async (address, abi, functionName, args, gas) => {
    const hash = await wallet.writeContract({ address, abi, functionName, args, ...(gas ? { gas } : {}) });
    return pub.waitForTransactionReceipt({ hash, pollingInterval: 50 });
  };
  const ws = '6f1c2a9e-3b7d-4c11-9a2e-5d4b3c2a1f00';

  let d;
  await step('Deploy ONCHAINID, claim issuer, three ERC-3643 suites, cash, onboarder, DvP and anchor', async () => {
    d = await deploy({ rpcUrl: node.url, operatorKey: DEV_KEYS.operator, claimKey: DEV_KEYS.claim, custodySeed: seed, outFile, log: () => {} });
    return `${Object.keys(d.funds).join(', ')}; DvP ${d.contracts.dvp}`;
  });
  if (!d) throw new Error('Deployment failed, nothing else can run.');
  const tw = d.funds.TWLF;
  const usd = d.contracts.cash.USD;
  const C = d.contracts;

  await step('Fund wiring: topic 10101 required, Laissez issuer trusted, countries allowed, roles granted', async () => {
    const topics = await pub.readContract({ address: tw.claimTopicsRegistry, abi: A.ClaimTopicsRegistry.abi, functionName: 'getClaimTopics' });
    assert(topics.length === 1 && topics[0] === 10101n, 'claim topic 10101 not required');
    assert(await pub.readContract({ address: tw.trustedIssuersRegistry, abi: A.TrustedIssuersRegistry.abi, functionName: 'hasClaimTopic', args: [C.claimIssuer, 10101n] }), 'claim issuer not trusted for 10101');
    assert(await pub.readContract({ address: C.countryAllowModule, abi: A.CountryAllowModule.abi, functionName: 'isCountryAllowed', args: [tw.compliance, 702] }), 'SG not allowed');
    assert(!(await pub.readContract({ address: C.countryAllowModule, abi: A.CountryAllowModule.abi, functionName: 'isCountryAllowed', args: [tw.compliance, 840] })), 'US should not be allowed for TWLF');
    for (const a of [C.dvp, C.onboarder]) assert(await pub.readContract({ address: tw.token, abi: A.Token.abi, functionName: 'isAgent', args: [a] }), `${a} is not a token agent`);
    assert(await pub.readContract({ address: tw.identityRegistry, abi: A.IdentityRegistry.abi, functionName: 'isAgent', args: [C.onboarder] }), 'onboarder is not a registry agent');
    const owner = await pub.readContract({ address: C.idFactory, abi: A.IdFactory.abi, functionName: 'owner' });
    assert(owner.toLowerCase() === C.onboarder.toLowerCase(), 'IdFactory is not owned by the onboarder');
    return `countries ${tw.countries.join(', ')}`;
  });

  // Investors: Lumen (SG) holds 3,250,000 TWLF off-chain; Qamar (DIFC) holds none; Reyes (US) is outside TWLF distribution.
  const inv = {
    lumen: { lzid: 'LZ-LMN1-SG01-AAAA', country: ISO_NUMERIC.SG, opening: 3_250_000 },
    qamar: { lzid: 'LZ-QMR1-AE01-BBBB', country: ISO_NUMERIC['AE-DIFC'], opening: 0 },
    reyes: { lzid: 'LZ-RYS1-US01-CCCC', country: ISO_NUMERIC.US, opening: 0 },
    harlow: { lzid: 'LZ-HRL1-SG02-EEEE', country: ISO_NUMERIC.SG, opening: 0 },
    nova: { lzid: 'LZ-NVA1-SG03-FFFF', country: ISO_NUMERIC.SG, opening: 0 },
  };
  const expires = Math.floor(Date.parse('2027-03-14T00:00:00Z') / 1000);
  const onboard = async (id, opts = {}) => {
    const i = inv[id];
    i.wallet = investorWallet(seed, ws, id);
    i.identity = predictIdentity(C.idFactory, d.identityInitCodeHash, identitySalt(ws, id));
    i.data = claimData(credentialHash(opts.lzid ?? i.lzid), opts.expires ?? expires);
    i.sig = await signClaim(DEV_KEYS.claim, i.identity, i.data);
    return send(C.onboarder, A.LaissezOnboarder.abi, 'onboard', [i.wallet, identitySalt(ws, id), i.sig, i.data, [{ token: tw.token, country: i.country, openingUnits: units6(opts.opening ?? i.opening) }]], 2_500_000n);
  };
  const verified = (w) => pub.readContract({ address: tw.identityRegistry, abi: A.IdentityRegistry.abi, functionName: 'isVerified', args: [w] });
  const bal = async (w) => fromUnits6(await pub.readContract({ address: tw.token, abi: A.Token.abi, functionName: 'balanceOf', args: [w] }));
  const cashBal = async (w) => fromUnits6(await pub.readContract({ address: usd, abi: A.LaissezCash.abi, functionName: 'balanceOf', args: [w] }));
  const dh = (s) => keccak256(toBytes(`laissez:decision:${ws}:${s}`));

  await step('Onboard Lumen in one transaction: identity at the predicted CREATE2 address, claim, registration, opening balance', async () => {
    const r = await onboard('lumen');
    assert(r.status === 'success', 'onboarding reverted');
    const actual = await pub.readContract({ address: C.idFactory, abi: A.IdFactory.abi, functionName: 'getIdentity', args: [inv.lumen.wallet] });
    assert(actual === inv.lumen.identity, `identity ${actual} does not match prediction ${inv.lumen.identity}`);
    assert(await verified(inv.lumen.wallet), 'Lumen is not verified');
    assert((await bal(inv.lumen.wallet)) === 3_250_000, 'opening balance wrong');
    return `identity ${actual}, gas ${r.gasUsed}`;
  });

  await step('Onboard Qamar (DIFC) and Reyes (US) with no opening balance', async () => {
    const a = await onboard('qamar'); const b = await onboard('reyes');
    assert(a.status === 'success' && b.status === 'success', 'onboarding reverted');
    assert(await verified(inv.qamar.wallet) && await verified(inv.reyes.wallet), 'not verified');
    return `gas ${a.gasUsed}`;
  });

  await step('Onboarding again is idempotent: no duplicate identity and no second opening mint', async () => {
    const r = await onboard('lumen');
    assert(r.status === 'success', 'second onboarding reverted');
    assert((await bal(inv.lumen.wallet)) === 3_250_000, 'opening balance minted twice');
  });

  await step('Subscribe: Lumen pays 2,000,000 tUSD to the TWLF treasury and receives 2,000,000 units atomically', async () => {
    const r = await send(C.dvp, A.LaissezDvP.abi, 'subscribe', [tw.token, inv.lumen.wallet, units6(2_000_000), usd, units6(2_000_000), tw.treasury, dh('dec_sub')], 600_000n);
    assert(r.status === 'success', 'subscribe reverted');
    const ev = parseEventLogs({ abi: A.LaissezDvP.abi, logs: r.logs, eventName: 'Settled' })[0];
    assert(ev && ev.args.decisionHash === dh('dec_sub') && ev.args.action === 0, 'Settled event missing');
    assert((await bal(inv.lumen.wallet)) === 5_250_000, 'units not minted');
    assert((await cashBal(tw.treasury)) === 2_000_000, 'treasury not paid');
    const at = await pub.readContract({ address: C.dvp, abi: A.LaissezDvP.abi, functionName: 'settledAt', args: [dh('dec_sub')] });
    assert(at === r.blockNumber, 'settledAt not recorded');
    return `block ${r.blockNumber}, gas ${r.gasUsed}`;
  });

  await step('The same decision cannot settle twice', async () => {
    try {
      await pub.simulateContract({ account: operator, address: C.dvp, abi: A.LaissezDvP.abi, functionName: 'subscribe', args: [tw.token, inv.lumen.wallet, units6(1), usd, units6(1), tw.treasury, dh('dec_sub')] });
    } catch (e) { const why = reason(e); assert(/already settled/.test(why), why); return why; }
    throw new Error('second settlement did not revert');
  });

  await step('Transfer: Lumen delivers 500,000 units to Qamar against 500,000 tUSD', async () => {
    const r = await send(C.dvp, A.LaissezDvP.abi, 'transfer', [tw.token, inv.lumen.wallet, inv.qamar.wallet, units6(500_000), usd, units6(500_000), dh('dec_xfer')], 600_000n);
    assert(r.status === 'success', 'transfer reverted');
    assert((await bal(inv.lumen.wallet)) === 4_750_000 && (await bal(inv.qamar.wallet)) === 500_000, 'units did not move');
    assert((await cashBal(inv.lumen.wallet)) === 500_000, 'seller not paid');
    return `gas ${r.gasUsed}`;
  });

  await step('Redeem: Qamar burns 100,000 units and the treasury pays 100,000 tUSD', async () => {
    const r = await send(C.dvp, A.LaissezDvP.abi, 'redeem', [tw.token, inv.qamar.wallet, units6(100_000), usd, units6(100_000), tw.treasury, dh('dec_red')], 400_000n);
    assert(r.status === 'success', 'redeem reverted');
    assert((await bal(inv.qamar.wallet)) === 400_000, 'units not burned');
    assert((await cashBal(inv.qamar.wallet)) === 100_000, 'investor not paid');
    return `gas ${r.gasUsed}`;
  });

  await step('Claim expiry module is bound to every fund compliance', async () => {
    for (const [t, f] of Object.entries(d.funds)) {
      assert(await pub.readContract({ address: f.compliance, abi: A.ModularCompliance.abi, functionName: 'isModuleBound', args: [C.claimExpiryModule] }), `${t} compliance is not bound to the claim expiry module`);
    }
    const exp = await pub.readContract({ address: C.claimExpiryModule, abi: A.ClaimExpiryModule.abi, functionName: 'claimExpiry', args: [tw.token, inv.lumen.wallet] });
    assert(Number(exp) === expires, `Lumen's claim expiry on-chain is ${exp}, expected ${expires}`);
    return `Lumen's claim expires at ${new Date(Number(exp) * 1000).toISOString().slice(0, 10)}`;
  });

  await step('Expired claim: Harlow is verified by the registry, but the compliance module blocks units reaching the wallet', async () => {
    const past = Math.floor(Date.now() / 1000) - 86_400;
    const r = await onboard('harlow', { expires: past });
    assert(r.status === 'success', 'onboarding reverted');
    assert(await verified(inv.harlow.wallet), 'the registry should still verify a signed claim whose expiry it does not read');
    const ok = await pub.readContract({ address: tw.compliance, abi: A.ModularCompliance.abi, functionName: 'canTransfer', args: [inv.lumen.wallet, inv.harlow.wallet, units6(1_000)] });
    assert(ok === false, 'canTransfer should be false for an expired claim');
    let why = '';
    try {
      await pub.simulateContract({ account: operator, address: C.dvp, abi: A.LaissezDvP.abi, functionName: 'transfer', args: [tw.token, inv.lumen.wallet, inv.harlow.wallet, units6(1_000), usd, units6(1_000), dh('dec_expired')] });
    } catch (e) { why = reason(e); }
    assert(/fund compliance/.test(why), `expected a fund compliance revert, got: ${why || 'no revert'}`);
    let whySub = '';
    try {
      await pub.simulateContract({ account: operator, address: C.dvp, abi: A.LaissezDvP.abi, functionName: 'subscribe', args: [tw.token, inv.harlow.wallet, units6(1_000), usd, units6(1_000), tw.treasury, dh('dec_expired_sub')] });
    } catch (e) { whySub = reason(e); }
    assert(whySub.length > 0, 'a subscription to an expired claim should revert at mint');
    assert((await bal(inv.harlow.wallet)) === 0, 'units reached the expired wallet');
    return `transfer: ${why}; subscribe: ${whySub}`;
  });

  await step('A transfer to an expired claim reverts on-chain, and a renewed claim lets it settle', async () => {
    await pub.request({ method: 'evm_setAutomine', params: [false] });
    let r;
    try {
      const hash = await wallet.writeContract({ address: C.dvp, abi: A.LaissezDvP.abi, functionName: 'transfer', args: [tw.token, inv.lumen.wallet, inv.harlow.wallet, units6(1_000), usd, units6(1_000), dh('dec_expired2')], gas: 600_000n });
      await pub.request({ method: 'evm_mine', params: [] });
      r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    } finally { await pub.request({ method: 'evm_setAutomine', params: [true] }); }
    assert(r.status === 'reverted', `expected a reverted receipt, got ${r.status}`);
    assert((await bal(inv.harlow.wallet)) === 0, 'balances changed on a reverted transfer');
    // The renewed credential replaces the claim (same issuer and topic, so the same claim id) with a future expiry.
    const renew = await onboard('harlow', { lzid: 'LZ-HRL2-SG02-FFFF' });
    assert(renew.status === 'success', 'claim renewal reverted');
    const r2 = await send(C.dvp, A.LaissezDvP.abi, 'transfer', [tw.token, inv.lumen.wallet, inv.harlow.wallet, units6(1_000), usd, units6(1_000), dh('dec_renewed')], 600_000n);
    assert(r2.status === 'success', 'transfer after renewal reverted');
    assert((await bal(inv.harlow.wallet)) === 1_000, 'units did not move after renewal');
    return `reverted tx ${r.transactionHash.slice(0, 12)}..., then settled in block ${r2.blockNumber}`;
  });

  await step('Fund compliance blocks a transfer to a US investor (TWLF is not distributed in the US)', async () => {
    try {
      await pub.simulateContract({ account: operator, address: C.dvp, abi: A.LaissezDvP.abi, functionName: 'transfer', args: [tw.token, inv.lumen.wallet, inv.reyes.wallet, units6(1_000), usd, units6(1_000), dh('dec_us')] });
    } catch (e) { const why = reason(e); assert(/fund compliance/.test(why), why); return why; }
    throw new Error('transfer to the US investor did not revert');
  });

  await step('Revoke Qamar\'s Laissez claim on the claim issuer: Qamar is no longer verified', async () => {
    const r = await send(C.claimIssuer, A.ClaimIssuer.abi, 'revokeClaim', [claimId(C.claimIssuer), inv.qamar.identity], 200_000n);
    assert(r.status === 'success', 'revocation reverted');
    assert(!(await verified(inv.qamar.wallet)), 'still verified after revocation');
    return `gas ${r.gasUsed}`;
  });

  await step('A transfer to the revoked investor now reverts on-chain', async () => {
    // Hardhat rejects reverting transactions at submission when automining, so mine this one manually to get a real receipt.
    const lumenBefore = await bal(inv.lumen.wallet);
    await pub.request({ method: 'evm_setAutomine', params: [false] });
    let r;
    try {
      const hash = await wallet.writeContract({ address: C.dvp, abi: A.LaissezDvP.abi, functionName: 'transfer', args: [tw.token, inv.lumen.wallet, inv.qamar.wallet, units6(10_000), usd, units6(10_000), dh('dec_revoked')], gas: 600_000n });
      await pub.request({ method: 'evm_mine', params: [] });
      r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    } finally { await pub.request({ method: 'evm_setAutomine', params: [true] }); }
    assert(r.status === 'reverted', `expected a reverted receipt, got ${r.status}`);
    let why = '';
    try { await pub.simulateContract({ account: operator, address: C.dvp, abi: A.LaissezDvP.abi, functionName: 'transfer', args: [tw.token, inv.lumen.wallet, inv.qamar.wallet, units6(10_000), usd, units6(10_000), dh('dec_revoked')] }); } catch (e) { why = reason(e); }
    assert(/not verified/.test(why), `unexpected reason: ${why}`);
    assert((await bal(inv.qamar.wallet)) === 400_000 && (await bal(inv.lumen.wallet)) === lumenBefore, 'balances changed');
    return `tx ${r.transactionHash.slice(0, 12)}... status reverted: ${why || 'reverted'}`;
  });

  await step('Redemption is never blocked: the revoked investor can still redeem', async () => {
    const r = await send(C.dvp, A.LaissezDvP.abi, 'redeem', [tw.token, inv.qamar.wallet, units6(50_000), usd, units6(50_000), tw.treasury, dh('dec_red2')], 400_000n);
    assert(r.status === 'success', 'redeem reverted');
    assert((await bal(inv.qamar.wallet)) === 350_000, 'units not burned');
  });

  await step('Policy sync: allowing the US on TWLF lets the transfer to Reyes settle', async () => {
    const r1 = await send(tw.compliance, A.ModularCompliance.abi, 'callModuleFunction', [encodeFunctionData({ abi: A.CountryAllowModule.abi, functionName: 'batchAllowCountries', args: [[840]] }), C.countryAllowModule], 200_000n);
    assert(r1.status === 'success', 'policy sync reverted');
    const r = await send(C.dvp, A.LaissezDvP.abi, 'transfer', [tw.token, inv.lumen.wallet, inv.reyes.wallet, units6(1_000), usd, units6(1_000), dh('dec_us2')], 600_000n);
    assert(r.status === 'success', 'transfer reverted');
    assert((await bal(inv.reyes.wallet)) === 1_000, 'units did not move');
  });

  await step('Re-issued credential: a new claim makes Qamar verified again, with no opening re-mint', async () => {
    const r = await onboard('qamar', { lzid: 'LZ-QMR2-AE01-DDDD', opening: 999 });
    assert(r.status === 'success', 'claim refresh reverted');
    assert(await verified(inv.qamar.wallet), 'not verified after re-issue');
    assert((await bal(inv.qamar.wallet)) === 350_000, 'opening minted again');
  });

  let anchored;
  await step('Anchor an audit Merkle root and verify a proof on-chain', async () => {
    const heads = [
      ['6f1c2a9e-3b7d-4c11-9a2e-5d4b3c2a1f00', 41, 'a3'.repeat(32)],
      ['0b8e7d6c-5a4b-4c3d-8e2f-1a0b9c8d7e6f', 7, '5c'.repeat(32)],
      ['9d8c7b6a-5f4e-4d3c-9b2a-0f1e2d3c4b5a', 129, '0e'.repeat(32)],
    ];
    const leaves = heads.map(([w, s, h]) => anchorLeaf(w, s, h));
    const { root, proofs } = merkle(leaves);
    assert(leaves.every((l, i) => verifyProof(root, l, proofs[i])), 'off-chain proof failed');
    const r = await send(C.auditAnchor, A.AuditAnchor.abi, 'anchor', [root, 20261002n, leaves.length], 200_000n);
    assert(r.status === 'success', 'anchor reverted');
    const ev = parseEventLogs({ abi: A.AuditAnchor.abi, logs: r.logs, eventName: 'Anchored' })[0];
    assert(ev?.args.root === root, 'Anchored event missing');
    for (let i = 0; i < leaves.length; i++) assert(await pub.readContract({ address: C.auditAnchor, abi: A.AuditAnchor.abi, functionName: 'verify', args: [20261002n, leaves[i], proofs[i]] }), `leaf ${i} did not verify on-chain`);
    assert(!(await pub.readContract({ address: C.auditAnchor, abi: A.AuditAnchor.abi, functionName: 'verify', args: [20261002n, keccak256('0x01'), proofs[0]] })), 'forged leaf verified');
    anchored = { heads, leaves, proofs, root, tx: r.transactionHash, block: Number(r.blockNumber) };
    return `root ${root.slice(0, 14)}...`;
  });

  await step('RPC-only verifier: accepts every anchored head and rejects a tampered head, a wrong organization and an unanchored day', async () => {
    assert(anchored, 'no anchor to verify');
    const row = (i, over = {}) => ({ anchor_date: '2026-10-02', merkle_root: anchored.root, seq: anchored.heads[i][1], head_hash: anchored.heads[i][2], leaf: anchored.leaves[i], proof: anchored.proofs[i], tx_hash: anchored.tx, block: anchored.block, ...over });
    for (let i = 0; i < anchored.heads.length; i++) {
      const r = await verifyAnchorRow({ client: pub, contract: C.auditAnchor, workspaceId: anchored.heads[i][0], row: row(i) });
      assert(r.ok, `row ${i} failed: ${r.checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}`);
    }
    const tampered = await verifyAnchorRow({ client: pub, contract: C.auditAnchor, workspaceId: anchored.heads[0][0], row: row(0, { head_hash: 'b4'.repeat(32) }) });
    assert(!tampered.ok && tampered.checks.some((c) => !c.ok && /leaf recomputed/.test(c.name)), 'a tampered head hash was accepted');
    const wrongOrg = await verifyAnchorRow({ client: pub, contract: C.auditAnchor, workspaceId: anchored.heads[1][0], row: row(0) });
    assert(!wrongOrg.ok, 'another organization id was accepted');
    const wrongDay = await verifyAnchorRow({ client: pub, contract: C.auditAnchor, workspaceId: anchored.heads[0][0], row: row(0, { anchor_date: '2026-10-03' }) });
    assert(!wrongDay.ok && wrongDay.checks.some((c) => !c.ok && /same root/.test(c.name)), 'an unanchored day was accepted');
    return `${anchored.heads.length} accepted, 3 rejected`;
  });

  // An issuer that Laissez never deployed anything for: its own owner key, its own ERC-3643 registry, no Laissez API call.
  await step('Independent issuer registry: trusts the Laissez claim issuer itself and verifies an investor Laissez onboarded', async () => {
    const issuerB = privateKeyToAccount(generatePrivateKey());
    const fund = await wallet.sendTransaction({ to: issuerB.address, value: 10n ** 18n });
    await pub.waitForTransactionReceipt({ hash: fund, pollingInterval: 50 });
    const bw = createWalletClient({ account: issuerB, chain, transport: http(node.url) });
    const bDeploy = async (name) => { const h = await bw.deployContract({ abi: A[name].abi, bytecode: A[name].bytecode, args: [] }); return (await pub.waitForTransactionReceipt({ hash: h, pollingInterval: 50 })).contractAddress; };
    const bSend = async (address, name, functionName, args = []) => { const h = await bw.writeContract({ address, abi: A[name].abi, functionName, args }); const r = await pub.waitForTransactionReceipt({ hash: h, pollingInterval: 50 }); assert(r.status === 'success', `${name}.${functionName} reverted`); };
    const ctr = await bDeploy('ClaimTopicsRegistry'); const tir = await bDeploy('TrustedIssuersRegistry'); const irs = await bDeploy('IdentityRegistryStorage'); const ir = await bDeploy('IdentityRegistry');
    for (const [a, n] of [[ctr, 'ClaimTopicsRegistry'], [tir, 'TrustedIssuersRegistry'], [irs, 'IdentityRegistryStorage']]) await bSend(a, n, 'init');
    await bSend(ir, 'IdentityRegistry', 'init', [tir, ctr, irs]);
    await bSend(irs, 'IdentityRegistryStorage', 'bindIdentityRegistry', [ir]);
    await bSend(ir, 'IdentityRegistry', 'addAgent', [issuerB.address]);
    await bSend(ctr, 'ClaimTopicsRegistry', 'addClaimTopic', [10101n]);
    const isV = (w) => pub.readContract({ address: ir, abi: A.IdentityRegistry.abi, functionName: 'isVerified', args: [w] });
    const r = await onboard('nova'); assert(r.status === 'success', 'nova onboarding reverted');
    const n = inv.nova;
    assert(!(await isV(n.wallet)), 'verified before the issuer registered the identity or trusted Laissez');
    await bSend(ir, 'IdentityRegistry', 'registerIdentity', [n.wallet, n.identity, ISO_NUMERIC.SG]);
    assert(!(await isV(n.wallet)), 'verified although the issuer does not trust the Laissez claim issuer yet');
    await bSend(tir, 'TrustedIssuersRegistry', 'addTrustedIssuer', [C.claimIssuer, [10101n]]);
    assert(await isV(n.wallet), 'the independent registry did not accept the Laissez claim');
    assert(!(await isV(inv.reyes.wallet)), 'an investor that was never registered is verified');
    await bSend(tir, 'TrustedIssuersRegistry', 'removeTrustedIssuer', [C.claimIssuer]);
    assert(!(await isV(n.wallet)), 'still verified after the issuer stopped trusting Laissez');
    await bSend(tir, 'TrustedIssuersRegistry', 'addTrustedIssuer', [C.claimIssuer, [10101n]]);
    assert(await isV(n.wallet), 'not verified again after trust was restored');
    const rv = await send(C.claimIssuer, A.ClaimIssuer.abi, 'revokeClaim', [claimId(C.claimIssuer), n.identity], 200_000n);
    assert(rv.status === 'success', 'revocation reverted');
    assert(!(await isV(n.wallet)), 'a Laissez revocation did not reach the independent registry');
    return `registry ${ir}`;
  });

  await step('Operator-only: another account cannot settle', async () => {
    const stranger = privateKeyToAccount(DEV_KEYS.claim);
    try {
      await pub.simulateContract({ account: stranger, address: C.dvp, abi: A.LaissezDvP.abi, functionName: 'subscribe', args: [tw.token, inv.lumen.wallet, units6(1), usd, units6(1), tw.treasury, dh('dec_x')] });
    } catch (e) { const why = reason(e); assert(/not an operator/.test(why), why); return why; }
    throw new Error('stranger was allowed to settle');
  });
} finally {
  node.stop();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed.`);
process.exit(failed ? 1 : 0);
