/** @jsxImportSource preact */
// Sidebar page search for the app. Type to filter pages; Enter opens the first match; Escape clears.
// The shell focuses the input when "/" is pressed anywhere outside a form field.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { NavGroup } from '../app/registry';

export const SEARCH_INPUT_ID = 'app-search';

export function Search({ groups, onPick }: { groups: NavGroup[]; onPick?: () => void }) {
  const [q, setQ] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  const flat = useMemo(() => groups.flatMap((g) => g.items.map((r) => ({ group: g.group, label: r.label!, pattern: r.pattern }))), [groups]);
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const words = s.split(/\s+/);
    return flat.filter((r) => { const hay = `${r.label} ${r.group}`.toLowerCase(); return words.every((w) => hay.includes(w)); }).slice(0, 8);
  }, [q, flat]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  const go = (pattern: string) => { location.hash = '#' + pattern; setQ(''); ref.current?.blur(); onPick?.(); };
  return (
    <div class="search" role="search">
      <label class="sr" for={SEARCH_INPUT_ID}>Search pages</label>
      <div class="search-box">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
        <input
          id={SEARCH_INPUT_ID} ref={ref} type="search" placeholder="Search pages" autoComplete="off" spellcheck={false}
          value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hits[0]) { e.preventDefault(); go(hits[0].pattern); }
            if (e.key === 'Escape') { setQ(''); (e.target as HTMLInputElement).blur(); }
          }}
          aria-controls="app-search-results" aria-expanded={hits.length > 0}
        />
        <kbd aria-hidden="true">/</kbd>
      </div>
      {q.trim() ? (
        <ul class="search-results" id="app-search-results" role="listbox" aria-label="Matching pages">
          {hits.length ? hits.map((h, i) => (
            <li role="option" aria-selected={i === 0}><button type="button" onClick={() => go(h.pattern)}><span>{h.label}</span><em>{h.group}</em></button></li>
          )) : <li class="none">No page matches "{q.trim()}".</li>}
        </ul>
      ) : null}
    </div>
  );
}
