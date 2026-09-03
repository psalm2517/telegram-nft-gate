import { describe, expect, it } from 'vitest';
import { handleTelegramWebhook } from '../../src/routes/telegram.js';
import { buildContext } from '../helpers.js';

const update = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://gate.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('telegram webhook authentication', () => {
  /**
   * The webhook must fail closed. Skipping the check when no secret is
   * configured would let anyone who guesses this URL forge an update carrying
   * an admin's `from.id` and drive the admin commands: while real Telegram
   * traffic kept working, so nothing would look broken.
   */
  it('refuses every update when no webhook secret is configured', async () => {
    const ctx = await buildContext({ TELEGRAM_WEBHOOK_SECRET: '' });
    expect(ctx.config.telegramWebhookSecret).toBeUndefined();

    const res = await handleTelegramWebhook(update({ update_id: 1 }), ctx);

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'webhook_not_configured' });
  });

  it('refuses a forged admin update when no secret is configured', async () => {
    const ctx = await buildContext({ TELEGRAM_WEBHOOK_SECRET: '' });
    const adminId = ctx.config.adminTelegramIds[0]!;

    const res = await handleTelegramWebhook(
      update({
        update_id: 2,
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          text: '/adminusers',
          chat: { id: Number(adminId), type: 'private' },
          from: { id: Number(adminId), is_bot: false, first_name: 'Forged' },
        },
      }),
      ctx,
    );

    expect(res.status).toBe(503);
    // Nothing reached the bot, so no reply was ever attempted.
    expect(ctx.fakeTelegram.messages).toHaveLength(0);
  });
});
