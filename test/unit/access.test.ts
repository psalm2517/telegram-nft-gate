import { beforeEach, describe, expect, it } from 'vitest';
import { buildContext, resetDatabase, type TestContext } from '../helpers.js';
import { runScheduledRecheck } from '../../src/scheduled.js';
import type { UserRow } from '../../src/services/db.js';

/** Distinct, valid-shaped wallet per user — the schema enforces one wallet per account. */
const walletFor = (id: string) =>
  `Wa11et${id}`.padEnd(44, 'x').slice(0, 44);

/** Seed a user directly in a chosen state. */
async function seedUser(
  ctx: TestContext,
  telegramUserId: string,
  patch: Partial<UserRow> = {},
): Promise<UserRow> {
  await ctx.db.upsertUser(telegramUserId, `user${telegramUserId}`);
  await ctx.db.updateUser(telegramUserId, {
    wallet_address: walletFor(telegramUserId),
    ...patch,
  });
  return (await ctx.db.getUserByTelegramId(telegramUserId))!;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe('access state machine', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await resetDatabase();
    ctx = await buildContext();
  });

  it('grants access and issues a single-use invite to a new holder', async () => {
    const user = await seedUser(ctx, '1');
    const decision = await ctx.access.applyOwnership(user, 'OWNED', { source: 'verification' });

    expect(decision.newStatus).toBe('eligible');
    expect(decision.changed).toBe(true);
    expect(ctx.fakeTelegram.invites).toHaveLength(1);
  });

  it('does not issue a new invite to someone already in the group', async () => {
    const user = await seedUser(ctx, '1');
    ctx.fakeTelegram.membership.set('1', true);

    const decision = await ctx.access.applyOwnership(user, 'OWNED', { source: 'verification' });
    expect(decision.newStatus).toBe('eligible');
    expect(ctx.fakeTelegram.invites).toHaveLength(0);
  });

  it('tells an already-eligible, still-present user they reconfirmed, not that a link is coming', async () => {
    const user = await seedUser(ctx, '1', { status: 'eligible', verified_at: hoursAgo(1) });
    ctx.fakeTelegram.membership.set('1', true);

    const decision = await ctx.access.applyOwnership(user, 'OWNED', { source: 'verification' });
    expect(decision.newStatus).toBe('eligible');
    expect(decision.changed).toBe(false);
    expect(decision.inviteLink).toBeUndefined();
    // Without this, a user re-verifying while already eligible gets no
    // Telegram message at all, while the web page still tells them to check
    // their chat "for your invite link" — a link that never arrives.
    expect(decision.notify).toBeTruthy();
  });

  it('issues a fresh invite to an eligible user who left the group voluntarily', async () => {
    // Leaving the group is not a tracked transition (see the bot's
    // chat_member handler) — DB status stays `eligible` exactly as if they'd
    // never left. Telegram's own membership check is the only thing that can
    // tell "still inside" apart from "eligible but needs back in".
    const user = await seedUser(ctx, '1', { status: 'eligible', verified_at: hoursAgo(1) });
    ctx.fakeTelegram.membership.set('1', false);

    const decision = await ctx.access.applyOwnership(user, 'OWNED', { source: 'verification' });
    expect(decision.newStatus).toBe('eligible');
    expect(decision.inviteLink).toBeTruthy();
    expect(ctx.fakeTelegram.invites).toHaveLength(1);
  });

  it('starts a grace period when an eligible holder loses their NFT', async () => {
    const user = await seedUser(ctx, '1', { status: 'eligible' });
    const decision = await ctx.access.applyOwnership(user, 'NOT_OWNED', { source: 'recheck' });

    expect(decision.newStatus).toBe('grace');
    expect(decision.notify).toMatch(/24 hour/);
    expect(ctx.fakeTelegram.removed).toHaveLength(0);

    const after = await ctx.db.getUserByTelegramId('1');
    expect(after?.grace_period_started_at).toBeTruthy();
  });

  it('keeps a user in grace while the window is still open', async () => {
    const user = await seedUser(ctx, '1', {
      status: 'grace',
      grace_period_started_at: hoursAgo(2),
    });
    const decision = await ctx.access.applyOwnership(user, 'NOT_OWNED', { source: 'recheck' });

    expect(decision.newStatus).toBe('grace');
    expect(decision.changed).toBe(false);
    expect(ctx.fakeTelegram.removed).toHaveLength(0);
  });

  it('revokes and removes once the grace window has closed', async () => {
    const user = await seedUser(ctx, '1', {
      status: 'grace',
      grace_period_started_at: hoursAgo(25),
    });
    const decision = await ctx.access.applyOwnership(user, 'NOT_OWNED', { source: 'recheck' });

    expect(decision.newStatus).toBe('revoked');
    expect(ctx.fakeTelegram.removed).toEqual(['1']);

    const after = await ctx.db.getUserByTelegramId('1');
    expect(after?.status).toBe('revoked');
    expect(after?.revoked_at).toBeTruthy();
  });

  it('restores eligibility if ownership returns during the grace period', async () => {
    const user = await seedUser(ctx, '1', {
      status: 'grace',
      grace_period_started_at: hoursAgo(3),
    });
    const decision = await ctx.access.applyOwnership(user, 'OWNED', { source: 'recheck' });

    expect(decision.newStatus).toBe('eligible');
    expect(decision.reason).toBe('eligibility_restored');

    const after = await ctx.db.getUserByTelegramId('1');
    expect(after?.grace_period_started_at).toBeNull();
    expect(ctx.fakeTelegram.removed).toHaveLength(0);
  });

  it('lets a revoked user regain access by re-verifying', async () => {
    const user = await seedUser(ctx, '1', { status: 'revoked', revoked_at: hoursAgo(48) });
    const decision = await ctx.access.applyOwnership(user, 'OWNED', { source: 'verification' });

    expect(decision.newStatus).toBe('eligible');
    expect(ctx.fakeTelegram.invites).toHaveLength(1);

    const after = await ctx.db.getUserByTelegramId('1');
    expect(after?.revoked_at).toBeNull();
  });

  // --- the failure modes that must NOT cost anyone their access -------------

  it('changes nothing when ownership is indeterminate', async () => {
    for (const status of ['eligible', 'grace'] as const) {
      await resetDatabase();
      const user = await seedUser(ctx, '1', {
        status,
        grace_period_started_at: status === 'grace' ? hoursAgo(30) : null,
      });
      const decision = await ctx.access.applyOwnership(user, 'INDETERMINATE', { source: 'recheck' });

      expect(decision.changed).toBe(false);
      expect(decision.newStatus).toBe(status);
      expect(ctx.fakeTelegram.removed).toHaveLength(0);
    }
  });

  it('leaves last_ownership_check_at untouched on an indeterminate result', async () => {
    // So the user stays at the front of the retry queue rather than waiting a
    // whole interval after a transient outage.
    const user = await seedUser(ctx, '1', { status: 'eligible', last_ownership_check_at: null });
    await ctx.access.applyOwnership(user, 'INDETERMINATE', { source: 'recheck' });
    const after = await ctx.db.getUserByTelegramId('1');
    expect(after?.last_ownership_check_at).toBeNull();
  });

  it('does not mark a user revoked if Telegram removal fails', async () => {
    const user = await seedUser(ctx, '1', {
      status: 'grace',
      grace_period_started_at: hoursAgo(25),
    });
    ctx.fakeTelegram.failRemovals = true;

    const decision = await ctx.access.applyOwnership(user, 'NOT_OWNED', { source: 'recheck' });
    expect(decision.newStatus).toBe('grace');
    expect(decision.reason).toMatch(/removal_failed/);

    const after = await ctx.db.getUserByTelegramId('1');
    expect(after?.status).toBe('grace'); // retried on the next cron run
  });

  it('still grants eligibility when the invite link cannot be created', async () => {
    const user = await seedUser(ctx, '1');
    ctx.fakeTelegram.failInvites = true;

    const decision = await ctx.access.applyOwnership(user, 'OWNED', { source: 'verification' });
    expect(decision.newStatus).toBe('eligible');
    expect(decision.inviteLink).toBeUndefined();
    expect(decision.notify).toMatch(/could not be created/i);
  });

  it('records an audit trail for every transition', async () => {
    const user = await seedUser(ctx, '1', { status: 'eligible' });
    await ctx.access.applyOwnership(user, 'NOT_OWNED', { source: 'recheck' });

    const access = await ctx.db.listAccessEvents('1');
    expect(access.map((e) => (e as { action: string }).action)).toContain('grace_started');

    const verification = await ctx.db.listVerificationEvents('1');
    expect(verification.map((e) => (e as { result: string }).result)).toContain('not_owned');
  });
});

describe('migration mode', () => {
  it('never auto-removes a pre-existing member, even past the grace window', async () => {
    await resetDatabase();
    const ctx = await buildContext({ MIGRATION_MODE: 'true' });
    await ctx.db.upsertUser('1', 'legacy', { isLegacyMember: true });
    await ctx.db.updateUser('1', {
      wallet_address: walletFor('1'),
      status: 'grace',
      grace_period_started_at: hoursAgo(100),
    });
    const user = (await ctx.db.getUserByTelegramId('1'))!;

    const decision = await ctx.access.applyOwnership(user, 'NOT_OWNED', { source: 'recheck' });

    expect(decision.newStatus).toBe('grace');
    expect(ctx.fakeTelegram.removed).toHaveLength(0);
    expect(decision.reason).toBe('migration_mode_protected');

    const events = await ctx.db.listAccessEvents('1');
    expect(events.map((e) => (e as { action: string }).action)).toContain(
      'removal_skipped_migration_mode',
    );
  });

  it('still lets an admin explicitly revoke a legacy member', async () => {
    await resetDatabase();
    const ctx = await buildContext({ MIGRATION_MODE: 'true' });
    await ctx.db.upsertUser('1', 'legacy', { isLegacyMember: true });
    await ctx.db.updateUser('1', { wallet_address: walletFor('1'), status: 'eligible' });
    const user = (await ctx.db.getUserByTelegramId('1'))!;

    const decision = await ctx.access.revoke(user, new Date().toISOString(), 'admin_action');
    expect(decision.newStatus).toBe('revoked');
    expect(ctx.fakeTelegram.removed).toEqual(['1']);
  });

  it('removes a non-legacy member normally while migration mode is on', async () => {
    await resetDatabase();
    const ctx = await buildContext({ MIGRATION_MODE: 'true' });
    await ctx.db.upsertUser('2', 'newcomer');
    await ctx.db.updateUser('2', {
      wallet_address: walletFor('2'), status: 'grace', grace_period_started_at: hoursAgo(100),
    });
    const user = (await ctx.db.getUserByTelegramId('2'))!;

    const decision = await ctx.access.applyOwnership(user, 'NOT_OWNED', { source: 'recheck' });
    expect(decision.newStatus).toBe('revoked');
    expect(ctx.fakeTelegram.removed).toEqual(['2']);
  });

  it('enforces normally once migration mode is off', async () => {
    await resetDatabase();
    const ctx = await buildContext({ MIGRATION_MODE: 'false' });
    await ctx.db.upsertUser('1', 'legacy', { isLegacyMember: true });
    await ctx.db.updateUser('1', {
      wallet_address: walletFor('2'), status: 'grace', grace_period_started_at: hoursAgo(100),
    });
    const user = (await ctx.db.getUserByTelegramId('1'))!;

    const decision = await ctx.access.applyOwnership(user, 'NOT_OWNED', { source: 'recheck' });
    expect(decision.newStatus).toBe('revoked');
    expect(ctx.fakeTelegram.removed).toEqual(['1']);
  });
});

describe('scheduled recheck', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await resetDatabase();
    ctx = await buildContext();
  });

  it('re-checks due users and applies the right transitions', async () => {
    await seedUser(ctx, 'keeper', { status: 'eligible', last_ownership_check_at: hoursAgo(48) });
    await seedUser(ctx, 'loser', { status: 'eligible', last_ownership_check_at: hoursAgo(48) });
    ctx.fakeOwnership
      .set(walletFor('keeper'), 'OWNED')
      .set(walletFor('loser'), 'NOT_OWNED');

    const summary = await runScheduledRecheck(ctx);

    expect(summary.checked).toBe(2);
    expect(summary.stillEligible).toBe(1);
    expect(summary.graceStarted).toBe(1);
    expect((await ctx.db.getUserByTelegramId('loser'))?.status).toBe('grace');
    expect((await ctx.db.getUserByTelegramId('keeper'))?.status).toBe('eligible');
  });

  it('revokes grace users whose window expired, even if not otherwise due', async () => {
    await seedUser(ctx, 'expired', {
      status: 'grace',
      grace_period_started_at: hoursAgo(30),
      last_ownership_check_at: new Date().toISOString(), // checked just now
    });
    ctx.fakeOwnership.setDefault('NOT_OWNED');

    const summary = await runScheduledRecheck(ctx);
    expect(summary.revoked).toBe(1);
    expect(ctx.fakeTelegram.removed).toEqual(['expired']);
  });

  it('skips users that are not due yet', async () => {
    await seedUser(ctx, 'fresh', { status: 'eligible', last_ownership_check_at: hoursAgo(1) });
    ctx.fakeOwnership.setDefault('NOT_OWNED');

    const summary = await runScheduledRecheck(ctx);
    expect(summary.checked).toBe(0);
    expect((await ctx.db.getUserByTelegramId('fresh'))?.status).toBe('eligible');
  });

  it('revokes nobody during a total indexer outage', async () => {
    await seedUser(ctx, 'a', { status: 'eligible', last_ownership_check_at: hoursAgo(48) });
    await seedUser(ctx, 'b', { status: 'grace', grace_period_started_at: hoursAgo(72) });
    ctx.fakeOwnership.setDefault('INDETERMINATE', { reason: 'timeout' });

    const summary = await runScheduledRecheck(ctx);

    expect(summary.indeterminate).toBe(2);
    expect(summary.revoked).toBe(0);
    expect(ctx.fakeTelegram.removed).toHaveLength(0);
    expect((await ctx.db.getUserByTelegramId('a'))?.status).toBe('eligible');
    expect((await ctx.db.getUserByTelegramId('b'))?.status).toBe('grace');
  });

  it('ignores users with no linked wallet', async () => {
    await ctx.db.upsertUser('nowallet', 'x');
    await ctx.db.updateUser('nowallet', { status: 'eligible' });
    const summary = await runScheduledRecheck(ctx);
    expect(summary.checked).toBe(0);
  });

  it('purges expired nonces', async () => {
    await ctx.db.createNonce({
      telegram_user_id: '1', wallet_address: walletFor('1'), nonce: 'old',
      challenge: 'c', expires_at: hoursAgo(48),
    });
    await ctx.db.createNonce({
      telegram_user_id: '1', wallet_address: walletFor('1'), nonce: 'new',
      challenge: 'c', expires_at: new Date(Date.now() + 60_000).toISOString(),
    });

    const summary = await runScheduledRecheck(ctx);
    expect(summary.noncesPurged).toBe(1);
    expect(await ctx.db.getNonce('new')).not.toBeNull();
    expect(await ctx.db.getNonce('old')).toBeNull();
  });

  it('honours the batch size limit', async () => {
    const ctxSmall = await buildContext({ RECHECK_BATCH_SIZE: '2' });
    for (const id of ['1', '2', '3', '4', '5']) {
      await ctxSmall.db.upsertUser(id, id);
      await ctxSmall.db.updateUser(id, {
        wallet_address: walletFor(id),
        status: 'eligible',
        last_ownership_check_at: hoursAgo(48),
      });
    }
    ctxSmall.fakeOwnership.setDefault('OWNED');
    const summary = await runScheduledRecheck(ctxSmall);
    expect(summary.checked).toBe(2);
  });
});
