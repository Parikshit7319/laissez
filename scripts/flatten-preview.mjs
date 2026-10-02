// Rewrites the PUBLIC_ARTIFACT build so every link is relative,
// and strips the document wrapper from index.html for the hosted preview.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
const dir = 'dist-preview';
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
for (const file of walk(dir).filter((f) => f.endsWith('.html'))) {
  const rel = relative(dir, file);
  const depth = rel.split(sep).length - 1;
  const up = '../'.repeat(depth);
  let s = readFileSync(file, 'utf8');
  s = s.replace(/(href|src|component-url|renderer-url|before-hydration-url)="\/(assets\/[^"]+)"/g, `$1="${up || './'}$2"`);
  s = s.replace(/href="\/favicon\.svg"/g, `href="${up}favicon.svg"`);
  s = s.replace(/href="\/"/g, `href="${up}index.html"`);
  s = s.replace(/href="\/([a-z0-9/-]+?)\/?(#[^"]*)?"/g, (_, p, h) => `href="${up}${p}.html${h ?? ''}"`);
  if (rel === 'index.html') {
    const head = s.match(/<head>([\s\S]*?)<\/head>/)[1];
    const body = s.match(/<body[^>]*>([\s\S]*?)<\/body>/)[1];
    s = head.replace(/<meta charset="utf-8">|<meta name="viewport"[^>]*>/g, '') + '\n' + body;
  }
  writeFileSync(file, s);
}
console.log('flattened');
