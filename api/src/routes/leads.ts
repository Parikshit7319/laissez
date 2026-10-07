// Public: access requests from the marketing site's Request access form.
// Stores the lead, notifies the founder and confirms to the requester through the email outbox
// (sent by Resend when configured, otherwise held in email_outbox).
import { z } from 'zod';
import { adminSql } from '../db';
import { ApiError, id, sha256, rateLimit, type Env } from '../util';
import { router, body } from '../http';
import { sendEmail, deliverable, type EmailKind, type Message } from '../email';

export const publicRoutes = router();

const ROLES = ['distributor', 'issuer', 'ta', 'engineering', 'compliance', 'investor', 'other'] as const;
const ROLE_LABEL: Record<(typeof ROLES)[number], string> = {
  distributor: 'Distribution or wealth platform', issuer: 'Issuer or asset manager', ta: 'Transfer agent or fund administrator',
  engineering: 'Engineering or digital assets', compliance: 'Compliance or legal', investor: 'Investor or allocator', other: 'Something else',
};
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
const clean = (s: string | undefined | null, max: number) => (s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

function plain(title: string, lines: string[]): Message {
  const html = `<!doctype html><html><body style="margin:0;background:#f7f5f0;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#fff;border:1px solid #ddd9d0;border-radius:12px">
<tr><td style="padding:28px 30px 24px"><h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#14161a">${esc(title)}</h1>
${lines.map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#4a4f57;white-space:pre-wrap">${esc(l)}</p>`).join('')}</td></tr>
<tr><td style="padding:14px 30px 22px;border-top:1px solid #ddd9d0;font-size:12px;line-height:1.5;color:#6b7079">Laissez, Houston, Texas. Pre-launch software; nothing in this message is an offer of securities or a regulated service.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject: title, html, text: [title, '', ...lines].join('\n'), link: null };
}

const Body = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(200),
  organization: z.string().min(2).max(160),
  role: z.enum(ROLES).optional().default('other'),
  distributes: z.string().max(200).optional().default(''),
  message: z.string().max(2000).optional().default(''),
  website: z.string().max(200).optional().default(''),
  source: z.string().max(200).optional(),
  elapsed_ms: z.number().int().nonnegative().optional(),
});

publicRoutes.post('/access-requests', async (c) => {
  const admin = adminSql(c.env.DATABASE_URL);
  const b = await body(c, Body);
  const ipHash = await sha256(c.req.header('cf-connecting-ip') ?? 'unknown');
  // Honeypot: the hidden "website" field is empty for people. Answer as if accepted so bots learn nothing.
  if (b.website.trim() !== '' || (b.elapsed_ms != null && b.elapsed_ms < 1500)) return c.json({ id: 'req_received', accepted: true }, 201);
  if (!(await rateLimit(admin, `leads:${ipHash}`, 5, 3600))) throw new ApiError(429, 'rate_limited', 'More than 5 access requests in an hour from this network. Try again later, or email us.');
  const email = clean(b.email, 200).toLowerCase();
  const [dup] = await admin`select id from leads where lower(email) = ${email} and created_at > now() - interval '10 minutes' limit 1`;
  if (dup) return c.json({ id: dup.id, accepted: true, duplicate: true }, 201);
  const lead = {
    id: id('req', 10), name: clean(b.name, 120), email, organization: clean(b.organization, 160), role: b.role,
    distributes: clean(b.distributes, 200) || null, message: clean(b.message, 2000) || null, source: clean(b.source, 200) || null,
    user_agent: clean(c.req.header('user-agent'), 300) || null,
  };
  await admin`insert into leads (id, name, email, organization, role, distributes, message, source, ip_hash, user_agent)
    values (${lead.id}, ${lead.name}, ${lead.email}, ${lead.organization}, ${lead.role}, ${lead.distributes}, ${lead.message}, ${lead.source}, ${ipHash}, ${lead.user_agent})`;

  const env = c.env as Env & { LEADS_EMAIL?: string };
  // Routed to a shared inbox when one is configured (LEADS_EMAIL, else STAFF_EMAIL); the founder's address is the fallback.
  const to = env.LEADS_EMAIL || env.STAFF_EMAIL || 'parikshit.ambhore@rice.edu';
  const kind = 'access_request' as unknown as EmailKind;
  const notify = plain(`Access request: ${lead.organization}`, [
    `${lead.name} <${lead.email}>`, `${lead.organization}, ${ROLE_LABEL[lead.role]}`,
    lead.distributes ? `Distributes or issues: ${lead.distributes}` : 'Distributes or issues: not given',
    lead.message ? `Message:\n${lead.message}` : 'No message.', `Reference ${lead.id}. Source ${lead.source ?? 'unknown'}.`,
  ]);
  const notified = await sendEmail(env, admin, { ws: null, to, kind, ...notify }).catch(() => null);
  if (notified) await admin`update leads set notified_email_id = ${notified.id}::uuid where id = ${lead.id}`.catch(() => {});
  if (deliverable(lead.email)) {
    const confirm = plain('We received your Laissez access request', [
      `Hello ${lead.name.split(/\s+/)[0]},`,
      `Thank you for writing about ${lead.organization}. Parikshit reads every request and replies within two business days.`,
      'In the meantime the sandbox is open to anyone: a private copy of Laissez with fictional institutions, deleted after 7 days. https://parikshit7319.github.io/laissez/app/',
      `Your reference is ${lead.id}.`,
    ]);
    c.executionCtx.waitUntil(sendEmail(env, admin, { ws: null, to: lead.email, kind, ...confirm }).catch(() => null));
  }
  return c.json({ id: lead.id, accepted: true }, 201);
});
