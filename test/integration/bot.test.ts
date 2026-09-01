import { env, SELF } from 'cloudflare:test';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDatabase } from '../helpers.js';

const SECRET = 'test-webhook-secret';
const USER_ID = 700100;

const BOT_INFO = {
  id: 123456789, is_bot: true, first_name: 'Gate Bot', username: 'gate_bot',
  can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
};

/** Send an update through the real webhook route, as Telegram would. */
function sendUpdate(update: unknown, secret = SECRET) {
  return SELF.fetch('https://gate.example/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify(update),
  });
}

let updateId = 1;
const command = (text: string, userId = USER_ID) => ({
  update_id: updateId++,
  message: {
    message_id: updateId,
    date: Math.floor(Date.now() / 1000),
    chat: { id: userId, type: 'private' },
    from: { id: userId, is_bot: false, first_name: 'Tester', username: 'tester' },
    text,
    entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }],
  },
});

/** Captured outbound Bot API calls, newest last. */
const sent: { method: string; body: Record<string, unknown> }[] = [];

const RESULTS: Record<string, unknown> = {
  getMe: BOT_INFO,
  sendMessage: { message_id: 1 },
  createChatInviteLink: { invite_link: 'https://t.me/+singleuse' },
  getChatMember: { status: 'left' },
  banChatMember: true,
  unbanChatMember: true,
};

/**
 * The Worker under test shares this isolate, so stubbing global fetch captures
 * its outbound Bot API calls. Anything not addressed to Telegram is refused
 * rather than escaping to the network.
 */
beforeAll(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.telegram.org/')) {
      throw new Error(`unexpected outbound request in test: ${url}`);
    }
    const method = url.split('/').pop()!;
    sent.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify({ ok: true, result: RESULTS[method] ?? true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await resetDatabase();
  await env.KV.delete('telegram:bot-info');
  sent.length = 0;
});

describe('bot commands over the real webhook', () => {
  it('/start creates the user and replies', async () => {
    const res = await sendUpdate(command('/start'));
    expect(res.status).toBe(200);

    const reply = sent.find((c) => c.method === 'sendMessage');
    expect(reply?.body.text).toMatch(/Welcome to test-gate/);
    // The message must read as separate lines, not one run-on paragraph.
    expect(String(reply?.body.text)).toContain('\n');

    const user = await env.DB.prepare('SELECT * FROM users WHERE telegram_user_id = ?')
      .bind(String(USER_ID)).first<{ status: string }>();
    expect(user?.status).toBe('unverified');
  });

  it('/help explains the commands and disclaims key requests', async () => {
    await sendUpdate(command('/help'));
    const text = String(sent.find((c) => c.method === 'sendMessage')?.body.text);
    for (const cmd of ['/verify', '/status', '/help']) expect(text).toContain(cmd);
    expect(text).toMatch(/never ask for your seed phrase/i);
  });

  it('/verify sends a personal, expiring link button', async () => {
    await sendUpdate(command('/verify'));
    const reply = sent.find((c) => c.method === 'sendMessage')!;
    const markup = reply.body.reply_markup as { inline_keyboard: { url: string }[][] };
    const url = markup.inline_keyboard[0]![0]!.url;

    expect(url).toContain('/verify#token=');
    expect(String(reply.body.text)).toMatch(/expires in 15 minutes/);
    expect(String(reply.body.text)).toMatch(/not a transaction/i);
  });

  it('/status tells an unverified user to verify first', async () => {
    await sendUpdate(command('/status'));
    const text = String(sent.find((c) => c.method === 'sendMessage')?.body.text);
    expect(text).toMatch(/have not verified a wallet yet/i);
  });

  it('caches botInfo in KV so getMe is not repeated per request', async () => {
    await sendUpdate(command('/help'));
    expect(sent.filter((c) => c.method === 'getMe')).toHaveLength(1);
    expect(await env.KV.get('telegram:bot-info')).toBeTruthy();

    sent.length = 0;
    await sendUpdate(command('/help'));
    expect(sent.filter((c) => c.method === 'getMe')).toHaveLength(0);
  });

  it('refuses commands sent in a group chat', async () => {
    const update = command('/verify');
    update.message.chat = { id: -1001234567890, type: 'supergroup' };
    await sendUpdate(update);

    const text = String(sent.find((c) => c.method === 'sendMessage')?.body.text);
    expect(text).toMatch(/message me directly/i);
    // No verification link may be issued from a group.
    expect(text).not.toContain('#token=');
  });

  it('rate-limits repeated /verify from one user', async () => {
    for (let i = 0; i < 8; i++) await sendUpdate(command('/verify'));
    const texts = sent.filter((c) => c.method === 'sendMessage').map((c) => String(c.body.text));
    expect(texts.some((t) => /Too many verification attempts/.test(t))).toBe(true);
  });

  it('flags joining members as legacy while migration mode is on', async () => {
    // The deployed test config has MIGRATION_MODE=false, so this asserts the
    // inverse: a normal join is recorded but not flagged.
    await sendUpdate({
      update_id: updateId++,
      chat_member: {
        chat: { id: -1001234567890, type: 'supergroup' },
        from: { id: USER_ID, is_bot: false, first_name: 'Tester' },
        date: Math.floor(Date.now() / 1000),
        old_chat_member: { status: 'left', user: { id: USER_ID, is_bot: false, first_name: 'T' } },
        new_chat_member: {
          status: 'member',
          user: { id: USER_ID, is_bot: false, first_name: 'T', username: 'tester' },
        },
      },
    });

    const user = await env.DB.prepare('SELECT * FROM users WHERE telegram_user_id = ?')
      .bind(String(USER_ID)).first<{ is_legacy_member: number }>();
    expect(user?.is_legacy_member).toBe(0);

    const event = await env.DB.prepare(
      "SELECT action FROM access_events WHERE telegram_user_id = ?",
    ).bind(String(USER_ID)).first<{ action: string }>();
    expect(event?.action).toBe('joined_group');
  });
});

describe('admin commands over the real webhook', () => {
  const ADMIN_ID = 111111; // matches ADMIN_TELEGRAM_IDS in vitest.config.ts
  const NOT_ADMIN_ID = 424242;

  it('runs adminstats for an admin', async () => {
    await sendUpdate(command('/adminstats', ADMIN_ID));
    const text = String(sent.find((c) => c.method === 'sendMessage')?.body.text);
    expect(text).toMatch(/Total: \d+/);
  });

  it('gives a non-admin a generic refusal, not a permission error', async () => {
    await sendUpdate(command('/adminstats', NOT_ADMIN_ID));
    const text = String(sent.find((c) => c.method === 'sendMessage')?.body.text);
    expect(text).toBe('Unknown command.');
  });

  it('refuses admin commands from a group chat even for an admin id', async () => {
    const update = command('/adminstats', ADMIN_ID);
    update.message.chat = { id: -100999, type: 'supergroup' };
    await sendUpdate(update);
    const text = String(sent.find((c) => c.method === 'sendMessage')?.body.text);
    expect(text).toBe('Unknown command.');
  });

  it('searches users with adminusers', async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, telegram_user_id, telegram_username, status, is_legacy_member, created_at, updated_at)
       VALUES ('u1', '555', 'searchme', 'eligible', 0, datetime('now'), datetime('now'))`,
    ).run();

    const update = command('/adminusers searchme', ADMIN_ID);
    update.message.text = '/adminusers searchme';
    update.message.entities = [{ type: 'bot_command', offset: 0, length: '/adminusers'.length }];
    await sendUpdate(update);

    const text = String(sent.find((c) => c.method === 'sendMessage')?.body.text);
    expect(text).toContain('555');
    expect(text).toContain('eligible');
  });

  it('adminrevoke removes a user and audits the action', async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, telegram_user_id, status, is_legacy_member, created_at, updated_at)
       VALUES ('u2', '777', 'eligible', 0, datetime('now'), datetime('now'))`,
    ).run();

    const update = command('/adminrevoke 777 testing', ADMIN_ID);
    update.message.text = '/adminrevoke 777 testing';
    update.message.entities = [{ type: 'bot_command', offset: 0, length: '/adminrevoke'.length }];
    await sendUpdate(update);

    const user = await env.DB.prepare('SELECT status FROM users WHERE telegram_user_id = ?')
      .bind('777').first<{ status: string }>();
    expect(user?.status).toBe('revoked');

    const audit = await env.DB.prepare(
      "SELECT admin_telegram_id, target_telegram_id FROM admin_audit_log WHERE action = 'revoke'",
    ).first<{ admin_telegram_id: string; target_telegram_id: string }>();
    expect(audit).toMatchObject({ admin_telegram_id: String(ADMIN_ID), target_telegram_id: '777' });
  });

  it('adminrestore refuses a user with no linked wallet (no ordinary bypass)', async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, telegram_user_id, status, is_legacy_member, created_at, updated_at)
       VALUES ('u3', '888', 'revoked', 0, datetime('now'), datetime('now'))`,
    ).run();

    const update = command('/adminrestore 888', ADMIN_ID);
    update.message.text = '/adminrestore 888';
    update.message.entities = [{ type: 'bot_command', offset: 0, length: '/adminrestore'.length }];
    await sendUpdate(update);

    const text = String(sent.find((c) => c.method === 'sendMessage')?.body.text);
    expect(text).toMatch(/no linked wallet/i);

    const user = await env.DB.prepare('SELECT status FROM users WHERE telegram_user_id = ?')
      .bind('888').first<{ status: string }>();
    expect(user?.status).toBe('revoked');
  });

  it('adminrecheck reports the ownership outcome and audits it', async () => {
    await env.DB.prepare(
      `INSERT INTO users (id, telegram_user_id, wallet_address, status, is_legacy_member, created_at, updated_at)
       VALUES ('u4', '999', 'J7rxtKmEpNJEtrfkagiTF1gsmLyVus6BQZFY4ouBkeMG', 'eligible', 0, datetime('now'), datetime('now'))`,
    ).run();

    const update = command('/adminrecheck 999', ADMIN_ID);
    update.message.text = '/adminrecheck 999';
    update.message.entities = [{ type: 'bot_command', offset: 0, length: '/adminrecheck'.length }];
    await sendUpdate(update);

    const audit = await env.DB.prepare(
      "SELECT action FROM admin_audit_log WHERE action = 'manual_recheck'",
    ).first<{ action: string }>();
    expect(audit).toBeTruthy();
  });

  it('lists admin commands via adminhelp, but not to non-admins', async () => {
    await sendUpdate(command('/adminhelp', ADMIN_ID));
    expect(String(sent.find((c) => c.method === 'sendMessage')?.body.text)).toContain('/adminrevoke');

    sent.length = 0;
    await sendUpdate(command('/adminhelp', NOT_ADMIN_ID));
    expect(String(sent.find((c) => c.method === 'sendMessage')?.body.text)).toBe('Unknown command.');
  });
});
