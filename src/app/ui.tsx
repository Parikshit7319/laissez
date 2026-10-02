/** @jsxImportSource preact */
import { useEffect, useState, useCallback, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { api, ApiError, shortHash, txUrl } from './api';

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

type BtnProps = {
  children: ComponentChildren; onClick?: () => void; kind?: 'default' | 'primary' | 'danger' | 'ghost'; disabled?: boolean;
  type?: 'button' | 'submit'; title?: string; ariaLabel?: string; describedBy?: string; class?: string; busy?: boolean;
};
export function Btn({ children, onClick, kind = 'default', disabled, type = 'button', title, ariaLabel, describedBy, class: cls, busy }: BtnProps) {
  return (
    <button type={type} class={`b b-${kind}${cls ? ` ${cls}` : ''}`} onClick={onClick} disabled={disabled || busy} title={title} aria-label={ariaLabel} aria-describedby={describedBy} aria-busy={busy ? 'true' : undefined}>
      {busy ? <span class="spin sm" aria-hidden="true" /> : null}{children}
    </button>
  );
}

export function Chip({ tone = 'muted', children, title }: { tone?: 'ok' | 'no' | 'warn' | 'info' | 'muted' | 'brass'; children: ComponentChildren; title?: string }) {
  return <span class={`chip c-${tone}`} title={title}>{children}</span>;
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

export function Card({ title, actions, children, pad = true, class: cls }: { title?: ComponentChildren; actions?: ComponentChildren; children: ComponentChildren; pad?: boolean; class?: string }) {
  return (
    <section class={`card ${pad ? '' : 'np'}${cls ? ` ${cls}` : ''}`}>
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
  const copy = () => {
    const ok = () => { setDone(true); setTimeout(() => setDone(false), 1500); };
    try { navigator.clipboard?.writeText(text).then(ok).catch(() => {}); } catch { /* clipboard blocked */ }
  };
  return <Btn kind="ghost" onClick={copy} ariaLabel={done ? 'Copied' : `${label} to clipboard`}>{done ? 'Copied' : label}</Btn>;
}

/** Two-step button for destructive actions: the first press asks, the second acts. */
export function ConfirmBtn({ children, confirm, onConfirm, disabled, title, kind = 'danger' }: { children: ComponentChildren; confirm: string; onConfirm: () => Promise<unknown> | void; disabled?: boolean; title?: string; kind?: 'danger' | 'ghost' | 'default' }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking) return <Btn kind={kind} disabled={disabled} title={title} onClick={() => setAsking(true)}>{children}</Btn>;
  return (
    <span class="row-inline tight">
      <Btn kind="danger" busy={busy} onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); setAsking(false); } }}>{confirm}</Btn>
      <Btn kind="ghost" onClick={() => setAsking(false)}>Cancel</Btn>
    </span>
  );
}

/** A secret or link shown once, with a copy button. */
export function Reveal({ label, value, note }: { label: string; value: string; note?: ComponentChildren }) {
  return (
    <div class="reveal" role="status">
      <span class="f-l">{label}</span>
      <div class="reveal-row"><code class="break">{value}</code><Copy text={value} /></div>
      {note ? <p class="small muted">{note}</p> : null}
    </div>
  );
}

/** A short hash with the full value on hover and a copy button. */
export function Hash({ value, n = 10 }: { value?: string | null; n?: number }) {
  if (!value) return <span class="muted">None</span>;
  return <code class="hash" title={value}>{shortHash(value, n)}</code>;
}

/** Link to a Base Sepolia transaction. */
export function TxLink({ hash }: { hash?: string | null }) {
  if (!hash) return null;
  return <a class="mono small" href={txUrl(hash)} target="_blank" rel="noopener">{shortHash(hash, 14)} <span aria-hidden="true">↗</span><span class="sr">(opens Basescan)</span></a>;
}

/** Button with a floating panel. Closes on outside click and Escape, returns focus to the button. */
export function Popover({ label, children, class: cls, align = 'end', ariaLabel }: { label: ComponentChildren; children: (close: () => void) => ComponentChildren; class?: string; align?: 'start' | 'end'; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const close = () => { setOpen(false); btn.current?.focus(); };
  return (
    <div class={`pop ${cls ?? ''}`} ref={ref}>
      <button ref={btn} type="button" class="pop-btn" aria-expanded={open} aria-haspopup="true" aria-label={ariaLabel} onClick={() => setOpen(!open)}>{label}</button>
      {open ? <div class={`pop-panel pop-${align}`}>{children(close)}</div> : null}
    </div>
  );
}
