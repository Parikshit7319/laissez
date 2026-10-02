/** @jsxImportSource preact */
// In-app notifications: the bell in the top bar (unread count, polled every 60 seconds) and the full page.
import { useEffect, useState } from 'preact/hooks';
import { api, when } from '../api';
import { Btn, Chip, Card, Empty, Loading, ErrorBox, Head, Popover } from '../ui';
import { usePaged, LoadMore } from '../paged';

const POLL_MS = 60_000;

const KIND_LABEL: Record<string, string> = {
  'monitor.item': 'Monitoring', 'monitor.run': 'Monitoring run', 'screening.hit': 'Screening match', 'policy.proposed': 'Policy change',
  'travel_rule.review': 'Travel Rule review', 'travel_rule.callback_failed': 'Travel Rule delivery', 'placement.limit': 'Placement limit',
};
const KIND_TONE: Record<string, 'ok' | 'no' | 'warn' | 'info' | 'muted'> = {
  'monitor.item': 'warn', 'monitor.run': 'muted', 'screening.hit': 'no', 'policy.proposed': 'info', 'travel_rule.review': 'warn', 'travel_rule.callback_failed': 'no',
};
const kindChip = (k: string) => <Chip tone={KIND_TONE[k] ?? 'muted'}>{KIND_LABEL[k] ?? k.replace(/[._]/g, ' ')}</Chip>;

async function markRead(id: string) {
  try { await api(`/v1/notifications/${id}/read`, { body: {} }); } catch { /* best effort */ }
}

/** The bell. Polls the unread count every minute; opening it shows the newest items and marks them read on click. */
export function NotificationBell() {
  const [unread, setUnread] = useState<number | null>(null);
  const [items, setItems] = useState<any[] | null>(null);
  const [err, setErr] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const load = async (full: boolean) => {
    try {
      const d = await api(`/v1/notifications?limit=${full ? 8 : 1}&unread=${full ? 'false' : 'true'}`);
      setUnread(d.unread ?? 0);
      if (full) setItems(d.data ?? []);
      setErr(null);
    } catch (e) { if (full) setErr(e); }
  };
  useEffect(() => {
    load(false);
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(false); }, POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') load(false); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  const open = (n: any, close: () => void) => {
    if (!n.read_at) { markRead(n.id); setUnread((u) => Math.max(0, (u ?? 1) - 1)); setItems((xs) => (xs ?? []).map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x))); }
    close();
    if (n.link) location.hash = n.link.startsWith('#') ? n.link : `#${n.link}`;
  };
  const readAll = async () => {
    setBusy(true);
    try { await api('/v1/notifications/read-all', { body: {} }); setUnread(0); setItems((xs) => (xs ?? []).map((x) => ({ ...x, read_at: x.read_at ?? new Date().toISOString() }))); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const n = unread ?? 0;
  const label = n ? `${n} unread notification${n === 1 ? '' : 's'}` : 'Notifications';
  return (
    <div onClickCapture={() => { if (items === null) load(true); }} style={{ display: 'contents' }}>
      <Popover class="bell" ariaLabel={label} label={<>
        <span aria-hidden="true" style={{ display: 'inline-block', width: '1rem', height: '1rem', borderRadius: '0.5rem 0.5rem 0.2rem 0.2rem', border: '1.6px solid #6f685d', borderBottomWidth: '2.4px', position: 'relative' }} />
        {n ? <span class="test-pill" style={{ background: '#a3302a', color: '#fff', minWidth: '1.2rem', textAlign: 'center' }}>{n > 99 ? '99+' : n}</span> : null}
      </>}>
        {(close) => (
          <div class="menu-body" role="group" aria-label="Notifications" style={{ width: '22rem', maxWidth: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.2rem 0.55rem 0' }}>
              <p class="menu-h" style={{ margin: 0 }}>Notifications</p>
              {n ? <button type="button" class="menu-a" style={{ width: 'auto', padding: '0.25rem 0.5rem', fontSize: '0.78rem' }} disabled={busy} onClick={readAll}>Mark all read</button> : null}
            </div>
            <ErrorBox error={err} />
            {items === null ? <p class="menu-hint">Loading</p> : !items.length ? <p class="menu-hint">Nothing yet. Monitoring findings, screening matches, policy proposals and Travel Rule reviews land here.</p> : (
              <ul class="menu-list">
                {items.map((x) => (
                  <li><button type="button" style={{ paddingLeft: '0.6rem', alignItems: 'flex-start', flexDirection: 'column', gap: '0.15rem' }} onClick={() => open(x, close)}>
                    <span style={{ fontWeight: x.read_at ? 500 : 650 }}>{x.title}</span>
                    <em>{KIND_LABEL[x.kind] ?? x.kind}, {when(x.created_at)}{x.read_at ? '' : ', unread'}</em>
                  </button></li>
                ))}
              </ul>
            )}
            <div class="menu-sec"><a class="menu-a" href="#/notifications" onClick={close}>All notifications</a></div>
          </div>
        )}
      </Popover>
    </div>
  );
}

export function Notifications() {
  const [filter, setFilter] = useState<'unread' | 'all'>('unread');
  const r = usePaged(`/v1/notifications?limit=50&unread=${filter === 'unread'}`, [filter]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<any>(null);
  const rows: any[] = r.rows;
  const unread: number | undefined = r.extra.unread;
  const readAll = async () => {
    setBusy(true); setErr(null);
    try { await api('/v1/notifications/read-all', { body: {} }); r.reload(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const openOne = async (x: any) => {
    if (!x.read_at) { await markRead(x.id); r.setExtra((d) => ({ ...d, unread: Math.max(0, (d.unread ?? 1) - 1) })); r.setRows((rs) => rs.map((y: any) => (y.id === x.id ? { ...y, read_at: new Date().toISOString() } : y))); }
    if (x.link) location.hash = x.link.startsWith('#') ? x.link : `#${x.link}`;
  };
  return (
    <>
      <Head title="Notifications" sub="What Laissez found and what needs a person: monitoring findings, screening matches, policy changes waiting for a second approver, and Travel Rule inquiries held for review. Organization-wide items are shown to everyone; the rest are addressed to you."
        actions={<Btn kind="ghost" busy={busy} disabled={!unread} onClick={readAll}>Mark all read</Btn>} />
      <div class="tabs" role="tablist" aria-label="Filter notifications">
        {([['unread', `Unread${unread !== undefined ? ` (${unread})` : ''}`], ['all', 'All']] as const).map(([v, l]) => <button type="button" role="tab" aria-selected={filter === v} class={filter === v ? 'on' : ''} onClick={() => setFilter(v)}>{l}</button>)}
      </div>
      <ErrorBox error={err} />
      {r.loading && !rows.length ? <Loading /> : r.error ? <ErrorBox error={r.error} onRetry={r.reload} /> : !rows.length ? (
        <Card><Empty title={filter === 'unread' ? 'You are caught up' : 'No notifications yet'}>{filter === 'unread' ? 'New findings appear here and on the bell within a minute.' : 'Monitoring runs nightly and after each sanctions list update.'}</Empty></Card>
      ) : (
        <Card pad={false}>
          <div class="tw"><table class="t">
            <thead><tr><th>When</th><th>Kind</th><th>Notification</th><th></th></tr></thead>
            <tbody>{rows.map((x) => (
              <tr style={x.read_at ? undefined : { background: 'rgba(201, 169, 110, 0.08)' }}>
                <td class="nowrap small muted">{when(x.created_at)}</td>
                <td>{kindChip(x.kind)}</td>
                <td>
                  <div style={{ fontWeight: x.read_at ? 500 : 650 }}>{x.link ? <a href={x.link} onClick={(e) => { e.preventDefault(); openOne(x); }}>{x.title}</a> : x.title}</div>
                  {x.body ? <div class="small muted">{x.body}</div> : null}
                  <div class="small muted">{x.organization_wide ? 'Whole organization' : 'Addressed to you'}{x.read_at ? `, read ${when(x.read_at)}` : ''}</div>
                </td>
                <td>{x.read_at ? null : <Btn kind="ghost" onClick={() => openOne(x)}>{x.link ? 'Open' : 'Mark read'}</Btn>}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <LoadMore p={r} what="notifications" />
        </Card>
      )}
    </>
  );
}
