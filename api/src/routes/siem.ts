// Audit log export: destinations (Splunk HEC, signed HTTPS, S3 Object Lock) and their deliveries. Mounted under /v1.
import { z } from 'zod';
import { router, need, needStepUp, body, audit, actorRef } from '../http';
import { ApiError } from '../util';
import { destinationIn, createDestination, deliver, runExports, KINDS } from '../siem';

export const routes = router();

const present = (d: any) => ({ id: d.id, kind: d.kind, name: d.name, config: d.config_public, enabled: d.enabled, last_seq: Number(d.last_seq), last_run_at: d.last_run_at, last_ok_at: d.last_ok_at, last_error: d.last_error, created_by: d.created_by, created_at: d.created_at });
const COLS = 'id, kind, name, config_public, enabled, last_seq, last_run_at, last_ok_at, last_error, created_by, created_at';

routes.get('/audit-export/destinations', async (c) => {
  need(c, 'audit:export');
  const rows = await c.get('sql').query(`select ${COLS} from siem_destinations where workspace_id = $1 order by created_at`, [c.get('ws')]);
  const [{ seq }] = await c.get('sql')`select coalesce(max(seq), 0)::bigint as seq from audit_events where workspace_id = ${c.get('ws')}`;
  return c.json({ data: rows.map(present), kinds: KINDS, latest_seq: Number(seq) });
});

routes.post('/audit-export/destinations', async (c) => {
  const a = need(c, 'members:admin');
  needStepUp(c, 'add an audit export destination');
  if (c.get('wsKind') === 'sandbox') throw new ApiError(403, 'sandbox_only', 'Audit export destinations are for organizations. A sandbox can download its audit log as CSV instead.');
  const d = await body(c, destinationIn);
  const id = await createDestination(c.env, c.get('admin'), c.get('ws'), actorRef(a), d);
  await audit(c.get('sql'), c.get('ws'), a, 'audit_export.destination_created', id, { kind: d.kind, name: d.name });
  const [row] = await c.get('admin').query(`select ${COLS} from siem_destinations where id = $1`, [id]);
  return c.json(present(row), 201);
});

routes.delete('/audit-export/destinations/:id', async (c) => {
  const a = need(c, 'members:admin');
  needStepUp(c, 'remove an audit export destination');
  const [row] = await c.get('admin')`delete from siem_destinations where id = ${c.req.param('id')} and workspace_id = ${c.get('ws')} returning id, name, kind`;
  if (!row) throw new ApiError(404, 'not_found', 'No destination with that id in this organization.');
  await audit(c.get('sql'), c.get('ws'), a, 'audit_export.destination_removed', row.id, { kind: row.kind, name: row.name });
  return c.json({ removed: true });
});

routes.patch('/audit-export/destinations/:id', async (c) => {
  const a = need(c, 'members:admin');
  const { enabled } = await body(c, z.object({ enabled: z.boolean() }));
  const [row] = await c.get('admin')`update siem_destinations set enabled = ${enabled} where id = ${c.req.param('id')} and workspace_id = ${c.get('ws')} returning id`;
  if (!row) throw new ApiError(404, 'not_found', 'No destination with that id in this organization.');
  await audit(c.get('sql'), c.get('ws'), a, enabled ? 'audit_export.destination_enabled' : 'audit_export.destination_disabled', row.id, {});
  return c.json({ id: row.id, enabled });
});

/** Sends one test event so the customer can see the shape arrive before anything real goes out. */
routes.post('/audit-export/destinations/:id/test', async (c) => {
  need(c, 'audit:export');
  const [d] = await c.get('admin')`select * from siem_destinations where id = ${c.req.param('id')} and workspace_id = ${c.get('ws')}`;
  if (!d) throw new ApiError(404, 'not_found', 'No destination with that id in this organization.');
  const r = await deliver(c.env, c.get('admin'), d, { test: true });
  return c.json({ ok: !r.error, detail: r.error ?? 'The test event was accepted.' });
});

/** Pushes everything since the last delivery now, instead of waiting for the schedule. With from_seq, re-sends from an earlier point (backfill). */
routes.post('/audit-export/destinations/:id/run', async (c) => {
  const a = need(c, 'audit:export');
  const { from_seq } = await body(c, z.object({ from_seq: z.number().int().min(0).optional() }));
  const [d] = await c.get('admin')`select * from siem_destinations where id = ${c.req.param('id')} and workspace_id = ${c.get('ws')}`;
  if (!d) throw new ApiError(404, 'not_found', 'No destination with that id in this organization.');
  const r = await deliver(c.env, c.get('admin'), d, from_seq !== undefined ? { fromSeq: from_seq } : {});
  if (from_seq !== undefined) await audit(c.get('sql'), c.get('ws'), a, 'audit_export.backfill', d.id, { from_seq, sent: r.sent });
  return c.json({ sent: r.sent, batches: r.batches, error: r.error ?? null });
});

routes.get('/audit-export/deliveries', async (c) => {
  need(c, 'audit:export');
  const dest = c.req.query('destination_id');
  const rows = dest
    ? await c.get('sql')`select d.*, s.name as destination from siem_deliveries d join siem_destinations s on s.id = d.destination_id where d.workspace_id = ${c.get('ws')} and d.destination_id = ${dest} order by d.sent_at desc limit 100`
    : await c.get('sql')`select d.*, s.name as destination from siem_deliveries d join siem_destinations s on s.id = d.destination_id where d.workspace_id = ${c.get('ws')} order by d.sent_at desc limit 100`;
  return c.json({ data: rows.map((r: any) => ({ id: Number(r.id), destination_id: r.destination_id, destination: r.destination, from_seq: Number(r.from_seq), to_seq: Number(r.to_seq), events: r.events, status: r.status, detail: r.detail, object_key: r.object_key, sent_at: r.sent_at })) });
});

export { runExports };
