// Chain routes: deployment and wallet views, chain jobs, reconciliation of token balances against the register,
// and audit anchors. Mounted under /v1 behind authentication.
import { z } from 'zod';
import { router, need, body } from '../http';
import { ApiError } from '../util';
import { loadDeployment, chainOverview, investorChainView, runRecon, resolveBreak, simulateBreak, txUrl, addressUrl, verifyProof } from '../chain';

export const routes = router();

routes.get('/chain', async (c) => {
  need(c, 'read');
  return c.json(await chainOverview(c.get('admin'), c.env));
});

routes.get('/chain/investors/:id', async (c) => {
  need(c, 'read');
  return c.json(await investorChainView(c.get('admin'), c.env, c.get('ws'), c.req.param('id')));
});

routes.get('/chain/jobs', async (c) => {
  need(c, 'read');
  const admin = c.get('admin');
  const [dep, rows] = await Promise.all([
    loadDeployment(admin),
    admin`select id, kind, ref, status, attempts, tx_hashes, block, error, created_at, updated_at, payload - 'sent' as payload from chain_jobs where workspace_id = ${c.get('ws')} order by created_at desc limit 50`,
  ]);
  return c.json({ data: rows.map((r: any) => ({ ...r, transactions: (r.tx_hashes ?? []).map((h: string) => ({ hash: h, url: txUrl(dep, h) })) })) });
});

routes.post('/reconciliation/run', async (c) => {
  const a = need(c, 'compliance:write');
  return c.json(await runRecon(c.get('admin'), c.get('ws'), 'manual', c.env, a), 201);
});

routes.get('/reconciliation', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  const [runs, breaks, dep] = await Promise.all([
    sql`select id, trigger, started_at, finished_at, positions, breaks, chain_block from recon_runs where workspace_id = ${ws} order by id desc limit 20`,
    sql`select b.id, b.run_id, b.investor_id, i.name as investor, b.ticker, b.register_units::float8 as register_units, b.chain_units::float8 as chain_units,
        (b.chain_units - b.register_units)::float8 as difference, b.status, b.resolution, b.note, b.resolved_by, b.resolved_at, b.created_at
      from recon_breaks b left join investors i on i.workspace_id = b.workspace_id and i.id = b.investor_id
      where b.workspace_id = ${ws} order by (b.status = 'open') desc, b.created_at desc limit 100`,
    loadDeployment(c.get('admin')),
  ]);
  return c.json({ enabled: !!dep && !!c.env.CHAIN_OPERATOR_KEY, sandbox: c.get('wsKind') === 'sandbox', network: dep?.network ?? null, runs, breaks });
});

routes.post('/reconciliation/breaks/:id/resolve', async (c) => {
  const a = need(c, 'compliance:write');
  const b = await body(c, z.object({ resolution: z.enum(['adjust_register', 'investigated']), note: z.string().trim().max(500).optional() }));
  return c.json(await resolveBreak(c.get('admin'), c.env, c.get('ws'), c.req.param('id'), b.resolution, b.note ?? null, a));
});

routes.post('/reconciliation/simulate-break', async (c) => {
  need(c, 'compliance:write');
  if (c.get('wsKind') !== 'sandbox') throw new ApiError(403, 'sandbox_only', 'Simulated breaks are only available in sandboxes. They mint real test units on-chain without touching the register.');
  const b = await body(c, z.object({ investor_id: z.string().min(1).max(80), ticker: z.string().min(2).max(12) }));
  const out = await simulateBreak(c.get('admin'), c.env, c.get('ws'), b.investor_id, b.ticker.toUpperCase());
  const job = out.job;
  return c.json({
    job_id: job?.id ?? null, status: job?.status ?? 'queued', error: job?.error ?? null, tx_url: out.tx_url,
    message: job?.status === 'confirmed'
      ? `The operator minted 1,000 ${b.ticker.toUpperCase()} units to ${b.investor_id} on-chain without updating the register. Run reconciliation to find the break.`
      : 'The mint is queued. Run reconciliation once it confirms.',
  }, 201);
});

routes.get('/audit-anchors', async (c) => {
  need(c, 'read');
  const [rows, dep] = await Promise.all([
    c.get('sql')`select a.id as anchor_id, a.anchor_date::text as anchor_date, a.merkle_root, a.leaves, a.tx_hash, a.block, a.status, l.seq, l.head_hash, l.leaf, l.proof
      from audit_anchor_leaves l join audit_anchors a on a.id = l.anchor_id where l.workspace_id = ${c.get('ws')} order by a.anchor_date desc limit 60`,
    loadDeployment(c.get('admin')),
  ]);
  return c.json({
    contract: dep?.contracts.auditAnchor ?? null, contract_url: addressUrl(dep, dep?.contracts.auditAnchor), network: dep?.network ?? null,
    how_to_verify: 'Hash the leaf with each proof element in sorted order (keccak256 of the smaller value followed by the larger). The result must equal the root, and AuditAnchor.verify(day, leaf, proof) returns true for the anchored day (YYYYMMDD).',
    data: rows.map((r: any) => ({ ...r, seq: Number(r.seq), explorer_url: txUrl(dep, r.tx_hash), proof_valid: verifyProof(r.merkle_root, r.leaf, r.proof ?? []) })),
  });
});
