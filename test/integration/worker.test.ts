import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '../helpers.js';
import { signToken } from '../../src/lib/token.js';

const SECRET = 'test-session-secret-at-least-16-chars';

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`https://gate.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('worker routing', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('serves the health endpoint', async () => {
    const res = await SELF.fetch('https://gate.example/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('exposes public config without leaking the Helius key', async () => {
    const res = await SELF.fetch('https://gate.example/api/config');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.collectionId).toBe('J7rxtKmEpNJEtrfkagiTF1gsmLyVus6BQZFY4ouBkeMG');
    expect(JSON.stringify(body)).not.toContain('test-helius-key');
    expect(body).not.toHaveProperty('heliusApiKey');
  });

  it('public config reports groupTitle as null before any group is confirmed', async () => {
    await env.KV.delete('config:telegram_group_title');
    const res = await SELF.fetch('https://gate.example/api/config');
    const body = (await res.json()) as { groupTitle: unknown };
    expect(body.groupTitle).toBeNull();
  });

  it('public config reports the confirmed group title once set', async () => {
    await env.KV.put('config:telegram_group_title', 'SBF Cabal');
    const res = await SELF.fetch('https://gate.example/api/config');
    const body = (await res.json()) as { groupTitle: unknown };
    expect(body.groupTitle).toBe('SBF Cabal');
    await env.KV.delete('config:telegram_group_title');
  });

  it('sets hardening headers on API responses', async () => {
    const res = await SELF.fetch('https://gate.example/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects a challenge request with no session token', async () => {
    const res = await post('/api/verify/challenge', {
      token: 'garbage',
      walletAddress: 'J7rxtKmEpNJEtrfkagiTF1gsmLyVus6BQZFY4ouBkeMG',
    });
    expect(res.status).toBe(401);
  });

  it('rejects a malformed challenge body', async () => {
    const token = await signToken(SECRET, { sub: '1', aud: 'verify' }, 300);
    const res = await post('/api/verify/challenge', { token });
    expect(res.status).toBe(400);
  });

  it('issues a challenge bound to the token holder, not the request body', async () => {
    const token = await signToken(SECRET, { sub: '424242', aud: 'verify' }, 300);
    const res = await post('/api/verify/challenge', {
      token,
      walletAddress: 'J7rxtKmEpNJEtrfkagiTF1gsmLyVus6BQZFY4ouBkeMG',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { challenge: string };
    expect(body.challenge).toContain('424242');

    const row = await env.DB.prepare(
      'SELECT telegram_user_id FROM verification_nonces LIMIT 1',
    ).first<{ telegram_user_id: string }>();
    expect(row?.telegram_user_id).toBe('424242');
  });

  it('rejects an oversized request body', async () => {
    const token = await signToken(SECRET, { sub: '1', aud: 'verify' }, 300);
    const res = await post('/api/verify/challenge', { token, walletAddress: 'x'.repeat(40_000) });
    expect([400, 413]).toContain(res.status);
  });

  it('falls through unknown paths to the static assets (the React SPA)', async () => {
    const res = await SELF.fetch('https://gate.example/verify');
    expect(res.status).toBe(200);
    const html = await res.text();
    // Served by this same Worker via the ASSETS binding: no Pages involved.
    expect(html).toContain('<div id="root">');
    expect(html).toContain('/assets/');
  });

  it('serves the built JS bundle as a static asset', async () => {
    const index = await (await SELF.fetch('https://gate.example/')).text();
    const src = /src="([^"]+\.js)"/.exec(index)?.[1];
    expect(src).toBeTruthy();
    const asset = await SELF.fetch(`https://gate.example${src}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toMatch(/javascript/);
  });
});

describe('telegram webhook', () => {
  it('rejects an update without the shared secret header', async () => {
    const res = await post('/telegram/webhook', { update_id: 1 });
    expect(res.status).toBe(403);
  });

  it('rejects an update with the wrong shared secret', async () => {
    const res = await post('/telegram/webhook', { update_id: 1 }, {
      'x-telegram-bot-api-secret-token': 'wrong',
    });
    expect(res.status).toBe(403);
  });
});

describe('rate limiting', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('throttles repeated challenge requests from one Telegram user', async () => {
    const token = await signToken(SECRET, { sub: '31337', aud: 'verify' }, 300);
    const wallet = 'J7rxtKmEpNJEtrfkagiTF1gsmLyVus6BQZFY4ouBkeMG';

    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      const res = await post('/api/verify/challenge', { token, walletAddress: wallet });
      statuses.push(res.status);
    }
    // Limit is 10 per 5-minute window.
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(10);
    expect(statuses).toContain(429);
  });
});
