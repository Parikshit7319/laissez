// One polling store per endpoint, shared by every island on the page. ES modules are singletons in the
// browser, so the metrics page makes one request per endpoint per minute however many islands read it.
import { useEffect, useState } from 'preact/hooks';
import { ENDPOINTS, getJson, type EndpointKey } from './api';

export const REFRESH_MS = 60_000;

export type LiveState<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** When the current data was received. */
  updatedAt: number | null;
  /** When the latest failed attempt happened, if the latest attempt failed. */
  failedAt: number | null;
  /** Last time this browser got a good answer from the endpoint, including earlier visits. */
  lastOkAt: number | null;
};

type Store = {
  state: LiveState<unknown>;
  subs: Set<(s: LiveState<unknown>) => void>;
  timer: ReturnType<typeof setInterval> | null;
  inflight: Promise<void> | null;
  refresh: () => Promise<void>;
};

const stores = new Map<EndpointKey, Store>();
const memKey = (k: EndpointKey) => `laissez-live-last-ok-${k}`;
const readLastOk = (k: EndpointKey): number | null => {
  try { const v = Number(localStorage.getItem(memKey(k))); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
};
const writeLastOk = (k: EndpointKey, t: number) => { try { localStorage.setItem(memKey(k), String(t)); } catch { /* storage blocked */ } };

function storeFor(key: EndpointKey): Store {
  let s = stores.get(key);
  if (s) return s;
  const store: Store = {
    state: { data: null, error: null, loading: true, updatedAt: null, failedAt: null, lastOkAt: null },
    subs: new Set(),
    timer: null,
    inflight: null,
    refresh: () => {
      if (store.inflight) return store.inflight;
      set({ loading: true });
      store.inflight = getJson(ENDPOINTS[key])
        .then((data) => { const now = Date.now(); writeLastOk(key, now); set({ data, error: null, loading: false, updatedAt: now, failedAt: null, lastOkAt: now }); })
        .catch((e: Error) => set({ error: e.message || 'The request failed.', loading: false, failedAt: Date.now() }))
        .finally(() => { store.inflight = null; });
      return store.inflight;
    },
  };
  const set = (patch: Partial<LiveState<unknown>>) => {
    store.state = { ...store.state, ...patch };
    store.subs.forEach((f) => f(store.state));
  };
  if (typeof window !== 'undefined') store.state.lastOkAt = readLastOk(key);
  stores.set(key, store);
  return store;
}

function start(key: EndpointKey, store: Store) {
  if (store.timer || typeof window === 'undefined') return;
  if (!store.state.updatedAt && !store.inflight) store.refresh();
  store.timer = setInterval(() => { if (!document.hidden) store.refresh(); }, REFRESH_MS);
  if (!visibilityBound.has(key)) {
    visibilityBound.add(key);
    document.addEventListener('visibilitychange', () => {
      const st = stores.get(key);
      if (!st || !st.subs.size || document.hidden) return;
      const last = Math.max(st.state.updatedAt ?? 0, st.state.failedAt ?? 0);
      if (Date.now() - last > REFRESH_MS) st.refresh();
    });
  }
}
const visibilityBound = new Set<EndpointKey>();

/** Subscribe to a live endpoint. Polls every 60 seconds while the page is visible. */
export function useLive<T>(key: EndpointKey): LiveState<T> & { refresh: () => void } {
  const store = storeFor(key);
  const [state, setState] = useState<LiveState<unknown>>(store.state);
  useEffect(() => {
    store.subs.add(setState);
    setState(store.state);
    start(key, store);
    return () => {
      store.subs.delete(setState);
      if (!store.subs.size && store.timer) { clearInterval(store.timer); store.timer = null; }
    };
  }, [key]);
  return { ...(state as LiveState<T>), refresh: () => { store.refresh(); } };
}

/** Re-render on an interval, for relative times such as "3 min ago". */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
