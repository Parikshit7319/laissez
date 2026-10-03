/** @jsxImportSource preact */
// Cloudflare Turnstile bot check. Rendered only when the API reports a site key (GET /v1/auth/config), so a deployment
// without one shows nothing and the API does not ask for a token.
import { useEffect, useRef } from 'preact/hooks';

declare global { interface Window { turnstile?: any; __lzTurnstile?: Promise<void> } }

function load(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!window.__lzTurnstile) {
    window.__lzTurnstile = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { window.__lzTurnstile = undefined; reject(new Error('The bot check could not load. Check your connection, disable blockers for this page and reload.')); };
      document.head.appendChild(s);
    });
  }
  return window.__lzTurnstile;
}

/** `nonce` changes after a failed submit: Turnstile tokens work once, so the widget resets for a fresh one. */
export function Turnstile({ siteKey, onToken, onError, nonce = 0 }: { siteKey: string; onToken: (token: string | null) => void; onError?: (message: string) => void; nonce?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  useEffect(() => {
    let dead = false;
    load().then(() => {
      if (dead || !box.current || !window.turnstile) return;
      widget.current = window.turnstile.render(box.current, {
        sitekey: siteKey,
        callback: (t: string) => onToken(t),
        'expired-callback': () => onToken(null),
        'error-callback': () => { onToken(null); onError?.('The bot check failed. Reload the page and try again.'); },
      });
    }).catch((e) => onError?.(e.message));
    return () => { dead = true; try { if (widget.current) window.turnstile?.remove(widget.current); } catch { /* already gone */ } widget.current = null; };
  }, [siteKey]);
  useEffect(() => { if (nonce && widget.current) { try { window.turnstile?.reset(widget.current); } catch { /* ignore */ } } }, [nonce]);
  return <div ref={box} class="turnstile" aria-label="Bot check" />;
}
