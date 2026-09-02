import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext } from '../../src/context.js';
import type { Env } from '../../src/env.js';

const baseEnv = (overrides: Partial<Env> = {}): Env => ({ ...(env as unknown as Env), ...overrides });

describe('createContext group id resolution', () => {
  beforeEach(async () => {
    await env.KV.delete('config:telegram_group_id');
  });

  it('uses the env-configured group id when nothing is confirmed in KV', async () => {
    const ctx = await createContext(baseEnv());
    expect(ctx.config.telegramGroupId).toBe('-1001234567890'); // set in vitest.config.ts
  });

  it('lets a KV-confirmed group id (via /setup) override the env value', async () => {
    await env.KV.put('config:telegram_group_id', '-100999888');
    const ctx = await createContext(baseEnv());
    expect(ctx.config.telegramGroupId).toBe('-100999888');
  });

  it('resolves to an empty string when neither env nor KV has a group configured', async () => {
    const ctx = await createContext(baseEnv({ TELEGRAM_GROUP_ID: undefined }));
    expect(ctx.config.telegramGroupId).toBe('');
  });

  it('does not throw when unconfigured — misconfiguration only bites when a group action is attempted', async () => {
    await expect(createContext(baseEnv({ TELEGRAM_GROUP_ID: undefined }))).resolves.toBeDefined();
  });
});

describe('createContext wires group-migration persistence', () => {
  it('persists a migrated group id to KV via the real TelegramClient', async () => {
    await env.KV.delete('config:telegram_group_id');
    const originalGroupId = baseEnv().TELEGRAM_GROUP_ID;

    // Must stub before createContext: TelegramClient binds fetch at
    // construction time, so stubbing afterward would miss it entirely.
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.chat_id === originalGroupId) {
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: 'Bad Request: group chat was upgraded to a supergroup chat',
            parameters: { migrate_to_chat_id: -100999888 },
          }),
          { status: 400 },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: { status: 'member' } }));
    });

    try {
      const ctx = await createContext(baseEnv());
      const result = await ctx.telegram.getChatMember('42');
      expect(result.ok).toBe(true);
      expect(await env.KV.get('config:telegram_group_id')).toBe('-100999888');
    } finally {
      vi.unstubAllGlobals();
      await env.KV.delete('config:telegram_group_id');
    }
  });
});
