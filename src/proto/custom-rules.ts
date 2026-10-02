// Customer-authored rules. A compliance team writes a rule as data in the app: who it applies to, a condition over a
// fixed vocabulary of order, investor, fund and holding facts, and what happens when the condition holds. The engine
// evaluates active rules after its built-in layers (see evaluate() in engine.ts). Packs stay engine code; these rules
// sit on top of them and can only add checks, never remove one.
//
// Shared by the browser (the rule workbench validates and previews with it) and the Worker (api/src/rules-dsl.ts
// re-exports it). No DOM, no database: pure data and pure functions.

import { z } from 'zod';
import type { Check, Layer, Order } from './engine';
import type { Fund, Investor } from './data';

// ---------- Vocabulary ----------
export const RULE_ACTIONS = ['subscribe', 'transfer', 'redeem'] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];
export const RULE_RESULTS = ['fail', 'info', 'freeze'] as const;
export type RuleResult = (typeof RULE_RESULTS)[number];
export const RULE_SEVERITIES = ['low', 'medium', 'high'] as const;
export type RuleSeverity = (typeof RULE_SEVERITIES)[number];
export const RULE_STATUSES = ['draft', 'in_review', 'approved', 'scheduled', 'active', 'retired'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];
/** Same list as LAYERS in engine.ts. Declared here too so this module never needs a value from the engine (the engine imports this file). */
export const RULE_LAYERS: Layer[] = ['Credential', 'Fund policy', 'Residence law', 'Booking-center licence', 'Documents', 'Fund terms', 'Transfer controls', 'Counterparty', 'Global screens'];
export const STATUS_LABEL: Record<RuleStatus, string> = {
  draft: 'Draft', in_review: 'In review', approved: 'Approved', scheduled: 'Scheduled', active: 'Active', retired: 'Retired',
};
export const RESULT_LABEL: Record<RuleResult, string> = { fail: 'Deny the order', info: 'Flag for information', freeze: 'Freeze the units' };

export type FieldType = 'number' | 'string' | 'boolean' | 'set';
export type FieldDef = {
  key: string; label: string; type: FieldType; group: 'Order' | 'Investor' | 'Counterparty' | 'Fund' | 'Holding';
  hint: string;
  /** Known values, for a picker. Free text is still accepted. */
  values?: string[];
};
const partyFields = (p: 'investor' | 'counterparty', who: string): FieldDef[] => [
  { key: `${p}.residence`, label: `${who} residence`, type: 'string', group: p === 'investor' ? 'Investor' : 'Counterparty', hint: 'Jurisdiction code, for example SG or AE-DIFC.' },
  { key: `${p}.kind`, label: `${who} kind`, type: 'string', group: p === 'investor' ? 'Investor' : 'Counterparty', hint: 'Individual, or the entity type recorded on the client, for example Corporate treasury.', values: ['Individual', 'Corporate'] },
  { key: `${p}.usPerson`, label: `${who} is a U.S. person`, type: 'boolean', group: p === 'investor' ? 'Investor' : 'Counterparty', hint: 'Regulation S U.S. person flag on the client record.' },
  { key: `${p}.classes`, label: `${who} classifications`, type: 'set', group: p === 'investor' ? 'Investor' : 'Counterparty', hint: 'Class codes valid today, for example SG_AI or HK_PI.' },
  { key: `${p}.credentialDaysToExpiry`, label: `${who} credential days to expiry`, type: 'number', group: p === 'investor' ? 'Investor' : 'Counterparty', hint: 'Days until the Laissez credential lapses. Negative once lapsed. Empty when no credential exists, and an empty value never satisfies a condition.' },
  { key: `${p}.booking`, label: `${who} booking center`, type: 'string', group: p === 'investor' ? 'Investor' : 'Counterparty', hint: 'Booking center id, for example HK, SG, ZRH, DIFC or NY.' },
];
export const FIELDS: FieldDef[] = [
  { key: 'order.action', label: 'Order action', type: 'string', group: 'Order', hint: 'subscribe, transfer or redeem.', values: [...RULE_ACTIONS] },
  { key: 'order.amount', label: 'Order amount', type: 'number', group: 'Order', hint: 'In the fund currency.' },
  { key: 'order.asset', label: 'Settlement asset', type: 'string', group: 'Order', hint: 'For example USDC, EURC or USDT.' },
  { key: 'order.currency', label: 'Fund currency of the order', type: 'string', group: 'Order', hint: 'USD or EUR.', values: ['USD', 'EUR'] },
  ...partyFields('investor', 'Investor'),
  { key: 'fund.ticker', label: 'Fund ticker', type: 'string', group: 'Fund', hint: 'For example TWLF.' },
  { key: 'fund.currency', label: 'Fund currency', type: 'string', group: 'Fund', hint: 'USD or EUR.', values: ['USD', 'EUR'] },
  { key: 'fund.domicile', label: 'Fund domicile', type: 'string', group: 'Fund', hint: 'As recorded on the fund, for example Ireland.' },
  { key: 'fund.holders', label: 'Fund holder count', type: 'number', group: 'Fund', hint: 'Beneficial owners on the register before this order.' },
  { key: 'fund.holderCap', label: 'Fund holder cap', type: 'number', group: 'Fund', hint: 'Empty for funds without a cap; an empty value never satisfies a condition.' },
  { key: 'holding.units', label: 'Units already held', type: 'number', group: 'Holding', hint: 'The ordering investor\'s units in this fund. 0 when none.' },
  { key: 'holding.ageDays', label: 'Days since first holding', type: 'number', group: 'Holding', hint: 'Empty when the investor holds nothing in the fund.' },
  { key: 'holding.exists', label: 'Investor already holds the fund', type: 'boolean', group: 'Holding', hint: 'True when units are on the register.' },
  ...partyFields('counterparty', 'Counterparty'),
];
export const FIELD_KEYS = FIELDS.map((f) => f.key) as [string, ...string[]];
export const fieldDef = (key: string): FieldDef | undefined => FIELDS.find((f) => f.key === key);

export const CMP_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'has', 'hasAny', 'hasAll'] as const;
export type CmpOp = (typeof CMP_OPS)[number];
export type OperatorDef = { id: CmpOp; label: string; types: FieldType[]; list: boolean };
export const OPERATORS: OperatorDef[] = [
  { id: 'eq', label: 'is', types: ['number', 'string', 'boolean'], list: false },
  { id: 'ne', label: 'is not', types: ['number', 'string', 'boolean'], list: false },
  { id: 'gt', label: 'is more than', types: ['number'], list: false },
  { id: 'gte', label: 'is at least', types: ['number'], list: false },
  { id: 'lt', label: 'is less than', types: ['number'], list: false },
  { id: 'lte', label: 'is at most', types: ['number'], list: false },
  { id: 'in', label: 'is one of', types: ['number', 'string'], list: true },
  { id: 'notIn', label: 'is none of', types: ['number', 'string'], list: true },
  { id: 'has', label: 'includes', types: ['set'], list: false },
  { id: 'hasAny', label: 'includes any of', types: ['set'], list: true },
  { id: 'hasAll', label: 'includes all of', types: ['set'], list: true },
];
export const operatorsFor = (type: FieldType): OperatorDef[] => OPERATORS.filter((o) => o.types.includes(type));

// ---------- Condition tree ----------
export type Scalar = string | number | boolean;
export type Condition =
  | { op: 'and' | 'or'; items: Condition[] }
  | { op: 'not'; item: Condition }
  | { op: CmpOp; field: string; value: Scalar | Scalar[] };

export type GroupCondition = Extract<Condition, { items: Condition[] }>;
export type NotCondition = Extract<Condition, { item: Condition }>;
export type LeafCondition = Extract<Condition, { field: string }>;
export const isGroup = (c: Condition): c is GroupCondition => c.op === 'and' || c.op === 'or';
export const isNot = (c: Condition): c is NotCondition => c.op === 'not';

const scalarZ = z.union([z.string().max(200), z.number(), z.boolean()]);
export const conditionSchema: z.ZodType<Condition> = z.lazy(() => z.union([
  z.object({ op: z.enum(['and', 'or']), items: z.array(conditionSchema).min(1).max(20) }),
  z.object({ op: z.literal('not'), item: conditionSchema }),
  z.object({ op: z.enum(CMP_OPS), field: z.enum(FIELD_KEYS), value: z.union([scalarZ, z.array(scalarZ).min(1).max(50)]) }),
]));

const listOrStar = (max: number, item: z.ZodString) => z.union([z.literal('*'), z.array(item).min(1).max(max)]);
export const appliesToSchema = z.object({
  actions: z.array(z.enum(RULE_ACTIONS)).min(1).max(3),
  funds: listOrStar(50, z.string().trim().min(1).max(20)),
  investor_kinds: listOrStar(20, z.string().trim().min(1).max(60)),
  residence: listOrStar(60, z.string().trim().min(1).max(10)),
});
export const outcomeSchema = z.object({
  result: z.enum(RULE_RESULTS),
  layer: z.enum(RULE_LAYERS as [Layer, ...Layer[]]),
  label: z.string().trim().min(3).max(140),
  detail: z.string().trim().min(3).max(600),
  rule_ref: z.string().trim().max(120).optional(),
  source_id: z.string().trim().max(60).optional(),
  remedy: z.string().trim().max(400).optional(),
});
/** What an author writes. Identity, status and dates are added by the workbench. */
export const ruleDefinitionSchema = z.object({
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().max(1000).default(''),
  jurisdiction: z.string().trim().min(1).max(10).default('*'),
  applies_to: appliesToSchema,
  condition: conditionSchema,
  outcome: outcomeSchema,
  severity: z.enum(RULE_SEVERITIES).default('medium'),
});
export type RuleDefinition = z.infer<typeof ruleDefinitionSchema>;
export type RuleDefinitionInput = z.input<typeof ruleDefinitionSchema>;

/** A stored rule version: the definition plus identity, lifecycle and sign-off. */
export type CustomRule = RuleDefinition & {
  id: string;
  version: number;
  status: RuleStatus;
  /** First day the rule is in force (inclusive). Null until approved. */
  effective_from: string | null;
  /** First day the rule is no longer in force (exclusive). Null for open-ended. */
  effective_to: string | null;
  authored_by: string;
  reviewed_by: string | null;
  approved_at: string | null;
  review_note?: string | null;
  template?: string | null;
};

// ---------- Validation beyond the shape ----------
/** Problems zod cannot see: an operator that does not fit the field's type, or a value of the wrong kind. */
export function validateCondition(c: Condition, path = 'condition'): string[] {
  if (isGroup(c)) return c.items.flatMap((x, i) => validateCondition(x, `${path}.items[${i}]`));
  if (isNot(c)) return validateCondition(c.item, `${path}.item`);
  const f = fieldDef(c.field);
  if (!f) return [`${path}: unknown field ${c.field}.`];
  const op = OPERATORS.find((o) => o.id === c.op);
  if (!op) return [`${path}: unknown operator ${c.op}.`];
  const out: string[] = [];
  if (!op.types.includes(f.type)) out.push(`${path}: "${op.label}" does not apply to ${f.label.toLowerCase()} (${f.type}).`);
  const values = Array.isArray(c.value) ? c.value : [c.value];
  if (op.list && !Array.isArray(c.value)) out.push(`${path}: "${op.label}" needs a list of values.`);
  if (!op.list && Array.isArray(c.value)) out.push(`${path}: "${op.label}" takes a single value.`);
  const want: FieldType = f.type === 'set' ? 'string' : f.type;
  for (const v of values) {
    if (want === 'number' && typeof v !== 'number') out.push(`${path}: ${f.label} compares to a number, not "${String(v)}".`);
    if (want === 'boolean' && typeof v !== 'boolean' && v !== 'true' && v !== 'false') out.push(`${path}: ${f.label} is true or false.`);
    if (want === 'string' && typeof v !== 'string') out.push(`${path}: ${f.label} compares to text, not ${String(v)}.`);
  }
  return out;
}
export function validateDefinition(d: RuleDefinition): string[] {
  const out = validateCondition(d.condition);
  if (d.outcome.result === 'info' && d.outcome.remedy) out.push('An information flag has no remedy: nothing is blocked.');
  if (d.outcome.result !== 'info' && d.outcome.layer === 'Counterparty' && !d.applies_to.actions.includes('transfer')) out.push('The Counterparty layer only appears on transfers. Add transfer to the actions, or pick another layer.');
  for (const m of d.outcome.detail.matchAll(/\{([^}]+)\}/g)) if (!TEMPLATE_KEYS.has(m[1])) out.push(`Detail template: {${m[1]}} is not a known field.`);
  return out;
}
/** Parses and validates an author's definition. Throws a zod error for shape problems; returns semantic problems separately. */
export function parseDefinition(input: unknown): { definition: RuleDefinition; problems: string[] } {
  const definition = ruleDefinitionSchema.parse(input);
  return { definition, problems: validateDefinition(definition) };
}

// ---------- Facts ----------
export type PartyFacts = {
  id: string; name: string; short: string; residence: string; kind: string; usPerson: boolean; classes: string[];
  credentialDaysToExpiry: number | null; booking: string; city: string;
};
export type Facts = {
  today: string;
  order: { action: RuleAction; amount: number; asset: string; currency: string };
  investor: PartyFacts;
  counterparty: PartyFacts | null;
  fund: { ticker: string; short: string; name: string; currency: string; domicile: string; holders: number; holderCap: number | null; minSubscription: number; nav: number };
  holding: { units: number; ageDays: number | null; exists: boolean };
};
const DAY = 86_400_000;
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
export function daysBetween(from: string, to: string): number | null {
  if (!isDate(from) || !isDate(to)) return null;
  const a = Date.parse(from + 'T00:00:00Z'); const b = Date.parse(to + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / DAY);
}
function partyFacts(p: Investor, today: string): PartyFacts {
  const hasCred = !!p.credentialId;
  return {
    id: p.id, name: p.name, short: p.short, residence: p.residence, kind: p.kind, usPerson: !!p.usPerson,
    classes: p.classifications.filter((c) => c.expires >= today).map((c) => c.code).sort(),
    credentialDaysToExpiry: hasCred ? daysBetween(today, p.expires) : null,
    booking: p.booking, city: p.city,
  };
}
/** Everything a rule can read for one order, derived from the engine's inputs. */
export function factsFor(order: Order, investor: Investor, fund: Fund, counterparty: Investor | undefined, today: string): Facts {
  const h = investor.holdings[fund.id];
  return {
    today,
    order: { action: order.action, amount: order.amount, asset: order.asset, currency: fund.currency },
    investor: partyFacts(investor, today),
    counterparty: counterparty ? partyFacts(counterparty, today) : null,
    fund: { ticker: fund.ticker, short: fund.short, name: fund.name, currency: fund.currency, domicile: fund.domicile, holders: fund.holders, holderCap: fund.holderCap ?? null, minSubscription: fund.minSubscription, nav: fund.nav },
    holding: { units: h?.units ?? 0, ageDays: h ? daysBetween(h.since, today) : null, exists: !!h },
  };
}
/** Reads a dotted key from the facts. Undefined when the path does not exist or the party is absent. */
export function getFact(facts: Facts, key: string): unknown {
  const [a, b] = key.split('.');
  const group = (facts as unknown as Record<string, unknown>)[a];
  if (!group || typeof group !== 'object') return undefined;
  const v = (group as Record<string, unknown>)[b];
  return v === null ? undefined : v;
}
const TEMPLATE_KEYS = new Set<string>([
  ...FIELD_KEYS, 'today', 'investor.name', 'investor.short', 'investor.city', 'counterparty.name', 'counterparty.short', 'counterparty.city',
  'fund.short', 'fund.name', 'fund.minSubscription', 'fund.nav',
]);

// ---------- Evaluation ----------
const norm = (v: Scalar) => (typeof v === 'string' ? v.trim().toLowerCase() : v);
const asBool = (v: Scalar) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);
function compare(op: CmpOp, actual: unknown, expected: Scalar | Scalar[]): boolean {
  if (actual === undefined || actual === null) return false;
  const list = Array.isArray(expected) ? expected : [expected];
  if (Array.isArray(actual)) {
    const set = new Set(actual.map((x) => norm(x as Scalar)));
    if (op === 'has') return !Array.isArray(expected) && set.has(norm(expected));
    if (op === 'hasAny') return list.some((x) => set.has(norm(x)));
    if (op === 'hasAll') return list.every((x) => set.has(norm(x)));
    return false;
  }
  if (typeof actual === 'boolean') {
    if (Array.isArray(expected)) return false;
    const e = asBool(expected);
    if (e === null) return false;
    return op === 'eq' ? actual === e : op === 'ne' ? actual !== e : false;
  }
  if (typeof actual === 'number') {
    const nums = list.map((x) => (typeof x === 'number' ? x : Number(x))).filter((x) => Number.isFinite(x));
    if (op === 'in') return nums.includes(actual);
    if (op === 'notIn') return nums.length > 0 && !nums.includes(actual);
    if (Array.isArray(expected) || !nums.length) return false;
    const e = nums[0];
    switch (op) {
      case 'eq': return actual === e;
      case 'ne': return actual !== e;
      case 'gt': return actual > e;
      case 'gte': return actual >= e;
      case 'lt': return actual < e;
      case 'lte': return actual <= e;
      default: return false;
    }
  }
  const a = norm(String(actual));
  const strs = list.map((x) => norm(String(x)));
  switch (op) {
    case 'eq': return !Array.isArray(expected) && a === strs[0];
    case 'ne': return !Array.isArray(expected) && a !== strs[0];
    case 'in': return strs.includes(a);
    case 'notIn': return !strs.includes(a);
    default: return false;
  }
}
export function evaluateCondition(c: Condition, facts: Facts): boolean {
  if (isGroup(c)) return c.op === 'and' ? c.items.every((x) => evaluateCondition(x, facts)) : c.items.some((x) => evaluateCondition(x, facts));
  if (isNot(c)) return !evaluateCondition(c.item, facts);
  return compare(c.op, getFact(facts, c.field), c.value);
}

const isIndividual = (kind: string) => kind.trim().toLowerCase() === 'individual';
/** Whether a kind filter entry matches a client's recorded kind. "Corporate" stands for any non-individual. */
export function kindMatches(entry: string, kind: string): boolean {
  const e = entry.trim().toLowerCase();
  if (e === kind.trim().toLowerCase()) return true;
  if (e === 'corporate' || e === 'entity') return !isIndividual(kind);
  return false;
}
/** Whether the rule's scope covers this order. The jurisdiction must be touched by the order; applies_to narrows further. */
export function ruleApplies(rule: RuleDefinition, facts: Facts): boolean {
  const a = rule.applies_to;
  if (!a.actions.includes(facts.order.action)) return false;
  if (a.funds !== '*' && !a.funds.some((t) => t.toUpperCase() === facts.fund.ticker.toUpperCase())) return false;
  if (a.investor_kinds !== '*' && !a.investor_kinds.some((k) => kindMatches(k, facts.investor.kind))) return false;
  if (a.residence !== '*' && !a.residence.some((r) => r.toUpperCase() === facts.investor.residence.toUpperCase())) return false;
  if (rule.jurisdiction !== '*') {
    const j = rule.jurisdiction.toUpperCase();
    const touched = [facts.investor.residence, facts.counterparty?.residence].filter((x): x is string => !!x).map((x) => x.toUpperCase());
    if (!touched.includes(j)) return false;
  }
  return true;
}
/** In force on `today`: from <= today < to. A rule without dates (a draft under test) is treated as in force. */
export function ruleInForce(rule: Pick<CustomRule, 'effective_from' | 'effective_to'>, today: string): boolean {
  if (rule.effective_from && rule.effective_from > today) return false;
  if (rule.effective_to && rule.effective_to <= today) return false;
  return true;
}

const fmtNum = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
export function formatFact(v: unknown): string {
  if (v === undefined || v === null) return 'none';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
  return String(v);
}
/** Fills {group.field} placeholders from the facts. Unknown placeholders stay as written so the author sees them. */
export function renderTemplate(template: string, facts: Facts): string {
  return template.replace(/\{([a-z]+(?:\.[A-Za-z]+)?)\}/g, (m, key: string) => {
    if (key === 'today') return facts.today;
    if (!key.includes('.')) return m;
    const v = getFact(facts, key);
    return v === undefined ? m : formatFact(v);
  });
}

/** A check produced by a custom rule. The extra `custom` block records which rule version fired and what it asked for. */
export type CustomCheck = Check & { custom: { rule_id: string; version: number; result: RuleResult; severity: RuleSeverity; matched: boolean } };
export const customCheckId = (ruleId: string) => `custom:${ruleId}`;
export const isFreezeCheck = (c: Check): boolean => !!(c as CustomCheck).custom && (c as CustomCheck).custom.result === 'freeze' && (c as CustomCheck).custom.matched;

/**
 * Evaluates the given rules against the facts. Pure: same rules and facts, same checks, in rule id order.
 * Every rule whose scope covers the order yields one check: pass when the condition does not hold, otherwise fail
 * (deny or freeze) or info. Rules outside their effective window or outside their scope yield nothing.
 * When two versions of one rule are both in force, the highest version wins.
 */
export function evaluateCustomRules(rules: CustomRule[], facts: Facts): CustomCheck[] {
  const latest = new Map<string, CustomRule>();
  for (const r of rules) {
    if (!ruleInForce(r, facts.today)) continue;
    const cur = latest.get(r.id);
    if (!cur || r.version > cur.version) latest.set(r.id, r);
  }
  const out: CustomCheck[] = [];
  for (const r of [...latest.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!ruleApplies(r, facts)) continue;
    const matched = evaluateCondition(r.condition, facts);
    const o = r.outcome;
    const subject = o.layer === 'Counterparty' && facts.counterparty ? facts.counterparty.short : facts.investor.short;
    const check: CustomCheck = {
      id: customCheckId(r.id), layer: o.layer, subject, label: o.label,
      result: matched ? (o.result === 'info' ? 'info' : 'fail') : 'pass',
      detail: matched ? renderTemplate(o.detail, facts) : `${r.name} (your organization's rule, version ${r.version}) was checked and does not apply to this order.`,
      custom: { rule_id: r.id, version: r.version, result: o.result, severity: r.severity, matched },
    };
    if (o.rule_ref) check.ruleRef = o.rule_ref;
    if (o.source_id) check.source = o.source_id;
    if (matched && o.result !== 'info' && o.remedy) check.remedy = o.remedy;
    out.push(check);
  }
  return out;
}

// ---------- Plain language ----------
const quote = (v: Scalar) => (typeof v === 'string' ? v : formatFact(v));
const joinList = (xs: string[], word: string) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${word} ${xs[xs.length - 1]}`);
export function describeCondition(c: Condition, depth = 0): string {
  if (isGroup(c)) {
    const parts = c.items.map((x) => describeCondition(x, depth + 1));
    const joined = parts.join(c.op === 'and' ? ' and ' : ' or ');
    return depth > 0 && parts.length > 1 ? `(${joined})` : joined;
  }
  if (isNot(c)) return `it is not the case that ${describeCondition(c.item, depth + 1)}`;
  const f = fieldDef(c.field);
  const op = OPERATORS.find((o) => o.id === c.op);
  const name = f ? f.label.toLowerCase() : c.field;
  const values = Array.isArray(c.value) ? c.value.map(quote) : [quote(c.value)];
  const v = Array.isArray(c.value) ? joinList(values, c.op === 'hasAll' ? 'and' : 'or') : values[0];
  return `${name} ${op?.label ?? c.op} ${v}`;
}
export function describeRule(d: RuleDefinition): string {
  const a = d.applies_to;
  const actions = joinList(a.actions.map((x) => (x === 'subscribe' ? 'subscriptions' : x === 'transfer' ? 'transfers' : 'redemptions')), 'and');
  const scope = [
    a.funds === '*' ? 'any fund' : `fund ${joinList(a.funds, 'or')}`,
    a.investor_kinds === '*' ? '' : `${joinList(a.investor_kinds, 'or')} clients`,
    a.residence === '*' ? '' : `resident in ${joinList(a.residence, 'or')}`,
    d.jurisdiction === '*' ? '' : `touching ${d.jurisdiction}`,
  ].filter(Boolean).join(', ');
  const verb = d.outcome.result === 'fail' ? 'deny the order' : d.outcome.result === 'freeze' ? 'freeze the units' : 'add an information flag';
  const lead = d.condition.op === 'or' ? 'when any of these is true' : 'when all of these are true';
  return `On ${actions} in ${scope}, ${lead}: ${describeCondition(d.condition)}; then ${verb} with "${d.outcome.label}".`;
}

// ---------- Versions ----------
export type RuleDiff = { path: string; before: unknown; after: unknown };
const flatten = (v: unknown, prefix: string, out: Record<string, unknown>) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) { for (const [k, x] of Object.entries(v as Record<string, unknown>)) flatten(x, prefix ? `${prefix}.${k}` : k, out); return; }
  out[prefix] = v;
};
/** Field-level differences between two definitions, for the version history. Condition trees compare as one field. */
export function diffDefinitions(a: RuleDefinition, b: RuleDefinition): RuleDiff[] {
  const fa: Record<string, unknown> = {}; const fb: Record<string, unknown> = {};
  const strip = (d: RuleDefinition) => ({ ...d, condition: describeCondition(d.condition) });
  flatten(strip(a), '', fa); flatten(strip(b), '', fb);
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort();
  return keys.filter((k) => JSON.stringify(fa[k]) !== JSON.stringify(fb[k])).map((k) => ({ path: k, before: fa[k], after: fb[k] }));
}
/** Stable hash input for a definition, so "tested after the last edit" can be checked without a crypto dependency. */
export function definitionFingerprint(d: RuleDefinition): string {
  const s = JSON.stringify([d.name, d.description, d.jurisdiction, d.applies_to, d.condition, d.outcome, d.severity]);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------- Starter templates ----------
export type RuleTemplate = { id: string; name: string; summary: string; definition: RuleDefinition };
const def = (d: RuleDefinitionInput): RuleDefinition => ruleDefinitionSchema.parse(d);
export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: 'large-entity-subscription', name: 'Block subscriptions above an amount for a client kind',
    summary: 'Refuses a subscription from entities above a size your desk has not pre-cleared.',
    definition: def({
      name: 'Entity subscriptions above $25,000,000 need pre-clearance', description: 'Large tickets from entities go through the desk head before the order is placed. Until then the order is refused.',
      jurisdiction: '*', applies_to: { actions: ['subscribe'], funds: '*', investor_kinds: ['Corporate'], residence: '*' },
      condition: { op: 'and', items: [{ op: 'gt', field: 'order.amount', value: 25_000_000 }] },
      outcome: { result: 'fail', layer: 'Fund policy', label: 'Entity subscription above the pre-clearance limit', detail: '{investor.short} is subscribing {order.amount} {order.currency} to {fund.ticker}. Entity subscriptions above 25,000,000 need pre-clearance from the desk head.', remedy: 'Split the order below 25,000,000 or record the desk head\'s pre-clearance, then place it again.' },
      severity: 'medium',
    }),
  },
  {
    id: 'credential-expiry-buffer', name: 'Require a credential at least 30 days from expiry',
    summary: 'Stops subscriptions and transfers when the investor\'s credential lapses within 30 days.',
    definition: def({
      name: 'Credential must have at least 30 days left', description: 'A credential that lapses within a month is renewed before new money comes in, so settlement never lands on a lapsed record.',
      jurisdiction: '*', applies_to: { actions: ['subscribe', 'transfer'], funds: '*', investor_kinds: '*', residence: '*' },
      condition: { op: 'and', items: [{ op: 'lt', field: 'investor.credentialDaysToExpiry', value: 30 }] },
      outcome: { result: 'fail', layer: 'Credential', label: 'Credential expires within 30 days', detail: '{investor.short}\'s credential has {investor.credentialDaysToExpiry} days left. Your organization requires at least 30 days before a subscription or transfer.', remedy: 'Renew the credential, then place the order again.' },
      severity: 'medium',
    }),
  },
  {
    id: 'asset-blocked-in-jurisdiction', name: 'Block a settlement asset for one jurisdiction',
    summary: 'Refuses settlement in a named asset for clients resident in one jurisdiction.',
    definition: def({
      name: 'No USDT settlement for Singapore clients', description: 'Your Singapore entity does not accept USDT as a settlement asset, whatever the fund allows.',
      jurisdiction: 'SG', applies_to: { actions: ['subscribe', 'transfer', 'redeem'], funds: '*', investor_kinds: '*', residence: ['SG'] },
      condition: { op: 'and', items: [{ op: 'in', field: 'order.asset', value: ['USDT'] }] },
      outcome: { result: 'fail', layer: 'Fund policy', label: 'Settlement asset not accepted for Singapore clients', detail: '{investor.short} is resident in Singapore and the order settles in {order.asset}, which your Singapore entity does not accept.', remedy: 'Settle in an asset the fund and your Singapore entity both accept, such as USDC.' },
      severity: 'high',
    }),
  },
  {
    id: 'individual-order-cap', name: 'Cap single-order size for individuals',
    summary: 'Refuses any single order from an individual above a size limit.',
    definition: def({
      name: 'Individuals: single orders capped at 2,000,000', description: 'Retail-adjacent exposure per order is capped. Larger tickets are split or escalated.',
      jurisdiction: '*', applies_to: { actions: ['subscribe', 'transfer', 'redeem'], funds: '*', investor_kinds: ['Individual'], residence: '*' },
      condition: { op: 'and', items: [{ op: 'gt', field: 'order.amount', value: 2_000_000 }] },
      outcome: { result: 'fail', layer: 'Fund policy', label: 'Single order above the individual cap', detail: 'The order is {order.amount} {order.currency}. Individuals are capped at 2,000,000 per order.', remedy: 'Reduce the order to 2,000,000 or less, or escalate for an exception.' },
      severity: 'medium',
    }),
  },
  {
    id: 'first-time-investor-flag', name: 'Flag first-time investors in a fund',
    summary: 'Adds an information flag when a client subscribes to a fund they do not yet hold.',
    definition: def({
      name: 'First subscription to a fund', description: 'Onboarding checks for a new fund relationship: the flag tells operations to send the welcome pack and confirm the distribution preference.',
      jurisdiction: '*', applies_to: { actions: ['subscribe'], funds: '*', investor_kinds: '*', residence: '*' },
      condition: { op: 'and', items: [{ op: 'eq', field: 'holding.exists', value: false }] },
      outcome: { result: 'info', layer: 'Fund policy', label: 'First subscription to this fund', detail: '{investor.short} does not yet hold {fund.ticker}. This order opens the position; operations sends the welcome pack after settlement.' },
      severity: 'low',
    }),
  },
  {
    id: 'residence-freeze', name: 'Freeze orders for a named residence',
    summary: 'Freezes units for clients resident in a jurisdiction your organization has paused.',
    definition: def({
      name: 'Pause: clients resident in Myanmar', description: 'Internal pause pending a country risk review. Orders freeze rather than deny so compliance sees each one.',
      jurisdiction: '*', applies_to: { actions: ['subscribe', 'transfer', 'redeem'], funds: '*', investor_kinds: '*', residence: '*' },
      condition: { op: 'and', items: [{ op: 'in', field: 'investor.residence', value: ['MM'] }] },
      outcome: { result: 'freeze', layer: 'Global screens', label: 'Residence under internal pause', detail: '{investor.short} is resident in {investor.residence}, which your organization has paused pending a country risk review.', remedy: 'Compliance clears the client against the country risk review before anything settles.' },
      severity: 'high',
    }),
  },
];
export const templateById = (id: string): RuleTemplate | undefined => RULE_TEMPLATES.find((t) => t.id === id);
