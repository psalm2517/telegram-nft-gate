import { describe, expect, it } from 'vitest';
import { signToken, verifyToken } from '../../src/lib/token.js';
import { timingSafeEqual, isValidSolanaAddress } from '../../src/lib/crypto.js';

const SECRET = 'a-test-secret-of-sufficient-length';

describe('signed tokens', () => {
  it('round-trips a valid token', async () => {
    const token = await signToken(SECRET, { sub: '42', aud: 'verify' }, 60);
    const payload = await verifyToken(SECRET, token, 'verify');
    expect(payload?.sub).toBe('42');
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signToken('other-secret-of-good-length', { sub: '42', aud: 'verify' }, 60);
    expect(await verifyToken(SECRET, token, 'verify')).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const token = await signToken(SECRET, { sub: '42', aud: 'verify' }, 60);
    const [, sig] = token.split('.');
    const forged = `${btoa(JSON.stringify({ sub: '999', aud: 'verify', exp: 9e9 }))
      .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.${sig}`;
    expect(await verifyToken(SECRET, forged, 'verify')).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await signToken(SECRET, { sub: '42', aud: 'verify' }, 60, 1000);
    expect(await verifyToken(SECRET, token, 'verify', 2000)).toBeNull();
  });

  it('rejects structurally malformed tokens', async () => {
    for (const bad of ['', '.', 'nodot', 'a.', '.b', 'a.b.c']) {
      expect(await verifyToken(SECRET, bad, 'verify')).toBeNull();
    }
  });
});

describe('crypto helpers', () => {
  it('compares strings without leaking length-independent differences', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('validates Solana addresses as 32-byte base58 keys', () => {
    expect(isValidSolanaAddress('J7rxtKmEpNJEtrfkagiTF1gsmLyVus6BQZFY4ouBkeMG')).toBe(true);
    expect(isValidSolanaAddress('too-short')).toBe(false);
    // base58 excludes 0, O, I and l
    expect(isValidSolanaAddress('0OIl'.padEnd(44, 'x'))).toBe(false);
  });
});
