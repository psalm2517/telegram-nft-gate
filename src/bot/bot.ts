import { Bot, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import {
  clearPendingGroup,
  getConfiguredGroupId,
  getConfiguredGroupTitle,
  getPendingGroup,
  setConfiguredGroupId,
  setPendingGroup,
} from '../config-store.js';
import type { Config } from '../env.js';
import { signToken } from '../lib/token.js';
import type { AccessService } from '../services/access.js';
import type { Database, UserRow } from '../services/db.js';
import type { OwnershipChecker } from '../services/ownership.js';
import type { RateLimiter } from '../services/ratelimit.js';
import type { TelegramClient } from '../services/telegram.js';

export interface BotDeps {
  config: Config;
  db: Database;
  access: AccessService;
  ownership: OwnershipChecker;
  rateLimiter: RateLimiter;
  telegram: TelegramClient;
  kv: KVNamespace;
  baseUrl: string;
}

/** How long a /verify link stays usable. Short, because it is a bearer credential. */
const VERIFY_LINK_TTL_SECONDS = 15 * 60;

const HELP_TEXT = [
  'Available commands:',
  '',
  '/verify — connect a Solana wallet and prove NFT ownership',
  '/status — show your current verification and access status',
  '/help — show this message',
  '',
  'This bot will never ask for your seed phrase, private key, or any transaction.',
  'Verification is a plain message signature that moves no funds.',
].join('\n');

/**
 * Administration is entirely bot commands, deliberately not a separate web
 * dashboard: this is a gate for one group, and every admin action here is
 * something the operator would otherwise need a login flow, a session cookie
 * and a page for. `/adminhelp` lists these; they are intentionally left off
 * the bot's public command menu (BotFather `/setcommands`) so they are not
 * advertised to non-admins.
 */
const ADMIN_HELP_TEXT = [
  'Admin commands:',
  '',
  '/setup — check or configure which group this bot gates',
  '/adminstats — membership counts and migration progress',
  '/adminusers <query> — search by Telegram id, username or wallet',
  '/adminrecheck <telegram_id> — run a live ownership check on one user',
  '/adminrevoke <telegram_id> [reason] — remove a user\'s access',
  '/adminrestore <telegram_id> — restore access after re-confirming ownership',
  '',
  'There is no bypass: restore only succeeds if the linked wallet currently',
  'holds a qualifying NFT. Every action here is written to the audit log.',
].join('\n');

/**
 * Real Telegram command definitions, distinct from the free-text HELP_TEXT
 * above — these are what populate the "/" autocomplete menu in a client.
 * Admin commands are registered only in the scope of an admin's own private
 * chat (see registerAdminCommandMenu below), never bot-wide, so a non-admin's
 * menu never lists them.
 */
const PUBLIC_COMMANDS = [
  { command: 'start', description: 'Get started and verify' },
  { command: 'verify', description: 'Connect a wallet and prove NFT ownership' },
  { command: 'status', description: 'Check your verification and access status' },
  { command: 'help', description: 'Show available commands' },
];

const ADMIN_COMMANDS = [
  { command: 'setup', description: 'Check or configure the gated group' },
  { command: 'adminhelp', description: 'List admin commands' },
  { command: 'adminstats', description: 'Membership counts and migration progress' },
  { command: 'adminusers', description: 'Search users by id, username, or wallet' },
  { command: 'adminrecheck', description: 'Run a live ownership check on one user' },
  { command: 'adminrevoke', description: "Remove a user's access" },
  { command: 'adminrestore', description: 'Restore access after re-confirming ownership' },
];

const shortWallet = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

function formatUserLine(u: UserRow): string {
  const who = u.telegram_username ? `@${u.telegram_username}` : u.telegram_user_id;
  const wallet = u.wallet_address ? shortWallet(u.wallet_address) : 'no wallet';
  const legacy = u.is_legacy_member ? ' [legacy]' : '';
  return `${u.telegram_user_id} (${who}) — ${u.status} — ${wallet}${legacy}`;
}

export function createBot(deps: BotDeps, botInfo?: UserFromGetMe): Bot {
  // Passing cached botInfo lets grammY skip its startup getMe call, which would
  // otherwise cost a Telegram round-trip on every single webhook request.
  const bot = new Bot(deps.config.telegramBotToken, botInfo ? { botInfo } : {});

  const isAdmin = (id: string) => deps.config.adminTelegramIds.includes(id);

  /** Commands only make sense in a 1:1 chat; refuse politely in groups. */
  const privateOnly = async (ctx: Context): Promise<boolean> => {
    if (ctx.chat?.type === 'private') return true;
    await ctx.reply('Please message me directly to verify.').catch(() => {});
    return false;
  };

  /**
   * Registers Telegram's native "/" command menu for one admin's private chat
   * with the bot — scoped there only, so this is invisible to everyone else.
   * Without this, admin commands work but are effectively undiscoverable: an
   * admin has to already know to type e.g. /adminhelp. Fires once per admin
   * (cached in KV) rather than on every message.
   */
  async function ensureAdminCommandMenu(ctx: Context, telegramUserId: string): Promise<void> {
    const flagKey = `admin-menu-set:${telegramUserId}`;
    if (await deps.kv.get(flagKey)) return;
    await ctx.api
      .setMyCommands([...PUBLIC_COMMANDS, ...ADMIN_COMMANDS], {
        scope: { type: 'chat', chat_id: Number(telegramUserId) },
      })
      .catch(() => {});
    await deps.kv.put(flagKey, '1', { expirationTtl: 30 * 24 * 60 * 60 });
  }

  /**
   * Gate an admin command. Rejections are a generic "Unknown command" rather
   * than "you are not an admin", so a non-admin probing command names cannot
   * distinguish "does not exist" from "exists but you're not authorized".
   */
  const requireAdmin = async (ctx: Context): Promise<string | null> => {
    const from = ctx.from;
    if (!from || ctx.chat?.type !== 'private' || !isAdmin(String(from.id))) {
      await ctx.reply('Unknown command.').catch(() => {});
      return null;
    }
    return String(from.id);
  };

  /**
   * Issue a fresh verify link and reply with it as a button. Shared by /start
   * (the button is on the very first message, not a separate command you have
   * to know to type) and /verify (kept as an explicit fallback).
   *
   * If no group has been confirmed yet (see /setup), there is nothing to
   * grant access to, so this refuses instead of handing out a link that leads
   * nowhere — with a different message for admins (who can fix it) than for
   * everyone else (who just needs to wait).
   */
  async function replyWithVerifyLink(ctx: Context, isStart: boolean): Promise<void> {
    const from = ctx.from;
    if (!from) return;
    const telegramUserId = String(from.id);

    // Already fully resolved by context.ts: KV confirmation if present,
    // else the env var fallback, else ''.
    const configuredId = deps.config.telegramGroupId;
    if (!configuredId) {
      if (isAdmin(telegramUserId)) {
        await ctx.reply(
          [
            `${deps.config.appName} isn't fully set up yet — no group is configured.`,
            '',
            'Add me to your group as admin (Invite Users via Link, Ban Users),',
            "then reply /setup confirm here once I've messaged you. Run /setup",
            'any time to check status.',
          ].join('\n'),
        );
      } else {
        await ctx.reply(`${deps.config.appName} isn't ready yet. Please check back soon.`);
      }
      return;
    }

    const limit = await deps.rateLimiter.check(`verify:${telegramUserId}`, 5, 300);
    if (!limit.allowed) {
      await ctx.reply('Too many verification attempts. Please wait a few minutes and try again.');
      return;
    }

    await deps.db.upsertUser(telegramUserId, from.username ?? null);

    // The link carries a signed, short-lived token binding the web app session to
    // this Telegram account. The frontend never gets to choose whose account it is.
    const token = await signToken(
      deps.config.sessionSecret,
      { sub: telegramUserId, aud: 'verify', username: from.username ?? null },
      VERIFY_LINK_TTL_SECONDS,
    );
    const url = `${deps.baseUrl}/verify#token=${token}`;
    const groupTitle = await getConfiguredGroupTitle(deps.kv);

    const lines: string[] = [];
    if (isStart) {
      lines.push(
        groupTitle
          ? `To join "${groupTitle}", prove you control a Solana wallet holding a qualifying NFT.`
          : 'Prove you control a Solana wallet holding a qualifying NFT.',
        '',
      );
    }
    lines.push(
      `Tap below to connect your wallet and sign a verification message.`,
      `The link is personal to you and expires in ${VERIFY_LINK_TTL_SECONDS / 60} minutes. Do not share it.`,
      '',
      'You will be asked to sign a message. This is not a transaction and moves no funds.',
    );

    await ctx.reply(lines.join('\n'), {
      reply_markup: { inline_keyboard: [[{ text: 'Verify wallet', url }]] },
    });
  }

  // Runs before every command handler below. Cheap after the first message
  // (KV-cached), so this is fine as unconditional middleware rather than
  // something bolted onto just /start.
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (from && ctx.chat?.type === 'private' && isAdmin(String(from.id))) {
      await ensureAdminCommandMenu(ctx, String(from.id));
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    if (!(await privateOnly(ctx))) return;
    await replyWithVerifyLink(ctx, true);
  });

  bot.command('help', async (ctx) => {
    if (!(await privateOnly(ctx))) return;
    const from = ctx.from;
    const admin = from && isAdmin(String(from.id));
    await ctx.reply(admin ? `${HELP_TEXT}\n\nYou are an admin — send /adminhelp for admin commands.` : HELP_TEXT);
  });

  bot.command('verify', async (ctx) => {
    if (!(await privateOnly(ctx))) return;
    await replyWithVerifyLink(ctx, false);
  });

  bot.command('status', async (ctx) => {
    if (!(await privateOnly(ctx))) return;
    const from = ctx.from;
    if (!from) return;
    const telegramUserId = String(from.id);

    const limit = await deps.rateLimiter.check(`status:${telegramUserId}`, 10, 300);
    if (!limit.allowed) {
      await ctx.reply('Too many status checks. Please wait a few minutes.');
      return;
    }

    const user = await deps.db.getUserByTelegramId(telegramUserId);
    if (!user || !user.wallet_address) {
      await ctx.reply('You have not verified a wallet yet. Use /verify to get started.');
      return;
    }

    // /status performs a live ownership check (CLAUDE.md §11).
    const decision = await deps.access.recheckUser(user, 'status_command');
    const lines = [`Wallet: ${shortWallet(user.wallet_address)}`];

    if (decision.ownership === 'INDETERMINATE') {
      lines.push(
        `Status: ${user.status}`,
        '',
        'We could not reach the Solana indexer just now, so this is your last known status.',
        'Your access has not been changed.',
      );
    } else if (decision.newStatus === 'eligible') {
      lines.push('Status: eligible — you currently hold a qualifying NFT.');
    } else if (decision.newStatus === 'grace') {
      lines.push(
        'Status: grace period — no qualifying NFT found in this wallet.',
        `You have ${deps.config.gracePeriodHours} hour(s) from when the loss was detected`,
        'to restore ownership or verify a different wallet with /verify.',
      );
    } else {
      lines.push(
        'Status: no access — this wallet does not hold a qualifying NFT.',
        'Use /verify to link a wallet that does.',
      );
    }

    if (isAdmin(telegramUserId)) {
      lines.push('', 'You are an admin. Send /adminhelp to see admin commands.');
    }

    await ctx.reply(lines.join('\n'));

    if (decision.inviteLink) {
      await ctx.reply(`Your single-use invite link:\n${decision.inviteLink}`);
    }
  });

  // ---------------------------------------------------------------- admin --

  /**
   * The single entry point for "which group does this gate?" — status when
   * called bare, confirms an auto-detected group, or pins one directly by id.
   * This is what replaces pre-deploy TELEGRAM_GROUP_ID discovery: add the bot
   * to a group and talk to it from here, nothing else required.
   */
  bot.command('setup', async (ctx) => {
    const adminId = await requireAdmin(ctx);
    if (!adminId) return;

    const [subcommand, ...rest] = ctx.match.toString().trim().split(/\s+/);
    const configuredId = await getConfiguredGroupId(deps.kv);

    if (!subcommand) {
      const pending = await getPendingGroup(deps.kv);
      const lines = [
        configuredId
          ? `Configured group: ${configuredId}`
          : 'No group configured yet.',
      ];
      if (pending && pending.id !== configuredId) {
        lines.push(
          '',
          `Pending: "${pending.title}" (${pending.id}) — detected when I was added to it.`,
          'Run /setup confirm to use this group, or ignore this if it was unexpected.',
        );
      } else if (!configuredId) {
        lines.push(
          '',
          'Add me to your group as admin (Invite Users via Link, Ban Users), then',
          "I'll message you here to confirm. Or run /setup group <id> if you",
          'already know the chat id.',
        );
      }
      lines.push(
        '',
        `Collection: ${deps.config.nftCollectionId}`,
        `Migration mode: ${deps.config.migrationMode ? 'on' : 'off'}`,
        `Grace period: ${deps.config.gracePeriodHours}h`,
      );
      await ctx.reply(lines.join('\n'));
      return;
    }

    if (subcommand === 'confirm') {
      const pending = await getPendingGroup(deps.kv);
      if (!pending) {
        await ctx.reply(
          'Nothing pending. Add me to the group you want to gate first — I\'ll message you here once I am.',
        );
        return;
      }
      await setConfiguredGroupId(deps.kv, pending.id, pending.title);
      await clearPendingGroup(deps.kv);
      await deps.db.recordAdminAction({
        adminTelegramId: adminId,
        action: 'setup_group_confirmed',
        details: { groupId: pending.id, title: pending.title },
      });
      await ctx.reply(`Done. Now gating "${pending.title}" (${pending.id}).`);
      return;
    }

    if (subcommand === 'group') {
      const targetId = rest.join(' ').trim();
      if (!targetId) {
        await ctx.reply('Usage: /setup group <chat_id>');
        return;
      }
      const chat = await deps.telegram.getChat(targetId);
      if (!chat.ok) {
        await ctx.reply(
          `Could not find that chat (${chat.error}). Make sure I have already been added to it.`,
        );
        return;
      }
      if (chat.value.type !== 'group' && chat.value.type !== 'supergroup') {
        await ctx.reply('That chat is not a group or supergroup.');
        return;
      }
      await setConfiguredGroupId(deps.kv, targetId, chat.value.title);
      await clearPendingGroup(deps.kv);
      await deps.db.recordAdminAction({
        adminTelegramId: adminId,
        action: 'setup_group_pinned',
        details: { groupId: targetId, title: chat.value.title ?? null },
      });
      await ctx.reply(`Done. Now gating "${chat.value.title ?? targetId}" (${targetId}).`);
      return;
    }

    await ctx.reply('Usage: /setup, /setup confirm, or /setup group <chat_id>');
  });

  bot.command('adminhelp', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    await ctx.reply(ADMIN_HELP_TEXT);
  });

  bot.command('adminstats', async (ctx) => {
    if (!(await requireAdmin(ctx))) return;
    const stats = await deps.db.stats();
    const lines = [
      `Total: ${stats.total}`,
      `Eligible: ${stats.eligible}`,
      `Grace: ${stats.grace}`,
      `Revoked: ${stats.revoked}`,
      `Unverified: ${stats.unverified}`,
    ];
    if (deps.config.migrationMode) {
      lines.push(
        '',
        `Migration mode is ON. ${stats.legacyUnverified} of ${stats.legacyMembers} ` +
          'legacy members still need to verify.',
      );
    }
    await ctx.reply(lines.join('\n'));
  });

  bot.command('adminusers', async (ctx) => {
    const adminId = await requireAdmin(ctx);
    if (!adminId) return;
    const query = ctx.match.toString().trim();
    if (!query) {
      await ctx.reply('Usage: /adminusers <telegram id, username or wallet substring>');
      return;
    }
    const users = await deps.db.searchUsers(query, null, 15);
    if (users.length === 0) {
      await ctx.reply('No users match.');
      return;
    }
    await ctx.reply(users.map(formatUserLine).join('\n'));
  });

  bot.command('adminrecheck', async (ctx) => {
    const adminId = await requireAdmin(ctx);
    if (!adminId) return;
    const targetId = ctx.match.toString().trim();
    if (!targetId) {
      await ctx.reply('Usage: /adminrecheck <telegram_id>');
      return;
    }
    const user = await deps.db.getUserByTelegramId(targetId);
    if (!user) {
      await ctx.reply('No such user.');
      return;
    }

    const decision = await deps.access.recheckUser(user, 'admin_recheck');
    await deps.db.recordAdminAction({
      adminTelegramId: adminId,
      action: 'manual_recheck',
      targetTelegramId: targetId,
      details: { ownership: decision.ownership, newStatus: decision.newStatus },
    });

    await ctx.reply(`Ownership: ${decision.ownership}. Status: ${user.status} → ${decision.newStatus}.`);
    if (decision.notify) await ctx.api.sendMessage(targetId, decision.notify).catch(() => {});
    if (decision.inviteLink) {
      await ctx.api
        .sendMessage(targetId, `Your single-use invite link:\n${decision.inviteLink}`)
        .catch(() => {});
    }
  });

  bot.command('adminrevoke', async (ctx) => {
    const adminId = await requireAdmin(ctx);
    if (!adminId) return;
    const [targetId, ...reasonParts] = ctx.match.toString().trim().split(/\s+/);
    if (!targetId) {
      await ctx.reply('Usage: /adminrevoke <telegram_id> [reason]');
      return;
    }
    const user = await deps.db.getUserByTelegramId(targetId);
    if (!user) {
      await ctx.reply('No such user.');
      return;
    }

    const decision = await deps.access.revoke(user, new Date().toISOString(), 'admin_action');
    await deps.db.recordAdminAction({
      adminTelegramId: adminId,
      action: 'revoke',
      targetTelegramId: targetId,
      details: { reason: reasonParts.join(' ') || null, outcome: decision.reason },
    });

    await ctx.reply(
      decision.changed
        ? `Revoked ${targetId}.`
        : `No change (${decision.reason}). They may already be revoked, or removal failed and will retry.`,
    );
  });

  /**
   * Restore is deliberately not an unconditional grant (CLAUDE.md §13): it
   * re-runs the same ownership check everyone else goes through, and only
   * restores access if that check comes back OWNED.
   */
  bot.command('adminrestore', async (ctx) => {
    const adminId = await requireAdmin(ctx);
    if (!adminId) return;
    const targetId = ctx.match.toString().trim();
    if (!targetId) {
      await ctx.reply('Usage: /adminrestore <telegram_id>');
      return;
    }
    const user = await deps.db.getUserByTelegramId(targetId);
    if (!user) {
      await ctx.reply('No such user.');
      return;
    }
    if (!user.wallet_address) {
      await deps.db.recordAdminAction({
        adminTelegramId: adminId,
        action: 'restore_rejected',
        targetTelegramId: targetId,
        details: { reason: 'no_wallet_linked' },
      });
      await ctx.reply('This user has no linked wallet. They must run /verify themselves.');
      return;
    }

    const check = await deps.ownership.ownsAtLeastOne(user.wallet_address);
    if (check.status !== 'OWNED') {
      await deps.db.recordAdminAction({
        adminTelegramId: adminId,
        action: 'restore_rejected',
        targetTelegramId: targetId,
        details: { ownership: check.status, reason: check.reason ?? null },
      });
      await ctx.reply(
        check.status === 'INDETERMINATE'
          ? 'Ownership could not be confirmed right now. Try again shortly.'
          : 'This wallet does not hold a qualifying NFT, so access cannot be restored.',
      );
      return;
    }

    const decision = await deps.access.applyOwnership(user, 'OWNED', { source: 'admin_restore' });
    await deps.db.recordAdminAction({
      adminTelegramId: adminId,
      action: 'restore',
      targetTelegramId: targetId,
      details: { newStatus: decision.newStatus },
    });

    await ctx.reply(`Restored. Status: ${decision.newStatus}.`);
    if (decision.notify) await ctx.api.sendMessage(targetId, decision.notify).catch(() => {});
    if (decision.inviteLink) {
      await ctx.api
        .sendMessage(targetId, `Your single-use invite link:\n${decision.inviteLink}`)
        .catch(() => {});
    }
  });

  /**
   * Detect being added to a group and ask an admin to confirm it via /setup,
   * rather than requiring TELEGRAM_GROUP_ID to be known before deploy.
   */
  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    if (update.chat.type !== 'group' && update.chat.type !== 'supergroup') return;
    if (update.new_chat_member.user.id !== ctx.me.id) return; // some other bot/member change

    const joined = ['member', 'administrator'].includes(update.new_chat_member.status);
    if (!joined) return;

    const groupId = String(update.chat.id);
    const title = update.chat.title ?? groupId;
    const configuredId = await getConfiguredGroupId(deps.kv);
    if (configuredId === groupId) return; // already the confirmed group, nothing to do

    await setPendingGroup(deps.kv, { id: groupId, title, detectedAt: new Date().toISOString() });

    const text = [
      `I was just added to "${title}" (${groupId}).`,
      '',
      'Reply here with /setup confirm to make this the gated group.',
      "If this wasn't you, remove me from that group and ignore this message.",
    ].join('\n');
    for (const admin of deps.config.adminTelegramIds) {
      await deps.telegram.sendMessage(admin, text).catch(() => {});
    }
  });

  /**
   * Migration mode: record people who were already in the group before gating
   * went live, so enforcement can skip them until MIGRATION_MODE is turned off.
   */
  bot.on('chat_member', async (ctx) => {
    const update = ctx.chatMember;
    if (String(update.chat.id) !== deps.config.telegramGroupId) return;
    const joined = ['member', 'administrator', 'creator', 'restricted'].includes(
      update.new_chat_member.status,
    );
    const user = update.new_chat_member.user;
    if (user.is_bot) return;

    const telegramUserId = String(user.id);
    if (joined) {
      await deps.db.upsertUser(telegramUserId, user.username ?? null, {
        isLegacyMember: deps.config.migrationMode,
      });
      await deps.db.recordAccessEvent({
        telegramUserId,
        action: 'joined_group',
        newState: 'member',
        reason: deps.config.migrationMode ? 'migration_mode' : 'join',
      });
    } else {
      await deps.db.recordAccessEvent({
        telegramUserId,
        action: 'left_group',
        newState: update.new_chat_member.status,
        reason: 'telegram_update',
      });
    }
  });

  bot.catch((err) => {
    console.error('grammY error', { error: String(err.error) });
  });

  return bot;
}
