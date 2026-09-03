/**
 * Registers the Telegram webhook so the deployed bot starts receiving updates.
 *
 * This is the one step that genuinely cannot be conversational: the bot has
 * no way to talk to you until Telegram knows where to send updates, so this
 * has to run once, from outside, after the Worker is deployed.
 *
 * Everything after this: which group to gate, admin actions: is just
 * messaging the bot. Add it to your group as admin; it will detect that and
 * DM your admins to confirm via /setup. See docs/telegram-setup.md.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... node --experimental-transform-types scripts/setup-telegram.ts <worker-url>
 *
 * Nothing here touches Cloudflare: it only talks to the Telegram Bot API and
 * prints the webhook secret you still need to paste into the dashboard (or
 * .dev.vars locally).
 */
import { randomBytes } from 'node:crypto';

const token = process.env.TELEGRAM_BOT_TOKEN;
const workerUrlArg = process.argv[2];

if (!token || !workerUrlArg) {
  console.error('Usage:');
  console.error('  TELEGRAM_BOT_TOKEN=123:abc node --experimental-transform-types scripts/setup-telegram.ts https://your-worker.workers.dev');
  process.exit(2);
}

const api = `https://api.telegram.org/bot${token}`;

async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${api}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new Error(`${method} failed: ${json.description ?? res.status}`);
  return json.result as T;
}

function randomSecret(): string {
  // Telegram's secret_token only allows A-Z a-z 0-9 _ - (no + / =).
  return randomBytes(32).toString('base64').replace(/[+/]/g, (c) => (c === '+' ? '-' : '_')).replace(/=+$/, '');
}

async function main() {
  console.log('Checking bot token...');
  const me = await call<{ id: number; username: string }>('getMe');
  console.log(`  OK: this is @${me.username} (id ${me.id})\n`);

  const webhookUrl = `${workerUrlArg!.replace(/\/+$/, '')}/telegram/webhook`;
  const existingSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const secret = existingSecret || randomSecret();
  if (!existingSecret) {
    console.log('Generated a webhook secret (set TELEGRAM_WEBHOOK_SECRET yourself to reuse an existing one):');
    console.log(`  ${secret}\n`);
  }

  console.log(`Registering webhook at ${webhookUrl}...`);
  await call('setWebhook', {
    url: webhookUrl,
    secret_token: secret,
    // my_chat_member is what lets the bot notice being added to a group and
    // kick off /setup; chat_member is what migration mode watches for other
    // members joining/leaving.
    allowed_updates: ['message', 'chat_member', 'my_chat_member'],
    drop_pending_updates: true,
  });

  const info = await call<{ url: string; last_error_message?: string }>('getWebhookInfo');
  if (info.last_error_message) {
    console.error(`\nWebhook registered, but Telegram reports an error: ${info.last_error_message}`);
    console.error('This usually means the Worker is not deployed yet, or is misconfigured (check `wrangler tail`).');
    process.exitCode = 1;
    return;
  }

  console.log('  Webhook is live and error-free.\n');
  console.log(existingSecret ? 'Done.' : `Set TELEGRAM_WEBHOOK_SECRET=${secret} (dashboard or .dev.vars).`);
  console.log('\nNext: message the bot /start, then add it to your group as admin');
  console.log('(Invite Users via Link, Ban Users): it will DM your admins to confirm the group.');
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
