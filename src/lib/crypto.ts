import { ed25519 } from '@noble/curves/ed25519.js';
import { base58, base64urlnopad } from '@scure/base';

/** Cryptographically secure random bytes via the Workers runtime CSPRNG. */
export function randomBytes(length: number): Uint8Array {
  const b = new Uint8Array(length);
  crypto.getRandomValues(b);
  return b;
}

/** URL-safe random token. 32 bytes => 256 bits of entropy. */
export const randomToken = (bytes = 32): string => base64urlnopad.encode(randomBytes(bytes));

export const randomId = (): string => crypto.randomUUID();

export function decodeBase58(value: string): Uint8Array {
  return base58.decode(value);
}

export function encodeBase58(value: Uint8Array): string {
  return base58.encode(value);
}

/** A Solana address is a 32-byte ed25519 public key rendered as base58. */
export function isValidSolanaAddress(address: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  try {
    return decodeBase58(address).length === 32;
  } catch {
    return false;
  }
}

/**
 * Verify an ed25519 signature over `message` by `address`.
 *
 * Returns false — never throws — for any malformed input, so a caller cannot
 * distinguish "bad encoding" from "bad signature" and cannot use exceptions as
 * an oracle.
 */
export function verifySignature(
  message: Uint8Array,
  signatureBase58: string,
  address: string,
): boolean {
  try {
    const publicKey = decodeBase58(address);
    if (publicKey.length !== 32) return false;
    const signature = decodeBase58(signatureBase58);
    if (signature.length !== 64) return false;
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** Constant-time string comparison, to keep token checks free of timing leaks. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function hmacSign(secret: string, payload: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64urlnopad.encode(new Uint8Array(sig));
}

export async function hmacVerify(
  secret: string,
  payload: string,
  signature: string,
): Promise<boolean> {
  const expected = await hmacSign(secret, payload);
  return timingSafeEqual(expected, signature);
}
