import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBot, type BotDeps } from '../../src/bot/bot.js';
import { buildContext, resetDatabase } from '../helpers.js';

const BOT_INFO = {
  id: 123456789, is_bot: true as const, first_name: 'Gate Bot', username: 'gate_bot',
  can_join_groups: true as const, can_read_all_group_messages: true as const,
  supports_inline_queries: false as const, can_connect_to_business: false as const,
  has_main_web_app: false as const, has_topics_enabled: false as const,
  allows_users_to_create_topics: false as const, can_manage_bots: false as const,
  supports_join_request_queries: false as const,
};

const ADMIN_ID = '111111'; // matches ADMIN_TELEGRAM_IDS in vitest.config.ts
const NON_ADMIN_ID = '999999';

async function resetKvState(): Promise<void> {
  await env.KV.delete(`admin-menu-set:${ADMIN_ID}`);
  await env.KV.delete('config:telegram_group_title');
  const rateLimitKeys = await env.KV.list({ prefix: 'rl:' });
  await Promise.all(rateLimitKeys.keys.map((k) => env.KV.delete(k.name)));
}

const messageUpdate = (text: string, userId: string) => ({
  update_id: 1,
  message: {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: Number(userId), type: 'private' as const },
    from: { id: Number(userId), is_bot: false, first_name: 'Tester' },
    text,
    entities: [{ type: 'bot_command' as const, offset: 0, length: text.length }],
  },
});

/**
 * Drives the bot directly via bot.handleUpdate, bypassing the HTTP webhook
 * route. This is what lets telegramGroupId be overridden per test — the
 * webhook-based integration tests share one worker whose env is fixed for
 * the whole file.
 */
async function sendToBotDirectly(deps: BotDeps, text: string, userId: string) {
  const bot = createBot(deps, BOT_INFO);
  await bot.handleUpdate(messageUpdate(text, userId) as never);
}

describe('replyWithVerifyLink when no group is configured', () => {
  const sent: { text: string }[] = [];

  beforeEach(async () => {
    await resetDatabase();
    await resetKvState();
    sent.length = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://api.telegram.org/')) throw new Error(`unexpected fetch: ${url}`);
      if (url.includes('/sendMessage')) {
        sent.push({ text: JSON.parse(String(init?.body ?? '{}')).text });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function unconfiguredDeps(): Promise<BotDeps> {
    const ctx = await buildContext();
    ctx.config.telegramGroupId = ''; // simulate nothing confirmed yet
    return {
      config: ctx.config, db: ctx.db, access: ctx.access, ownership: ctx.ownership,
      rateLimiter: ctx.rateLimiter, telegram: ctx.telegram, kv: ctx.env.KV, baseUrl: ctx.baseUrl,
    };
  }

  it('tells an admin setup is unfinished, with no verify button offered', async () => {
    const deps = await unconfiguredDeps();
    await sendToBotDirectly(deps, '/start', ADMIN_ID);
    expect(sent[0]?.text).toMatch(/isn't fully set up yet/);
    expect(sent[0]?.text).toMatch(/\/setup confirm/);
  });

  it('tells a non-admin only that it is not ready, nothing about setup', async () => {
    const deps = await unconfiguredDeps();
    await sendToBotDirectly(deps, '/start', NON_ADMIN_ID);
    expect(sent[0]?.text).toMatch(/isn't ready yet/);
    expect(sent[0]?.text).not.toMatch(/setup|admin/i);
  });

  it('/verify (not just /start) also refuses when unconfigured', async () => {
    const deps = await unconfiguredDeps();
    await sendToBotDirectly(deps, '/verify', NON_ADMIN_ID);
    expect(sent[0]?.text).toMatch(/isn't ready yet/);
  });
});

describe('replyWithVerifyLink uses the confirmed group title', () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetKvState();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://api.telegram.org/')) throw new Error(`unexpected fetch: ${url}`);
      capturedText = JSON.parse(String(init?.body ?? '{}')).text;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  let capturedText = '';

  it('names the actual group instead of generic "this group" text', async () => {
    const ctx = await buildContext();
    await ctx.env.KV.put('config:telegram_group_title', 'SBF Cabal');
    const deps: BotDeps = {
      config: ctx.config, db: ctx.db, access: ctx.access, ownership: ctx.ownership,
      rateLimiter: ctx.rateLimiter, telegram: ctx.telegram, kv: ctx.env.KV, baseUrl: ctx.baseUrl,
    };
    await sendToBotDirectly(deps, '/start', NON_ADMIN_ID);
    expect(capturedText).toContain('"SBF Cabal"');
    expect(capturedText).not.toMatch(/this group/i);
  });

  it('falls back to generic phrasing when no title has been recorded', async () => {
    const ctx = await buildContext();
    const deps: BotDeps = {
      config: ctx.config, db: ctx.db, access: ctx.access, ownership: ctx.ownership,
      rateLimiter: ctx.rateLimiter, telegram: ctx.telegram, kv: ctx.env.KV, baseUrl: ctx.baseUrl,
    };
    await sendToBotDirectly(deps, '/start', NON_ADMIN_ID);
    expect(capturedText).toMatch(/prove you control a Solana wallet/i);
  });
});

describe('admin command menu registration', () => {
  const setMyCommandsCalls: unknown[] = [];

  beforeEach(async () => {
    await resetDatabase();
    await resetKvState();
    setMyCommandsCalls.length = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://api.telegram.org/')) throw new Error(`unexpected fetch: ${url}`);
      if (url.includes('/setMyCommands')) setMyCommandsCalls.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function deps(): Promise<BotDeps> {
    const ctx = await buildContext();
    return {
      config: ctx.config, db: ctx.db, access: ctx.access, ownership: ctx.ownership,
      rateLimiter: ctx.rateLimiter, telegram: ctx.telegram, kv: ctx.env.KV, baseUrl: ctx.baseUrl,
    };
  }

  it('registers a chat-scoped command menu for an admin on first contact', async () => {
    await sendToBotDirectly(await deps(), '/help', ADMIN_ID);
    expect(setMyCommandsCalls).toHaveLength(1);
    const call = setMyCommandsCalls[0] as { scope: { type: string; chat_id: number }; commands: { command: string }[] };
    expect(call.scope).toEqual({ type: 'chat', chat_id: Number(ADMIN_ID) });
    expect(call.commands.map((c) => c.command)).toContain('adminrevoke');
  });

  it('does not register a command menu for a non-admin', async () => {
    await sendToBotDirectly(await deps(), '/help', NON_ADMIN_ID);
    expect(setMyCommandsCalls).toHaveLength(0);
  });

  it('only registers the menu once per admin (cached in KV)', async () => {
    const d = await deps();
    await sendToBotDirectly(d, '/help', ADMIN_ID);
    await sendToBotDirectly(d, '/help', ADMIN_ID);
    expect(setMyCommandsCalls).toHaveLength(1);
  });
});
