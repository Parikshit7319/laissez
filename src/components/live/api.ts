// Response shapes for the public Laissez endpoints used by the status and metrics pages.
// Source of truth: api/src/routes/platform.ts (GET /v1/status, GET /v1/metrics/public) and
// api/src/routes/core.ts (GET /v1/rule-packs).

export const API_BASE: string = ((import.meta as any).env?.PUBLIC_API_BASE as string | undefined)?.replace(/\/$/, '') || 'https://laissez-api.laissez.workers.dev';
export const API_HOST = 'laissez-api.laissez.workers.dev';

export type ComponentStatus = 'operational' | 'degraded' | 'unknown';
export type OverallStatus = 'operational' | 'degraded' | 'partial_data';

export type StatusComponent = {
  id: string;
  name: string;
  status: ComponentStatus;
  ok: boolean | null;
  last_checked_at: string | null;
  latency_ms: number | null;
  detail: string | null;
  uptime: { '24h': number | null; '7d': number | null; '90d': number | null };
  checks_24h: number;
};

export type DailyUptime = { date: string; checks: number; ok_checks: number; uptime: number | null };

export type Incident = {
  component: string;
  name: string;
  started_at: string;
  last_failed_at: string;
  ended_at: string | null;
  ongoing: boolean;
  duration_seconds: number;
  failed_checks: number;
  detail: string | null;
};

export type SanctionsSource = {
  source: string;
  name: string;
  last_fetched_at: string | null;
  last_published: string | null;
  entries: number;
  status: string;
  error: string | null;
  age_hours: number | null;
};

export type ErrorBudget = {
  objective: number;
  window_days: number;
  covered_days: number;
  availability: number | null;
  intervals: number;
  failed_intervals: number;
  interval_minutes: number;
  allowed_downtime_minutes: number;
  used_downtime_minutes: number;
  remaining_minutes: number;
  remaining_share: number | null;
  state: 'ok' | 'warning' | 'exhausted' | 'no_data';
  definition: string;
};

export type LatencyRoute = { path: string; samples: number; p95_ms: number | null; server_errors: number };
export type Latency = {
  window_hours: number;
  sample_rate: number;
  samples: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  server_errors: number;
  client_errors: number;
  server_error_rate: number | null;
  first_sample_at: string | null;
  by_route: LatencyRoute[];
  definition: string;
};

export type StatusResponse = {
  status: OverallStatus;
  checked_at: string;
  components: StatusComponent[];
  error_budget?: ErrorBudget;
  latency?: Latency;
  sanctions: { sources: SanctionsSource[]; oldest_list_hours: number | null };
  monitoring: { last_run_finished_at: string | null; runs_24h: number };
  daily_window_days?: number;
  daily?: Record<string, DailyUptime[]>;
  incident_window_days?: number;
  incidents?: Incident[];
  note: string;
};

export type FunnelStep = { event: string; subjects: number; conversion_from_start: number | null };
export type CurrencyValue = { currency: string; last_30d: number; all_time: number; settlements_30d: number; settlements_all_time: number };

export type MetricsResponse = {
  generated_at: string;
  window_days: number;
  funnel: FunnelStep[];
  north_star: { name: string; definition: string; by_currency: CurrencyValue[] };
  guardrail: { name: string; target: number; settled_without_allow: number; rechecked_at_settlement: number; settlements: number };
  time_to_first_settlement: { median_seconds: number | null; workspaces_settled: number; workspaces_opened_30d: number };
  credential_reuse: {
    investors_with_allowed_orders: number; multi_fund: number; multi_fund_rate: number | null;
    relied_on_network: number; network_rate: number | null;
  };
  series?: {
    window_days: number;
    days: string[];
    events: Record<string, number[]>;
    cross_border_settled_value: Record<string, number[]>;
    cross_border_settlements: number[];
    note?: string;
  };
  note: string;
};

export type RulePack = {
  id: string; version: string; jurisdiction: string; status: string; summary: string | null;
  effective_from: string | null; effective_to: string | null; approved_by: string | null; created_at: string;
};
export type RulePacksResponse = { data: RulePack[] };

export const ENDPOINTS = {
  status: '/v1/status',
  metrics: '/v1/metrics/public',
  rulepacks: '/v1/rule-packs',
  chain: '/v1/chain/public',
} as const;
export type ChainPublic = {
  deployed: boolean; enabled?: boolean; network?: string; network_label?: string; chain_id?: number; explorer?: string | null; deployed_at?: string | null; claim_topic?: number; message?: string;
  operator?: { address: string; url: string | null };
  contracts?: { key: string; name: string; address: string; url: string | null; role: string }[];
  funds?: { ticker: string; name: string; token: string; token_url: string | null; countries: number[] }[];
};
export type EndpointKey = keyof typeof ENDPOINTS;

export class FetchError extends Error {
  constructor(message: string, public kind: 'network' | 'timeout' | 'http' | 'parse', public status?: number) { super(message); }
}

/** GET a public endpoint with a timeout. Errors carry a plain-language message. */
export async function getJson<T>(path: string, timeoutMs = 12_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { signal: ctrl.signal, headers: { accept: 'application/json' }, cache: 'no-store' });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new FetchError(`No response within ${Math.round(timeoutMs / 1000)} seconds.`, 'timeout');
    throw new FetchError('The request did not reach the API.', 'network');
  } finally {
    clearTimeout(timer);
  }
  let body: any = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (!res.ok) throw new FetchError(body?.error?.message ?? `The API answered with status ${res.status}.`, 'http', res.status);
  if (body == null) throw new FetchError('The API answered, but not with JSON.', 'parse', res.status);
  return body as T;
}
