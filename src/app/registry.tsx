/** @jsxImportSource preact */
// Every page in the app, in one list. App.tsx builds the sidebar and the router from it,
// so a new view is one line here: { pattern, group, label, component, perm? }.
import type { ComponentType } from 'preact';
import { Overview, Clients, ClientDetail, IssueCredential, NewOrder, DecisionDetail, Decisions, Settlements, SettlementDetail, Bulk } from './views/distributor';
import { Funds, FundDetail, PolicyChanges, CreateFund } from './views/issuer';
import { RuleLibrary, Screening, RuleDrafts, AuditLog, ReceiptChecker } from './views/compliance';
import { Explorer, Webhooks } from './views/developers';
import { Integrations } from './views/integrations';
import { Members, SingleSignOn, Security, ApiKeys, Branding } from './views/settings';
import { Outbox, Sessions, Provisioning, Organization } from './views/settings2';
import { WorkQueue, ScreeningHits, ScreeningHitDetail, SanctionsLists, Monitoring, RegFeed, InboundTravelRule } from './views/compliance2';
import { Notifications } from './views/notifications';
import { Anchors } from './views/anchors';
import { RedemptionNotices } from './views/fundops';
import { Network } from './views/network';
import { PortalRequests, EvidenceReview } from './views/portalAdmin';
import { TravelRule } from './views/travel';
import { Approvals, ApprovalPolicies, Waitlist, Batches } from './views/workflow';
import { Reports } from './views/reports';
import { ReportBuilder } from './views/reports2';
import { ChainOverview, ChainJobsPage, Reconciliation } from './views/chain';

export type RouteProps = { params: Record<string, string>; query: URLSearchParams };
export type RouteEntry = {
  /** Hash path, with :params, for example '/clients/:id'. */
  pattern: string;
  /** Sidebar group. Groups appear in first-seen order; Organization is always last. */
  group: string;
  /** Sidebar label. Entries without a label, or with hidden: true, route but do not appear in the sidebar. */
  label?: string;
  component: ComponentType<RouteProps>;
  /** Permission needed to open the page. Without it the page explains why instead of rendering. */
  perm?: string;
  hidden?: boolean;
};

export const ROUTES: RouteEntry[] = [
  // Distributor
  { pattern: '/', group: 'Distributor', label: 'Overview', component: Overview },
  { pattern: '/clients', group: 'Distributor', label: 'Clients', component: Clients },
  { pattern: '/clients/:id', group: 'Distributor', component: (r) => <ClientDetail id={r.params.id} /> },
  { pattern: '/clients/:id/credential', group: 'Distributor', component: (r) => <IssueCredential id={r.params.id} /> },
  { pattern: '/orders/new', group: 'Distributor', label: 'New order', component: (r) => <NewOrder params={r.query} /> },
  { pattern: '/decisions', group: 'Distributor', label: 'Decisions', component: Decisions },
  { pattern: '/decisions/:id', group: 'Distributor', component: (r) => <DecisionDetail id={r.params.id} /> },
  { pattern: '/settlements', group: 'Distributor', label: 'Settlements', component: Settlements },
  { pattern: '/settlements/:id', group: 'Distributor', component: (r) => <SettlementDetail id={r.params.id} /> },
  { pattern: '/bulk', group: 'Distributor', label: 'Bulk check', component: Bulk },
  { pattern: '/work', group: 'Distributor', label: 'Work queue', component: WorkQueue },
  { pattern: '/network', group: 'Distributor', label: 'Network', component: Network },
  { pattern: '/portal-requests', group: 'Distributor', label: 'Portal requests', component: PortalRequests },
  { pattern: '/redemption-notices', group: 'Distributor', label: 'Redemption notices', component: (r) => <RedemptionNotices query={r.query} /> },
  { pattern: '/waitlist', group: 'Distributor', label: 'Waitlist', component: Waitlist },
  { pattern: '/batches', group: 'Distributor', label: 'Order batches', component: () => <Batches /> },
  { pattern: '/batches/:id', group: 'Distributor', component: (r) => <Batches id={r.params.id} /> },

  // Issuer
  { pattern: '/funds', group: 'Issuer', label: 'Funds', component: Funds },
  { pattern: '/funds/new', group: 'Issuer', component: CreateFund },
  { pattern: '/funds/:ticker', group: 'Issuer', component: (r) => <FundDetail ticker={r.params.ticker} /> },
  { pattern: '/policy-changes', group: 'Issuer', label: 'Policy changes', component: PolicyChanges },
  { pattern: '/reports', group: 'Issuer', label: 'Reports', component: Reports },
  { pattern: '/reports/builder', group: 'Issuer', label: 'Report builder', component: () => <ReportBuilder /> },
  { pattern: '/reports/builder/:id', group: 'Issuer', component: (r) => <ReportBuilder id={r.params.id} /> },

  // Compliance
  { pattern: '/rules', group: 'Compliance', label: 'Rule library', component: RuleLibrary },
  { pattern: '/screening-hits', group: 'Compliance', label: 'Screening hits', component: ScreeningHits },
  { pattern: '/screening-hits/:id', group: 'Compliance', component: (r) => <ScreeningHitDetail id={r.params.id} /> },
  { pattern: '/screening', group: 'Compliance', label: 'Name screening', component: Screening },
  { pattern: '/sanctions-lists', group: 'Compliance', label: 'Sanctions lists', component: SanctionsLists },
  { pattern: '/monitoring', group: 'Compliance', label: 'Monitoring', component: () => <Monitoring /> },
  { pattern: '/monitoring/:id', group: 'Compliance', component: (r) => <Monitoring runId={r.params.id} /> },
  { pattern: '/evidence', group: 'Compliance', label: 'Evidence review', component: EvidenceReview },
  { pattern: '/travel-rule', group: 'Compliance', label: 'Travel Rule', component: () => <TravelRule /> },
  { pattern: '/travel-rule/inbound', group: 'Compliance', label: 'Inbound review', component: () => <InboundTravelRule /> },
  { pattern: '/travel-rule/inbound/:id', group: 'Compliance', component: (r) => <InboundTravelRule id={r.params.id} /> },
  { pattern: '/travel-rule/:id', group: 'Compliance', component: (r) => <TravelRule id={r.params.id} /> },
  { pattern: '/reg-feed', group: 'Compliance', label: 'Regulatory feed', component: RegFeed },
  { pattern: '/drafts', group: 'Compliance', label: 'Change agent', component: RuleDrafts },
  { pattern: '/audit', group: 'Compliance', label: 'Audit log', component: AuditLog },
  { pattern: '/anchors', group: 'Compliance', label: 'Audit anchors', component: Anchors },
  { pattern: '/notifications', group: 'Compliance', component: Notifications, hidden: true },
  { pattern: '/receipts', group: 'Compliance', label: 'Receipt checker', component: ReceiptChecker },
  { pattern: '/approvals', group: 'Compliance', label: 'Approvals', component: () => <Approvals /> },
  { pattern: '/approvals/:id', group: 'Compliance', component: (r) => <Approvals id={r.params.id} /> },

  // Settlement network
  { pattern: '/chain', group: 'Settlement', label: 'On-chain', component: ChainOverview },
  { pattern: '/chain/jobs', group: 'Settlement', label: 'Chain jobs', component: ChainJobsPage },
  { pattern: '/reconciliation', group: 'Settlement', label: 'Reconciliation', component: Reconciliation },

  // Developers
  { pattern: '/explorer', group: 'Developers', label: 'API explorer', component: Explorer },
  { pattern: '/webhooks', group: 'Developers', label: 'Webhooks', component: Webhooks },
  { pattern: '/settings/integrations', group: 'Developers', label: 'Integrations', component: Integrations },

  // Organization
  { pattern: '/settings/members', group: 'Organization', label: 'Members', component: Members },
  { pattern: '/settings/sso', group: 'Organization', label: 'Single sign-on', component: SingleSignOn },
  { pattern: '/settings/security', group: 'Organization', label: 'Security', component: Security },
  { pattern: '/settings/sessions', group: 'Organization', label: 'Sessions and recovery', component: Sessions },
  { pattern: '/settings/provisioning', group: 'Organization', label: 'Provisioning', component: Provisioning },
  { pattern: '/settings/api-keys', group: 'Organization', label: 'API keys', component: ApiKeys, perm: 'keys:admin' },
  { pattern: '/settings/branding', group: 'Organization', label: 'Branding', component: Branding },
  { pattern: '/settings/outbox', group: 'Organization', label: 'Outbox', component: Outbox },
  { pattern: '/settings/organization', group: 'Organization', label: 'Organization', component: Organization },
  { pattern: '/approval-policies', group: 'Organization', label: 'Approval policies', component: ApprovalPolicies },
  { pattern: '/keys', group: 'Organization', component: ApiKeys, perm: 'keys:admin', hidden: true },
];

const segs = (p: string) => p.split('/').filter(Boolean);

/** Finds the entry for a path. When several match, the one with more literal segments wins. */
export function matchRoute(path: string): { entry: RouteEntry; params: Record<string, string> } | null {
  const parts = segs(path);
  let best: { entry: RouteEntry; params: Record<string, string>; score: number } | null = null;
  for (const entry of ROUTES) {
    const ps = segs(entry.pattern);
    if (ps.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let score = 0; let ok = true;
    for (let i = 0; i < ps.length; i++) {
      if (ps[i].startsWith(':')) { try { params[ps[i].slice(1)] = decodeURIComponent(parts[i]); } catch { params[ps[i].slice(1)] = parts[i]; } }
      else if (ps[i] === parts[i]) score++;
      else { ok = false; break; }
    }
    if (ok && (!best || score > best.score)) best = { entry, params, score };
  }
  return best ? { entry: best.entry, params: best.params } : null;
}

export type NavGroup = { group: string; items: RouteEntry[] };
export function navGroups(): NavGroup[] {
  const order: string[] = [];
  const by: Record<string, RouteEntry[]> = {};
  for (const r of ROUTES) {
    if (!r.label || r.hidden || r.pattern.includes(':')) continue;
    if (!by[r.group]) { by[r.group] = []; order.push(r.group); }
    by[r.group].push(r);
  }
  const sorted = [...order.filter((g) => g !== 'Organization'), ...order.filter((g) => g === 'Organization')];
  return sorted.map((group) => ({ group, items: by[group] }));
}

/** True when a sidebar entry should show as the current page. */
export const isActive = (pattern: string, path: string) => (pattern === '/' ? path === '/' : path === pattern || path.startsWith(pattern + '/'));
