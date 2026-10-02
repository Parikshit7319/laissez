// Decision receipt as a PDF 1.4 file, written by hand: Helvetica (a standard font every reader ships), one or
// more A4 pages, no dependencies, so it runs in a Worker. Text is WinAnsi; characters outside it are replaced.

export type ReceiptCheck = { id: string; layer: string; label: string; result: string; detail: string; ruleRef?: string; binding?: boolean };
export type ReceiptInput = {
  decisionId: string; outcome: string; headline: string; action: string; createdAt: string;
  workspace: string; actor?: string | null;
  investor: { name: string; residence: string; booking: string }; counterparty?: { name: string; residence: string; booking: string } | null;
  fund: { ticker: string; name: string; currency: string; issuer?: string | null };
  amount: number; units: number; asset: string; dealingDate?: string | null;
  bindingRules: { text: string; ruleRef: string; layer?: string }[];
  checks: ReceiptCheck[];
  rulePacks: string[]; inputsHash: string; signature?: string | null; whatIfs?: string[];
  settlement?: { id: string; status: string } | null;
};

// ---------- Text metrics (Helvetica widths, 1/1000 em, for WinAnsi 32 to 126; other characters count as 556) ----------
const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const WB = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const width = (s: string, size: number, bold = false) => {
  const t = bold ? WB : W;
  let w = 0;
  for (const ch of s) { const c = ch.charCodeAt(0); w += c >= 32 && c <= 126 ? t[c - 32] : 556; }
  return (w * size) / 1000;
};

/** Replace characters WinAnsi cannot show and escape for a PDF string literal. */
function pdfText(s: string): string {
  const cleaned = s
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\u2026/g, '...').replace(/\u2013|\u2014/g, '-')
    .replace(/\u00A0/g, ' ').replace(/\u20AC/g, 'EUR ').replace(/\u00A3/g, 'GBP ').replace(/\u00A5/g, 'JPY ').replace(/\u20B9/g, 'INR ')
    .replace(/\u00A7/g, 'S.').replace(/[^\x20-\x7E]/g, '?');
  return cleaned.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
function wrap(s: string, size: number, maxWidth: number, bold = false): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (width(next, size, bold) <= maxWidth || !cur) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

// ---------- Page builder ----------
const PAGE_W = 595.28; const PAGE_H = 841.89; const MARGIN = 48; const CONTENT_W = PAGE_W - 2 * MARGIN;
type Op = string;
class Doc {
  pages: Op[][] = [];
  ops: Op[] = [];
  y = PAGE_H - MARGIN;
  constructor(private footer: (page: number) => string) { this.newPage(); }
  newPage() {
    if (this.ops.length) this.pages.push(this.ops);
    this.ops = [];
    this.y = PAGE_H - MARGIN;
  }
  need(h: number) { if (this.y - h < MARGIN + 28) this.newPage(); }
  text(x: number, y: number, s: string, size: number, opts: { bold?: boolean; gray?: number; color?: [number, number, number] } = {}) {
    const font = opts.bold ? '/F2' : '/F1';
    const color = opts.color ? `${opts.color.map((c) => c.toFixed(3)).join(' ')} rg` : `${(opts.gray ?? 0).toFixed(3)} g`;
    this.ops.push(`BT ${color} ${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfText(s)}) Tj ET`);
  }
  line(x1: number, y1: number, x2: number, y2: number, gray = 0.8, w = 0.6) {
    this.ops.push(`${gray.toFixed(3)} G ${w} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }
  rect(x: number, y: number, w: number, h: number, fill: [number, number, number]) {
    this.ops.push(`${fill.map((c) => c.toFixed(3)).join(' ')} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }
  para(s: string, size: number, opts: { bold?: boolean; gray?: number; x?: number; width?: number; lead?: number; color?: [number, number, number] } = {}) {
    const x = opts.x ?? MARGIN; const w = opts.width ?? CONTENT_W; const lead = opts.lead ?? size * 1.35;
    for (const ln of wrap(s, size, w, opts.bold)) {
      this.need(lead);
      this.y -= lead;
      this.text(x, this.y, ln, size, opts);
    }
  }
  gap(h: number) { this.y -= h; }
  heading(s: string) { this.gap(10); this.need(30); this.para(s.toUpperCase(), 8.5, { bold: true, gray: 0.35, lead: 12 }); this.line(MARGIN, this.y - 4, PAGE_W - MARGIN, this.y - 4, 0.75); this.gap(8); }
  kv(rows: [string, string][], labelW = 130) {
    for (const [k, v] of rows) {
      const lines = wrap(v, 9.5, CONTENT_W - labelW);
      const h = lines.length * 13 + 3;
      this.need(h);
      this.text(MARGIN, this.y - 11, k, 8.5, { gray: 0.4 });
      lines.forEach((ln, i) => this.text(MARGIN + labelW, this.y - 11 - i * 13, ln, 9.5));
      this.y -= h;
    }
  }
  finish(): Uint8Array<ArrayBuffer> {
    if (this.ops.length) this.pages.push(this.ops);
    const total = this.pages.length;
    const objects: string[] = [];
    const add = (body: string) => { objects.push(body); return objects.length; };
    const catalogId = add(''); const pagesId = add('');
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pageIds: number[] = [];
    this.pages.forEach((ops, i) => {
      const foot = this.footer(i + 1).replace('{total}', String(total));
      const stream = [...ops,
        `0.8 G 0.6 w ${MARGIN} ${MARGIN + 16} m ${PAGE_W - MARGIN} ${MARGIN + 16} l S`,
        `BT 0.45 g /F1 7.5 Tf ${MARGIN} ${MARGIN + 4} Td (${pdfText(foot)}) Tj ET`,
        `BT 0.45 g /F1 7.5 Tf ${(PAGE_W - MARGIN - width(`Page ${i + 1} of ${total}`, 7.5)).toFixed(2)} ${MARGIN + 4} Td (Page ${i + 1} of ${total}) Tj ET`,
      ].join('\n');
      const contentId = add(`<< /Length ${utf8Len(stream)} >>\nstream\n${stream}\nendstream`);
      const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contentId} 0 R >>`);
      pageIds.push(pageId);
    });
    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    const infoId = add(`<< /Producer (Laissez) /Title (Laissez decision receipt) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
    let out = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => { offsets.push(utf8Len(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = utf8Len(out);
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return latin1(out);
  }
}
const utf8Len = (s: string) => latin1(s).length;
/** The file is built from Latin-1 text (binary marker bytes included), so one char is one byte. */
function latin1(s: string): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

const OUTCOME: Record<string, { word: string; color: [number, number, number] }> = {
  ALLOW: { word: 'ALLOWED', color: [0.13, 0.45, 0.27] }, DENY: { word: 'DENIED', color: [0.62, 0.17, 0.14] }, FREEZE: { word: 'FROZEN', color: [0.55, 0.33, 0.05] },
};
const money = (n: number, ccy: string) => `${ccy} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (iso: string) => new Date(iso).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

/** Builds the receipt. The caller sets content-type application/pdf. */
export function receiptPdf(r: ReceiptInput): Uint8Array<ArrayBuffer> {
  const doc = new Doc(() => `Fictional institutions, Laissez sandbox. Receipt for decision ${r.decisionId}, generated ${new Date().toISOString().slice(0, 10)}.`);
  const o = OUTCOME[r.outcome] ?? { word: r.outcome, color: [0.2, 0.2, 0.2] as [number, number, number] };
  const verb = r.action === 'subscribe' ? 'Subscription' : r.action === 'transfer' ? 'Transfer' : 'Redemption';

  // Header band
  doc.rect(0, PAGE_H - 92, PAGE_W, 92, [0.96, 0.95, 0.93]);
  doc.text(MARGIN, PAGE_H - 40, 'LAISSEZ', 16, { bold: true, gray: 0.12 });
  doc.text(MARGIN + width('LAISSEZ', 16, true) + 8, PAGE_H - 40, 'Decision receipt', 11, { gray: 0.4 });
  doc.text(MARGIN, PAGE_H - 58, `Decision ${r.decisionId}`, 9, { gray: 0.35 });
  doc.text(MARGIN, PAGE_H - 71, `Issued ${fmtDate(r.createdAt)}${r.actor ? ` by ${r.actor}` : ''}. Organization ${r.workspace}.`, 9, { gray: 0.35 });
  const stampW = width(o.word, 13, true) + 20;
  doc.rect(PAGE_W - MARGIN - stampW, PAGE_H - 54, stampW, 24, o.color);
  doc.text(PAGE_W - MARGIN - stampW + 10, PAGE_H - 46.5, o.word, 13, { bold: true, color: [1, 1, 1] });
  doc.y = PAGE_H - 92 - 18;

  // Headline
  doc.para(r.headline, 12.5, { bold: true, lead: 17 });
  if (r.whatIfs?.length) doc.para(`Hypothetical: evaluated with what-if scenarios ${r.whatIfs.join(', ')}. This decision cannot settle.`, 9, { gray: 0.35 });

  // Parties and order
  doc.heading('Order');
  doc.kv([
    ['Action', `${verb} of ${money(r.amount, r.fund.currency)} (${r.units.toLocaleString('en-US', { maximumFractionDigits: 2 })} units), settled in ${r.asset}`],
    ['Fund', `${r.fund.name} (${r.fund.ticker})${r.fund.issuer ? `, issued by ${r.fund.issuer}` : ''}`],
    [r.action === 'transfer' ? 'Sender' : 'Investor', `${r.investor.name}, resident ${r.investor.residence}, booked ${r.investor.booking}`],
    ...(r.counterparty ? [['Receiver', `${r.counterparty.name}, resident ${r.counterparty.residence}, booked ${r.counterparty.booking}`] as [string, string]] : []),
    ...(r.dealingDate ? [['Dealing date', r.dealingDate] as [string, string]] : []),
    ...(r.settlement ? [['Settlement', `${r.settlement.id} (${r.settlement.status})`] as [string, string]] : []),
  ]);

  // Binding rules
  doc.heading('Rules that bind');
  if (r.bindingRules.length) for (const b of r.bindingRules) doc.para(`${b.text} (${b.ruleRef}${b.layer ? `, ${b.layer}` : ''})`, 9.5, { lead: 13 });
  else doc.para('No investor-class restriction applies to this order.', 9.5, { gray: 0.3 });

  // Checks table
  doc.heading('Checks');
  const cols = { res: MARGIN, layer: MARGIN + 52, label: MARGIN + 150, detail: MARGIN + 150 };
  doc.need(16);
  doc.text(cols.res, doc.y - 10, 'Result', 8, { bold: true, gray: 0.4 });
  doc.text(cols.layer, doc.y - 10, 'Layer', 8, { bold: true, gray: 0.4 });
  doc.text(cols.label, doc.y - 10, 'Check and detail', 8, { bold: true, gray: 0.4 });
  doc.y -= 14;
  doc.line(MARGIN, doc.y, PAGE_W - MARGIN, doc.y, 0.85);
  const resWord: Record<string, string> = { pass: 'Pass', fail: 'Fail', na: 'n/a', info: 'Info' };
  const resColor: Record<string, [number, number, number]> = { pass: [0.13, 0.45, 0.27], fail: [0.62, 0.17, 0.14], info: [0.3, 0.3, 0.3], na: [0.5, 0.5, 0.5] };
  for (const ch of r.checks) {
    const labelLines = wrap(`${ch.label}${ch.binding ? ' (binding)' : ''}${ch.ruleRef ? `  [${ch.ruleRef}]` : ''}`, 9, CONTENT_W - 150, true);
    const detailLines = wrap(ch.detail, 8.5, CONTENT_W - 150);
    const layerLines = wrap(ch.layer, 8, 92);
    const h = Math.max(labelLines.length * 12 + detailLines.length * 11.5, layerLines.length * 11) + 8;
    doc.need(h);
    let y = doc.y - 11;
    doc.text(cols.res, y, resWord[ch.result] ?? ch.result, 8.5, { bold: true, color: resColor[ch.result] ?? [0.2, 0.2, 0.2] });
    layerLines.forEach((ln, i) => doc.text(cols.layer, y - i * 11, ln, 8, { gray: 0.35 }));
    for (const ln of labelLines) { doc.text(cols.label, y, ln, 9, { bold: true }); y -= 12; }
    for (const ln of detailLines) { doc.text(cols.detail, y, ln, 8.5, { gray: 0.2 }); y -= 11.5; }
    doc.y -= h;
    doc.line(MARGIN, doc.y, PAGE_W - MARGIN, doc.y, 0.9, 0.4);
  }

  // Rule packs, hash and signature
  doc.heading('Rule packs in force');
  doc.para(r.rulePacks.join('; '), 9, { lead: 12.5 });
  doc.heading('Integrity');
  doc.kv([
    ['Inputs SHA-256', r.inputsHash],
    ['Signature', r.signature ? r.signature : 'Receipt signing is not configured on this deployment.'],
    ['Verify', 'POST /v1/receipts/verify with the JSON receipt and signature, or check the key at GET /v1/signing-key (Ed25519).'],
  ], 100);
  doc.gap(6);
  doc.para('Laissez records only the outcome, the inputs hash and the rule-pack versions on chain. This receipt reproduces the full trace from the stored decision. Fictional institutions, Laissez sandbox.', 8, { gray: 0.4, lead: 11 });
  return doc.finish();
}
