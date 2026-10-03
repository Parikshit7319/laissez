// Time-based one-time passwords (RFC 6238) for the authenticator-app second method. HMAC-SHA1, 6 digits, 30 second
// steps, one step of tolerance either side. Secrets are 160-bit, base32 encoded, and sealed at rest (util.seal).
import { enc } from './util';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(bytes: Uint8Array): string {
  let bits = 0; let value = 0; let out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function fromBase32(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export const newTotpSecret = () => base32(crypto.getRandomValues(new Uint8Array(20)));
export const totpUri = (secret: string, account: string, issuer = 'Laissez') =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

async function hotp(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', fromBase32(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[19] & 15;
  const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}
export const totpAt = (secret: string, atMs: number) => hotp(secret, Math.floor(atMs / 30_000));

/**
 * Checks a code against the current step and one either side. Returns the matching step, or null.
 * `lastStep` rejects a step already used, so one code cannot be replayed inside its window.
 */
export async function verifyTotp(secret: string, code: string, nowMs = Date.now(), lastStep: number | null = null): Promise<number | null> {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(nowMs / 30_000);
  for (const s of [step, step - 1, step + 1]) {
    if (lastStep !== null && s <= lastStep) continue;
    const expect = await hotp(secret, s);
    // Constant-time compare of two six digit strings.
    let diff = 0; for (let i = 0; i < 6; i++) diff |= expect.charCodeAt(i) ^ c.charCodeAt(i);
    if (diff === 0) return s;
  }
  return null;
}
void enc;
