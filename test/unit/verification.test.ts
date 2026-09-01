import { beforeEach, describe, expect, it } from 'vitest';
import { buildContext, makeWallet, resetDatabase, type TestContext } from '../helpers.js';
import { buildChallenge } from '../../src/services/wallet.js';

const TG = '555000111';

/** Walk the happy path up to (but not including) submit, returning what is needed to submit. */
async function issueChallenge(ctx: TestContext, telegramUserId = TG) {
  const wallet = makeWallet();
  const challenge = await ctx.verification.createChallenge(
    telegramUserId,
    wallet.address,
    'gate.example',
  );
  if ('error' in challenge) throw new Error(`unexpected: ${challenge.error}`);
  return { wallet, challenge };
}

describe('wallet signature verification', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await resetDatabase();
    ctx = await buildContext();
  });

  it('accepts a valid signature from a holder and grants access', async () => {
    const { wallet, challenge } = await issueChallenge(ctx);
    ctx.fakeOwnership.set(wallet.address, 'OWNED');

    const result = await ctx.verification.submit({
      telegramUserId: TG,
      walletAddress: wallet.address,
      nonce: challenge.nonce,
      signature: wallet.sign(challenge.challenge),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.newStatus).toBe('eligible');
    expect(ctx.fakeTelegram.invites).toHaveLength(1);
  });

  it('rejects a signature made by a different key', async () => {
    const { wallet, challenge } = await issueChallenge(ctx);
    const attacker = makeWallet();
    ctx.fakeOwnership.set(wallet.address, 'OWNED');

    const result = await ctx.verification.submit({
      telegramUserId: TG,
      walletAddress: wallet.address,
      nonce: challenge.nonce,
      // correct message, wrong signer
      signature: attacker.sign(challenge.challenge),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('invalid_signature');
  });

  it('rejects a signature over a different message', async () => {
    const { wallet, challenge } = await issueChallenge(ctx);
    ctx.fakeOwnership.set(wallet.address, 'OWNED');

    const result = await ctx.verification.submit({
      telegramUserId: TG,
      walletAddress: wallet.address,
      nonce: challenge.nonce,
      signature: wallet.sign('some other message entirely'),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('invalid_signature');
  });

  it('rejects structurally invalid signature bytes without throwing', async () => {
    const { wallet, challenge } = await issueChallenge(ctx);
    ctx.fakeOwnership.set(wallet.address, 'OWNED');

    const result = await ctx.verification.submit({
      telegramUserId: TG,
      walletAddress: wallet.address,
      nonce: challenge.nonce,
      signature: '1111111111111111111111111111111111111111111111111111111111111111',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown nonce', async () => {
    const wallet = makeWallet();
    const result = await ctx.verification.submit({
      telegramUserId: TG,
      walletAddress: wallet.address,
      nonce: 'never-issued',
      signature: wallet.sign('anything'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('unknown_nonce');
  });

  it('rejects a non-base58 wallet address at challenge time', async () => {
    const res = await ctx.verification.createChallenge(TG, 'not-a-wallet-0OIl', 'gate.example');
    expect(res).toEqual({ error: 'invalid_wallet' });
  });
});

describe('replay and substitution protection', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await resetDatabase();
    ctx = await buildContext();
  });

  it('refuses to reuse a nonce that already succeeded', async () => {
    const { wallet, challenge } = await issueChallenge(ctx);
    ctx.fakeOwnership.set(wallet.address, 'OWNED');
    const signature = wallet.sign(challenge.challenge);

    const first = await ctx.verification.submit({
      telegramUserId: TG, walletAddress: wallet.address, nonce: challenge.nonce, signature,
    });
    expect(first.ok).toBe(true);

    // Same nonce, same signature, replayed verbatim.
    const replay = await ctx.verification.submit({
      telegramUserId: TG, walletAddress: wallet.address, nonce: challenge.nonce, signature,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.failure).toBe('nonce_already_used');
  });

  it('lets only one of two concurrent submissions of the same nonce win', async () => {
    const { wallet, challenge } = await issueChallenge(ctx);
    ctx.fakeOwnership.set(wallet.address, 'OWNED');
    const signature = wallet.sign(challenge.challenge);
    const submit = () =>
      ctx.verification.submit({
        telegramUserId: TG, walletAddress: wallet.address, nonce: challenge.nonce, signature,
      });

    const [a, b] = await Promise.all([submit(), submit()]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('rejects an expired challenge', async () => {
    // A 30s TTL is the schema minimum; rewind the stored expiry to force expiry.
    const { wallet, challenge } = await issueChallenge(ctx);
    ctx.fakeOwnership.set(wallet.address, 'OWNED');
    await ctx.env.DB.prepare('UPDATE verification_nonces SET expires_at = ? WHERE nonce = ?')
      .bind(new Date(Date.now() - 60_000).toISOString(), challenge.nonce)
      .run();

    const result = await ctx.verification.submit({
      telegramUserId: TG,
      walletAddress: wallet.address,
      nonce: challenge.nonce,
      signature: wallet.sign(challenge.challenge),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('nonce_expired');
  });

  it('rejects a challenge presented by a different Telegram user', async () => {
    const { wallet, challenge } = await issueChallenge(ctx, '111');
    ctx.fakeOwnership.set(wallet.address, 'OWNED');

    const result = await ctx.verification.submit({
      telegramUserId: '999', // stolen link used by someone else
      walletAddress: wallet.address,
      nonce: challenge.nonce,
      signature: wallet.sign(challenge.challenge),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('telegram_user_mismatch');
  });

  it('rejects wallet substitution: a challenge for wallet A submitted for wallet B', async () => {
    const { challenge } = await issueChallenge(ctx);
    const other = makeWallet();
    ctx.fakeOwnership.set(other.address, 'OWNED');

    const result = await ctx.verification.submit({
      telegramUserId: TG,
      walletAddress: other.address,
      nonce: challenge.nonce,
      signature: other.sign(challenge.challenge),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('wallet_mismatch');
  });

  it('rejects challenge substitution: signing another user\'s challenge text', async () => {
    // Victim's challenge, attacker's own valid nonce — the message no longer
    // matches what the server stored for the attacker's nonce.
    const victim = await issueChallenge(ctx, '111');
    const attacker = await issueChallenge(ctx, '222');
    ctx.fakeOwnership.set(attacker.wallet.address, 'OWNED');

    const result = await ctx.verification.submit({
      telegramUserId: '222',
      walletAddress: attacker.wallet.address,
      nonce: attacker.challenge.nonce,
      signature: attacker.wallet.sign(victim.challenge.challenge),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('invalid_signature');
  });

  it('refuses to bind one wallet to two Telegram accounts', async () => {
    const first = await issueChallenge(ctx, '111');
    ctx.fakeOwnership.set(first.wallet.address, 'OWNED');
    await ctx.verification.submit({
      telegramUserId: '111',
      walletAddress: first.wallet.address,
      nonce: first.challenge.nonce,
      signature: first.wallet.sign(first.challenge.challenge),
    });

    // Second Telegram account tries the same wallet, signing correctly.
    const second = await ctx.verification.createChallenge('222', first.wallet.address, 'gate.example');
    if ('error' in second) throw new Error('unexpected');
    const result = await ctx.verification.submit({
      telegramUserId: '222',
      walletAddress: first.wallet.address,
      nonce: second.nonce,
      signature: first.wallet.sign(second.challenge),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('wallet_bound_to_other_user');
  });

  it('invalidates a user\'s previous challenge when a new one is issued', async () => {
    const first = await issueChallenge(ctx);
    ctx.fakeOwnership.setDefault('OWNED');
    const second = await ctx.verification.createChallenge(TG, first.wallet.address, 'gate.example');
    if ('error' in second) throw new Error('unexpected');

    const stale = await ctx.verification.submit({
      telegramUserId: TG,
      walletAddress: first.wallet.address,
      nonce: first.challenge.nonce,
      signature: first.wallet.sign(first.challenge.challenge),
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.failure).toBe('nonce_already_used');
  });
});

describe('ownership outcomes at verification time', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    await resetDatabase();
    ctx = await buildContext();
  });

  it('denies a non-holder with a valid signature', async () => {
    const { wallet, challenge } = await issueChallenge(ctx);
    ctx.fakeOwnership.set(wallet.address, 'NOT_OWNED');

    const result = await ctx.verification.submit({
      telegramUserId: TG, walletAddress: wallet.address,
      nonce: challenge.nonce, signature: wallet.sign(challenge.challenge),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('not_a_holder');
    expect(ctx.fakeTelegram.invites).toHaveLength(0);

    // The wallet is still recorded so /status has something to watch.
    const user = await ctx.db.getUserByTelegramId(TG);
    expect(user?.wallet_address).toBe(wallet.address);
    expect(user?.status).toBe('unverified');
  });

  it('does not grant access when the indexer is unreachable', async () => {
    const { wallet, challenge } = await issueChallenge(ctx);
    ctx.fakeOwnership.set(wallet.address, 'INDETERMINATE', { reason: 'timeout' });

    const result = await ctx.verification.submit({
      telegramUserId: TG, walletAddress: wallet.address,
      nonce: challenge.nonce, signature: wallet.sign(challenge.challenge),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('ownership_indeterminate');
    expect(ctx.fakeTelegram.invites).toHaveLength(0);
    // Crucially, this is not reported to the user as "you don't own one".
    expect(result.message).not.toMatch(/does not.*hold/i);
  });
});

describe('challenge content', () => {
  it('binds app, domain, telegram user, wallet, nonce and both timestamps', () => {
    const text = buildChallenge({
      appName: 'gate', domain: 'gate.example', telegramUserId: '42',
      walletAddress: 'Wa11et', nonce: 'NONCE', issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:05:00.000Z',
    });
    for (const needle of [
      'gate', 'gate.example', '42', 'Wa11et', 'NONCE',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z',
    ]) {
      expect(text).toContain(needle);
    }
    // Must make clear it is not a transaction, and must never mention key material.
    expect(text).toMatch(/not a transaction/i);
    expect(text).not.toMatch(/seed phrase|private key/i);
  });
});
