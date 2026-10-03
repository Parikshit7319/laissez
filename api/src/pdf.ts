// A small PDF writer for invoices: one A4 page, the built-in Helvetica and Courier fonts, no dependencies, so it runs
// in a Worker. Text is reduced to printable ASCII (accents are stripped, EUR replaces the euro sign).
const W = 595.28; const H = 841.89; const M = 48;

const ascii = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[–—]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/€/g, 'EUR ').replace(/[^\x20-\x7e]/g, '?');
const esc = (s: string) => ascii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const wrap = (s: string, max: number): string[] => {
  const out: string[] = []; let line = '';
  for (const w of ascii(s).split(/\s+/).filter(Boolean)) {
    if ((line + ' ' + w).trim().length > max) { if (line) out.push(line); line = w; } else line = (line + ' ' + w).trim();
  }
  if (line) out.push(line);
  return out.length ? out : [''];
};

export type InvoicePdf = {
  number: string; status: string; kind: string; currency: string;
  issuedOn: string; dueOn: string; periodStart: string; periodEnd: string;
  seller: { name: string; address?: string | null; taxId?: string | null };
  billTo: { name: string; lines: string[]; taxId?: string | null; po?: string | null };
  lines: { description: string; amount_cents: number }[];
  subtotalCents: number; taxCents: number; totalCents: number; taxLabel: string;
  payUrl?: string | null; paidAt?: string | null;
};

const fmt = (cents: number, cur: string) => `${cur === 'USD' ? 'USD ' : `${cur} `}${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function invoicePdf(o: InvoicePdf): Uint8Array {
  const ops: string[] = [];
  const Y = (top: number) => (H - top).toFixed(2);
  const text = (x: number, top: number, s: string, size = 10, font: 'F1' | 'F2' | 'F3' = 'F1', color = '0.08 0.09 0.10') => ops.push(`${color} rg BT /${font} ${size} Tf ${x.toFixed(2)} ${Y(top)} Td (${esc(s)}) Tj ET`);
  const right = (xr: number, top: number, s: string, size = 10, font: 'F1' | 'F2' | 'F3' = 'F3', color?: string) => text(xr - ascii(s).length * (font === 'F3' ? 0.6 : 0.52) * size, top, s, size, font, color);
  const rule = (top: number, gray = 0.82, w = 0.5) => ops.push(`${gray} G ${w} w ${M} ${Y(top)} m ${W - M} ${Y(top)} l S`);
  const GREEN = '0.059 0.361 0.29'; const MUTED = '0.42 0.40 0.36';

  text(M, 60, 'Laissez', 24, 'F2', GREEN);
  right(W - M, 56, 'INVOICE', 11, 'F2', MUTED);
  right(W - M, 74, o.number, 13, 'F3');
  rule(92, 0.0, 1.2);

  let y = 118;
  text(M, y, 'From', 8.5, 'F2', MUTED); text(310, y, 'Bill to', 8.5, 'F2', MUTED);
  y += 14;
  const from = [o.seller.name, ...(o.seller.address ? wrap(o.seller.address, 44) : []), ...(o.seller.taxId ? [`Tax ID ${o.seller.taxId}`] : [])];
  const to = [o.billTo.name, ...o.billTo.lines.flatMap((l) => wrap(l, 46)), ...(o.billTo.taxId ? [`Tax ID ${o.billTo.taxId}`] : []), ...(o.billTo.po ? [`PO ${o.billTo.po}`] : [])];
  const rows = Math.max(from.length, to.length);
  for (let i = 0; i < rows; i++) { if (from[i]) text(M, y + i * 13, from[i], 10, i === 0 ? 'F2' : 'F1'); if (to[i]) text(310, y + i * 13, to[i], 10, i === 0 ? 'F2' : 'F1'); }
  y += rows * 13 + 18;

  const meta: [string, string][] = [['Issued', o.issuedOn], ['Due', o.dueOn], ['Period', `${o.periodStart} to ${o.periodEnd}`], ['Status', o.status === 'paid' && o.paidAt ? `Paid ${o.paidAt.slice(0, 10)}` : o.status[0].toUpperCase() + o.status.slice(1)]];
  meta.forEach(([k, v], i) => { const x = M + i * 128; text(x, y, k, 8.5, 'F2', MUTED); text(x, y + 14, v, 10, 'F1'); });
  y += 40;

  rule(y, 0.3, 0.8);
  text(M, y + 16, 'Description', 8.5, 'F2', MUTED); right(W - M, y + 16, 'Amount', 8.5, 'F2', MUTED);
  rule(y + 24, 0.82);
  y += 42;
  let shown = 0;
  for (const l of o.lines) {
    const parts = wrap(l.description, 78);
    if (y + parts.length * 13 > H - 250) break;
    parts.forEach((p, i) => text(M, y + i * 13, p, 10, 'F1'));
    right(W - M, y, fmt(l.amount_cents, o.currency), 10, 'F3');
    y += parts.length * 13 + 8; shown++;
  }
  if (shown < o.lines.length) { text(M, y, `${o.lines.length - shown} more line${o.lines.length - shown === 1 ? '' : 's'} are on the invoice page in Billing.`, 9.5, 'F1', MUTED); y += 18; }
  rule(y, 0.82); y += 22;
  const tot = (label: string, v: string, bold = false) => { text(330, y, label, bold ? 11 : 10, bold ? 'F2' : 'F1'); right(W - M, y, v, bold ? 11 : 10, 'F3'); y += bold ? 22 : 17; };
  tot('Subtotal', fmt(o.subtotalCents, o.currency));
  tot(o.taxLabel, fmt(o.taxCents, o.currency));
  rule(y - 8, 0.3, 0.8); y += 6;
  tot(o.status === 'paid' ? 'Total paid' : 'Total due', fmt(o.totalCents, o.currency), true);

  y = Math.max(y + 24, 600);
  text(M, y, 'How to pay', 8.5, 'F2', MUTED); y += 15;
  const how = o.status === 'paid' ? ['Paid in full. Thank you.']
    : o.payUrl ? [`Pay by ACH or card on the secure invoice page: ${o.payUrl}`, 'Or pay by wire using the bank details in your order form, and quote the invoice number.']
    : ['Pay by wire or ACH using the bank details in your order form, and quote the invoice number.'];
  for (const h of how) for (const p of wrap(h, 92)) { text(M, y, p, 9.5, 'F1'); y += 13; }
  y += 8;
  for (const p of wrap(`Invoices are payable within the terms of your order form. An invoice unpaid one day after its due date marks the organization past due; unpaid thirty days after, the organization becomes read-only until it is paid. Questions: reply to the invoice email.`, 100)) { text(M, y, p, 8.5, 'F1', MUTED); y += 12; }
  text(M, H - 40, `Laissez ${o.number}`, 8, 'F1', MUTED);

  const stream = ops.join('\n');
  const objs: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
  ];
  let pdf = '%PDF-1.4\n'; const offsets: number[] = [];
  objs.forEach((b, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${b}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
