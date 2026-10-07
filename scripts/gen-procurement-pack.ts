// Builds public/laissez-procurement-pack.pdf: what a bank's procurement and security teams ask for before anyone reads
// the API docs. Generated from the same data the Trust and Sub-processors pages render (src/data/trust.ts), so the PDF
// cannot drift from the site. Run with npm run docs:pack (also runs before every build).
//
// A small multi-page PDF writer lives here on purpose: the built-in Helvetica faces, printable ASCII, no dependency.
import { writeFileSync, mkdirSync } from 'node:fs';
import { roles, matrix, controls, subprocessors } from '../src/data/trust';

const W = 595.28; const H = 841.89; const M = 52; const BODY = 10; const LEAD = 14;
const ascii = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2013\u2014]/g, '-').replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/\u20ac/g, 'EUR').replace(/[^\x20-\x7e]/g, '');
const esc = (s: string) => ascii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
// Helvetica average glyph width is about 0.5em; wrap by estimated width so long words do not overflow the margin.
const wrap = (s: string, size: number, width: number): string[] => {
  const max = Math.floor(width / (size * 0.5));
  const out: string[] = []; let line = '';
  for (const w of ascii(s).split(/\s+/).filter(Boolean)) {
    if ((line + ' ' + w).trim().length > max) { if (line) out.push(line); line = w; } else line = (line + ' ' + w).trim();
  }
  if (line) out.push(line);
  return out.length ? out : [''];
};

class Pdf {
  pages: string[][] = [];
  ops: string[] = [];
  y = M;
  pageNo = 0;
  constructor(public title: string, public footer: string) { this.newPage(); }
  newPage() {
    if (this.ops.length) this.pages.push(this.ops);
    this.ops = []; this.y = M; this.pageNo++;
    this.text(`${this.title}`, 8, 'F2', M, H - 24, 0.45);
    this.text(`${this.footer}  Page ${this.pageNo}`, 8, 'F1', M, 22, 0.45);
  }
  text(s: string, size: number, font: 'F1' | 'F2' | 'F3', x: number, yFromBottom: number, gray = 0) {
    this.ops.push(`BT /${font} ${size} Tf ${gray} g ${x.toFixed(2)} ${yFromBottom.toFixed(2)} Td (${esc(s)}) Tj ET`);
  }
  ensure(h: number) { if (this.y + h > H - M - 10) this.newPage(); }
  h1(s: string) { this.ensure(40); this.y += 8; this.text(s, 20, 'F2', M, H - this.y - 18); this.y += 34; }
  h2(s: string) { this.ensure(30); this.y += 6; this.text(s, 13, 'F2', M, H - this.y - 12); this.y += 24; }
  p(s: string, opts: { size?: number; gray?: number; indent?: number; font?: 'F1' | 'F2' | 'F3' } = {}) {
    const size = opts.size ?? BODY; const indent = opts.indent ?? 0;
    for (const line of wrap(s, size, W - 2 * M - indent)) { this.ensure(LEAD); this.text(line, size, opts.font ?? 'F1', M + indent, H - this.y - size, opts.gray ?? 0); this.y += LEAD; }
    this.y += 4;
  }
  kv(k: string, v: string) {
    const lines = wrap(v, BODY, W - 2 * M - 150);
    this.ensure(LEAD * lines.length + 2);
    this.text(k, BODY, 'F2', M, H - this.y - BODY);
    lines.forEach((l, i) => { this.text(l, BODY, 'F1', M + 150, H - this.y - BODY); this.y += LEAD; });
    this.y += 2;
  }
  rule() { this.ensure(10); this.ops.push(`0.8 G 0.5 w ${M} ${(H - this.y - 2).toFixed(2)} m ${W - M} ${(H - this.y - 2).toFixed(2)} l S`); this.y += 8; }
  table(head: string[], rows: string[][], widths: number[], size = 8.5) {
    const lead = size * 1.35;
    const draw = (cells: string[], bold: boolean) => {
      const wrapped = cells.map((c, i) => wrap(c, size, widths[i] - 6));
      const h = Math.max(...wrapped.map((w) => w.length)) * lead + 6;
      this.ensure(h);
      let x = M;
      wrapped.forEach((lines, i) => { lines.forEach((l, j) => this.text(l, size, bold ? 'F2' : 'F1', x + 2, H - this.y - size - j * lead)); x += widths[i]; });
      this.y += h;
      this.ops.push(`0.85 G 0.4 w ${M} ${(H - this.y + 2).toFixed(2)} m ${W - M} ${(H - this.y + 2).toFixed(2)} l S`);
    };
    draw(head, true);
    for (const r of rows) draw(r, false);
    this.y += 6;
  }
  bytes(): Uint8Array {
    if (this.ops.length) this.pages.push(this.ops);
    const objs: string[] = [];
    const add = (s: string) => { objs.push(s); return objs.length; };
    const fonts = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontB = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const fontM = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
    const pagesId = objs.length + 1 + this.pages.length * 2;
    const pageIds: number[] = [];
    for (const ops of this.pages) {
      const stream = ops.join('\n');
      const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${fonts} 0 R /F2 ${fontB} 0 R /F3 ${fontM} 0 R >> >> /Contents ${content} 0 R >>`));
    }
    add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
    const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    const info = add(`<< /Title (${esc(this.title)}) /Producer (Laissez) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

const today = new Date().toISOString().slice(0, 10);
const pdf = new Pdf('Laissez procurement and security pack', `Laissez, generated ${today} from the public Trust pages. Pre-launch; no certifications. parikshit.ambhore@rice.edu`);

// ---------- Cover ----------
pdf.y = 140;
pdf.text('Laissez', 34, 'F2', M, H - pdf.y); pdf.y += 46;
pdf.text('Procurement and security pack', 18, 'F1', M, H - pdf.y); pdf.y += 30;
pdf.p('Compliance and settlement layer for tokenized funds. A distributor verifies an investor once; Laissez resolves every rule that applies to each order across jurisdictions, settles cash and fund units together, and keeps a signed record of which rule decided.', { size: 11 });
pdf.y += 10;
pdf.p(`Generated ${today} from https://parikshit7319.github.io/laissez/trust/ and the sub-processors page. The website is the current version; this file is a snapshot for a procurement folder.`, { gray: 0.35 });
pdf.y += 10;
pdf.p('What is in this pack', { font: 'F2' });
for (const s of ['1. Company and product summary', '2. Architecture and data flow', '3. Security questionnaire answers (SIG Lite and CAIQ style)', '4. SOC 2 controls map, state by criterion', '5. Access model: roles and permissions', '6. Sub-processors', '7. Business continuity and recovery', '8. Legal documents and contacts', '9. What is not yet done']) pdf.p(s, { indent: 12 });
pdf.y += 10;
pdf.p('Honesty note. Laissez is pre-launch: no SOC 2 report, no penetration test report, no production customers, no legal entity yet. Every answer below says so where it applies. A questionnaire that read better than this would be wrong.', { gray: 0.25 });

// ---------- 1. Company and product ----------
pdf.newPage();
pdf.h1('1. Company and product summary');
pdf.kv('Product', 'Laissez: eligibility credentials, a policy resolver across jurisdictions, atomic delivery versus payment, a credential network with investor consent, a white-label investor portal, Travel Rule messaging, and a hash-chained, anchored audit log.');
pdf.kv('Status', 'Pre-launch. Live sandbox at https://parikshit7319.github.io/laissez/app/ with fictional institutions. Recruiting design partners for a 90-day pilot on test networks.');
pdf.kv('Founder', 'Parikshit Ambhore. Former lead engineer at FIS delivering Franklin Templeton\'s institutional transfer agency platform; software engineer in payments and supply chain; founder of a healthcare SaaS; MBA candidate, Rice University (2027).');
pdf.kv('Legal entity', 'Not yet formed. Pilot agreements are signed by the founder personally until incorporation; counsel review of terms, privacy and the draft DPA is pending.');
pdf.kv('Hosting', 'Cloudflare Workers (API, global edge), Neon (managed Postgres, one US region), GitHub Pages (site and app), GitHub Actions (scheduled jobs).');
pdf.kv('Deployment modes', 'Full: Laissez decides and settles. Decide-only: Laissez returns decisions and evidence; the customer settles on its own rails and every settlement route is closed. On-chain settlement is limited to test networks in code.');
pdf.kv('Support', 'Email to the founder; two business day reply. Status page with 90 days of uptime at /status/. No paid support tiers yet.');

// ---------- 2. Architecture ----------
pdf.h1('2. Architecture and data flow');
pdf.p('Request path. A distributor\'s system or a signed-in person calls the API over TLS. Authentication is a passkey or SSO session, or a scoped API key. Every request is tenant-scoped by Postgres row-level security; every write is permission-checked, audited into a hash chain, and emitted to the customer\'s webhooks.');
pdf.table(['Component', 'Runs where', 'Holds', 'Trust boundary'], [
  ['Site and app (static)', 'GitHub Pages', 'No customer data', 'Public; the app stores a session token in the browser only'],
  ['API (Hono on Cloudflare Workers)', 'Cloudflare edge, every region', 'Nothing at rest; secrets as Worker secrets', 'TLS, HSTS, security headers, rate limits, IP allowlists on keys'],
  ['Database (Postgres on Neon)', 'One US region', 'All customer data, audit log, billing', 'Row-level security per organization; owner role only for staff paths'],
  ['Scheduled jobs (GitHub Actions)', 'GitHub-hosted runners', 'No persistent data', 'Owner connection string as a repository secret'],
  ['Chain (Base Sepolia test network)', 'Public test network', 'Hashes, claims, test tokens; no personal data', 'Operator key as a Worker secret; signing refused on non-test chains'],
  ['Email (Resend), payments (Stripe), identity checks (Sumsub)', 'Vendor clouds', 'See sub-processors', 'Switched on per deployment by secret; off by default'],
], [130, 110, 125, 126]);
pdf.p('Data flow for an order. 1) The distributor creates a client and issues a credential (evidence stays with the distributor; the credential carries references and hashes). 2) An order asks for a decision: the engine evaluates seven layers in order and returns the binding rule, a signed receipt and an input hash. 3) Settlement re-checks the decision at the moment of settlement and moves both legs together, or neither. 4) The audit log records every step; a daily Merkle root of every organization\'s log head is anchored on-chain; customers can push the log to their SIEM or a write-once bucket.');
pdf.p('What never leaves the customer. Identity documents (they go from the client to the identity provider), card and bank details (Stripe-hosted pages), and personal data on-chain (none: outcome, hash and rule versions only).');

// ---------- 3. Questionnaire ----------
pdf.newPage();
pdf.h1('3. Security questionnaire answers');
pdf.p('Written in the shape of SIG Lite and CAIQ questions. "Yes" means built and in the current release; "Partial" means built with a named gap; "No" means not yet.', { gray: 0.3 });
const qa: [string, [string, string, string][]][] = [
  ['Governance and risk', [
    ['Do you have an information security policy approved by management?', 'Partial', 'Written practices live in the public Trust page and the runbook (incident checklist, key rotation, restore drills). No board-approved policy document yet; there is one person.'],
    ['Do you hold SOC 2, ISO 27001 or equivalent?', 'No', 'A controls map against SOC 2 criteria is published with the state of each criterion (section 4). The audit has not started.'],
    ['Do you carry cyber and E&O insurance?', 'No', 'Quotes will be taken at incorporation. Pilots run on test networks with fictional money.'],
    ['Do you perform background checks on staff?', 'Not applicable', 'Single founder. A hiring policy will cover this before the first employee.'],
  ]],
  ['Access control', [
    ['Is multi-factor authentication enforced?', 'Yes', 'Passkeys only; no passwords exist. An authenticator app can be added. Sensitive actions require a fresh passkey assertion (step-up) within ten minutes.'],
    ['Can we use our own identity provider?', 'Yes', 'OpenID Connect with PKCE. Organizations can require SSO; administrators keep passkeys as break-glass. SCIM provisioning is available.'],
    ['Is access role-based with least privilege?', 'Yes', 'Seven roles, fifteen permissions (section 5). Approvals, member changes and billing are human-only; API keys cannot perform them.'],
    ['Can we restrict access by network or device?', 'Yes', 'Per-organization policy: approved networks (CIDR), allowed email domains, session and idle limits, user-verified passkeys. API keys carry IP allowlists and expiry.'],
    ['Are access reviews performed?', 'No', 'Membership and role changes are audited and alerted; no periodic re-certification yet.'],
    ['How are investor (end-client) users authenticated?', 'Yes', 'A private link invites; a passkey account with an optional authenticator app secures the portal. Distributors can require accounts, after which links alone no longer open the portal.'],
  ]],
  ['Data protection', [
    ['Is data encrypted in transit and at rest?', 'Yes', 'TLS 1.2+ everywhere with HSTS. Storage encryption by the database provider. Secrets (SSO client secrets, authenticator seeds, SIEM credentials) and identity-check evidence are additionally sealed with AES-GCM under keys held only by the API.'],
    ['Is customer data logically separated?', 'Yes', 'Postgres row-level security on every tenant table; the tenant role cannot read outside its organization. Owner-role paths are limited and audited.'],
    ['Where is data stored and can we choose a region?', 'Partial', 'One United States region today. No residency choice yet.'],
    ['Do you support customer-managed keys?', 'No', 'Planned after the first production corridor.'],
    ['Can we export and delete our data?', 'Yes', 'Full organization export (JSON) by an administrator, including during a billing suspension; per-person export and deletion; CSV exports escaped against spreadsheet formulas.'],
    ['Do you process payment card data?', 'No', 'Stripe-hosted invoice pages. Card and bank numbers never reach Laissez.'],
    ['What personal data is placed on a blockchain?', 'None', 'Outcome, input hash and rule versions. Claims carry a credential hash and an expiry.'],
  ]],
  ['Application security', [
    ['Is code reviewed and tested before release?', 'Partial', 'The site deploys only after the full suite passes (engine, rule-pack regression, OpenAPI coverage, security and billing end-to-end, chain tests). Secret scanning, dependency audit with an expiring allowlist, and CodeQL run on every push and weekly. No second human reviewer yet.'],
    ['Have you had an independent penetration test?', 'No', 'Budgeted for the pilot phase. Tenant isolation has not been independently attacked.'],
    ['How are vulnerabilities in dependencies handled?', 'Yes', 'CI fails on any high or critical advisory in production dependencies unless allowlisted with a reason and a review date; expired exceptions fail the build again.'],
    ['Do you have a responsible disclosure channel?', 'Partial', 'A security contact is published. No bounty.'],
    ['Are webhooks and callbacks authenticated?', 'Yes', 'HMAC-SHA256 signatures with timestamps on outbound webhooks and SIEM pushes; inbound provider webhooks (Stripe, Sumsub) are verified against their secrets.'],
  ]],
  ['Logging and monitoring', [
    ['Is there an immutable audit trail?', 'Yes', 'Every write is an audit event with a sequence number and a hash over its content and the previous hash, per organization. Anyone with read access can verify the chain in one call. A daily Merkle root is anchored on a public test network once the chain deployment is live.'],
    ['Can we receive the audit log in our SIEM?', 'Yes', 'Splunk HTTP Event Collector, a signed HTTPS endpoint, or an S3 bucket with Object Lock (write-once). Incremental, ordered, every ten minutes, with backfill.'],
    ['Is production monitored with alerting and on-call?', 'Partial', 'Five components checked every ten minutes on a public status page; security events email administrators. No paging rotation.'],
  ]],
  ['Business continuity', [
    ['What are your RTO and RPO?', 'Not measured', 'Database history window is six hours on the current plan; a restore procedure and checker exist and the first drill is scheduled. Raising the window and measuring recovery time are pilot prerequisites.'],
    ['Is there a documented incident response plan?', 'Partial', 'Incident checklist and breach notification steps in the runbook; the draft DPA commits to notice within 72 hours. No tabletop exercise yet.'],
  ]],
  ['Compliance and legal', [
    ['Are your eligibility rules reviewed by counsel?', 'No', 'Every threshold carries a citation to the primary source and a regression test. No law firm has signed off. Rule packs are research until they are.'],
    ['Do you hold any financial licence?', 'No', 'Pilots are structured so the customer settles on its own rails (decide-only) or on test networks only. A regulatory perimeter memo is planned per beachhead jurisdiction.'],
    ['Do you offer a DPA with SCCs?', 'Partial', 'A draft DPA (SCC Module Two, 72 hour breach notice, 30 day sub-processor notice) is published for counsel review. Not yet offered for signature as written.'],
  ]],
];
for (const [domain, items] of qa) {
  pdf.h2(domain);
  for (const [q, a, d] of items) { pdf.p(q, { font: 'F2' }); pdf.p(`${a}. ${d}`, { indent: 12 }); }
}

// ---------- 4. Controls map ----------
pdf.newPage();
pdf.h1('4. SOC 2 controls map');
const counts = { Implemented: controls.filter((c) => c.state === 'Implemented').length, Partial: controls.filter((c) => c.state === 'Partial').length, Planned: controls.filter((c) => c.state === 'Planned').length };
pdf.p(`${controls.length} criteria tracked: ${counts.Implemented} implemented, ${counts.Partial} partial, ${counts.Planned} planned. No audit has been performed; the states are Laissez's own assessment.`, { gray: 0.3 });
pdf.table(['Criterion', 'State', 'What exists', 'Gap'], controls.map((c) => [`${c.id} ${c.name}`, c.state, c.evidence, c.gap]), [110, 55, 190, 136], 7.5);

// ---------- 5. Access model ----------
pdf.newPage();
pdf.h1('5. Access model: roles and permissions');
pdf.p('"yes" means the role holds the permission. "People only" permissions are refused to API keys.', { gray: 0.3 });
pdf.table(['Permission', ...roles.map((r) => ({ Administrator: 'Admin', 'Operations analyst': 'Ops', 'Compliance officer': 'Compl.', 'Legal reviewer': 'Legal', 'Issuer admin': 'Issuer', Developer: 'Dev', Auditor: 'Auditor' } as Record<string, string>)[r] ?? r)], matrix.map(([label, key, cells]) => [`${label} (${key})`, ...cells.map((v) => (v ? 'yes' : ''))]), [191, 43, 43, 43, 43, 43, 43, 42], 7.5);

// ---------- 6. Sub-processors ----------
pdf.h1('6. Sub-processors');
pdf.table(['Provider', 'What it does', 'What it sees', 'Where', 'Status'], subprocessors.map((s) => [s.name, s.purpose, s.data, s.where, s.status + (s.note ? `. ${s.note}` : '')]), [78, 125, 125, 78, 85], 7.5);

// ---------- 7. Continuity ----------
pdf.h1('7. Business continuity and recovery');
pdf.p('Database: managed Postgres with point-in-time history (six hours on the current plan; to be raised before the first paying customer). Restore procedure: docs/runbook.md, Restoring from Neon branches; a read-only checker (api/db/restore-check.mjs) verifies tables, row-level security, every organization\'s audit chain and how far back a restore landed. Drill: scheduled quarterly; the first drill has not run.');
pdf.p('API: Cloudflare Workers run in every Cloudflare location; a regional outage does not take the API down. Database outage: the API fails closed on reads and writes; settlements cannot proceed; redemptions and all writes resume when the database returns. Chain outage: settlements queue and retry; nothing is marked settled without a receipt.');
pdf.p('People: one founder. Credentials and secrets are documented for rotation; there is no second operator today. This is a stated risk for any pilot and the first hire closes it.');

// ---------- 8. Legal and contacts ----------
pdf.h1('8. Legal documents and contacts');
pdf.kv('Terms of Service', 'https://parikshit7319.github.io/laissez/terms/ (version 2026-10-07, draft for counsel)');
pdf.kv('Privacy', 'https://parikshit7319.github.io/laissez/privacy/');
pdf.kv('DPA (draft)', 'https://parikshit7319.github.io/laissez/dpa/');
pdf.kv('Sub-processors', 'https://parikshit7319.github.io/laissez/subprocessors/');
pdf.kv('Trust page', 'https://parikshit7319.github.io/laissez/trust/');
pdf.kv('Status page', 'https://parikshit7319.github.io/laissez/status/');
pdf.kv('API reference', 'https://parikshit7319.github.io/laissez/developers/reference/');
pdf.kv('Source and changelog', 'https://github.com/Parikshit7319/laissez');
pdf.kv('Security contact', 'parikshit.ambhore@rice.edu');

// ---------- 9. Not done ----------
pdf.h1('9. What is not yet done');
for (const s of [
  'No legal entity, insurance, SOC 2 report or penetration test.',
  'No counsel sign-off on rule packs, terms, privacy or the DPA.',
  'No financial licence and no licensed settlement partner; pilots are decide-only or on test networks.',
  'Single region, six hour database history, no measured RTO or RPO, no on-call rotation.',
  'No second code reviewer, no separate staging environment yet.',
  'Smart contracts (four Laissez contracts) unaudited; the T-REX suite is audited upstream.',
  'One person. The first hire is a compliance lead or a second engineer.',
]) pdf.p(`- ${s}`, { indent: 8 });

mkdirSync('public', { recursive: true });
const bytes = pdf.bytes();
writeFileSync('public/laissez-procurement-pack.pdf', bytes);
console.log(`ok    wrote public/laissez-procurement-pack.pdf (${(bytes.length / 1024).toFixed(0)} KB, ${pdf.pages.length} pages)`);
