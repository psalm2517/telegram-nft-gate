import { webhookCallback } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { AppContext } from '../context.js';
import { createBot } from '../bot/bot.js';
import { json } from '../lib/http.js';
import { timingSafeEqual } from '../lib/crypto.js';

const BOT_INFO_KEY = 'telegram:bot-info';
const BOT_INFO_TTL_SECONDS = 24 * 60 * 60;

/**
 * grammY needs the bot's own identity before it can dispatch updates, and
 * fetches it with `getMe` unless supplied. A Worker starts cold constantly, so
 * without caching that is one extra Telegram round-trip per webhook request.
 *
 * A miss is not fatal: we let grammY do its own `init()` instead.
 */
async function loadBotInfo(ctx: AppContext): Promise<UserFromGetMe | undefined> {
  const cached = await ctx.env.KV.get(BOT_INFO_KEY, 'json');
  if (cached) return cached as UserFromGetMe;

  const me = await ctx.telegram.getMe();
  if (!me.ok) return undefined;

  const info = me.value;
  await ctx.env.KV.put(BOT_INFO_KEY, JSON.stringify(info), {
    expirationTtl: BOT_INFO_TTL_SECONDS,
  });
  return info;
}

/**
 * Telegram webhook entrypoint.
 *
 * Telegram signs nothing, so the shared secret header set at
 * `setWebhook(secret_token=...)` is the only thing separating real updates from
 * anyone who guesses the URL. Treat a missing/incorrect header as hostile.
 */
export async function handleTelegramWebhook(
  request: Request,
  ctx: AppContext,
): Promise<Response> {
  const expected = ctx.config.telegramWebhookSecret;
  if (expected) {
    const provided = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
    if (!timingSafeEqual(expected, provided)) {
      // Returned rather than thrown: an unauthenticated caller hitting the
      // webhook is an expected, routine event, not an exceptional one.
      return json(
        { error: 'invalid_webhook_secret', message: 'Invalid webhook secret.' },
        { status: 403 },
      );
    }
  }

  const botInfo = await loadBotInfo(ctx);
  const bot = createBot(
    {
      config: ctx.config,
      db: ctx.db,
      access: ctx.access,
      ownership: ctx.ownership,
      telegram: ctx.telegram,
      kv: ctx.env.KV,
      rateLimiter: ctx.rateLimiter,
      baseUrl: ctx.baseUrl,
    },
    botInfo,
  );
  if (!botInfo) await bot.init();

  return webhookCallback(bot, 'cloudflare-mod')(request);
}
