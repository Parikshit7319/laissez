// Browser side of passkeys (WebAuthn). Converts the server's JSON options into the
// ArrayBuffer shapes the browser wants, and the browser's credential back into JSON.

export class PasskeyError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function b64urlToBuf(s: string): ArrayBuffer {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function bufToB64url(buf: ArrayBuffer | ArrayBufferView | null | undefined): string {
  if (!buf) return '';
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const passkeysSupported = () => typeof window !== 'undefined' && typeof (window as any).PublicKeyCredential === 'function' && !!navigator.credentials;

function unsupported(): never {
  throw new PasskeyError('unsupported', 'This browser does not support passkeys. Use a current version of Chrome, Safari, Edge or Firefox, or sign in with single sign-on.');
}

function friendly(e: any, ceremony: 'create' | 'get'): PasskeyError {
  if (e instanceof PasskeyError) return e;
  const name = e?.name ?? '';
  if (name === 'NotAllowedError') return new PasskeyError('cancelled', ceremony === 'create' ? 'Passkey setup was cancelled or timed out. Try again when you are ready.' : 'Sign-in was cancelled or timed out, or this device has no Laissez passkey. Try again, or create an account.');
  if (name === 'InvalidStateError') return new PasskeyError('exists', 'This device already holds a passkey for this account. Sign in with it instead.');
  if (name === 'SecurityError') return new PasskeyError('security', 'Passkeys only work on the Laissez site over HTTPS. Open the app from its usual address and try again.');
  if (name === 'NotSupportedError') return new PasskeyError('unsupported', 'This device cannot create a passkey of the type Laissez needs. Try another device or a security key.');
  if (name === 'AbortError') return new PasskeyError('cancelled', 'The passkey request was interrupted. Try again.');
  return new PasskeyError('failed', e?.message ? `The passkey request failed: ${e.message}` : 'The passkey request failed. Try again.');
}

/** Run navigator.credentials.create with server options and return JSON for /register/verify. */
export async function createPasskey(options: any) {
  if (!passkeysSupported()) unsupported();
  const publicKey: PublicKeyCredentialCreationOptions = {
    ...options,
    challenge: b64urlToBuf(options.challenge),
    user: { ...options.user, id: b64urlToBuf(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map((c: any) => ({ ...c, id: b64urlToBuf(c.id) })),
  };
  let cred: PublicKeyCredential | null;
  try { cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null; } catch (e) { throw friendly(e, 'create'); }
  if (!cred) throw new PasskeyError('cancelled', 'No passkey was created. Try again.');
  const r = cred.response as AuthenticatorAttestationResponse;
  const pub = typeof r.getPublicKey === 'function' ? r.getPublicKey() : null;
  if (!pub) throw new PasskeyError('unsupported', 'This browser did not share the passkey public key. Use a current version of Chrome, Safari, Edge or Firefox.');
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufToB64url(r.clientDataJSON),
      attestationObject: bufToB64url(r.attestationObject),
      publicKey: bufToB64url(pub),
      publicKeyAlgorithm: typeof r.getPublicKeyAlgorithm === 'function' ? r.getPublicKeyAlgorithm() : -7,
      transports: (r as any).getTransports?.() ?? [],
    },
  };
}

/** Run navigator.credentials.get with server options and return JSON for /login/verify. */
export async function getPasskey(options: any) {
  if (!passkeysSupported()) unsupported();
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...options,
    challenge: b64urlToBuf(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map((c: any) => ({ ...c, id: b64urlToBuf(c.id) })),
  };
  let cred: PublicKeyCredential | null;
  try { cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null; } catch (e) { throw friendly(e, 'get'); }
  if (!cred) throw new PasskeyError('cancelled', 'No passkey was chosen. Try again.');
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufToB64url(r.clientDataJSON),
      authenticatorData: bufToB64url(r.authenticatorData),
      signature: bufToB64url(r.signature),
      userHandle: r.userHandle ? bufToB64url(r.userHandle) : null,
    },
  };
}
