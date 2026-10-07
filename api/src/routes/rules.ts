// The rule workbench: customer-authored rules stored as data, tested against the golden regression suite and the
// organization's own decisions, signed off by a second person (legal, compliance or an administrator), scheduled
// with effective dates and loaded into every evaluation once active. Packs stay engine code; these rules sit on top.
import { z } from 'zod';
import type { Sql } from '../db';
import { router, need, can, audit, auditQ, body, bg, SYSTEM, type C, type Actor, needStepUp } from '../http';
import { ApiError, id, today } from '../util';
import { notify, notifyRoles } from '../notifications';
import { evaluate, ctxFromSnapshot, type Ctx, type Snapshot, type Order, type Check } from '../../../src/proto/engine';
import { REGRESSION_CASES } from '../../../src/proto/rulepacks';
import { ctxFor } from './compliance2';
import { liveCtx } from './core';
import { loadGlobals } from '../ctx';
import {
  ruleDefinitionSchema, validateDefinition, describeRule, describeCondition, diffDefinitions, definitionFingerprint, templateById,
  FIELDS, OPERATORS, RULE_LAYERS, RULE_ACTIONS, RULE_RESULTS, RULE_SEVERITIES, RULE_STATUSES, STATUS_LABEL, RESULT_LABEL, RULE_TEMPLATES,
  type CustomRule, type RuleDefinition, type RuleStatus, type CustomCheck,
} from '../rules-dsl';

export const routes = router();

/** Roles told when a rule is sent for review. Approval itself is gated on the rules:approve permission. */
export const RULE_REVIEWER_ROLES = ['legal', 'compliance', 'admin'];
/** Bounded so one test stays within the Worker CPU budget. */
const BACKTEST_MAX = 120;
const BACKTEST_DAYS = 90;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ymd = z.string().regex(DATE, 'Use YYYY-MM-DD');

// ---------- Rows ----------
/** Postgres date columns arrive as strings over Neon HTTP and as local-midnight Dates from node-postgres. */
const dateStr = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
};
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

type Row = Record<string, any>;
export type RuleOut = CustomRule & {
  authored_by_user: string | null; reviewed_by_user: string | null; retired_by: string | null; retired_at: string | null;
  last_test: Record<string, unknown> | null; tested: boolean; created_at: string; updated_at: string; summary: string; problems: string[];
};
function definitionOf(r: Row): RuleDefinition {
  const d = r.definition ?? {};
  return { name: r.name, description: r.description ?? '', jurisdiction: r.jurisdiction ?? '*', applies_to: d.applies_to, condition: d.condition, outcome: d.outcome, severity: d.severity ?? 'medium' };
}
/** The engine's view of a row. */
export function ruleOf(r: Row): CustomRule {
  return {
    ...definitionOf(r), id: r.id, version: Number(r.version), status: r.status, effective_from: dateStr(r.effective_from), effective_to: dateStr(r.effective_to),
    authored_by: r.authored_by, reviewed_by: r.reviewed_by ?? null, approved_at: iso(r.approved_at), review_note: r.review_note ?? null, template: r.template ?? null,
  };
}
function out(r: Row): RuleOut {
  const rule = ruleOf(r);
  const def = definitionOf(r);
  const lt = r.last_test ?? null;
  return {
    ...rule, authored_by_user: r.authored_by_user ? String(r.authored_by_user) : null, reviewed_by_user: r.reviewed_by_user ? String(r.reviewed_by_user) : null, retired_by: r.retired_by ?? null, retired_at: iso(r.retired_at),
    last_test: lt, tested: !!lt && lt.fingerprint === definitionFingerprint(def), created_at: iso(r.created_at) ?? '', updated_at: iso(r.updated_at) ?? '',
    summary: describeRule(def), problems: validateDefinition(def),
  };
}
const defJson = (d: RuleDefinition) => JSON.stringify({ applies_to: d.applies_to, condition: d.condition, outcome: d.outcome, severity: d.severity });

/** Parses an author's definition. Shape problems are a 400 with every issue listed; semantic problems a 422. */
function parseBody(input: unknown): RuleDefinition {
  const res = ruleDefinitionSchema.safeParse(input);
  if (!res.success) {
    throw new ApiError(400, 'invalid_request', 'The rule is not valid. Fix the fields listed in detail and retry.', res.error.issues.map((i) => `${i.path.join('.') || 'rule'}: ${i.message}`));
  }
  const problems = validateDefinition(res.data);
  if (problems.length) throw new ApiError(422, 'invalid_rule', 'The rule does not make sense as written. Fix the problems listed in detail.', problems);
  return res.data;
}

/** Rules in force for evaluation: approved and active or scheduled, inside their effective window today. */
export async function loadActiveRules(sql: Sql, ws: string, date: string = today()): Promise<CustomRule[]> {
  const rows = await sql`select * from custom_rules where workspace_id = ${ws} and status in ('scheduled', 'active')
    and (effective_from is null or effective_from <= ${date}::date) and (effective_to is null or effective_to > ${date}::date) order by id, version`;
  return rows.map(ruleOf);
}

async function latest(sql: Sql, ws: string, ruleId: string): Promise<Row | null> {
  const [r] = await sql`select * from custom_rules where workspace_id = ${ws} and id = ${ruleId} order by version desc limit 1`;
  return r ?? null;
}
async function version(sql: Sql, ws: string, ruleId: string, v: number): Promise<Row | null> {
  const [r] = await sql`select * from custom_rules where workspace_id = ${ws} and id = ${ruleId} and version = ${v}`;
  return r ?? null;
}
const notFound = (ruleId: string) => new ApiError(404, 'not_found', `No rule ${ruleId} in this organization.`);

/**
 * Time moves rules along: a scheduled version becomes active on its effective date (retiring any older version of the
 * same rule), an active one retires when its end date arrives. Cheap, so the list and detail routes call it first.
 */
export async function sweepRuleStatuses(sql: Sql, ws: string) {
  const t = today();
  const activated = await sql`update custom_rules set status = 'active', updated_at = now() where workspace_id = ${ws} and status = 'scheduled' and effective_from <= ${t}::date returning id, version, name`;
  for (const a of activated) {
    await sql.transaction([
      sql`update custom_rules set status = 'retired', effective_to = least(coalesce(effective_to, ${t}::date), ${t}::date), retired_by = ${`Superseded by version ${a.version}`}, retired_at = now(), updated_at = now()
        where workspace_id = ${ws} and id = ${a.id} and version < ${a.version} and status in ('active', 'scheduled', 'approved')`,
      auditQ(sql, ws, SYSTEM, 'rule.activated', a.id, { version: a.version, name: a.name, effective_from: t }),
    ]);
  }
  const expired = await sql`update custom_rules set status = 'retired', retired_at = coalesce(retired_at, now()), retired_by = coalesce(retired_by, 'Effective end date reached'), updated_at = now()
    where workspace_id = ${ws} and status in ('active', 'scheduled') and effective_to is not null and effective_to <= ${t}::date returning id, version, name, effective_to::text as effective_to`;
  for (const e of expired) await audit(sql, ws, SYSTEM, 'rule.expired', e.id, { version: e.version, name: e.name, effective_to: e.effective_to });
}

const sameUser = (a: Actor, r: Row) => (r.authored_by_user && a.userId ? String(r.authored_by_user) === a.userId : String(r.authored_by).trim().toLowerCase() === a.name.trim().toLowerCase());

// ---------- Tests ----------
type RegressionChange = { id: string; name: string; pack: string; from: string; to: string; failing_before: string[]; failing_after: string[]; rule_result: string | null };
type Flip = { decision_id: string; created_at: string; investor: string; action: string; fund: string; amount: number; from: string; to: string; reason: string };
export type RuleTestResult = {
  ran_at: string; fingerprint: string; version: number;
  regression: { scope: string; cases: number; applied: number; fired: number; changed: RegressionChange[] };
  backtest: { window_days: number; decisions_checked: number; truncated: boolean; applied: number; fired: number; flips: Flip[] };
  try?: { order: Record<string, unknown>; outcome: string; headline: string; checks: Check[]; remedies: string[]; binding_rules: unknown[]; custom_check: CustomCheck | null };
};

const customOf = (d: { checks: Check[] }, ruleId: string): CustomCheck | null => (d.checks.find((c) => c.id === `custom:${ruleId}`) as CustomCheck | undefined) ?? null;
const failing = (d: { checks: Check[] }) => d.checks.filter((c) => c.result === 'fail').map((c) => c.id).sort();
const withRule = (ctx: Ctx, rule: CustomRule): Ctx => ({ ...ctx, customRules: [...(ctx.customRules ?? []).filter((r) => r.id !== rule.id), rule] });

/** The shipped golden cases for the rule's jurisdiction, each run without and with the rule. Lists every case whose outcome or failing checks change. */
function regressionWithRule(rule: CustomRule): RuleTestResult['regression'] {
  const jur = rule.jurisdiction.toUpperCase();
  const cases = jur === '*' ? REGRESSION_CASES : REGRESSION_CASES.filter((c) => c.pack === `${jur}/eligibility` || c.investor.residence.toUpperCase() === jur || c.counterparty?.residence.toUpperCase() === jur);
  let applied = 0; let fired = 0;
  const changed: RegressionChange[] = [];
  for (const cse of cases) {
    try {
      const { ctx } = ctxFor(cse);
      const order: Order = { ...cse.order, investorId: cse.investor.id, fundId: cse.fund, counterpartyId: cse.counterparty?.id };
      const before = evaluate(order, cse.whatIfs ?? [], ctx);
      const after = evaluate(order, cse.whatIfs ?? [], withRule(ctx, rule));
      const cc = customOf(after, rule.id);
      if (cc) applied++;
      if (cc?.custom.matched) fired++;
      const fb = failing(before); const fa = failing(after);
      if (before.outcome !== after.outcome || fb.join('|') !== fa.join('|')) {
        changed.push({ id: cse.id, name: cse.name, pack: cse.pack, from: before.outcome, to: after.outcome, failing_before: fb, failing_after: fa, rule_result: cc ? cc.result : null });
      }
    } catch (e: any) {
      changed.push({ id: cse.id, name: cse.name, pack: cse.pack, from: 'error', to: String(e?.message ?? e), failing_before: [], failing_after: [], rule_result: null });
    }
  }
  return { scope: jur === '*' ? 'every pack' : `${jur}/eligibility and cases touching ${jur}`, cases: cases.length, applied, fired, changed };
}

/** The organization's own decisions from the last 90 days, each re-run from its snapshot with the rule added. */
async function backtestWithRule(c: C, rule: CustomRule): Promise<RuleTestResult['backtest']> {
  const sql = c.get('sql'); const ws = c.get('ws');
  const funds = rule.applies_to.funds === '*' ? null : rule.applies_to.funds.map((f) => f.toUpperCase());
  const [g, rows] = await Promise.all([
    loadGlobals(sql),
    sql`select d.id, d.created_at, d.action, d.ticker, d.amount::float8 as amount, d.outcome, d.snapshot, i.name as investor from decisions d
      join investors i on i.workspace_id = d.workspace_id and i.id = d.investor_id
      where d.workspace_id = ${ws} and d.snapshot is not null and cardinality(d.what_ifs) = 0 and d.created_at > now() - make_interval(days => ${BACKTEST_DAYS})
        and (${funds}::text[] is null or upper(d.ticker) = any(${funds}::text[]))
      order by d.created_at desc limit ${BACKTEST_MAX + 1}`,
  ]);
  const checked = rows.slice(0, BACKTEST_MAX);
  let applied = 0; let fired = 0;
  const flips: Flip[] = [];
  for (const r of checked) {
    const snap = r.snapshot as Snapshot;
    const ctx = ctxFromSnapshot(snap);
    if (!ctx.funds[snap.order.fundId] || !ctx.investors[snap.order.investorId]) continue;
    ctx.classInfo = { ...g.classInfo, ...ctx.classInfo };
    ctx.jurName = { ...g.jurName, ...ctx.jurName };
    const d = evaluate(snap.order, snap.whatIfs ?? [], withRule(ctx, rule));
    const cc = customOf(d, rule.id);
    if (cc) applied++;
    if (cc?.custom.matched) fired++;
    if (d.outcome !== r.outcome) {
      flips.push({ decision_id: r.id, created_at: r.created_at, investor: r.investor, action: r.action, fund: r.ticker, amount: Number(r.amount), from: r.outcome, to: d.outcome,
        reason: cc?.custom.matched ? `${cc.label}: ${cc.detail}` : d.outcome === 'ALLOW' ? 'Every check passes with the rule added.' : d.headline });
    }
  }
  return { window_days: BACKTEST_DAYS, decisions_checked: checked.length, truncated: rows.length > BACKTEST_MAX, applied, fired, flips };
}

const tryIn = z.object({
  action: z.enum(RULE_ACTIONS), investor_id: z.string().min(1), fund: z.string().min(1), amount: z.number().positive().max(1e12),
  settle_with: z.string().min(1).max(20).default('USDC'), counterparty_id: z.string().optional(),
});
/** One live order evaluated with the rule added, nothing persisted. */
async function tryWithRule(c: C, rule: CustomRule, t: z.infer<typeof tryIn>): Promise<NonNullable<RuleTestResult['try']>> {
  if (t.action === 'transfer' && !t.counterparty_id) throw new ApiError(422, 'counterparty_required', 'A transfer needs counterparty_id, the investor receiving the units.');
  const ids = [t.investor_id, ...(t.action === 'transfer' && t.counterparty_id ? [t.counterparty_id] : [])];
  const { ctx } = await liveCtx(c, ids, t.fund);
  for (const i of ids) if (!ctx.investors[i]) throw new ApiError(404, 'not_found', `No investor ${i} in this organization.`);
  if (!ctx.funds[t.fund]) throw new ApiError(404, 'not_found', `No fund ${t.fund} in this organization.`);
  const order: Order = { action: t.action, investorId: t.investor_id, fundId: t.fund, amount: t.amount, asset: t.settle_with, counterpartyId: t.action === 'transfer' ? t.counterparty_id : undefined };
  const d = evaluate(order, [], withRule(ctx, rule));
  return { order: { ...t }, outcome: d.outcome, headline: d.headline, checks: d.checks, remedies: [...new Set(d.remedies)], binding_rules: d.resolved, custom_check: customOf(d, rule.id) };
}

// ---------- Routes ----------
/** The builder's vocabulary: fields, operators, layers, outcomes, statuses and the starter templates. */
routes.get('/rules/vocabulary', async (c) => {
  need(c, 'read');
  return c.json({
    fields: FIELDS, operators: OPERATORS, layers: RULE_LAYERS, actions: RULE_ACTIONS, results: RULE_RESULTS.map((r) => ({ id: r, label: RESULT_LABEL[r] })),
    severities: RULE_SEVERITIES, statuses: RULE_STATUSES.map((s) => ({ id: s, label: STATUS_LABEL[s] })),
    templates: RULE_TEMPLATES.map((t) => ({ ...t, summary_sentence: describeRule(t.definition) })),
    reviewer_roles: RULE_REVIEWER_ROLES,
    note: 'A rule applies when its actions, funds, client kinds and residences cover the order and its jurisdiction is the residence of the investor or the counterparty (or *). Conditions read these fields; an empty value never satisfies a condition. Detail text may use {group.field} placeholders.',
  });
});

/** Rules, latest version each, newest first. Filter: status. */
routes.get('/rules', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws');
  await sweepRuleStatuses(sql, ws);
  const status = c.req.query('status') || null;
  if (status && !(RULE_STATUSES as readonly string[]).includes(status)) throw new ApiError(400, 'invalid_status', `Status must be one of ${RULE_STATUSES.join(', ')}. You sent "${status}".`);
  const rows = await sql`select distinct on (id) * from custom_rules where workspace_id = ${ws} order by id, version desc`;
  const data = rows.map(out).filter((r) => !status || r.status === status).sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const [[live]] = await Promise.all([sql`select count(*)::int as n from custom_rules where workspace_id = ${ws} and status = 'active'`]);
  return c.json({ data, counts, active: Number(live?.n ?? 0) });
});

const createIn = z.object({ template: z.string().max(60).optional() }).passthrough();
/** Creates version 1 of a rule as a draft, from a starter template or from scratch. */
routes.post('/rules', async (c) => {
  const actor = need(c, 'rules:write');
  const sql = c.get('sql'); const ws = c.get('ws');
  const raw = await body(c, createIn);
  const { template, ...rest } = raw as Record<string, unknown> & { template?: string };
  const tpl = template ? templateById(template) : undefined;
  if (template && !tpl) throw new ApiError(404, 'not_found', `No starter template ${template}. GET /v1/rules/vocabulary lists them.`);
  const def = parseBody({ ...(tpl?.definition ?? {}), ...rest });
  const ruleId = id('crl', 10);
  const [[row]] = await sql.transaction([
    sql`insert into custom_rules (workspace_id, id, version, name, description, jurisdiction, definition, status, template, authored_by, authored_by_user)
      values (${ws}, ${ruleId}, 1, ${def.name}, ${def.description}, ${def.jurisdiction}, ${defJson(def)}, 'draft', ${tpl?.id ?? null}, ${actor.name}, ${actor.userId ?? null})
      returning *`,
    auditQ(sql, ws, actor, 'rule.created', ruleId, { version: 1, name: def.name, jurisdiction: def.jurisdiction, template: tpl?.id ?? null, summary: describeRule(def) }),
  ]);
  return c.json(out(row), 201);
});

/** One rule: its latest version, or ?version=n. */
routes.get('/rules/:id', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const ruleId = c.req.param('id');
  await sweepRuleStatuses(sql, ws);
  const v = c.req.query('version');
  const row = v ? await version(sql, ws, ruleId, Number(v)) : await latest(sql, ws, ruleId);
  if (!row) throw notFound(ruleId);
  const versions = await sql`select version, status from custom_rules where workspace_id = ${ws} and id = ${ruleId} order by version`;
  return c.json({ ...out(row), versions: versions.map((x: any) => ({ version: Number(x.version), status: x.status })) });
});

/** Edits a draft in place. Editing an approved, scheduled or active rule creates the next version as a draft; the live version keeps running. */
routes.put('/rules/:id', async (c) => {
  const actor = need(c, 'rules:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const ruleId = c.req.param('id');
  const def = parseBody(await c.req.json().catch(() => ({})));
  const cur = await latest(sql, ws, ruleId);
  if (!cur) throw notFound(ruleId);
  if (cur.status === 'in_review') throw new ApiError(409, 'in_review', 'This version is with a reviewer. Ask them to request changes, then edit it.');
  if (cur.status === 'draft') {
    const [[row]] = await sql.transaction([
      sql`update custom_rules set name = ${def.name}, description = ${def.description}, jurisdiction = ${def.jurisdiction}, definition = ${defJson(def)}, updated_at = now()
        where workspace_id = ${ws} and id = ${ruleId} and version = ${cur.version} returning *`,
      auditQ(sql, ws, actor, 'rule.updated', ruleId, { version: cur.version, name: def.name, changes: diffDefinitions(definitionOf(cur), def) }),
    ]);
    return c.json(out(row));
  }
  const next = Number(cur.version) + 1;
  const [[row]] = await sql.transaction([
    sql`insert into custom_rules (workspace_id, id, version, name, description, jurisdiction, definition, status, template, authored_by, authored_by_user)
      values (${ws}, ${ruleId}, ${next}, ${def.name}, ${def.description}, ${def.jurisdiction}, ${defJson(def)}, 'draft', ${cur.template ?? null}, ${actor.name}, ${actor.userId ?? null})
      returning *`,
    auditQ(sql, ws, actor, 'rule.created', ruleId, { version: next, from_version: cur.version, name: def.name, changes: diffDefinitions(definitionOf(cur), def), note: `Version ${cur.version} stays ${cur.status} until this one is approved.` }),
  ]);
  return c.json({ ...out(row), note: `Version ${next} created as a draft. Version ${cur.version} stays ${cur.status} until the new one is approved and takes effect.` }, 201);
});

const testIn = z.object({ version: z.number().int().min(1).optional(), try: tryIn.optional() });
/** Runs the regression suite and the 90-day backtest with the rule applied, and optionally one live order. Records the result on the version. */
routes.post('/rules/:id/test', async (c) => {
  const actor = need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const ruleId = c.req.param('id');
  const b = await body(c, testIn);
  const row = b.version ? await version(sql, ws, ruleId, b.version) : await latest(sql, ws, ruleId);
  if (!row) throw notFound(ruleId);
  const def = definitionOf(row);
  const problems = validateDefinition(def);
  if (problems.length) throw new ApiError(422, 'invalid_rule', 'Fix the rule before testing it.', problems);
  // Dates are lifted for the test, so a draft or a scheduled rule shows what it does once in force.
  const rule: CustomRule = { ...ruleOf(row), status: 'active', effective_from: null, effective_to: null };
  const regression = regressionWithRule(rule);
  const backtest = await backtestWithRule(c, rule);
  const result: RuleTestResult = { ran_at: new Date().toISOString(), fingerprint: definitionFingerprint(def), version: Number(row.version), regression, backtest };
  if (b.try) result.try = await tryWithRule(c, rule, b.try);
  const stored = { ran_at: result.ran_at, fingerprint: result.fingerprint, version: result.version, regression: { ...regression, changed: regression.changed.slice(0, 50) }, backtest: { ...backtest, flips: backtest.flips.slice(0, 50) }, by: actor.name };
  await sql.transaction([
    sql`update custom_rules set last_test = ${JSON.stringify(stored)}, updated_at = now() where workspace_id = ${ws} and id = ${ruleId} and version = ${row.version}`,
    auditQ(sql, ws, actor, 'rule.tested', ruleId, { version: row.version, regression: { cases: regression.cases, applied: regression.applied, fired: regression.fired, changed: regression.changed.length }, backtest: { decisions_checked: backtest.decisions_checked, applied: backtest.applied, fired: backtest.fired, flips: backtest.flips.length }, tried: !!b.try }),
  ]);
  return c.json({ id: ruleId, ...result, rule: out({ ...row, last_test: stored }) });
});

/** Sends the draft to review. The version must have been tested since its last edit. Reviewers are notified. */
routes.post('/rules/:id/submit', async (c) => {
  const actor = need(c, 'rules:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const ruleId = c.req.param('id');
  const cur = await latest(sql, ws, ruleId);
  if (!cur) throw notFound(ruleId);
  if (cur.status !== 'draft') throw new ApiError(409, 'not_draft', `Version ${cur.version} is ${STATUS_LABEL[cur.status as RuleStatus].toLowerCase()}, not a draft.`);
  const o = out(cur);
  if (o.problems.length) throw new ApiError(422, 'invalid_rule', 'Fix the rule before sending it for review.', o.problems);
  if (!o.tested) throw new ApiError(409, 'not_tested', 'Run Test after the last edit, then send the rule for review. Reviewers see the test results with the rule.');
  const [[row]] = await sql.transaction([
    sql`update custom_rules set status = 'in_review', review_note = null, updated_at = now() where workspace_id = ${ws} and id = ${ruleId} and version = ${cur.version} and status = 'draft' returning *`,
    auditQ(sql, ws, actor, 'rule.sent_for_review', ruleId, { version: cur.version, name: cur.name, summary: o.summary }),
  ]);
  if (!row) throw new ApiError(409, 'not_draft', 'Someone else changed this rule a moment ago. Reload to see its status.');
  bg(c, notifyRoles(sql, ws, RULE_REVIEWER_ROLES, {
    kind: 'rule.review', title: `Rule "${cur.name}" needs legal sign-off`, link: `#/rule-workbench/${ruleId}`,
    body: `${actor.name} sent version ${cur.version} for review. ${o.summary} Nothing changes until a second person approves it with an effective date.`,
  }, actor.userId ?? null));
  return c.json(out(row));
});

const approveIn = z.object({ note: z.string().trim().max(1000).optional(), effective_from: ymd.optional() });
/** A second person approves with a note and an effective date. Active now, or scheduled when the date is in the future. */
routes.post('/rules/:id/approve', async (c) => {
  const actor = need(c, 'rules:approve');
  needStepUp(c, 'approve a rule');
  const sql = c.get('sql'); const ws = c.get('ws'); const ruleId = c.req.param('id');
  const b = await body(c, approveIn);
  const cur = await latest(sql, ws, ruleId);
  if (!cur) throw notFound(ruleId);
  if (cur.status !== 'in_review') throw new ApiError(409, 'not_in_review', `Version ${cur.version} is ${STATUS_LABEL[cur.status as RuleStatus].toLowerCase()}. Only a version in review can be approved.`);
  if (sameUser(actor, cur)) throw new ApiError(403, 'same_person', `You wrote this version. A second person must approve it.${c.get('wsKind') === 'sandbox' ? ' Switch to a teammate to try it.' : ''}`);
  const t = today();
  const from = b.effective_from ?? t;
  if (from < t) throw new ApiError(422, 'past_date', `effective_from cannot be in the past. Today is ${t}.`);
  if (Number.isNaN(Date.parse(from + 'T00:00:00Z'))) throw new ApiError(422, 'invalid_date', `${from} is not a calendar date.`);
  const status: RuleStatus = from === t ? 'active' : 'scheduled';
  const queries: any[] = [
    sql`update custom_rules set status = ${status}, effective_from = ${from}::date, reviewed_by = ${actor.name}, reviewed_by_user = ${actor.userId ?? null}, review_note = ${b.note ?? null}, approved_at = now(), updated_at = now()
      where workspace_id = ${ws} and id = ${ruleId} and version = ${cur.version} and status = 'in_review' returning *`,
    auditQ(sql, ws, actor, 'rule.approved', ruleId, { version: cur.version, name: cur.name, note: b.note ?? null, effective_from: from, status, authored_by: cur.authored_by }),
  ];
  if (status === 'active') {
    queries.push(sql`update custom_rules set status = 'retired', effective_to = ${from}::date, retired_by = ${`Superseded by version ${cur.version}`}, retired_at = now(), updated_at = now()
      where workspace_id = ${ws} and id = ${ruleId} and version < ${cur.version} and status in ('active', 'scheduled', 'approved')`);
  }
  const [[row]] = await sql.transaction(queries);
  if (!row) throw new ApiError(409, 'not_in_review', 'Someone else decided this version a moment ago. Reload to see its status.');
  if (cur.authored_by_user) {
    bg(c, notify(sql, ws, { kind: 'rule.approved', user_id: cur.authored_by_user, title: `Rule "${cur.name}" was approved`, link: `#/rule-workbench/${ruleId}`,
      body: `${actor.name} approved version ${cur.version}${b.note ? `: ${b.note}` : '.'} ${status === 'active' ? 'It applies to every order from now on.' : `It takes effect on ${from}.`}` }));
  }
  return c.json(out(row));
});

const changesIn = z.object({ note: z.string().trim().min(3).max(1000) });
/** The reviewer sends the version back to draft with what needs to change. */
routes.post('/rules/:id/request-changes', async (c) => {
  const actor = need(c, 'rules:approve');
  const sql = c.get('sql'); const ws = c.get('ws'); const ruleId = c.req.param('id');
  const b = await body(c, changesIn);
  const cur = await latest(sql, ws, ruleId);
  if (!cur) throw notFound(ruleId);
  if (cur.status !== 'in_review') throw new ApiError(409, 'not_in_review', `Version ${cur.version} is ${STATUS_LABEL[cur.status as RuleStatus].toLowerCase()}. Only a version in review can be sent back.`);
  const [[row]] = await sql.transaction([
    sql`update custom_rules set status = 'draft', reviewed_by = ${actor.name}, reviewed_by_user = ${actor.userId ?? null}, review_note = ${b.note}, updated_at = now()
      where workspace_id = ${ws} and id = ${ruleId} and version = ${cur.version} and status = 'in_review' returning *`,
    auditQ(sql, ws, actor, 'rule.rejected', ruleId, { version: cur.version, name: cur.name, note: b.note }),
  ]);
  if (!row) throw new ApiError(409, 'not_in_review', 'Someone else decided this version a moment ago. Reload to see its status.');
  if (cur.authored_by_user) {
    bg(c, notify(sql, ws, { kind: 'rule.changes_requested', user_id: cur.authored_by_user, title: `Rule "${cur.name}" needs changes`, link: `#/rule-workbench/${ruleId}`, body: `${actor.name} sent version ${cur.version} back: ${b.note}` }));
  }
  return c.json(out(row));
});

const retireIn = z.object({ effective_to: ymd.optional(), note: z.string().trim().max(500).optional() });
/** Ends a rule: now, or on a date. A draft or a version in review is withdrawn at once. */
routes.post('/rules/:id/retire', async (c) => {
  const actor = c.get('actor');
  if (!can(actor, 'rules:write') && !can(actor, 'rules:approve')) need(c, 'rules:write');
  const sql = c.get('sql'); const ws = c.get('ws'); const ruleId = c.req.param('id');
  const b = await body(c, retireIn);
  const cur = await latest(sql, ws, ruleId);
  if (!cur) throw notFound(ruleId);
  if (cur.status === 'retired') throw new ApiError(409, 'already_retired', `Version ${cur.version} is already retired.`);
  const t = today();
  const to = b.effective_to ?? t;
  if (to < t) throw new ApiError(422, 'past_date', `effective_to cannot be in the past. Today is ${t}.`);
  const live = cur.status === 'active' || cur.status === 'scheduled' || cur.status === 'approved';
  const now = !live || to === t;
  const [[row]] = await sql.transaction([
    now
      ? sql`update custom_rules set status = 'retired', effective_to = ${live ? to : null}::date, retired_by = ${actor.name}, retired_at = now(), review_note = coalesce(${b.note ?? null}, review_note), updated_at = now()
          where workspace_id = ${ws} and id = ${ruleId} and version = ${cur.version} returning *`
      : sql`update custom_rules set effective_to = ${to}::date, retired_by = ${actor.name}, review_note = coalesce(${b.note ?? null}, review_note), updated_at = now()
          where workspace_id = ${ws} and id = ${ruleId} and version = ${cur.version} returning *`,
    auditQ(sql, ws, actor, 'rule.retired', ruleId, { version: cur.version, name: cur.name, from_status: cur.status, effective_to: live ? to : null, immediate: now, note: b.note ?? null }),
  ]);
  return c.json({ ...out(row), note: now ? `Version ${cur.version} no longer applies.` : `Version ${cur.version} stays active until ${to}, then retires.` });
});

/** Every version of a rule with the field-level differences between consecutive versions. */
routes.get('/rules/:id/versions', async (c) => {
  need(c, 'read');
  const sql = c.get('sql'); const ws = c.get('ws'); const ruleId = c.req.param('id');
  const rows = await sql`select * from custom_rules where workspace_id = ${ws} and id = ${ruleId} order by version`;
  if (!rows.length) throw notFound(ruleId);
  const data = rows.map((r: Row, i: number) => ({ ...out(r), condition_text: describeCondition(definitionOf(r).condition), changes_from_previous: i === 0 ? [] : diffDefinitions(definitionOf(rows[i - 1]), definitionOf(r)) }));
  return c.json({ id: ruleId, data });
});

// ---------- OpenAPI (merged by api/src/openapi-gen.ts; the tag is declared in api/src/openapi.ts) ----------
type S = Record<string, unknown>;
const str = (x: S = {}): S => ({ type: 'string', ...x });
const int = (x: S = {}): S => ({ type: 'integer', ...x });
const num = (x: S = {}): S => ({ type: 'number', ...x });
const bool = (): S => ({ type: 'boolean' });
const arr = (items: S, x: S = {}): S => ({ type: 'array', items, ...x });
const en = (...v: string[]): S => ({ type: 'string', enum: v });
const ref = (n: string): S => ({ $ref: `#/components/schemas/${n}` });
const nul = (s: S): S => (s.$ref ? { anyOf: [s, { type: 'null' }] } : { ...s, type: [s.type as string, 'null'] });
const d = (s: S, description: string): S => ({ ...s, description });
const o = (props: Record<string, S>, x: S = {}): S => {
  const properties: Record<string, S> = {}; const required: string[] = [];
  for (const [k, v] of Object.entries(props)) { const r = k.endsWith('*'); properties[r ? k.slice(0, -1) : k] = v; if (r) required.push(k.slice(0, -1)); }
  return { type: 'object', properties, ...(required.length ? { required } : {}), ...x };
};
const q = (name: string, schema: S, description: string): S => ({ name, in: 'query', required: false, description, schema });
const ymdS = str({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', format: 'date' });
const ACTION = en(...RULE_ACTIONS);
const OUTCOME = en('ALLOW', 'DENY', 'FREEZE');
const LAYER = en(...RULE_LAYERS);
const RESULT = en(...RULE_RESULTS);
const SEVERITY = en(...RULE_SEVERITIES);
const STATUS = en(...RULE_STATUSES);
const listOrStar = (what: string): S => ({ oneOf: [en('*'), arr(str(), { minItems: 1 })], description: what });
const RULE_EX_IN = { ...RULE_TEMPLATES[3].definition };
const defProps = (required: boolean): Record<string, S> => ({
  [required ? 'name*' : 'name']: str({ minLength: 3, maxLength: 120 }), description: str({ maxLength: 1000 }),
  jurisdiction: d(str({ maxLength: 10 }), 'A jurisdiction code, or * for any. A coded rule applies only when the investor or the counterparty is resident there.'),
  [required ? 'applies_to*' : 'applies_to']: ref('RuleAppliesTo'), [required ? 'condition*' : 'condition']: ref('RuleCondition'), [required ? 'outcome*' : 'outcome']: ref('RuleOutcome'), severity: SEVERITY,
});

export const OPENAPI_SCHEMAS: Record<string, S> = {
  RuleAppliesTo: o({ 'actions*': arr(ACTION, { minItems: 1 }), 'funds*': listOrStar('Fund tickers, or * for any.'), 'investor_kinds*': listOrStar('Client kinds: Individual, Corporate (any entity), or an exact recorded kind.'), 'residence*': listOrStar('Investor residence codes, or * for any.') }),
  RuleCondition: { type: 'object', description: 'An expression tree. A group: { op: and | or, items: [...] }. A negation: { op: not, item: {...} }. A comparison: { op: eq | ne | gt | gte | lt | lte | in | notIn | has | hasAny | hasAll, field: <vocabulary key>, value: scalar or list }. GET /v1/rules/vocabulary lists the fields and which operators fit each type.', properties: { op: str(), items: arr({ type: 'object' }), item: { type: 'object' }, field: str(), value: {} }, required: ['op'] },
  RuleOutcome: o({ 'result*': d(RESULT, 'fail denies the order, freeze freezes the units, info adds a flag without changing the outcome.'), 'layer*': LAYER, 'label*': str({ minLength: 3, maxLength: 140 }), 'detail*': d(str({ minLength: 3, maxLength: 600 }), 'Shown on the check. May use {group.field} placeholders such as {investor.short} or {order.amount}.'), rule_ref: str({ maxLength: 120 }), source_id: str({ maxLength: 60 }), remedy: str({ maxLength: 400 }) }),
  RuleDefinition: o(defProps(true)),
  CustomRule: o({
    'id*': str(), 'version*': int(), ...defProps(true), 'status*': STATUS, effective_from: nul(ymdS), effective_to: nul(ymdS), authored_by: str(), authored_by_user: nul(str()), reviewed_by: nul(str()), reviewed_by_user: nul(str()),
    review_note: nul(str()), approved_at: nul(str({ format: 'date-time' })), retired_by: nul(str()), retired_at: nul(str({ format: 'date-time' })), template: nul(str()),
    last_test: nul({ type: 'object', description: 'The last test recorded on this version, with the definition fingerprint it ran against.' }), tested: d(bool(), 'True when the last test ran against the current definition.'),
    summary: d(str(), 'The rule in one plain-English sentence.'), problems: arr(str()), versions: arr(o({ version: int(), status: STATUS })), changes_from_previous: arr(o({ path: str(), before: {}, after: {} })), condition_text: str(),
    created_at: str({ format: 'date-time' }), updated_at: str({ format: 'date-time' }),
  }),
};
const CHANGE = o({ id: str(), name: str(), pack: str(), from: str(), to: str(), failing_before: arr(str()), failing_after: arr(str()), rule_result: nul(str()) });
const FLIP = o({ decision_id: str(), created_at: str({ format: 'date-time' }), investor: str(), action: ACTION, fund: str(), amount: num(), from: OUTCOME, to: OUTCOME, reason: str() });
const TAG = 'Rule workbench';
const RULE_ID: [string, string, string] = ['id', 'Rule id.', 'crl_7KQ2M4ZP7W'];
export const OPENAPI_OPS = [
  { method: 'get', path: '/v1/rules/vocabulary', tag: TAG, id: 'getRuleVocabulary', sum: 'Fields, operators and templates for the rule builder', perm: 'read', desc: 'The fixed vocabulary a custom rule can read (order, investor, counterparty, fund and holding facts), the operators each field type accepts, the engine layers an outcome can sit in, and the six starter templates.',
    res: o({ fields: arr(o({ key: str(), label: str(), type: en('number', 'string', 'boolean', 'set'), group: str(), hint: str(), values: arr(str()) })), operators: arr(o({ id: str(), label: str(), types: arr(str()), list: bool() })), layers: arr(LAYER), actions: arr(ACTION), results: arr(o({ id: RESULT, label: str() })), severities: arr(SEVERITY), statuses: arr(o({ id: STATUS, label: str() })), templates: arr(o({ id: str(), name: str(), summary: str(), summary_sentence: str(), definition: ref('RuleDefinition') })), reviewer_roles: arr(str()), note: str() }) },
  { method: 'get', path: '/v1/rules', tag: TAG, id: 'listRules', sum: 'List custom rules', perm: 'read', desc: 'The latest version of every rule, newest change first. Time moves rules along first: a scheduled version becomes active on its effective date and an active one retires when its end date arrives.',
    q: [q('status', STATUS, 'Filter by rule status.')], res: o({ 'data*': arr(ref('CustomRule')), counts: { type: 'object', additionalProperties: int(), description: 'Rules by status.' }, active: int() }) },
  { method: 'post', path: '/v1/rules', tag: TAG, id: 'createRule', sum: 'Create a rule draft', perm: 'rules:write', desc: 'Version 1 of a new rule, as a draft. Pass template to start from a starter template and override any field. Shape problems are a 400 with every issue listed; a rule that does not make sense (an operator that does not fit the field, a placeholder that is not a field) is a 422 invalid_rule.',
    body: o({ template: d(str({ maxLength: 60 }), 'A starter template id from GET /v1/rules/vocabulary.'), ...defProps(false) }), ex: RULE_EX_IN, ok: 201, res: ref('CustomRule'), err: [422] },
  { method: 'get', path: '/v1/rules/{id}', tag: TAG, id: 'getRule', sum: 'Get a rule', perm: 'read', pathParam: RULE_ID, q: [q('version', int({ minimum: 1 }), 'A specific version. Defaults to the latest.')], res: ref('CustomRule') },
  { method: 'put', path: '/v1/rules/{id}', tag: TAG, id: 'updateRule', sum: 'Edit a rule', perm: 'rules:write', pathParam: RULE_ID, desc: 'A draft is edited in place and must be tested again before review. Editing an approved, scheduled or active rule creates the next version as a draft; the live version keeps running until the new one is approved. A version in review cannot be edited: the reviewer requests changes first.',
    body: o(defProps(true)), ex: RULE_EX_IN, res: ref('CustomRule'), err: [409, 422] },
  { method: 'post', path: '/v1/rules/{id}/test', tag: TAG, id: 'testRule', sum: 'Test a rule', perm: 'read', pathParam: RULE_ID, desc: 'Three results. Regression: the shipped golden cases for the rule\'s jurisdiction run without and with the rule, listing every case whose outcome or failing checks change. Backtest: this organization\'s decisions from the last 90 days re-run from their stored snapshots with the rule added, listing flips (at most 120 decisions). Try: when given, one live order evaluated with the rule, nothing persisted. Effective dates are lifted for the test. The result is recorded on the version; a draft must be tested after its last edit before it can be sent for review.',
    body: o({ version: d(int({ minimum: 1 }), 'Defaults to the latest version.'), try: o({ 'action*': ACTION, 'investor_id*': str(), 'fund*': str(), 'amount*': num({ exclusiveMinimum: 0 }), settle_with: str({ default: 'USDC' }), counterparty_id: str() }) }), ex: { try: { action: 'subscribe', investor_id: 'meitan', fund: 'TWLF', amount: 3_000_000, settle_with: 'USDC' } },
    res: o({ id: str(), ran_at: str({ format: 'date-time' }), fingerprint: str(), version: int(), regression: o({ scope: str(), cases: int(), applied: int(), fired: int(), changed: arr(CHANGE) }), backtest: o({ window_days: int(), decisions_checked: int(), truncated: bool(), applied: int(), fired: int(), flips: arr(FLIP) }), try: o({ order: { type: 'object' }, outcome: OUTCOME, headline: str(), checks: arr(ref('Check')), remedies: arr(str()), binding_rules: arr({ type: 'object' }), custom_check: nul(ref('Check')) }), rule: ref('CustomRule') }), err: [422] },
  { method: 'post', path: '/v1/rules/{id}/submit', tag: TAG, id: 'submitRule', sum: 'Send a rule for review', perm: 'rules:write', pathParam: RULE_ID, desc: 'Moves the draft to in_review and notifies people with the legal, compliance or admin role. The version must have been tested since its last edit (409 not_tested otherwise).', res: ref('CustomRule'), err: [409, 422] },
  { method: 'post', path: '/v1/rules/{id}/approve', tag: TAG, id: 'approveRule', sum: 'Approve a rule', perm: 'rules:approve', human: true, pathParam: RULE_ID, desc: 'Legal sign-off by a second person: someone other than the author with the legal, compliance or admin role. effective_from defaults to today, which makes the version active at once; a future date schedules it. An older active version of the same rule retires when the new one takes effect.',
    body: o({ note: str({ maxLength: 1000 }), effective_from: ymdS }), ex: { note: 'Reviewed against the desk mandate. The threshold matches the approved limit.', effective_from: '2026-11-01' }, res: ref('CustomRule'), err: [409, 422] },
  { method: 'post', path: '/v1/rules/{id}/request-changes', tag: TAG, id: 'requestRuleChanges', sum: 'Send a rule back to the author', perm: 'rules:approve', human: true, pathParam: RULE_ID, desc: 'The version returns to draft with the reviewer\'s note. The author is notified.', body: o({ 'note*': str({ minLength: 3, maxLength: 1000 }) }), ex: { note: 'Scope is too wide: limit it to the Singapore booking center.' }, res: ref('CustomRule'), err: [409] },
  { method: 'post', path: '/v1/rules/{id}/retire', tag: TAG, id: 'retireRule', sum: 'Retire a rule', perm: 'rules:write', pathParam: RULE_ID, desc: 'Ends the rule today or on a date. Anyone who can author or approve rules may retire one. A draft or a version in review is withdrawn at once.', body: o({ effective_to: ymdS, note: str({ maxLength: 500 }) }), ex: { effective_to: '2026-12-31', note: 'Replaced by the desk mandate review.' }, res: ref('CustomRule'), err: [409, 422] },
  { method: 'get', path: '/v1/rules/{id}/versions', tag: TAG, id: 'listRuleVersions', sum: 'Version history of a rule', perm: 'read', pathParam: RULE_ID, desc: 'Every version with the field-level differences from the one before it.', res: o({ id: str(), 'data*': arr(ref('CustomRule')) }) },
];
