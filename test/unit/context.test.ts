import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
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
