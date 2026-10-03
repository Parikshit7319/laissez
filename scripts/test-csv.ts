import { csvCell, csvRow, csvTable } from '../src/proto/csv';

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); } else console.log(`PASS ${name}`);
};

// Formula starters are neutralised.
for (const s of ['=1+1', '+SUM(A1)', '@SUM(A1)', '-2+3', '-cmd|calc', '\t=1', '\r=1', ' =1', '=HYPERLINK("http://x","y")']) eq(`neutralises ${JSON.stringify(s)}`, csvCell(s).startsWith(`"'`), true);
// Ordinary text, numbers and negative numbers are untouched.
eq('plain text', csvCell('Aurelia Pensionskasse'), '"Aurelia Pensionskasse"');
eq('number', csvCell(42), '"42"');
eq('negative number', csvCell(-12.5), '"-12.5"');
eq('negative number as text', csvCell('-12.5'), '"-12.5"');
eq('email', csvCell('a@b.com'), '"a@b.com"');
eq('null', csvCell(null), '""');
eq('date', csvCell(new Date('2026-10-02T00:00:00Z')), '"2026-10-02T00:00:00.000Z"');
eq('object is json', csvCell({ a: 1 }), '"{""a"":1}"');
// Quoting.
eq('quotes doubled', csvCell('say "hi"'), '"say ""hi"""');
eq('comma and newline kept inside quotes', csvCell('a,b\nc'), '"a,b\nc"');
eq('row', csvRow(['x', '=y', 3]), `"x","'=y","3"`);
eq('table ends with CRLF', csvTable([['a'], ['b']]), '"a"\r\n"b"\r\n');

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('csv: all passed');
