import { describe, expect, it } from 'vitest';
import { TelegramClient } from '../../src/services/telegram.js';

describe('TelegramClient default fetchImpl (regression)', () => {
  // Every other test that exercises TelegramClient goes through bot.test.ts's
  // stubbed global fetch, which (critically) does NOT reproduce this bug:
  // a plain stub function has no `this`-receiver requirement, so it masked
  // the fact that the *real* Workers fetch throws "Illegal invocation" when
  // stored as a bare reference and called as `this.fetchImpl(...)`. This test
  // deliberately omits fetchImpl to exercise the real default against a real
  // endpoint, the same way the equivalent OwnershipChecker regression test
  // does.
  it('does not throw "Illegal invocation" when using the real default fetch', async () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const client = new TelegramClient({
        botToken: 'not-a-real-token:invalid',
        groupId: '-1000000000000',
        // fetchImpl deliberately omitted: exercises the real default.
      });
      const result = await client.getMe();

      // An invalid token fails authentication (a real HTTP response from
      // Telegram), which is only reachable if the fetch call itself
      // succeeded: proof the binding is correct. A thrown "Illegal
      // invocation" would instead surface as { error: 'network_error' }.
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).not.toBe('network_error');
      for (const call of errors) {
        expect(JSON.stringify(call)).not.toMatch(/Illegal invocation/);
      }
    } finally {
      console.error = originalError;
    }
  });
});

describe('TelegramClient group migration handling', () => {
  const MIGRATE_RESPONSE = (newId: number) =>
    new Response(
      JSON.stringify({
        ok: false,
        error_code: 400,
        description: 'Bad Request: group chat was upgraded to a supergroup chat',
        parameters: { migrate_to_chat_id: newId },
      }),
      { status: 400 },
    );

  it('transparently retries against the new chat id and reports it', async () => {
    const calls: { method: string; chatId: unknown }[] = [];
    let migratedCallback: string | null = null;

    const client = new TelegramClient({
      botToken: 't',
      groupId: '-100111',
      onGroupMigrated: (newId) => {
        migratedCallback = newId;
      },
      fetchImpl: async (input, init) => {
        const method = String(input).split('/').pop();
        const body = JSON.parse(String(init?.body ?? '{}'));
        calls.push({ method: method!, chatId: body.chat_id });
        if (body.chat_id === '-100111') return MIGRATE_RESPONSE(-100222);
        return new Response(JSON.stringify({ ok: true, result: { invite_link: 'https://t.me/+x' } }));
      },
    });

    const result = await client.createSingleUseInviteLink('user-1');

    expect(result.ok).toBe(true);
    expect(migratedCallback).toBe('-100222');
    // First call against the stale id, second (transparent retry) against the new one.
    expect(calls).toEqual([
      { method: 'createChatInviteLink', chatId: '-100111' },
      { method: 'createChatInviteLink', chatId: '-100222' },
    ]);
  });

  it('self-heals for subsequent calls on the same client instance', async () => {
    const seenChatIds: unknown[] = [];
    const client = new TelegramClient({
      botToken: 't',
      groupId: '-100111',
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        seenChatIds.push(body.chat_id);
        if (body.chat_id === '-100111') return MIGRATE_RESPONSE(-100222);
        return new Response(JSON.stringify({ ok: true, result: { status: 'member' } }));
      },
    });

    await client.getChatMember('42'); // triggers + follows the migration
    await client.getChatMember('42'); // should go straight to the new id

    expect(seenChatIds).toEqual(['-100111', '-100222', '-100222']);
  });

  it('does not follow a migration reported for an unrelated chat id', async () => {
    const client = new TelegramClient({
      botToken: 't',
      groupId: '-100111',
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        // getChat targets an arbitrary id, not the configured group: a
        // migration reported for it must not overwrite the real group id.
        if (body.chat_id === '-999999') return MIGRATE_RESPONSE(-100222);
        return new Response(JSON.stringify({ ok: true, result: { status: 'member' } }));
      },
    });

    await client.getChat('-999999');
    const result = await client.getChatMember('42');
    expect(result.ok).toBe(true); // still using -100111, unaffected
  });
});
