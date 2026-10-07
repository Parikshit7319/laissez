// Records the home page walkthrough video: a real cross-border order through the sandbox, from an empty workspace to a
// settled subscription with its signed receipt. Runs Playwright against a local preview of the site and a local API, so
// the recording never touches production.
//
//   Prerequisites: npm run db:local, npm run api:local (port 8787), npm run build && npx astro preview --port 4399
//   Run:           node scripts/record-walkthrough.mjs            (from the repository root; needs ffmpeg on PATH)
//   Output:        public/media/walkthrough.mp4 and public/media/walkthrough-poster.jpg
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(path.resolve('tests/e2e/package.json'));
const { chromium } = require('playwright');

const SITE = (process.env.BASE_URL || 'http://localhost:4399/laissez/').replace(/\/?$/, '/');
const API = (process.env.API_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const OUT = path.resolve('public/media');
const TMP = path.resolve('.astro/walkthrough');
rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true }); mkdirSync(OUT, { recursive: true });

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium' });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, recordVideo: { dir: TMP, size: { width: 1280, height: 720 } }, reducedMotion: 'reduce' });
await context.addInitScript((api) => { try { localStorage.setItem('laissez-api-base', api); } catch { /* storage blocked */ } }, API);
const page = await context.newPage();

// A caption strip the viewer can read without narration. Injected into the page; part of the recording only.
async function caption(text) {
  await page.evaluate((t) => {
    let el = document.getElementById('lz-caption');
    if (!el) { el = document.createElement('div'); el.id = 'lz-caption'; el.setAttribute('style', 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99999;background:#14161A;color:#F7F5F0;font:500 18px/1.35 Geist, system-ui, sans-serif;padding:12px 18px;border-radius:12px;max-width:72%;box-shadow:0 8px 30px rgba(0,0,0,.25);transition:opacity .25s'); document.body.appendChild(el); }
    el.textContent = t; el.style.opacity = '1';
  }, text);
}
async function scrollTo(y, ms = 900) { await page.evaluate(([y, ms]) => window.scrollTo({ top: y, behavior: 'smooth' }), [y, ms]); await pause(ms); }

const mainText = async (re, timeout = 60_000) => page.waitForFunction((src) => new RegExp(src, 'i').test(document.querySelector('#app-main')?.textContent ?? ''), re.source, { timeout });

try {
  // 1. Home: the claim, then the three steps.
  await page.goto(SITE, { waitUntil: 'networkidle' });
  await caption('Laissez: tokenized funds, cleared to cross borders. One credential per investor, every rule resolved before a token moves, atomic settlement.');
  await pause(3500);
  await scrollTo(780, 1200); await caption('Three API calls between an order and a settled trade: credential, decision, settlement.'); await pause(3500);

  // 2. Open a sandbox.
  await page.goto(`${SITE}app/`, { waitUntil: 'networkidle' });
  await caption('The sandbox needs no sign-up. It is a private copy of the product with fictional institutions.');
  await pause(2000);
  await page.getByRole('button', { name: 'Open a sandbox' }).click();
  await page.locator('#app-main').waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => (document.querySelector('#app-main')?.textContent ?? '').length > 80, null, { timeout: 60_000 });
  await caption('A private bank with clients in Singapore, Hong Kong, Switzerland, the DIFC and the US, and funds from three issuers.');
  await pause(3500);

  // 3. A client and the credential.
  await page.evaluate(() => { location.hash = '#/clients'; });
  await mainText(/Clients/);
  await caption('Clients: each verified once by this distributor. The credential records the legal classification per jurisdiction, with its citation and expiry.');
  await pause(3000);
  await page.getByRole('link', { name: 'Lumen Family Office Pte. Ltd.' }).click();
  await mainText(/Lumen Family Office/);
  await pause(1200);
  await caption('Lumen is a Singapore accredited investor with opt-in recorded. The credential travels; the KYC file stays with the bank.');
  await pause(4000);
  await scrollTo(500, 900); await pause(2000);

  // 4. A decision.
  await page.evaluate(() => { location.hash = '#/orders/new'; });
  await mainText(/New order/);
  await caption('A subscription for Lumen in a tokenized Treasury fund. The decision is computed live as the form is filled in.');
  await page.getByRole('button', { name: 'Place order' }).waitFor({ state: 'visible', timeout: 45_000 });
  await page.waitForFunction(() => !document.querySelector('button:has-text("Place order")')?.hasAttribute('disabled'), null, { timeout: 45_000 }).catch(() => {});
  await pause(3500);
  await caption('Seven layers in order: credential, fund policy, home law, booking-centre licence, documents, fund terms, global screens. The stricter rule binds and the decision says which.');
  await scrollTo(420, 900); await pause(4000);
  await scrollTo(0, 600);
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.locator('#app-main h1').first().filter({ hasText: /^Decision dec_/ }).waitFor({ timeout: 45_000 });
  await caption('Allowed. The receipt is signed with Ed25519 over the inputs and the rule versions; anyone can verify it without an account.');
  await pause(4000);
  await scrollTo(600, 900); await pause(3000);

  // 5. Settlement.
  await scrollTo(0, 500);
  const settle = page.getByRole('button', { name: 'Settle now' });
  await settle.waitFor({ state: 'visible' });
  await caption('Settlement re-checks the decision at the moment of settlement and moves fund units and cash together, or neither.');
  await pause(2500);
  await settle.click();
  // After a dealing cut-off the order sits in a batch; the walkthrough settles it alone, which is what an operator would do for one order.
  const alone = page.getByRole('button', { name: 'Settle this order alone' });
  await Promise.race([mainText(/Settlement stl_/, 15_000).catch(() => null), alone.waitFor({ timeout: 15_000 }).catch(() => null)]);
  if (await alone.isVisible().catch(() => false)) { await caption('This order arrived after the dealing cut-off, so it joined a batch. An operator can settle it alone.'); await pause(2500); await alone.click(); }
  await mainText(/Settlement stl_/, 60_000);
  await mainText(/Settled/, 120_000);
  await caption('Settled. In the sandbox the cash is fictional; on the test network the same call runs through ERC-3643 contracts.');
  await pause(4000);

  // 6. The audit log.
  await page.evaluate(() => { location.hash = '#/audit'; });
  await mainText(/Audit/, 30_000).catch(() => {});
  await caption('Every write is in a hash-chained audit log that verifies in one call, exports to your SIEM, and is anchored daily on a public chain.');
  await pause(4500);
  await caption('Open a sandbox at parikshit7319.github.io/laissez. Then bring one fund and one corridor.');
  await pause(3500);
} finally {
  await page.close();
  await context.close();
  await browser.close();
}

const webm = readdirSync(TMP).find((f) => f.endsWith('.webm'));
if (!webm) throw new Error('No video was recorded.');
const src = path.join(TMP, webm);
const mp4 = path.join(OUT, 'walkthrough.mp4');
const poster = path.join(OUT, 'walkthrough-poster.jpg');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-c:v', 'libx264', '-preset', 'slow', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', '-r', '24', mp4]);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '00:00:04', '-i', mp4, '-frames:v', '1', '-q:v', '4', poster]);
console.log(`ok    ${path.relative(process.cwd(), mp4)} (${(statSync(mp4).size / 1024 / 1024).toFixed(1)} MB), poster ${path.relative(process.cwd(), poster)}`);
