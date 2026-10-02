export function GET() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0d0c0b"/><defs><clipPath id="a"><circle cx="12" cy="16" r="8.5"/></clipPath><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e6d2a4"/><stop offset="1" stop-color="#c9a96e"/></linearGradient></defs><circle cx="20" cy="16" r="8.5" fill="url(#g)" clip-path="url(#a)"/><circle cx="12" cy="16" r="8.5" fill="none" stroke="#ece8e1" stroke-width="1.5"/><circle cx="20" cy="16" r="8.5" fill="none" stroke="#ece8e1" stroke-width="1.5"/></svg>`;
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } });
}
