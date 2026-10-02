/** @jsxImportSource preact */
// Cursor pagination for list views. The API answers { data, next_cursor, limit, ...extras }; usePaged loads the
// first page, keeps the extras (counts, unread, threshold) from the latest response, and appends further pages
// on demand. LoadMore renders the button under a table.
import { useEffect, useState } from 'preact/hooks';
import { api } from './api';
import { Btn } from './ui';

export type Paged<T> = { rows: T[]; extra: Record<string, any>; next: string | null; loading: boolean; more: boolean; error: any; loadMore: () => Promise<void>; reload: () => void; setRows: (f: (rows: T[]) => T[]) => void; setExtra: (f: (x: Record<string, any>) => Record<string, any>) => void };

export function usePaged<T = any>(path: string | null, deps: unknown[] = []): Paged<T> {
  const [rows, setRows] = useState<T[]>([]);
  const [extra, setExtra] = useState<Record<string, any>>({});
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<any>(null);
  const [n, setN] = useState(0);
  const strip = ({ data, next_cursor, limit, ...rest }: any) => rest;
  useEffect(() => {
    if (!path) return;
    let live = true; setLoading(true);
    api(path).then((d) => { if (!live) return; setRows(d.data ?? []); setExtra(strip(d)); setNext(d.next_cursor ?? null); setError(null); }).catch((e) => { if (live) setError(e); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [path, n, ...deps]);
  const loadMore = async () => {
    if (!next || !path) return;
    setMore(true);
    try { const d = await api(`${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(next)}`); setRows((r) => [...r, ...(d.data ?? [])]); setExtra(strip(d)); setNext(d.next_cursor ?? null); }
    catch (e) { setError(e); } finally { setMore(false); }
  };
  return { rows, extra, next, loading, more, error, loadMore, reload: () => setN((x) => x + 1), setRows: (f) => setRows((r) => f(r)), setExtra: (f) => setExtra((x) => f(x)) };
}

export function LoadMore({ p, what = 'rows' }: { p: { next: string | null; more: boolean; loadMore: () => void; rows: any[] }; what?: string }) {
  if (!p.next) return p.rows.length > 50 ? <p class="small muted" style={{ marginTop: '0.6rem' }}>All {p.rows.length} {what} loaded.</p> : null;
  return <div class="row-inline" style={{ justifyContent: 'center', marginTop: '0.8rem', marginBottom: '0.8rem' }}><Btn kind="ghost" busy={p.more} onClick={p.loadMore}>{p.more ? 'Loading' : `Load more ${what}`}</Btn><span class="small muted">{p.rows.length} loaded</span></div>;
}
