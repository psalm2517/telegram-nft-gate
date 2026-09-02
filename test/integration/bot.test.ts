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
  getChat: { id: -100999, type: 'supergroup', title: 'Default Test Group' },
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
  await env.KV.delete('config:telegram_group_id');
  await env.KV.delete('config:gate_group_id');
  await env.KV.delete('pending:group_detect');
  // Rate-limit buckets (rl:*) would otherwise leak across tests that reuse
  // the same Telegram user id, since /start and /verify share a bucket.
  const rateLimitKeys = await env.KV.list({ prefix: 'rl:' });
  await Promise.all(rateLimitKeys.keys.map((k) => env.KV.delete(k.name)));
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

describe('start includes a verify button immediately', () => {
  it('/start replies with a welcome message and an inline Verify button', async () => {
    await sendUpdate(command('/start'));
    const reply = sent.find((c) => c.method === 'sendMessage')!;
    expect(String(reply.body.text)).toMatch(/Welcome to/);

    const markup = reply.body.reply_markup as { inline_keyboard: { text: string; url: string }[][] };
    const button = markup.inline_keyboard[0]![0]!;
    expect(button.text).toBe('Verify wallet');
    expect(button.url).toContain('/verify#token=');
  });

  it('/verify still works as an explicit fallback with the same button', async () => {
    await sendUpdate(command('/verify'));
    const reply = sent.find((c) => c.method === 'sendMessage')!;
    const markup = reply.body.reply_markup as { inline_keyboard: { text: string; url: string }[][] };
    expect(markup.inline_keyboard[0]![0]!.text).toBe('Verify wallet');
  });

  it('rate-limits repeated /start the same way as /verify', async () => {
    for (let i = 0; i < 8; i++) await sendUpdate(command('/start'));
    const texts = sent.filter((c) => c.method === 'sendMessage').map((c) => String(c.body.text));
    expect(texts.some((t) => /Too many verification attempts/.test(t))).toBe(true);
  });
});

describe('gate and main group setup via the bot', () => {
  const ADMIN_ID = 111111; // matches ADMIN_TELEGRAM_IDS in vitest.config.ts
  const NEW_GROUP_ID = -100777888;
  const BOT_OWN_ID = BOT_INFO.id;

  const myChatMemberUpdate = (status: 'member' | 'administrator' | 'left', title = 'New Community', chatId = NEW_GROUP_ID) => ({
    update_id: updateId++,
    my_chat_member: {
      chat: { id: chatId, type: 'supergroup', title },
      from: { id: ADMIN_ID, is_bot: false, first_name: 'Admin' },
      date: Math.floor(Date.now() / 1000),
      old_chat_member: { status: 'left', user: { id: BOT_OWN_ID, is_bot: true, first_name: 'Gate Bot' } },
      new_chat_member: {
        status,
        user: { id: BOT_OWN_ID, is_bot: true, first_name: 'Gate Bot', username: 'gate_bot' },
      },
    },
  });

  const setupCommand = (text: string, userId = ADMIN_ID) => {
    const update = command(text, userId);
    update.message.text = text;
    update.message.entities = [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }];
    return update;
  };

  it('detects being added to a group and asks admins which role it plays', async () => {
    await sendUpdate(myChatMemberUpdate('administrator'));

    const pending = await env.KV.get('pending:group_detect', 'json') as { id: string; title: string } | null;
    expect(pending).toMatchObject({ id: String(NEW_GROUP_ID), title: 'New Community' });

    const dm = sent.find((c) => c.method === 'sendMessage' && c.body.chat_id === String(ADMIN_ID));
    expect(String(dm?.body.text)).toMatch(/New Community/);
    expect(String(dm?.body.text)).toMatch(/\/setup main confirm/);
    expect(String(dm?.body.text)).toMatch(/\/setup gate confirm/);
  });

  it('ignores my_chat_member updates about someone else, not the bot itself', async () => {
    const update = myChatMemberUpdate('member');
    update.my_chat_member.new_chat_member.user.id = 999999;
    await sendUpdate(update);
    expect(await env.KV.get('pending:group_detect')).toBeNull();
  });

  it('ignores the bot leaving', async () => {
    await sendUpdate(myChatMemberUpdate('left'));
    expect(await env.KV.get('pending:group_detect')).toBeNull();
  });

  it('does not re-notify for a group already assigned a role', async () => {
    await env.KV.put('config:telegram_group_id', String(NEW_GROUP_ID));
    await sendUpdate(myChatMemberUpdate('administrator'));
    expect(await env.KV.get('pending:group_detect')).toBeNull();
    expect(sent.find((c) => c.method === 'sendMessage')).toBeUndefined();
  });

  it('/setup with nothing configured explains how to get started', async () => {
    await sendUpdate(setupCommand('/setup'));
    const text = String(sent.find((c) => c.method === 'sendMessage')?.body.text);
    expect(text).toMatch(/Main group: not configured yet/);
    expect(text).toMatch(/Gate group: not configured yet/);
  });

  it('/setup shows a pending group and lets you confirm it as main', async () => {
    await sendUpdate(myChatMemberUpdate('administrator'));
    sent.length = 0;

    await sendUpdate(setupCommand('/setup'));
    expect(String(sent.find((c) => c.method === 'sendMessage')?.body.text)).toMatch(/Pending: "New Community"/);

    sent.length = 0;
    await sendUpdate(setupCommand('/setup main confirm'));
    expect(String(sent.find((c) => c.method === 'sendMessage')?.body.text)).toMatch(/Done.*New Community.*main/s);

    expect(await env.KV.get('config:telegram_group_id')).toBe(String(NEW_GROUP_ID));
    expect(await env.KV.get('config:gate_group_id')).toBeNull();
    expect(await env.KV.get('pending:group_detect')).toBeNull();

    const audit = await env.DB.prepare(
      "SELECT action FROM admin_audit_log WHERE action = 'setup_group_confirmed'",
    ).first<{ action: string }>();
    expect(audit).toBeTruthy();
  });

  it('confirms a second detected group as gate, independent of main', async () => {
    await env.KV.put('config:telegram_group_id', String(NEW_GROUP_ID));
    await sendUpdate(myChatMemberUpdate('administrator', 'Lobby', -100333444));
    await sendUpdate(setupCommand('/setup gate confirm'));

    expect(await env.KV.get('config:telegram_group_id')).toBe(String(NEW_GROUP_ID));
    expect(await env.KV.get('config:gate_group_id')).toBe('-100333444');
  });

  it('/setup confirm with nothing pending says so', async () => {
    await sendUpdate(setupCommand('/setup main confirm'));
    expect(String(sent.find((c) => c.method === 'sendMessage')?.body.text)).toMatch(/Nothing pending/);
  });

  it('/setup <role> group <id> pins a group directly after validating it exists', async () => {
    RESULTS.getChat = { id: -100555, type: 'supergroup', title: 'Direct Pin Group' };
    await sendUpdate(setupCommand('/setup gate group -100555'));

    expect(String(sent.find((c) => c.method === 'sendMessage')?.body.text)).toMatch(/Direct Pin Group/);
    expect(await env.KV.get('config:gate_group_id')).toBe('-100555');
    expect(await env.KV.get('config:telegram_group_id')).toBeNull();
  });

  it('/setup <role> group <id> refuses a non-group chat', async () => {
    RESULTS.getChat = { id: 12345, type: 'private' };
    await sendUpdate(setupCommand('/setup main group 12345'));
    expect(String(sent.find((c) => c.method === 'sendMessage')?.body.text)).toMatch(/not a group or supergroup/);
    expect(await env.KV.get('config:telegram_group_id')).toBeNull();
  });

  it('/setup <role> group <id> reports a clear error when the bot cannot see that chat', async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/getChat')) {
        return new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 });
      }
      return originalFetch(input, init);
    });
    try {
      await sendUpdate(setupCommand('/setup main group -100999999'));
      expect(String(sent.find((c) => c.method === 'sendMessage')?.body.text)).toMatch(/Could not find that chat/);
      expect(await env.KV.get('config:telegram_group_id')).toBeNull();
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('rejects a role that is neither main nor gate', async () => {
    await sendUpdate(setupCommand('/setup other confirm'));
    expect(String(sent.find((c) => c.method === 'sendMessage')?.body.text)).toMatch(/Usage: \/setup/);
  });

  it('/setup is invisible to non-admins', async () => {
    await sendUpdate(setupCommand('/setup', 555444));
    expect(String(sent.find((c) => c.method === 'sendMessage')?.body.text)).toBe('Unknown command.');
  });
});

describe('gate group welcomes new joiners with a verify button', () => {
  const GATE_GROUP_ID = -100222333;
  const NEWCOMER_ID = 800900;

  beforeEach(async () => {
    await env.KV.put('config:gate_group_id', String(GATE_GROUP_ID));
  });

  const gateJoinUpdate = (opts: { oldStatus?: string; username?: string } = {}) => ({
    update_id: updateId++,
    chat_member: {
      chat: { id: GATE_GROUP_ID, type: 'supergroup', title: 'Lobby' },
      from: { id: NEWCOMER_ID, is_bot: false, first_name: 'New' },
      date: Math.floor(Date.now() / 1000),
      old_chat_member: {
        status: opts.oldStatus ?? 'left',
        user: { id: NEWCOMER_ID, is_bot: false, first_name: 'New' },
      },
      new_chat_member: {
        status: 'member',
        user: { id: NEWCOMER_ID, is_bot: false, first_name: 'New', username: opts.username },
      },
    },
  });

  it('posts a welcome message with a deep-link Verify button into the gate group', async () => {
    await sendUpdate(gateJoinUpdate({ username: 'newperson' }));

    const post = sent.find((c) => c.method === 'sendMessage' && c.body.chat_id === String(GATE_GROUP_ID));
    expect(post).toBeTruthy();
    expect(String(post?.body.text)).toMatch(/@newperson/);

    const markup = post?.body.reply_markup as { inline_keyboard: { text: string; url: string }[][] };
    expect(markup.inline_keyboard[0]![0]!.text).toBe('Verify');
    expect(markup.inline_keyboard[0]![0]!.url).toBe(`https://t.me/${BOT_INFO.username}?start=verify`);
  });

  it('falls back to first name when the newcomer has no username', async () => {
    await sendUpdate(gateJoinUpdate({}));
    const post = sent.find((c) => c.method === 'sendMessage' && c.body.chat_id === String(GATE_GROUP_ID));
    expect(String(post?.body.text)).toMatch(/New/);
  });

  it('does not re-welcome someone whose status merely changed (e.g. promoted)', async () => {
    await sendUpdate(gateJoinUpdate({ oldStatus: 'member' }));
    expect(sent.find((c) => c.method === 'sendMessage' && c.body.chat_id === String(GATE_GROUP_ID))).toBeUndefined();
  });

  it('does not touch the main-group migration logic for a gate-group join', async () => {
    await sendUpdate(gateJoinUpdate({ username: 'newperson' }));
    const user = await env.DB.prepare('SELECT * FROM users WHERE telegram_user_id = ?')
      .bind(String(NEWCOMER_ID)).first();
    expect(user).toBeNull(); // gate joins are not recorded as app users
  });
});
