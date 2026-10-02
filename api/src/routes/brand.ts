// White-label branding: logo, colors, portal domain, email footer and support contact per organization.
// GET /v1/brand and PUT /v1/brand for staff; GET /v1/brand/portal for the investor portal (portal link token).
// Mounted by routes/reports.ts (routes under /v1, publicRoutes under /v1). Email templates (api/src/email.ts)
// read brand_name only for now; the footer and logo are stored here for them to pick up.
import { z } from 'zod';
import { router, need, body, auditQ, type C } from '../http';
import { adminSql } from '../db';
import { ApiError, sha256 } from '../util';

export const routes = router();
export const publicRoutes = router();

const LOGO_MAX_BYTES = 200 * 1024;
const PORTAL_HOST = 'parikshit7319.github.io';
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Validates a data: URL for a logo: PNG or SVG only, 200 KB or less decoded, SVG without scripts or event handlers. */
export function validateLogo(dataUrl: string): { ok: true; mime: 'image/png' | 'image/svg+xml'; bytes: number } | { ok: false; reason: string } {
  const m = /^data:(image\/png|image\/svg\+xml)(;charset=[\w-]+)?(;base64)?,([\s\S]*)$/i.exec(dataUrl.trim());
  if (!m) return { ok: false, reason: 'Use a PNG or SVG file. Other formats are not accepted for the logo.' };
  const mime = m[1].toLowerCase() as 'image/png' | 'image/svg+xml';
  const b64 = !!m[3];
  let bytes: Uint8Array;
  try {
    if (b64) { const bin = atob(m[4].replace(/\s+/g, '')); bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0)); }
    else bytes = new TextEncoder().encode(decodeURIComponent(m[4]));
  } catch { return { ok: false, reason: 'The logo data could not be decoded. Upload the file again.' }; }
  if (bytes.length > LOGO_MAX_BYTES) return { ok: false, reason: `The logo is ${Math.round(bytes.length / 1024)} KB. Keep it under 200 KB; an SVG or a 400 px wide PNG is plenty.` };
  if (!bytes.length) return { ok: false, reason: 'The logo file is empty.' };
  if (mime === 'image/png') {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (!sig.every((b, i) => bytes[i] === b)) return { ok: false, reason: 'The file is not a PNG image.' };
  } else {
    const text = new TextDecoder().decode(bytes);
    if (!/<svg[\s>]/i.test(text)) return { ok: false, reason: 'The file is not an SVG image.' };
    if (/<script|<foreignObject|javascript:|\son[a-z]+\s*=|<!ENTITY|<iframe|<embed|<object/i.test(text)) return { ok: false, reason: 'The SVG contains scripts, event handlers or embedded content, which the portal does not allow. Export a plain SVG.' };
    if (/\bhref\s*=\s*["'](?!#|data:image\/)/i.test(text)) return { ok: false, reason: 'The SVG links to an external resource. Embed images as data URLs or remove the link.' };
  }
  return { ok: true, mime, bytes: bytes.length };
}

const BRAND_COLS = 'name, slug, kind, brand_name, brand_color, logo_data_url, portal_domain, email_footer, support_email, support_phone';
function brandOut(w: any, apiUrl: string) {
  const name = w.brand_name || w.name;
  const portalUrl = `https://${PORTAL_HOST}/laissez/portal/`;
  return {
    brand_name: name, legal_name: w.name, brand_color: w.brand_color || '#1f3a33', logo_data_url: w.logo_data_url ?? null, logo_bytes: w.logo_data_url ? Math.round((String(w.logo_data_url).length * 3) / 4) : 0,
    portal_domain: w.portal_domain ?? null, email_footer: w.email_footer ?? null, support_email: w.support_email ?? null, support_phone: w.support_phone ?? null,
    portal_url: portalUrl, api_url: apiUrl,
    custom_domain: {
      status: w.portal_domain ? 'recorded' : 'not_set',
      note: w.portal_domain
        ? `${w.portal_domain} is recorded as your portal domain. The portal is served from GitHub Pages, which supports one custom domain per site, so Laissez cannot route it yet; investors use ${portalUrl} until a per-tenant host exists. Prepare the DNS now so the switch is a flag.`
        : 'Record the domain you want investors to see, for example invest.yourbank.com. Laissez stores it and shows the DNS to prepare.',
      dns: w.portal_domain ? [
        { type: 'CNAME', host: w.portal_domain, value: `${PORTAL_HOST}.`, ttl: 3600, purpose: 'Points the host at the portal.' },
        { type: 'TXT', host: `_laissez.${w.portal_domain}`, value: `laissez-portal=${w.slug}`, ttl: 3600, purpose: 'Proves you control the domain.' },
      ] : [],
    },
  };
}

routes.get('/brand', async (c) => {
  need(c, 'read');
  const [w] = await c.get('sql').query(`select ${BRAND_COLS} from workspaces where id = $1`, [c.get('ws')]);
  return c.json(brandOut(w, c.env.API_URL));
});

const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const brandIn = z.object({
  brand_name: z.string().trim().min(2).max(80).optional(),
  brand_color: z.string().regex(HEX, 'Use a six-digit hex color such as #1f3a33.').optional(),
  logo_data_url: z.string().max(Math.ceil(LOGO_MAX_BYTES * 1.4) + 100, 'The logo is over 200 KB.').nullable().optional(),
  portal_domain: z.string().trim().toLowerCase().max(253).nullable().optional(),
  email_footer: z.string().trim().max(600).nullable().optional(),
  support_email: z.string().trim().toLowerCase().email().max(160).nullable().optional(),
  support_phone: z.string().trim().max(40).nullable().optional(),
}).strict();

routes.put('/brand', async (c) => {
  const actor = need(c, 'members:admin');
  const sql = c.get('sql'); const ws = c.get('ws');
  const b = await body(c, brandIn);
  if (!Object.keys(b).length) throw new ApiError(422, 'empty', 'Send at least one branding field to change.');
  const has = (k: keyof typeof b) => Object.prototype.hasOwnProperty.call(b, k);
  let logoMeta: { mime: string; bytes: number } | null = null;
  if (has('logo_data_url') && b.logo_data_url) {
    const v = validateLogo(b.logo_data_url);
    if (!v.ok) throw new ApiError(422, 'invalid_logo', v.reason);
    logoMeta = { mime: v.mime, bytes: v.bytes };
  }
  if (has('portal_domain') && b.portal_domain) {
    if (!DOMAIN.test(b.portal_domain)) throw new ApiError(422, 'invalid_domain', `${b.portal_domain} is not a valid host name. Use something like invest.yourbank.com, without https:// or a path.`);
    if (b.portal_domain.endsWith('github.io') || b.portal_domain.endsWith('workers.dev')) throw new ApiError(422, 'invalid_domain', 'Use a domain you control, not a GitHub Pages or workers.dev host.');
  }
  if (has('email_footer') && b.email_footer && /<[a-z/!]/i.test(b.email_footer)) throw new ApiError(422, 'invalid_footer', 'The email footer is plain text. Remove the HTML tags.');
  const [before] = await sql.query(`select ${BRAND_COLS} from workspaces where id = $1`, [ws]);
  await sql.transaction([
    sql`update workspaces set
        brand_name = coalesce(${b.brand_name ?? null}, brand_name),
        brand_color = coalesce(${b.brand_color ?? null}, brand_color),
        logo_data_url = case when ${has('logo_data_url')} then ${b.logo_data_url ?? null} else logo_data_url end,
        portal_domain = case when ${has('portal_domain')} then ${b.portal_domain || null} else portal_domain end,
        email_footer = case when ${has('email_footer')} then ${b.email_footer || null} else email_footer end,
        support_email = case when ${has('support_email')} then ${b.support_email || null} else support_email end,
        support_phone = case when ${has('support_phone')} then ${b.support_phone || null} else support_phone end
      where id = ${ws}`,
    auditQ(sql, ws, actor, 'brand.updated', ws, {
      changed: Object.keys(b), brand_name: b.brand_name ?? null, brand_color: b.brand_color ?? null, logo: has('logo_data_url') ? (logoMeta ?? 'removed') : undefined,
      portal_domain: has('portal_domain') ? (b.portal_domain || null) : undefined, support_email: has('support_email') ? (b.support_email || null) : undefined,
      previous: { brand_name: before?.brand_name ?? null, brand_color: before?.brand_color ?? null, portal_domain: before?.portal_domain ?? null },
    }),
  ]);
  const [w] = await sql.query(`select ${BRAND_COLS} from workspaces where id = $1`, [ws]);
  return c.json({ ...brandOut(w, c.env.API_URL), note: 'Saved. The investor portal applies it on the next load. Emails keep the brand name; the footer and logo are stored for the templates to pick up.' });
});

/** Branding for the investor portal, authenticated by the portal link token (same token as /v1/portal/me). */
publicRoutes.get('/brand/portal', async (c: C) => {
  const h = c.req.header('authorization') ?? '';
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!tok.startsWith('lz_inv_')) throw new ApiError(401, 'portal_unauthorized', 'Open the portal from the link your distributor sent you.');
  const admin = adminSql(c.env.DATABASE_URL);
  const hash = await sha256(tok);
  const [w] = await admin.query(`select w.${BRAND_COLS.split(', ').join(', w.')} from portal_access pa join workspaces w on w.id = pa.workspace_id
    where pa.token_hash = $1 and pa.revoked_at is null and pa.expires_at > now() and (w.expires_at is null or w.expires_at > now())`, [hash]);
  if (!w) throw new ApiError(401, 'portal_link_expired', 'This portal link has expired or was withdrawn. Ask your distributor for a new link.');
  c.header('cache-control', 'private, max-age=300');
  return c.json({ name: w.brand_name || w.name, brand_color: w.brand_color || '#1f3a33', logo_data_url: w.logo_data_url ?? null, email_footer: w.email_footer ?? null, support_email: w.support_email ?? null, support_phone: w.support_phone ?? null, portal_domain: w.portal_domain ?? null, sandbox: w.kind === 'sandbox' || w.kind === 'network' });
});
