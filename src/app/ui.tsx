/** @jsxImportSource preact */
import { useEffect, useState, useCallback } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { api, ApiError } from './api';

export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const load = useCallback(() => {
    if (!path) return;
    setLoading(true);
    api<T>(path).then((d) => { setData(d); setError(null); }).catch((e) => setError(e)).finally(() => setLoading(false));
  }, [path, ...deps]);
  useEffect(load, [load]);
  return { data, error, loading, reload: load, setData };
}

export const go = (path: string) => { location.hash = '#' + path; };

export function Head({ title, sub, actions }: { title: string; sub?: ComponentChildren; actions?: ComponentChildren }) {
  return (
    <header class="v-head">
      <div><h1>{title}</h1>{sub ? <p class="v-sub">{sub}</p> : null}</div>
      {actions ? <div class="v-actions">{actions}</div> : null}
    </header>
  );
}

export function Btn({ children, onClick, kind = 'default', disabled, type = 'button', title }: { children: ComponentChildren; onClick?: () => void; kind?: 'default' | 'primary' | 'danger' | 'ghost'; disabled?: boolean; type?: 'button' | 'submit'; title?: string }) {
  return <button type={type} class={`b b-${kind}`} onClick={onClick} disabled={disabled} title={title}>{children}</button>;
}

export function Chip({ tone = 'muted', children }: { tone?: 'ok' | 'no' | 'warn' | 'info' | 'muted'; children: ComponentChildren }) {
  return <span class={`chip c-${tone}`}>{children}</span>;
}
export const outcomeChip = (o: string) => o === 'ALLOW' ? <Chip tone="ok">Allowed</Chip> : o === 'DENY' ? <Chip tone="no">Denied</Chip> : <Chip tone="no">Frozen</Chip>;
export const statusChip = (s: string) => s === 'eligible' ? <Chip tone="ok">Eligible</Chip> : s === 'redemption-only' ? <Chip tone="warn">Redemption-only</Chip> : s === 'frozen' ? <Chip tone="no">Frozen</Chip> : <Chip>{s}</Chip>;

export function ErrorBox({ error, onRetry }: { error: ApiError | Error | null; onRetry?: () => void }) {
  if (!error) return null;
  const detail = (error as ApiError).detail;
  return (
    <div class="err" role="alert">
      <strong>{error.message}</strong>
      {Array.isArray(detail) ? <ul>{detail.map((d: any) => <li>{typeof d === 'string' ? d : d.reason ?? d.detail ?? JSON.stringify(d)}</li>)}</ul> : null}
      {onRetry ? <Btn kind="ghost" onClick={onRetry}>Try again</Btn> : null}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return <div class="loading" aria-live="polite"><span class="spin" aria-hidden="true" />{label}…</div>;
}

export function Empty({ title, children }: { title: string; children?: ComponentChildren }) {
  return <div class="empty-state"><strong>{title}</strong>{children ? <div>{children}</div> : null}</div>;
}

export function Field({ label, hint, children }: { label: string; hint?: ComponentChildren; children: ComponentChildren }) {
  return <label class="f"><span class="f-l">{label}</span>{children}{hint ? <span class="f-h">{hint}</span> : null}</label>;
}

export function Card({ title, actions, children, pad = true }: { title?: ComponentChildren; actions?: ComponentChildren; children: ComponentChildren; pad?: boolean }) {
  return (
    <section class={`card ${pad ? '' : 'np'}`}>
      {title || actions ? <div class="card-h">{title ? <h2>{title}</h2> : <span />}{actions}</div> : null}
      {children}
    </section>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre class="json"><code>{JSON.stringify(value, null, 2)}</code></pre>;
}

export function Toast({ msg }: { msg: string | null }) {
  return msg ? <div class="toast" role="status">{msg}</div> : null;
}

export function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return <Btn kind="ghost" onClick={() => { navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(() => {}); }}>{done ? 'Copied' : label}</Btn>;
}
