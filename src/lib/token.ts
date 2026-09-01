import { base64urlnopad } from '@scure/base';
import { hmacSign, hmacVerify } from './crypto.js';

/**
 * Compact stateless token: base64url(JSON payload).base64url(HMAC-SHA256).
 *
 * Binds the verification web app link to a Telegram user. `aud` exists so a
 * token minted for one purpose can never be silently accepted for another,
 * even though "verify" is the only purpose today.
 */
export interface TokenPayload {
  /** subject: Telegram user id */
  sub: string;
  aud: 'verify';
  /** issued-at / expires-at, epoch seconds */
  iat: number;
  exp: number;
  /** opaque extras (e.g. username) */
  [key: string]: unknown;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function signToken(
  secret: string,
  payload: { sub: string; aud: TokenPayload['aud'] } & Record<string, unknown>,
  ttlSeconds: number,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const body: TokenPayload = { ...payload, iat: now, exp: now + ttlSeconds };
  const encoded = base64urlnopad.encode(enc.encode(JSON.stringify(body)));
  const sig = await hmacSign(secret, encoded);
  return `${encoded}.${sig}`;
}

export async function verifyToken(
  secret: string,
  token: string,
  audience: TokenPayload['aud'],
  now: number = Math.floor(Date.now() / 1000),
): Promise<TokenPayload | null> {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  // Signature is checked before the payload is parsed, so unauthenticated input
  // never reaches JSON.parse.
  if (!(await hmacVerify(secret, encoded, signature))) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(dec.decode(base64urlnopad.decode(encoded))) as TokenPayload;
  } catch {
    return null;
  }

  if (typeof payload?.sub !== 'string' || payload.sub === '') return null;
  if (payload.aud !== audience) return null;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
  return payload;
}
