// Minimal WebAuthn (passkeys) relying party. Registration trusts the SPKI public key the
// browser reports (attestation "none"); sign-in verifies the assertion signature with WebCrypto.
import { ApiError, b64url, fromB64url, sha256Bytes, enc } from './util';

export type RegistrationResponse = { id: string; rawId: string; type: string; response: { clientDataJSON: string; attestationObject?: string; publicKey: string; publicKeyAlgorithm: number; transports?: string[] } };
export type AssertionResponse = { id: string; rawId: string; type: string; response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string | null } };

export function rpFor(origin: string | undefined, allowed: string[]) {
  const o = origin && allowed.includes(origin) ? origin : allowed[0];
  return { origin: o, rpId: new URL(o).hostname };
}

function checkClientData(b64: string, type: string, challenge: string, origins: string[]) {
  let cd: any;
  try { cd = JSON.parse(new TextDecoder().decode(fromB64url(b64))); } catch { throw new ApiError(400, 'bad_passkey', 'The passkey response could not be read.'); }
  if (cd.type !== type) throw new ApiError(400, 'bad_passkey', 'Unexpected passkey ceremony type.');
  if (cd.challenge !== challenge) throw new ApiError(400, 'bad_passkey', 'This passkey request expired or was already used. Try again.');
  if (!origins.includes(cd.origin)) throw new ApiError(400, 'bad_origin', `Passkeys for Laissez only work on ${origins[0]}.`);
  return cd;
}

export function verifyRegistration(r: RegistrationResponse, challenge: string, origins: string[]) {
  if (r.type !== 'public-key' || !r.id || !r.response?.publicKey) throw new ApiError(400, 'bad_passkey', 'This browser did not return a public key. Use a current version of Chrome, Safari, Edge or Firefox.');
  checkClientData(r.response.clientDataJSON, 'webauthn.create', challenge, origins);
  const alg = Number(r.response.publicKeyAlgorithm);
  if (alg !== -7 && alg !== -257) throw new ApiError(400, 'unsupported_alg', 'This passkey uses an algorithm Laissez does not accept.');
  return { credentialId: r.id, publicKey: r.response.publicKey, alg, transports: r.response.transports ?? [] };
}

/** Convert a DER-encoded ECDSA signature to the raw r||s form WebCrypto expects. */
function derToRaw(der: Uint8Array): Uint8Array {
  let i = 2;
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  const read = () => {
    if (der[i++] !== 0x02) throw new Error('der');
    const len = der[i++];
    let v = der.slice(i, i + len); i += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32); out.set(v, 32 - v.length);
    return out;
  };
  const r = read(); const s = read();
  const raw = new Uint8Array(64); raw.set(r, 0); raw.set(s, 32);
  return raw;
}

export async function verifyAssertion(a: AssertionResponse, stored: { public_key: string; alg: number; sign_count: number }, challenge: string, origins: string[], rpId: string) {
  checkClientData(a.response.clientDataJSON, 'webauthn.get', challenge, origins);
  const authData = fromB64url(a.response.authenticatorData);
  const rpHash = await sha256Bytes(enc.encode(rpId));
  if (b64url(authData.slice(0, 32)) !== b64url(rpHash)) throw new ApiError(400, 'bad_passkey', 'This passkey belongs to a different site.');
  const flags = authData[32];
  if (!(flags & 0x01)) throw new ApiError(400, 'bad_passkey', 'The authenticator did not confirm user presence.');
  const counter = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
  if (counter > 0 && stored.sign_count > 0 && counter <= stored.sign_count) throw new ApiError(400, 'cloned_passkey', 'This passkey looks cloned. Sign in with another passkey and remove this one.');
  const clientHash = await sha256Bytes(fromB64url(a.response.clientDataJSON));
  const signed = new Uint8Array(authData.length + clientHash.length);
  signed.set(authData, 0); signed.set(clientHash, authData.length);
  const spki = fromB64url(stored.public_key);
  let ok = false;
  if (stored.alg === -7) {
    const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(fromB64url(a.response.signature)), signed);
  } else {
    const key = await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(a.response.signature), signed);
  }
  if (!ok) throw new ApiError(401, 'bad_signature', 'The passkey signature did not verify.');
  return { counter, userVerified: !!(flags & 0x04) };
}
