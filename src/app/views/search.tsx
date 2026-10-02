/** @jsxImportSource preact */
// Global data search. Cmd/Ctrl+K opens a palette that queries GET /v1/search as you type (debounced) and
// groups clients, decisions, funds, settlements, work items and documents. Arrow keys move, Enter opens, Escape closes.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from '../api';

type Item = { id: string; title: string; subtitle: string; link: string };
type Group = { group: string; items: Item[] };

const CSS = `
.sp-wrap{position:fixed;inset:0;background:rgba(20,24,22,.42);display:flex;align-items:flex-start;justify-content:center;padding:10vh 1rem 1rem;z-index:60}
.sp{width:min(680px,100%);background:#fff;border:1px solid var(--line,#ddd);border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.25);overflow:hidden}
.sp-in{display:flex;align-items:center;gap:.6rem;padding:.8rem 1rem;border-bottom:1px solid var(--line,#ddd)}
.sp-in input{flex:1;border:0;outline:0;font:inherit;font-size:1.05rem;background:transparent}
.sp-in kbd{font-size:.7rem;color:var(--ink-3,#777);border:1px solid var(--line,#ddd);border-radius:4px;padding:.1rem .35rem}
.sp-body{max-height:min(60vh,520px);overflow:auto;padding:.4rem 0}
.sp-g{padding:.5rem 1rem .2rem;font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3,#777)}
.sp-item{display:flex;flex-direction:column;gap:.1rem;width:100%;text-align:left;padding:.5rem 1rem;border:0;background:transparent;cursor:pointer;font:inherit;color:inherit}
.sp-item[aria-selected="true"],.sp-item:hover{background:#f1f5f2}
.sp-item b{font-weight:600}
.sp-item span{font-size:.82rem;color:var(--ink-2,#555);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sp-empty{padding:1.2rem 1rem;color:var(--ink-2,#555);font-size:.9rem}
.sp-foot{display:flex;gap:1rem;padding:.5rem 1rem;border-top:1px solid var(--line,#ddd);font-size:.75rem;color:var(--ink-3,#777)}
`;

export function SearchPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  // Cmd/Ctrl+K toggles the palette from anywhere, even inside a field.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, []);
  useEffect(() => {
    if (!open) { setQ(''); setGroups([]); setErr(null); setSel(0); return; }
    setTimeout(() => input.current?.focus(), 0);
  }, [open]);
  // Debounced query.
  useEffect(() => {
    if (!open) return;
    const s = q.trim();
    if (s.length < 2) { setGroups([]); setBusy(false); return; }
    const mine = ++seq.current;
    setBusy(true);
    const t = window.setTimeout(() => {
      api(`/v1/search?q=${encodeURIComponent(s)}`).then((r) => { if (seq.current !== mine) return; setGroups(r.groups ?? []); setErr(null); setSel(0); }).catch((e) => { if (seq.current === mine) setErr(e.message); }).finally(() => { if (seq.current === mine) setBusy(false); });
    }, 250);
    return () => clearTimeout(t);
  }, [q, open]);
  const flat = useMemo(() => groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group }))), [groups]);
  const pick = (it: Item) => { setOpen(false); location.hash = it.link.startsWith('#') ? it.link : `#${it.link}`; };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(flat.length - 1, s + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); return; }
    if (e.key === 'Enter' && flat[sel]) { e.preventDefault(); pick(flat[sel]); }
  };
  useEffect(() => { document.getElementById(`sp-opt-${sel}`)?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  if (!open) return null;
  let idx = -1;
  return (
    <div class="sp-wrap" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <style>{CSS}</style>
      <div class="sp" role="dialog" aria-modal="true" aria-label="Search the organization">
        <div class="sp-in">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
          <input ref={input} type="search" placeholder="Search clients, decisions, funds, settlements, work items, documents" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={onKey}
            role="combobox" aria-expanded={flat.length > 0} aria-controls="sp-list" aria-activedescendant={flat.length ? `sp-opt-${sel}` : undefined} autoComplete="off" spellcheck={false} />
          <kbd>Esc</kbd>
        </div>
        <div class="sp-body" id="sp-list" role="listbox" aria-label="Results">
          {q.trim().length < 2 ? <p class="sp-empty">Type at least two characters. Matches by name, id, passport number, ticker, headline or title.</p>
            : err ? <p class="sp-empty">{err}</p>
            : !flat.length ? <p class="sp-empty">{busy ? 'Searching…' : `Nothing matches "${q.trim()}".`}</p>
            : groups.map((g) => (
              <div>
                <div class="sp-g">{g.group}</div>
                {g.items.map((it) => { idx++; const i = idx; return (
                  <button type="button" id={`sp-opt-${i}`} class="sp-item" role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => pick(it)}>
                    <b>{it.title}</b>{it.subtitle ? <span>{it.subtitle}</span> : null}
                  </button>
                ); })}
              </div>
            ))}
        </div>
        <div class="sp-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span><span style={{ marginLeft: 'auto' }}>{busy ? 'Searching' : flat.length ? `${flat.length} result${flat.length === 1 ? '' : 's'}` : ''}</span></div>
      </div>
    </div>
  );
}

/** A small button for the top bar that opens the palette, for people who do not know the shortcut. */
export function SearchButton() {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const fire = () => dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: mac, ctrlKey: !mac, bubbles: true }));
  return <button type="button" class="b b-ghost" onClick={fire} aria-label="Search the organization" title={`Search (${mac ? 'Cmd' : 'Ctrl'}+K)`}>Search <kbd style={{ fontSize: '.7rem', marginLeft: '.3rem' }}>{mac ? '⌘' : 'Ctrl'}K</kbd></button>;
}
