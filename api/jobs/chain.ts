// Chain jobs for Laissez. Run from api/ with: npx tsx jobs/chain.ts <process|recon|anchor> [limit]
//   process  retries queued and stalled chain jobs (settlements, claim revocations, policy syncs) until none are left
//   recon    reconciles on-chain token balances against the register for every workspace with onboarded investors
//   anchor   anchors today's audit log heads of every workspace in one Merkle root (idempotent per UTC day)
// Needs DATABASE_URL (owner role) and CHAIN_RPC_URL, CHAIN_OPERATOR_KEY, CHAIN_CLAIM_KEY, CHAIN_CUSTODY_SEED,
// from the environment or api/.dev.vars.
import { db, log } from './lib';
import { processPendingChainJobs, runRecon, anchorAudit, loadDeployment } from '../src/chain';
import type { Env } from '../src/util';

const admin = db();
const env = {
  DATABASE_URL: process.env.DATABASE_URL,
  CHAIN_RPC_URL: process.env.CHAIN_RPC_URL,
  CHAIN_OPERATOR_KEY: process.env.CHAIN_OPERATOR_KEY,
  CHAIN_CLAIM_KEY: process.env.CHAIN_CLAIM_KEY,
  CHAIN_CUSTODY_SEED: process.env.CHAIN_CUSTODY_SEED,
} as Env;

async function main(cmd: string | undefined, arg: string | undefined) {
  const dep = await loadDeployment(admin, true);
  if (!dep) { log('No chain deployment is recorded in chain_config. Run api/chain/deploy.mjs first.'); return 2; }
  if (cmd === 'process') {
    if (!env.CHAIN_OPERATOR_KEY) { log('CHAIN_OPERATOR_KEY is not set.'); return 2; }
    const limit = Number(arg) || 25;
    for (let round = 1; round <= 10; round++) {
      const [{ n }] = await admin`select count(*)::int as n from chain_jobs where status = 'queued' or (status = 'running' and updated_at < now() - interval '90 seconds')`;
      if (!n) { log(round === 1 ? 'No chain jobs waiting.' : 'All chain jobs processed.'); break; }
      log(`Round ${round}: ${n} job(s) waiting.`);
      await processPendingChainJobs(env, limit, { admin });
      await new Promise((r) => setTimeout(r, 3000));
    }
    const rows = await admin`select status, count(*)::int as n from chain_jobs where updated_at > now() - interval '1 day' group by status order by status`;
    log(`Last 24 hours: ${rows.map((r: any) => `${r.n} ${r.status}`).join(', ') || 'no jobs'}.`);
    return 0;
  }
  if (cmd === 'recon') {
    const wss = await admin`select distinct workspace_id::text as ws from investors where chain_onboarded_at is not null`;
    let breaks = 0;
    for (const { ws } of wss) {
      try {
        const r = await runRecon(admin, ws, 'scheduled', env);
        breaks += r.run.breaks;
        log(`${ws}: ${r.run.positions} positions, ${r.run.breaks} break(s) at block ${r.run.chain_block}.`);
      } catch (e: any) { log(`${ws}: reconciliation failed: ${e?.message ?? e}`); }
    }
    log(`Reconciled ${wss.length} workspace(s), ${breaks} break(s) in total.`);
    return 0;
  }
  if (cmd === 'anchor') {
    if (!env.CHAIN_OPERATOR_KEY) { log('CHAIN_OPERATOR_KEY is not set.'); return 2; }
    const a: any = await anchorAudit(admin, env);
    log(`Anchor for ${String(a.anchor_date).slice(0, 10)}: ${a.status}, root ${a.merkle_root}, ${a.leaves} leaves${a.explorer_url ? `, ${a.explorer_url}` : a.tx_hash ? `, tx ${a.tx_hash}` : ''}.`);
    return a.status === 'confirmed' || a.status === 'pending' ? 0 : 1;
  }
  log('Usage: npx tsx jobs/chain.ts <process|recon|anchor> [limit]');
  return 2;
}

main(process.argv[2], process.argv[3]).then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
