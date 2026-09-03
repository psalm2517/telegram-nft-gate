import { z } from 'zod';
import { getCachedCollectionName } from '../collection-cache.js';
import { getConfiguredGroupTitle } from '../config-store.js';
import type { AppContext } from '../context.js';
import { badRequest, tooManyRequests, unauthorized } from '../lib/errors.js';
import { clientIp, json, readJson } from '../lib/http.js';
import { verifyToken } from '../lib/token.js';

const challengeBody = z.object({
  token: z.string().min(1).max(4096),
  walletAddress: z.string().min(32).max(44),
});

const submitBody = z.object({
  token: z.string().min(1).max(4096),
  walletAddress: z.string().min(32).max(44),
  nonce: z.string().min(1).max(256),
  signature: z.string().min(64).max(128),
});

/**
 * Resolve the caller's Telegram identity from the signed link token.
 *
 * This is the only source of the acting Telegram user id. The request body never
 * gets to assert who it is, which is what stops a user from verifying on behalf
 * of someone else.
 */
async function requireVerifySession(ctx: AppContext, token: string) {
  const payload = await verifyToken(ctx.config.sessionSecret, token, 'verify');
  if (!payload) throw unauthorized('Verification link is invalid or has expired.', 'invalid_token');
  return {
    telegramUserId: payload.sub,
    username: typeof payload.username === 'string' ? payload.username : null,
  };
}

export async function handleChallenge(request: Request, ctx: AppContext): Promise<Response> {
  const parsed = challengeBody.safeParse(await readJson(request));
  if (!parsed.success) throw badRequest('Invalid request body.', 'invalid_body');

  const session = await requireVerifySession(ctx, parsed.data.token);

  const limit = await ctx.rateLimiter.check(`challenge:${session.telegramUserId}`, 10, 300);
  if (!limit.allowed) throw tooManyRequests('Too many challenge requests. Try again shortly.');

  const ipLimit = await ctx.rateLimiter.check(`challenge-ip:${clientIp(request)}`, 30, 300);
  if (!ipLimit.allowed) throw tooManyRequests('Too many challenge requests from this network.');

  const result = await ctx.verification.createChallenge(
    session.telegramUserId,
    parsed.data.walletAddress,
    new URL(request.url).host,
  );
  if ('error' in result) throw badRequest('That is not a valid Solana wallet address.', result.error);

  return json(result);
}

export async function handleSubmit(request: Request, ctx: AppContext): Promise<Response> {
  const parsed = submitBody.safeParse(await readJson(request));
  if (!parsed.success) throw badRequest('Invalid request body.', 'invalid_body');

  const session = await requireVerifySession(ctx, parsed.data.token);

  const limit = await ctx.rateLimiter.check(`submit:${session.telegramUserId}`, 10, 300);
  if (!limit.allowed) throw tooManyRequests('Too many verification attempts. Try again shortly.');

  const result = await ctx.verification.submit({
    telegramUserId: session.telegramUserId,
    username: session.username,
    walletAddress: parsed.data.walletAddress,
    nonce: parsed.data.nonce,
    signature: parsed.data.signature,
  });

  if (!result.ok) {
    // An indeterminate data source is a server-side condition, not user error.
    const status = result.failure === 'ownership_indeterminate' ? 503 : 400;
    return json({ ok: false, error: result.failure, message: result.message }, { status });
  }

  // Deliver the invite over Telegram rather than in the HTTP response, so the
  // link lands in the account that was actually verified.
  const { decision } = result;
  if (decision.notify) {
    await ctx.telegram.sendMessage(session.telegramUserId, decision.notify);
  }
  if (decision.inviteLink) {
    await ctx.telegram.sendMessage(
      session.telegramUserId,
      `Your single-use invite link:\n${decision.inviteLink}`,
    );
  }

  return json({
    ok: true,
    status: decision.newStatus,
    message:
      decision.notify || decision.inviteLink
        ? 'Verification complete. Check your Telegram chat with the bot for details.'
        : 'Verification complete.',
  });
}

/** Public, non-sensitive config the frontend needs to render itself. */
export async function handlePublicConfig(ctx: AppContext): Promise<Response> {
  const [groupTitle, collectionName] = await Promise.all([
    getConfiguredGroupTitle(ctx.env.KV),
    getCachedCollectionName(ctx.env.KV, ctx.ownership, ctx.config.nftCollectionId),
  ]);
  return json({
    appName: ctx.config.appName,
    // The actual Telegram group's name, so the web page can say "join <group>"
    // instead of generic "the private Telegram group" phrasing. null until an
    // admin has confirmed a group via /setup.
    groupTitle,
    // Friendly collection name derived from the chain (e.g. "Solana Business
    // Frogs"), so the page can say "an NFT from X" instead of generic
    // "a qualifying NFT". null if DAS couldn't be reached.
    collectionName,
    // The collection id is public on-chain data; the Helius API key is not and
    // never leaves the Worker.
    collectionId: ctx.config.nftCollectionId,
    gracePeriodHours: ctx.config.gracePeriodHours,
    migrationMode: ctx.config.migrationMode,
  });
}
