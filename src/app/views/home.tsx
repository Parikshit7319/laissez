/** @jsxImportSource preact */
// Home: three numbers that say whether the thesis holds in this workspace (credentials reused, value
// settled across borders, hours from credential to first settlement), then what needs a person, then
// the first-run checklist for sandboxes and recent activity. The per-day chart lives under Trends.
import { compact, when } from '../api';
import { useApi, Head, Btn, ErrorBox, Loading, Empty, Card, go } from '../ui';
import { PermBtn, useMe } from '../auth';
import { Checklist } from '../../components/Checklist';

const hours = (h: number | null | undefined) => (h == null ? null : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h < 10 ? h.toFixed(1) : Math.round(h)} h` : `${(h / 24).toFixed(1)} d`);

export function Home() {
  const { me, isSandbox, can } = useMe();
  const m = useApi('/v1/metrics');
  const a = useApi('/v1/audit-events?limit=8');
  if (m.loading && !m.data) return <Loading />;
  if (m.error) return <ErrorBox error={m.error} onRetry={m.reload} />;
  const d = m.data;
  const ws = me!.workspace;
  const reuse = d.credential_reuse ?? {};
  const net = d.network ?? { relied_on: 0, shared_out: 0, pending_shares: 0 };
  const needs = d.needs_you ?? { approvals: 0, work_items: 0, portal_requests: 0, shares: 0 };
  const xb: any[] = d.cross_border_settled_value ?? [];
  const xbUsd = xb.find((x) => x.currency === 'USD'); const xbEur = xb.find((x) => x.currency === 'EUR');
  const xbN = xb.reduce((s, x) => s + x.n, 0);
  const ttfs = hours(d.time_to_first_settlement_hours_median);
  const days = [...new Set((d.daily as any[]).map((r) => r.day))];
  const byDay = days.map((day) => ({ day, allow: d.daily.find((r: any) => r.day === day && r.outcome === 'ALLOW')?.n ?? 0, deny: d.daily.filter((r: any) => r.day === day && r.outcome !== 'ALLOW').reduce((s: number, r: any) => s + r.n, 0) }));
  const max = Math.max(1, ...byDay.map((x) => x.allow + x.deny));
  const items: { n: number; label: string; hint: string; href: string }[] = [
    { n: needs.approvals, label: 'Open approvals', hint: 'A second person has to decide these.', href: '#/approvals' },
    { n: needs.work_items, label: 'Work items', hint: 'Lapses, screening hits and monitoring findings.', href: '#/work' },
    { n: needs.portal_requests, label: 'Portal requests', hint: 'Orders clients submitted from the investor portal.', href: '#/portal-requests' },
    { n: needs.shares, label: 'Pending shares', hint: 'Credential shares waiting for the client to consent.', href: '#/network' },
  ];
  const open = items.filter((x) => x.n > 0);
  return (
    <>
      <Head title="Home" sub={`${ws.name}. Live numbers from this workspace.`} actions={<><PermBtn perm="orders:write" kind="primary" onClick={() => go('/')}>Check an order</PermBtn><Btn onClick={() => go('/clients')}>Clients</Btn></>} />
      <div class="home-nums">
        <a class="home-num" href="#/network">
          <span>Credential reuse</span>
          <b>{reuse.rate == null ? 'None yet' : `${Math.round(reuse.rate * 100)}%`}</b>
          <em>{reuse.investors_with_two_or_more_funds ?? 0} of {reuse.investors_with_allowed_orders ?? 0} clients cleared for 2 or more funds on one credential{net.relied_on ? `, plus ${net.relied_on} relied on from other distributors` : ''}</em>
        </a>
        <a class="home-num" href="#/settlements">
          <span>Cross-border settled</span>
          <b>{xbUsd || xbEur ? <>{xbUsd ? compact(xbUsd.value) : ''}{xbUsd && xbEur ? ' + ' : ''}{xbEur ? compact(xbEur.value, 'EUR') : ''}</> : '$0'}</b>
          <em>{xbN} settlement{xbN === 1 ? '' : 's'} where the investor lives outside the fund's domicile</em>
        </a>
        <a class="home-num" href="#/decisions">
          <span>Credential to first settlement</span>
          <b>{ttfs ?? 'None yet'}</b>
          <em>{ttfs ? `median across ${d.time_to_first_settlement_investors} client${d.time_to_first_settlement_investors === 1 ? '' : 's'}` : 'median once a client with a credential settles an order'}</em>
        </a>
      </div>

      <Card title="Needs you" actions={open.length ? <span class="small muted">{open.reduce((s, x) => s + x.n, 0)} waiting</span> : null}>
        {open.length ? (
          <ul class="home-needs">
            {open.map((x) => <li><a href={x.href}><b>{x.n}</b><span><strong>{x.label}</strong><em>{x.hint}</em></span><i aria-hidden="true">›</i></a></li>)}
          </ul>
        ) : <Empty title="Nothing waiting on you">Approvals, work items, portal requests and pending shares appear here.</Empty>}
      </Card>

      {isSandbox ? <Checklist workspaceId={ws.id} actingAs={!!me!.acting_as} canOrder={can('orders:write')} canPropose={can('funds:write')} /> : null}

      <Card title="Recent activity" actions={<Btn kind="ghost" onClick={() => go('/audit')}>Audit log</Btn>}>
        {a.error ? <ErrorBox error={a.error} onRetry={a.reload} /> : a.data ? ((a.data.data as any[]).length ? <ul class="feed">{(a.data.data as any[]).slice(0, 8).map((e) => <li><code>{e.type}</code><span>{e.subject}</span><time>{when(e.created_at)}</time></li>)}</ul> : <Empty title="No activity yet">Everything you do here is audited and shows up in this list.</Empty>) : <Loading />}
      </Card>

      <details class="home-trends">
        <summary>Trends: decisions per day, refusal reasons, expiring credentials</summary>
        <div class="home-kpis">
          <div class="kpi"><span>Decisions</span><b>{d.totals.decisions}</b><em>{d.totals.allowed} allowed, {d.totals.denied} denied, {d.totals.frozen} frozen</em></div>
          <div class="kpi"><span>Allow rate</span><b>{d.totals.allow_rate === null ? 'None yet' : `${Math.round(d.totals.allow_rate * 100)}%`}</b><em>share of pre-trade checks that passed</em></div>
          <div class="kpi"><span>Expiring in 30 days</span><b>{d.credentials_expiring_30d}</b><em>{d.credentials_expiring_30d === 1 ? 'credential' : 'credentials'} to renew</em></div>
        </div>
        <div class="grid2">
          <Card title="Decisions per day">
            {byDay.length ? (
              <div class="bars" role="img" aria-label="Decisions per day, allowed versus refused">
                {byDay.map((x) => (
                  <div class="bar-col" title={`${x.day}: ${x.allow} allowed, ${x.deny} refused`}>
                    <div class="bar-stack" style={{ height: `${((x.allow + x.deny) / max) * 100}%` }}>
                      <span class="seg-deny" style={{ flex: x.deny }} /><span class="seg-allow" style={{ flex: x.allow }} />
                    </div>
                    <small>{x.day.slice(5)}</small>
                  </div>
                ))}
              </div>
            ) : <Empty title="No decisions yet">Check an order to see it here.</Empty>}
            <div class="legend"><span><i class="lg-allow" />Allowed</span><span><i class="lg-deny" />Denied or frozen</span></div>
          </Card>
          <Card title="Top refusal reasons">
            {(d.top_refusal_reasons as any[]).length ? (
              <ol class="reasons">{d.top_refusal_reasons.map((r: any) => <li><span>{r.label}</span><b>{r.n}</b></li>)}</ol>
            ) : <Empty title="No refusals yet">Try an order that should fail, like Mei Tan buying Tidewell.</Empty>}
          </Card>
        </div>
      </details>
    </>
  );
}
