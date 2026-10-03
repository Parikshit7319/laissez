// Outgoing email. Every message is stored in email_outbox first, then handed to Resend when RESEND_API_KEY is set.
// Without a provider the row stays in status "outbox", and the Outbox page in settings shows the message and its link,
// so sandboxes and local setups work end to end without a mail server.
import type { Sql } from './db';
import type { Env } from './util';

export type EmailKind = 'invite' | 'consent_request' | 'portal_access' | 'work_digest' | 'api_key_new_network' | 'new_device' | 'verify_email' | 'recovery' | 'security_alert' | 'billing' | 'contract';
export type Message = { subject: string; html: string; text: string; link?: string | null };
export type SendOpts = { ws: string | null; to: string; kind: EmailKind } & Message;

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));

/** The one layout every template uses: a heading, a few paragraphs, an optional button, a footer line. */
function layout(o: { title: string; lines: string[]; button?: { label: string; url: string } | null; footer?: string; org?: string | null }): Message {
  const paragraphs = o.lines.map((l) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#2a2722">${esc(l)}</p>`).join('');
  const button = o.button
    ? `<p style="margin:22px 0"><a href="${esc(o.button.url)}" style="display:inline-block;background:#1f3a33;color:#fff;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:9px;font-size:15px">${esc(o.button.label)}</a></p>
       <p style="margin:0 0 14px;font-size:12.5px;color:#7a7368;word-break:break-all">If the button does not work, open this link: ${esc(o.button.url)}</p>`
    : '';
  const footer = o.footer ?? 'Sent by Laissez on behalf of the organization named above. If you were not expecting this message, ignore it; nothing happens unless the link is used.';
  const html = `<!doctype html><html><body style="margin:0;background:#f1eee8;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;background:#fff;border:1px solid #ddd6c9;border-radius:14px">
<tr><td style="padding:28px 30px 8px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a8377">${esc(o.org ?? 'Laissez')}</div>
<h1 style="margin:6px 0 16px;font-size:21px;line-height:1.3;color:#151412">${esc(o.title)}</h1>${paragraphs}${button}</td></tr>
<tr><td style="padding:14px 30px 24px;border-top:1px solid #eee8dc;font-size:12px;line-height:1.5;color:#8a8377">${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [o.title, '', ...o.lines, ...(o.button ? ['', `${o.button.label}: ${o.button.url}`] : []), '', footer].join('\n');
  return { subject: o.title, html, text, link: o.button?.url ?? null };
}

// ---------- Templates ----------
export const templates = {
  invite: (p: { org: string; role: string; invitedBy?: string | null; link: string; expiresDays?: number }): Message => ({
    ...layout({
      org: p.org, title: `You are invited to ${p.org} on Laissez`,
      lines: [
        `${p.invitedBy ? `${p.invitedBy} invited you` : 'You are invited'} to join ${p.org} as ${p.role}.`,
        'Laissez is where the team checks investor eligibility, settles tokenized fund orders and keeps the audit record. Accept the invite to create your account with a passkey, or sign in if you already have one.',
        `The link works once and expires in ${p.expiresDays ?? 7} days.`,
      ],
      button: { label: `Join ${p.org}`, url: p.link },
    }),
  }),
  consentRequest: (p: { investor: string; requester: string; issuer: string; purpose: string; link: string; expiresDays?: number }): Message => ({
    ...layout({
      org: p.requester, title: `${p.requester} asks to rely on your credential`,
      lines: [
        `${p.requester} would like to rely on the investor credential that ${p.issuer} issued to ${p.investor}, for this purpose: ${p.purpose}`,
        'Approving shares your legal name, investor type, country of residence and your investor classifications with their expiry dates. It does not share identity documents, financial statements or your holdings.',
        `You can withdraw consent at any time from the same page. The request expires in ${p.expiresDays ?? 14} days if you do nothing.`,
      ],
      button: { label: 'Review and decide', url: p.link },
    }),
  }),
  portalAccess: (p: { investor: string; org: string; link: string; expiresDays?: number }): Message => ({
    ...layout({
      org: p.org, title: `Your investor portal at ${p.org}`,
      lines: [
        `${p.org} has opened an investor portal for ${p.investor}. In it you can see your credential, which funds you are eligible for and why, read and acknowledge fund documents, submit evidence for a classification and sign subscription requests.`,
        `This private link works for ${p.expiresDays ?? 30} days. Anyone holding it can act for you in the portal, so do not forward it.`,
      ],
      button: { label: 'Open your portal', url: p.link },
    }),
  }),
  workDigest: (p: { org: string; name: string; open: number; high: number; dueSoon: number; items: { title: string; severity: string; due_on?: string | null }[]; link: string }): Message => ({
    ...layout({
      org: p.org, title: `${p.open} open work item${p.open === 1 ? '' : 's'} at ${p.org}`,
      lines: [
        `Good morning ${p.name.split(' ')[0]}. The work queue has ${p.open} open item${p.open === 1 ? '' : 's'}: ${p.high} high severity, ${p.dueSoon} due within 7 days.`,
        ...p.items.slice(0, 8).map((i) => `${i.severity === 'high' ? 'High' : i.severity === 'medium' ? 'Medium' : 'Low'}: ${i.title}${i.due_on ? ` (due ${i.due_on})` : ''}`),
        ...(p.items.length > 8 ? [`And ${p.items.length - 8} more.`] : []),
      ],
      button: { label: 'Open the work queue', url: p.link },
      footer: 'You receive this daily digest because you are an administrator or compliance officer. It is sent only on days with open items.',
    }),
  }),
  apiKeyNewNetwork: (p: { org: string; keyName: string; prefix: string; country: string | null; ua: string | null; link: string }): Message => ({
    ...layout({
      org: p.org, title: `API key ${p.keyName} was used from a new network`,
      lines: [
        `The key ${p.keyName} (${p.prefix}…) made its first request from a network Laissez had not seen for this key${p.country ? `, in ${p.country}` : ''}.${p.ua ? ` Client: ${p.ua.slice(0, 80)}.` : ''}`,
        'If you deployed the key somewhere new, nothing else is needed. If not, rotate or revoke the key now. Keys can be restricted to an IP allowlist from the API keys page.',
      ],
      button: { label: 'Review API keys', url: p.link },
      footer: 'Sent to every administrator of the organization. The event is also in the audit log as api_key.new_network.',
    }),
  }),
  verifyEmail: (p: { name: string; link: string; expiresHours: number }): Message => ({
    ...layout({
      title: 'Confirm your email address',
      lines: [
        `${p.name.split(' ')[0]}, confirm that this address is yours to finish setting up your Laissez account.`,
        `The link works once and expires in ${p.expiresHours} hours. Until you confirm, the account can only send this request again or sign out.`,
      ],
      button: { label: 'Confirm email', url: p.link },
      footer: 'You are receiving this because someone used this address to create a Laissez account. If that was not you, ignore the message; nothing happens unless the link is used.',
    }),
  }),
  recovery: (p: { name: string; link: string; cancelLink: string; waitMinutes: number; needsCode: boolean; browser: string | null; os: string | null; country: string | null; availableAt: string }): Message => ({
    ...layout({
      title: 'Recover access to your Laissez account',
      lines: [
        `Someone asked to recover access to the account for ${p.name}${p.browser ? ` from ${p.browser}${p.os ? ` on ${p.os}` : ''}` : ''}${p.country ? ` in ${p.country}` : ''}.`,
        p.waitMinutes > 0
          ? `For your protection the link only works after a ${p.waitMinutes >= 120 ? `${Math.round(p.waitMinutes / 60)} hour` : p.waitMinutes >= 60 ? '1 hour' : `${p.waitMinutes} minute`} waiting period, from ${p.availableAt}. If you did not ask for this, cancel it now.`
          : `Because your account has an authenticator app, you will be asked for its six-digit code and the link works straight away.`,
        p.needsCode ? 'Have your authenticator app ready.' : 'Recovery signs you in only far enough to add a new passkey.',
        `If this was not you, cancel the request: ${p.cancelLink}`,
      ],
      button: { label: 'Continue recovery', url: p.link },
      footer: 'Recovery links work once. Every recovery request is recorded in the audit log of each organization you belong to.',
    }),
  }),
  securityAlert: (p: { title: string; lines: string[]; link: string; org?: string | null; button?: string }): Message => ({
    ...layout({
      org: p.org ?? null, title: p.title, lines: p.lines,
      button: { label: p.button ?? 'Review security settings', url: p.link },
      footer: 'Laissez sends this when something that protects your account changes. If you did not make the change, sign in and review your sessions and passkeys at once.',
    }),
  }),
  contractReady: (p: { org: string; plan: string; fee: string; bps: string; startsOn: string; link: string }): Message => ({
    ...layout({
      org: p.org, title: `Your Laissez order form is ready to accept`,
      lines: [
        `An order form for ${p.org} is ready: ${p.plan} plan, platform fee ${p.fee} a year, ${p.bps} basis points of value settled, starting ${p.startsOn}.`,
        'An administrator reviews the terms in Billing and accepts them there. Nothing is charged before you accept.',
      ],
      button: { label: 'Review the order form', url: p.link },
    }),
  }),
  invoiceIssued: (p: { org: string; number: string; total: string; dueOn: string; link: string; payLink?: string | null }): Message => ({
    ...layout({
      org: p.org, title: `Invoice ${p.number} for ${p.total}`,
      lines: [
        `Invoice ${p.number} for ${p.total} is issued to ${p.org}. It is due on ${p.dueOn}.`,
        p.payLink ? 'Pay by ACH or card from the secure invoice page, or by wire using the details on the invoice.' : 'Pay by wire or ACH using the details on the invoice and quote the invoice number.',
      ],
      button: { label: p.payLink ? 'Open the invoice' : 'View in Billing', url: p.payLink ?? p.link },
    }),
  }),
  paymentOverdue: (p: { org: string; number: string; total: string; daysLate: number; suspendOn: string | null; link: string }): Message => ({
    ...layout({
      org: p.org, title: `Invoice ${p.number} is ${p.daysLate} day${p.daysLate === 1 ? '' : 's'} overdue`,
      lines: [
        `Invoice ${p.number} for ${p.total} was not paid by its due date.`,
        p.suspendOn ? `If it stays unpaid, ${p.org} moves to read-only on ${p.suspendOn}: you can still view and export everything, but new decisions, settlements and changes stop until payment arrives.` : `${p.org} is read-only until payment arrives: you can view and export everything, but new decisions, settlements and changes are paused.`,
        'If you already paid, reply to this message with the payment reference.',
      ],
      button: { label: 'View the invoice', url: p.link },
    }),
  }),
  newDevice: (p: { name: string; org: string; browser: string | null; os: string | null; country: string | null; city: string | null; link: string }): Message => ({
    ...layout({
      org: p.org, title: 'New sign-in to your Laissez account',
      lines: [
        `${p.name.split(' ')[0]}, your account just signed in to ${p.org} from a new network${p.browser ? ` using ${p.browser}${p.os ? ` on ${p.os}` : ''}` : ''}${p.city || p.country ? `, near ${[p.city, p.country].filter(Boolean).join(', ')}` : ''}.`,
        'If this was you, there is nothing to do. If not, open Security, sign out every other session and remove any passkey you do not recognize.',
      ],
      button: { label: 'Review sessions', url: p.link },
      footer: 'Laissez sends this when a sign-in comes from a network address your account has not used before.',
    }),
  }),
};

// ---------- Sending ----------
export async function sendEmail(env: Env, admin: Sql, m: SendOpts): Promise<{ id: string; status: 'sent' | 'outbox' | 'failed' }> {
  const [row] = await admin`insert into email_outbox (workspace_id, to_email, subject, html, text, kind, status, link)
    values (${m.ws}, ${m.to}, ${m.subject}, ${m.html}, ${m.text}, ${m.kind}, 'outbox', ${m.link ?? null}) returning id`;
  const id: string = row.id;
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { id, status: 'outbox' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [m.to], subject: m.subject, html: m.html, text: m.text, tags: [{ name: 'kind', value: m.kind }] }),
      signal: AbortSignal.timeout(8000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j?.message ?? `Resend returned ${res.status}`);
    // Confirmation and recovery links are bearer credentials. Once the provider has the message the stored copy does not need them.
    const scrub = m.kind === 'verify_email' || m.kind === 'recovery';
    await admin`update email_outbox set status = 'sent', provider_id = ${String(j.id ?? '')},
      html = case when ${scrub} then '<p>The link in this message was removed after it was sent.</p>' else html end,
      text = case when ${scrub} then 'The link in this message was removed after it was sent.' else text end,
      link = case when ${scrub} then null else link end
      where id = ${id}`;
    return { id, status: 'sent' };
  } catch (e: any) {
    await admin`update email_outbox set status = 'failed', error = ${String(e?.message ?? e).slice(0, 300)} where id = ${id}`;
    return { id, status: 'failed' };
  }
}

/** Whether an address can receive mail: sandbox guests and fictional teammates have placeholder addresses. */
export const deliverable = (email: string | null | undefined) => !!email && email.includes('@') && !email.endsWith('.sandbox') && !email.endsWith('.example');

/** Emails every administrator of an organization. Returns how many messages were written. */
export async function emailAdmins(env: Env, admin: Sql, ws: string, kind: EmailKind, m: Message) {
  const rows = await admin`select u.email from memberships mb join users u on u.id = mb.user_id where mb.workspace_id = ${ws} and mb.role = 'admin' and not u.fictional`;
  let n = 0;
  for (const r of rows) {
    await sendEmail(env, admin, { ws, to: r.email, kind, ...m });
    n++;
  }
  return n;
}

/**
 * Daily work queue digest: one email per administrator or compliance officer of each organization that has open work items.
 * Called from the daily cron. Sandboxes are included so the Outbox page shows what the email looks like.
 */
export async function sendDigests(env: Env, admin: Sql): Promise<{ workspaces: number; emails: number }> {
  const rows = await admin`select w.id, w.name, w.brand_name,
      (select count(*)::int from work_items i where i.workspace_id = w.id and i.status = 'open') as open,
      (select count(*)::int from work_items i where i.workspace_id = w.id and i.status = 'open' and i.severity = 'high') as high,
      (select count(*)::int from work_items i where i.workspace_id = w.id and i.status = 'open' and i.due_on is not null and i.due_on <= current_date + 7) as due_soon,
      (select coalesce(json_agg(json_build_object('title', i.title, 'severity', i.severity, 'due_on', i.due_on::text) order by (i.severity = 'high') desc, i.due_on nulls last, i.created_at), '[]'::json)
        from (select * from work_items i where i.workspace_id = w.id and i.status = 'open' order by (severity = 'high') desc, due_on nulls last, created_at limit 12) i) as items,
      (select coalesce(json_agg(json_build_object('email', u.email, 'name', u.name)), '[]'::json) from memberships m join users u on u.id = m.user_id
        where m.workspace_id = w.id and m.role in ('admin', 'compliance') and not u.fictional) as people
    from workspaces w
    where w.kind in ('org', 'sandbox') and (w.expires_at is null or w.expires_at > now())
      and exists (select 1 from work_items i where i.workspace_id = w.id and i.status = 'open')
      and not exists (select 1 from email_outbox e where e.workspace_id = w.id and e.kind = 'work_digest' and e.created_at > now() - interval '20 hours')`;
  let emails = 0;
  for (const w of rows) {
    const org = w.brand_name || w.name;
    for (const p of w.people as { email: string; name: string }[]) {
      await sendEmail(env, admin, { ws: w.id, to: p.email, kind: 'work_digest', ...templates.workDigest({ org, name: p.name, open: w.open, high: w.high, dueSoon: w.due_soon, items: w.items, link: `${env.APP_URL}#/work` }) });
      emails++;
    }
  }
  return { workspaces: rows.length, emails };
}
