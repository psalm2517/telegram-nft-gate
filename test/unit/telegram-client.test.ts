import { describe, expect, it } from 'vitest';
import { TelegramClient } from '../../src/services/telegram.js';

describe('TelegramClient default fetchImpl (regression)', () => {
  // Every other test that exercises TelegramClient goes through bot.test.ts's
  // stubbed global fetch, which — critically — does NOT reproduce this bug:
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
        // fetchImpl deliberately omitted — exercises the real default.
      });
      const result = await client.getMe();

      // An invalid token fails authentication (a real HTTP response from
      // Telegram), which is only reachable if the fetch call itself
      // succeeded — proof the binding is correct. A thrown "Illegal
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
