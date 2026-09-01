/**
 * Interactive Telegram setup: does the getUpdates/setWebhook dance for you
 * instead of handing you six curl commands to run one at a time.
 *
 * Handles:
 *   - confirming the bot token works
 *   - discovering TELEGRAM_GROUP_ID automatically (walks you through adding
 *     the bot, then polls getUpdates until it sees your group)
 *   - generating a webhook secret if you don't already have one
 *   - registering the webhook, with the allowed_updates the bot depends on
 *   - verifying the webhook actually took (getWebhookInfo)
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... node --experimental-transform-types scripts/setup-telegram.ts <worker-url>
 *
 * Nothing here is written to Cloudflare for you — it only talks to the
 * Telegram Bot API and prints the values you still need to paste into the
 * dashboard (or .dev.vars), so it never needs your Cloudflare credentials.
 */
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';

const token = process.env.TELEGRAM_BOT_TOKEN;
const workerUrlArg = process.argv[2];

if (!token) {
  console.error('Set TELEGRAM_BOT_TOKEN first, e.g.:');
  console.error('  TELEGRAM_BOT_TOKEN=123:abc node --experimental-transform-types scripts/setup-telegram.ts https://your-worker.workers.dev');
  process.exit(2);
}

const api = `https://api.telegram.org/bot${token}`;
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => rl.question(q);

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
  console.log(`  OK — this is @${me.username} (id ${me.id})\n`);

  console.log('Now, in Telegram:');
  console.log(`  1. Add @${me.username} to your private group`);
  console.log('  2. Promote it to admin with "Invite Users via Link" and "Ban Users" permissions');
  console.log('  3. Send any message in the group (e.g. "test")\n');
  await ask('Press Enter once you have done that... ');

  console.log('\nLooking for your group...');
  let groupId: string | undefined;
  let groupTitle: string | undefined;
  for (let attempt = 0; attempt < 15 && !groupId; attempt++) {
    const updates = await call<{ message?: { chat: { id: number; type: string; title?: string } } }[]>(
      'getUpdates',
      { limit: 100, allowed_updates: ['message'] },
    );
    for (const u of updates.reverse()) {
      const chat = u.message?.chat;
      if (chat && (chat.type === 'group' || chat.type === 'supergroup')) {
        groupId = String(chat.id);
        groupTitle = chat.title;
        break;
      }
    }
    if (!groupId) await new Promise((r) => setTimeout(r, 2000));
  }

  if (!groupId) {
    console.error('\nNo group message found after 30 seconds.');
    console.error('Common causes: bot privacy mode is still ON (BotFather → /setprivacy → Disable),');
    console.error('or a webhook is already registered, which steals updates from getUpdates');
    console.error('(delete it first: curl -s "' + api + '/deleteWebhook").');
    process.exit(1);
  }
  console.log(`  Found: "${groupTitle}" — TELEGRAM_GROUP_ID=${groupId}\n`);

  const workerUrl = workerUrlArg ?? (await ask('Your deployed Worker URL (e.g. https://your-worker.workers.dev): '));
  const webhookUrl = `${workerUrl.replace(/\/+$/, '')}/telegram/webhook`;

  const existingSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const secret = existingSecret || randomSecret();
  if (!existingSecret) {
    console.log(`\nGenerated a webhook secret (set TELEGRAM_WEBHOOK_SECRET yourself to reuse an existing one):`);
    console.log(`  ${secret}`);
  }

  console.log(`\nRegistering webhook at ${webhookUrl}...`);
  await call('setWebhook', {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ['message', 'chat_member'],
    drop_pending_updates: true,
  });

  const info = await call<{ url: string; last_error_message?: string; pending_update_count: number }>(
    'getWebhookInfo',
  );
  if (info.last_error_message) {
    console.error(`\nWebhook registered, but Telegram reports an error: ${info.last_error_message}`);
    console.error('This usually means the Worker is not deployed yet, or is misconfigured (check `wrangler tail`).');
  } else {
    console.log('  Webhook is live and error-free.\n');
  }

  console.log('Set these (dashboard "Variables and secrets", or .dev.vars locally):');
  console.log(`  TELEGRAM_GROUP_ID=${groupId}`);
  console.log(`  TELEGRAM_WEBHOOK_SECRET=${secret}`);
  console.log('\nThen message the bot /start to confirm it responds.');

  rl.close();
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  rl.close();
  process.exit(1);
});
