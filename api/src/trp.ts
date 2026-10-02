// OpenVASP Travel Rule Protocol (TRP) 3.x: Travel Addresses and the message builders.
//
// Travel Address: "ta" followed by the Base58Check encoding (Bitcoin alphabet, 4-byte
// double SHA-256 checksum, no version byte) of the beneficiary endpoint without its URI
// scheme and with the query parameter t=i. https:// is implied when it is decoded.
//
// Message flow (all POST, JSON, headers api-version and request-identifier on every call):
//   1. Inquiry: originator -> beneficiary endpoint (decoded Travel Address).
//      Body {asset, amount, callback, IVMS101}. The beneficiary answers 200 with a resolution,
//      or 204 and posts the resolution to the callback later.
//   2. Resolution: beneficiary -> originator callback. {approved: {address, callback}} or {rejected: reason}.
//   3. Confirmation: originator -> approved.callback once the transfer is broadcast. {txid} or {canceled: reason}.
// The request-identifier stays the same for the whole transfer.
import type { Env } from './util';
import { sha256Bytes, enc } from './util';
import { ofetch } from './oidc';

export const TRP_VERSION = '3.1.0';
export const TRP_EXTENSION = 'laissez-asset-details';

// ---------- Base58Check ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX: Record<string, number> = Object.fromEntries([...B58].map((ch, i) => [ch, i]));

function b58encode(bytes: Uint8Array): string {
  let x = 0n;
  for (const b of bytes) x = x * 256n + BigInt(b);
  let s = '';
  while (x > 0n) { s = B58[Number(x % 58n)] + s; x /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}

function b58decode(s: string): Uint8Array | null {
  let x = 0n;
  for (const ch of s) {
    const v = B58_INDEX[ch];
    if (v === undefined) return null;
    x = x * 58n + BigInt(v);
  }
  const out: number[] = [];
  while (x > 0n) { out.unshift(Number(x % 256n)); x /= 256n; }
  for (const ch of s) { if (ch !== '1') break; out.unshift(0); }
  return new Uint8Array(out);
}

async function checksum(data: Uint8Array): Promise<Uint8Array> {
  return (await sha256Bytes(await sha256Bytes(data))).slice(0, 4);
}

/** Normalizes a URL the way the reference implementation does: no scheme, t=i added, query keys sorted. */
export function travelUri(uri: string): string {
  const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : `https://${uri}`);
  const params = new URLSearchParams(u.search);
  params.set('t', 'i');
  params.sort();
  const rest = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const path = /^[^/?#]*\//.test(rest) ? u.pathname : '';
  return `${u.host}${path}?${params.toString()}`;
}

/** Encodes a beneficiary endpoint as a Travel Address ("ta..."). */
export async function encodeTravelAddress(uri: string): Promise<string> {
  const raw = enc.encode(travelUri(uri));
  const sum = await checksum(raw);
  const full = new Uint8Array(raw.length + 4);
  full.set(raw); full.set(sum, raw.length);
  return `ta${b58encode(full)}`;
}

export class TravelAddressError extends Error {}

/** Decodes a Travel Address into its raw URI and the https URL to post the inquiry to. */
export async function decodeTravelAddress(ta: string, env?: Env): Promise<{ raw: string; url: string }> {
  if (!ta.startsWith('ta')) throw new TravelAddressError('A Travel Address starts with "ta".');
  const bytes = b58decode(ta.slice(2));
  if (!bytes || bytes.length < 5) throw new TravelAddressError('This Travel Address is not valid Base58Check.');
  const body = bytes.slice(0, -4);
  const sum = await checksum(body);
  if (sum.some((b, i) => b !== bytes[bytes.length - 4 + i])) throw new TravelAddressError('This Travel Address failed its checksum. Check for a typing error.');
  const raw = new TextDecoder().decode(body);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) throw new TravelAddressError('A Travel Address must not include a URI scheme.');
  if (new URLSearchParams(raw.split('?')[1] ?? '').get('t') !== 'i') throw new TravelAddressError('A Travel Address must carry the t=i parameter.');
  // The spec implies https. A local API (http://127.0.0.1:8787) is the one exception, so the sandbox works offline.
  const apiHost = env?.API_URL?.replace(/^https?:\/\//, '');
  const scheme = apiHost && raw.startsWith(apiHost) && env!.API_URL.startsWith('http://') ? 'http' : 'https';
  return { raw, url: `${scheme}://${raw}` };
}

/** The TRP endpoint for one beneficiary account at Laissez. Each organization's booking center acts as its own VASP. */
export const beneficiaryEndpoint = (env: Env, ws: string, investorId: string) => `${env.API_URL}/trp/v3/${ws}/${encodeURIComponent(investorId)}`;
export const callbackEndpoint = (env: Env, ws: string, msgId: string) => `${env.API_URL}/trp/v3/callback/${ws}/${msgId}`;
export const confirmEndpoint = (env: Env, ws: string, msgId: string) => `${env.API_URL}/trp/v3/confirm/${ws}/${msgId}`;

// ---------- IVMS101 ----------
export type Party = { name: string; kind: string; residence: string; city: string; wallet: string };
export type Vasp = { name: string; country: string };

export const iso2 = (jur: string) => (jur === 'AE-DIFC' ? 'AE' : jur.slice(0, 2));
const isNatural = (p: Party) => p.kind.toLowerCase() === 'individual';

function person(p: Party) {
  const address = [{ addressType: 'GEOG', townName: p.city || 'Not provided', country: iso2(p.residence) }];
  if (isNatural(p)) {
    const parts = p.name.trim().split(/\s+/);
    const primary = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    const secondary = parts.length > 1 ? parts.slice(0, -1).join(' ') : undefined;
    return { naturalPerson: { name: { nameIdentifier: [{ primaryIdentifier: primary, ...(secondary ? { secondaryIdentifier: secondary } : {}), nameIdentifierType: 'LEGL' }] }, geographicAddress: address, countryOfResidence: iso2(p.residence) } };
  }
  return { legalPerson: { name: { nameIdentifier: [{ legalPersonName: p.name, legalPersonNameIdentifierType: 'LEGL' }] }, geographicAddress: address, countryOfRegistration: iso2(p.residence) } };
}
const vasp = (v: Vasp) => ({ legalPerson: { name: { nameIdentifier: [{ legalPersonName: v.name, legalPersonNameIdentifierType: 'LEGL' }] }, countryOfRegistration: v.country } });

/** IVMS101 identity payload for a transfer between two accounts. */
export function ivms101(o: { originator: Party; beneficiary: Party; originatingVasp: Vasp; beneficiaryVasp: Vasp }) {
  return {
    originator: { originatorPersons: [person(o.originator)], accountNumber: [o.originator.wallet] },
    beneficiary: { beneficiaryPersons: [person(o.beneficiary)], accountNumber: [o.beneficiary.wallet] },
    originatingVASP: { originatingVASP: vasp(o.originatingVasp) },
    beneficiaryVASP: { beneficiaryVASP: vasp(o.beneficiaryVasp) },
  };
}

function nameOf(p: any): string | null {
  if (!p) return null;
  if (p.legalPerson) return p.legalPerson.name?.nameIdentifier?.[0]?.legalPersonName ?? null;
  if (p.naturalPerson) {
    const n = p.naturalPerson.name?.nameIdentifier?.[0];
    return n ? [n.secondaryIdentifier, n.primaryIdentifier].filter(Boolean).join(' ') : null;
  }
  return null;
}
export const beneficiaryName = (payload: any) => nameOf(payload?.beneficiary?.beneficiaryPersons?.[0]);
export const originatorName = (payload: any) => nameOf(payload?.originator?.originatorPersons?.[0]);
export const originatingVaspName = (payload: any) => payload?.originatingVASP?.originatingVASP?.legalPerson?.name?.nameIdentifier?.[0]?.legalPersonName ?? null;

const normName = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
/** Beneficiary name screening: exact match after normalizing case, accents and punctuation. */
export const namesMatch = (a: string | null, b: string | null) => !!a && !!b && normName(a) === normName(b);

// ---------- Transport ----------
export type TrpResult = { status: number; body: any; error?: string };

/** Posts one TRP message. Same-Worker URLs dispatch in-process (a Worker cannot fetch its own hostname). */
export async function trpPost(env: Env, url: string, requestId: string, body: unknown, extensions: string[] = []): Promise<TrpResult> {
  try {
    const res = await ofetch(env, url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'api-version': TRP_VERSION,
        'request-identifier': requestId,
        ...(extensions.length ? { 'api-extensions': extensions.join(',') } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text.slice(0, 500); }
    return { status: res.status, body: parsed };
  } catch (e: any) {
    return { status: 0, body: null, error: e?.message ?? 'Network error' };
  }
}

/** Only https endpoints, or this Worker itself, may receive TRP callbacks from the sandbox. */
export function safeCallback(env: Env, url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 600) return false;
  if (url.startsWith(env.API_URL + '/trp/')) return true;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname;
    if (h === 'localhost' || /^(10|127|169\.254|192\.168)\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.internal') || h.includes(':')) return false;
    return true;
  } catch { return false; }
}
