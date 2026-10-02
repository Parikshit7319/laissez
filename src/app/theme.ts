// Theme preference for the app: system (follow the operating system), light or dark. Stored per browser in
// localStorage and applied as data-theme on <html>, which the tokens in src/styles/global.css read.
export type Theme = 'system' | 'light' | 'dark';
export const THEME_KEY = 'laissez-theme';
export const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: 'system', label: 'System', hint: 'Follows your operating system setting.' },
  { id: 'light', label: 'Light', hint: 'Paper and ink.' },
  { id: 'dark', label: 'Dark', hint: 'Dark paper, warm ink. Same green.' },
];
const EVENT = 'laissez-theme-change';

export function readTheme(): Theme {
  try { const v = localStorage.getItem(THEME_KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}
/** Writes the attribute the stylesheet reads. "system" removes it so the media query decides. */
export function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === 'system') el.removeAttribute('data-theme'); else el.setAttribute('data-theme', t);
}
export function setTheme(t: Theme) {
  try { if (t === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ }
  applyTheme(t);
  dispatchEvent(new CustomEvent(EVENT, { detail: t }));
}
/** The theme in effect right now, resolving "system" through the media query. */
export function effectiveTheme(t: Theme = readTheme()): 'light' | 'dark' {
  if (t !== 'system') return t;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
export function onThemeChange(fn: (t: Theme) => void): () => void {
  const h = (e: Event) => fn((e as CustomEvent).detail as Theme);
  addEventListener(EVENT, h);
  return () => removeEventListener(EVENT, h);
}
