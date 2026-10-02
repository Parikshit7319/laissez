// Runs a migration file against DATABASE_URL (the owner connection).
// Usage: node db/migrate.mjs db/migrate-002.sql   (reads .dev.vars when env is not set)
import { neon } from '@neondatabase/serverless';
import fs from 'node:fs';

if (!process.env.DATABASE_URL && fs.existsSync('.dev.vars')) {
  for (const line of fs.readFileSync('.dev.vars', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const sql = neon(process.env.DATABASE_URL);
const file = process.argv[2];
const statements = fs.readFileSync(file, 'utf8').split(/\n-- ;\n/).map((s) => s.replace(/^\s*(--[^\n]*\n)*/g, '').trim()).filter(Boolean);
let n = 0;
for (const s of statements) {
  try {
    await sql.query(s);
    n++;
  } catch (e) {
    console.error(`Statement ${n + 1} failed:\n${s.slice(0, 400)}\n${e.message}`);
    process.exit(1);
  }
}
console.log(`${file}: ${n} statements applied`);
