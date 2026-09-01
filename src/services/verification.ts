import type { Config } from '../env.js';
import { randomToken } from '../lib/crypto.js';
import { addSeconds, isBefore, nowIso } from '../lib/time.js';
import type { AccessService, AccessDecision } from './access.js';
import type { Database } from './db.js';
import type { OwnershipChecker } from './ownership.js';
import { buildChallenge, isValidSolanaAddress, verifyWalletSignature } from './wallet.js';

export interface ChallengeResponse {
  nonce: string;
  challenge: string;
  expiresAt: string;
}

export type VerificationFailure =
  | 'invalid_wallet'
  | 'unknown_nonce'
  | 'nonce_expired'
  | 'nonce_already_used'
  | 'telegram_user_mismatch'
  | 'wallet_mismatch'
  | 'invalid_signature'
  | 'wallet_bound_to_other_user'
  | 'ownership_indeterminate'
  | 'not_a_holder';

export type VerificationResult =
  | { ok: true; decision: AccessDecision; walletAddress: string }
  | { ok: false; failure: VerificationFailure; message: string };

const FAILURE_MESSAGES: Record<VerificationFailure, string> = {
  invalid_wallet: 'That is not a valid Solana wallet address.',
  unknown_nonce: 'This verification challenge is not recognised. Start again from /verify.',
  nonce_expired: 'This verification challenge has expired. Start again from /verify.',
  nonce_already_used: 'This verification challenge has already been used. Start again from /verify.',
  telegram_user_mismatch: 'This challenge was issued to a different Telegram account.',
  wallet_mismatch: 'This challenge was issued for a different wallet.',
  invalid_signature: 'The signature did not match the wallet address.',
  wallet_bound_to_other_user: 'This wallet is already linked to a different Telegram account.',
  ownership_indeterminate:
    'We could not reach the Solana indexer to confirm ownership. Please try again shortly — ' +
    'this is not a statement about your wallet.',
  not_a_holder: 'This wallet does not currently hold a qualifying NFT from the collection.',
};

export class VerificationService {
  constructor(
    private readonly db: Database,
    private readonly ownership: OwnershipChecker,
    private readonly access: AccessService,
    private readonly config: Config,
  ) {}

  /**
   * Issue a single-use challenge bound to (telegram user, wallet, nonce, expiry).
   *
   * Issuing a new challenge invalidates the user's outstanding ones, so a user
   * cannot bank a pile of live nonces.
   */
  async createChallenge(
    telegramUserId: string,
    walletAddress: string,
    domain: string,
  ): Promise<ChallengeResponse | { error: VerificationFailure }> {
    if (!isValidSolanaAddress(walletAddress)) return { error: 'invalid_wallet' };

    const issuedAt = nowIso();
    const expiresAt = addSeconds(issuedAt, this.config.challengeTtlSeconds);
    const nonce = randomToken(32);

    const challenge = buildChallenge({
      appName: this.config.appName,
      domain,
      telegramUserId,
      walletAddress,
      nonce,
      issuedAt,
      expiresAt,
    });

    await this.db.expireOutstandingNonces(telegramUserId);
    await this.db.createNonce({
      telegram_user_id: telegramUserId,
      wallet_address: walletAddress,
      nonce,
      challenge,
      expires_at: expiresAt,
    });
    await this.db.recordVerificationEvent({
      telegramUserId,
      walletAddress,
      eventType: 'challenge_issued',
      result: 'ok',
    });

    return { nonce, challenge, expiresAt };
  }

  /**
   * Verify a signed challenge and, if it holds up, check ownership and apply access.
   *
   * Order matters: identity binding is checked before the signature, the nonce is
   * burned before any network call, and ownership is only consulted once the
   * signature has proven wallet control.
   */
  async submit(input: {
    telegramUserId: string;
    walletAddress: string;
    nonce: string;
    signature: string;
    username?: string | null;
  }): Promise<VerificationResult> {
    const fail = (failure: VerificationFailure): VerificationResult => ({
      ok: false,
      failure,
      message: FAILURE_MESSAGES[failure],
    });

    const record = await this.db.getNonce(input.nonce);
    if (!record) {
      await this.logFailure(input, 'unknown_nonce');
      return fail('unknown_nonce');
    }

    // Bindings first — these say *who* the challenge was for.
    if (record.telegram_user_id !== input.telegramUserId) {
      await this.logFailure(input, 'telegram_user_mismatch');
      return fail('telegram_user_mismatch');
    }
    if (record.wallet_address !== input.walletAddress) {
      await this.logFailure(input, 'wallet_mismatch');
      return fail('wallet_mismatch');
    }
    if (record.used_at !== null) {
      await this.logFailure(input, 'nonce_already_used');
      return fail('nonce_already_used');
    }
    if (isBefore(record.expires_at, nowIso())) {
      await this.logFailure(input, 'nonce_expired');
      return fail('nonce_expired');
    }

    // Signature is checked against the *stored* challenge, never a client-supplied one.
    const signatureValid = verifyWalletSignature({
      challenge: record.challenge,
      signatureBase58: input.signature,
      walletAddress: record.wallet_address,
    });
    if (!signatureValid) {
      await this.logFailure(input, 'invalid_signature');
      return fail('invalid_signature');
    }

    // Burn the nonce atomically. Losing this race means a concurrent replay.
    const consumed = await this.db.consumeNonce(input.nonce);
    if (!consumed) {
      await this.logFailure(input, 'nonce_already_used');
      return fail('nonce_already_used');
    }

    // One wallet, one Telegram account.
    const walletOwner = await this.db.getUserByWallet(input.walletAddress);
    if (walletOwner && walletOwner.telegram_user_id !== input.telegramUserId) {
      await this.logFailure(input, 'wallet_bound_to_other_user');
      return fail('wallet_bound_to_other_user');
    }

    const ownership = await this.ownership.ownsAtLeastOne(input.walletAddress);
    if (ownership.status === 'INDETERMINATE') {
      await this.db.recordVerificationEvent({
        telegramUserId: input.telegramUserId,
        walletAddress: input.walletAddress,
        eventType: 'verification',
        result: 'indeterminate',
        reason: ownership.reason ?? 'unknown',
      });
      return fail('ownership_indeterminate');
    }

    const user = await this.db.upsertUser(input.telegramUserId, input.username ?? null);

    if (ownership.status === 'NOT_OWNED') {
      // Bind the wallet anyway so /status and rechecks have something to watch,
      // but grant nothing.
      await this.db.updateUser(input.telegramUserId, {
        wallet_address: input.walletAddress,
        last_ownership_check_at: nowIso(),
      });
      await this.db.recordVerificationEvent({
        telegramUserId: input.telegramUserId,
        walletAddress: input.walletAddress,
        eventType: 'verification',
        result: 'not_owned',
      });
      return fail('not_a_holder');
    }

    await this.db.updateUser(input.telegramUserId, {
      wallet_address: input.walletAddress,
      verified_at: user.verified_at ?? nowIso(),
    });

    const refreshed = (await this.db.getUserByTelegramId(input.telegramUserId))!;
    const decision = await this.access.applyOwnership(refreshed, 'OWNED', {
      source: 'verification',
    });

    return { ok: true, decision, walletAddress: input.walletAddress };
  }

  private async logFailure(
    input: { telegramUserId: string; walletAddress: string },
    reason: VerificationFailure,
  ): Promise<void> {
    await this.db.recordVerificationEvent({
      telegramUserId: input.telegramUserId,
      walletAddress: input.walletAddress,
      eventType: 'verification',
      result: 'rejected',
      reason,
    });
  }
}
