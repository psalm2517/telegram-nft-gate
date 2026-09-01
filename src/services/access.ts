import type { Config } from '../env.js';
import { addHours, isBefore, nowIso, type Iso } from '../lib/time.js';
import type { Database, UserRow, UserStatus } from './db.js';
import type { OwnershipChecker, OwnershipStatus } from './ownership.js';
import type { TelegramClient } from './telegram.js';

export interface AccessDecision {
  previousStatus: UserStatus;
  newStatus: UserStatus;
  changed: boolean;
  ownership: OwnershipStatus;
  reason: string;
  /** Present when a fresh invite link was minted for the user. */
  inviteLink?: string;
  /** Present when the user should be told something. */
  notify?: string;
}

/**
 * The access-control state machine.
 *
 *   unverified ──verify+owns──> eligible
 *   eligible   ──lost NFT────-> grace ──grace expires──> revoked
 *   grace      ──regains NFT─> eligible
 *   revoked    ──reverify────> eligible
 *
 * INDETERMINATE ownership is a no-op on every transition: a Helius outage must
 * not be able to move anybody toward revocation.
 */
export class AccessService {
  constructor(
    private readonly db: Database,
    private readonly telegram: TelegramClient,
    private readonly ownership: OwnershipChecker,
    private readonly config: Config,
  ) {}

  /**
   * Apply a fresh ownership result to a user and carry out any Telegram action
   * the transition implies.
   */
  async applyOwnership(
    user: UserRow,
    ownership: OwnershipStatus,
    opts: { source: string; at?: Iso } = { source: 'recheck' },
  ): Promise<AccessDecision> {
    const at = opts.at ?? nowIso();
    const previousStatus = user.status;

    if (ownership === 'INDETERMINATE') {
      // Record the attempt but do not touch last_ownership_check_at, so the user
      // stays at the front of the recheck queue and is retried promptly.
      await this.db.recordVerificationEvent({
        telegramUserId: user.telegram_user_id,
        walletAddress: user.wallet_address,
        eventType: opts.source,
        result: 'indeterminate',
        reason: 'ownership data source unavailable',
      });
      return {
        previousStatus,
        newStatus: previousStatus,
        changed: false,
        ownership,
        reason: 'ownership_indeterminate',
      };
    }

    if (ownership === 'OWNED') return this.grantOrRestore(user, at, opts.source);
    return this.beginOrContinueLoss(user, at, opts.source);
  }

  private async grantOrRestore(user: UserRow, at: Iso, source: string): Promise<AccessDecision> {
    const previousStatus = user.status;
    const wasAlreadyEligible = previousStatus === 'eligible';

    await this.db.updateUser(user.telegram_user_id, {
      status: 'eligible',
      last_ownership_check_at: at,
      grace_period_started_at: null,
      revoked_at: null,
      verified_at: user.verified_at ?? at,
    });

    await this.db.recordVerificationEvent({
      telegramUserId: user.telegram_user_id,
      walletAddress: user.wallet_address,
      eventType: source,
      result: 'owned',
    });

    if (wasAlreadyEligible) {
      return {
        previousStatus,
        newStatus: 'eligible',
        changed: false,
        ownership: 'OWNED',
        reason: 'still_eligible',
      };
    }

    await this.db.recordAccessEvent({
      telegramUserId: user.telegram_user_id,
      action: previousStatus === 'grace' ? 'grace_cleared' : 'granted',
      previousState: previousStatus,
      newState: 'eligible',
      reason: source,
    });

    // Someone already inside the group (grace period, or a legacy member) does
    // not need a new link — only a user who is actually outside does.
    const decision: AccessDecision = {
      previousStatus,
      newStatus: 'eligible',
      changed: true,
      ownership: 'OWNED',
      reason: previousStatus === 'grace' ? 'eligibility_restored' : 'access_granted',
    };

    const membership = await this.telegram.isMember(user.telegram_user_id);
    if (membership.ok && membership.value) {
      decision.notify =
        previousStatus === 'grace'
          ? 'Ownership confirmed again — your access is restored. No action needed.'
          : 'Ownership confirmed. Your access is active.';
      return decision;
    }

    const invite = await this.createInvite(user.telegram_user_id);
    if (invite) {
      decision.inviteLink = invite;
      decision.notify = 'Ownership confirmed. Here is your single-use invite link:';
    } else {
      decision.notify =
        'Ownership confirmed, but the invite link could not be created right now. ' +
        'Please try /status again in a few minutes.';
    }
    return decision;
  }

  private async beginOrContinueLoss(user: UserRow, at: Iso, source: string): Promise<AccessDecision> {
    const previousStatus = user.status;

    await this.db.recordVerificationEvent({
      telegramUserId: user.telegram_user_id,
      walletAddress: user.wallet_address,
      eventType: source,
      result: 'not_owned',
    });

    // Already revoked, or never verified: nothing to take away.
    if (previousStatus === 'revoked' || previousStatus === 'unverified') {
      await this.db.updateUser(user.telegram_user_id, { last_ownership_check_at: at });
      return {
        previousStatus,
        newStatus: previousStatus,
        changed: false,
        ownership: 'NOT_OWNED',
        reason: 'not_eligible',
      };
    }

    if (previousStatus === 'eligible') {
      await this.db.updateUser(user.telegram_user_id, {
        status: 'grace',
        grace_period_started_at: at,
        last_ownership_check_at: at,
      });
      await this.db.recordAccessEvent({
        telegramUserId: user.telegram_user_id,
        action: 'grace_started',
        previousState: 'eligible',
        newState: 'grace',
        reason: source,
      });
      return {
        previousStatus,
        newStatus: 'grace',
        changed: true,
        ownership: 'NOT_OWNED',
        reason: 'grace_started',
        notify:
          `Your wallet no longer holds a qualifying NFT. You have ` +
          `${this.config.gracePeriodHours} hour(s) to restore ownership or verify a ` +
          `different wallet with /verify before access is removed.`,
      };
    }

    // Already in grace — revoke only once the window has actually closed.
    const startedAt = user.grace_period_started_at ?? at;
    const deadline = addHours(startedAt, this.config.gracePeriodHours);
    if (!isBefore(deadline, at)) {
      await this.db.updateUser(user.telegram_user_id, { last_ownership_check_at: at });
      return {
        previousStatus,
        newStatus: 'grace',
        changed: false,
        ownership: 'NOT_OWNED',
        reason: 'grace_active',
      };
    }

    return this.revoke(user, at, 'grace_period_expired');
  }

  /** Move a user to `revoked` and remove them from the group. */
  async revoke(user: UserRow, at: Iso, reason: string): Promise<AccessDecision> {
    const previousStatus = user.status;

    // Migration mode protects pre-existing members from automated removal only.
    // An explicit admin revoke still goes through.
    if (this.config.migrationMode && user.is_legacy_member === 1 && reason !== 'admin_action') {
      await this.db.updateUser(user.telegram_user_id, { last_ownership_check_at: at });
      await this.db.recordAccessEvent({
        telegramUserId: user.telegram_user_id,
        action: 'removal_skipped_migration_mode',
        previousState: previousStatus,
        newState: previousStatus,
        reason,
      });
      return {
        previousStatus,
        newStatus: previousStatus,
        changed: false,
        ownership: 'NOT_OWNED',
        reason: 'migration_mode_protected',
      };
    }

    const removal = await this.telegram.removeMember(user.telegram_user_id);

    // A Telegram failure must not be recorded as a completed removal. The user
    // stays in `grace` so the next cron run retries.
    if (!removal.ok) {
      await this.db.recordAccessEvent({
        telegramUserId: user.telegram_user_id,
        action: 'removal_failed',
        previousState: previousStatus,
        newState: previousStatus,
        reason: removal.error,
      });
      return {
        previousStatus,
        newStatus: previousStatus,
        changed: false,
        ownership: 'NOT_OWNED',
        reason: `removal_failed:${removal.error}`,
      };
    }

    await this.db.updateUser(user.telegram_user_id, {
      status: 'revoked',
      revoked_at: at,
      grace_period_started_at: null,
      last_ownership_check_at: at,
    });
    await this.db.recordAccessEvent({
      telegramUserId: user.telegram_user_id,
      action: 'revoked',
      previousState: previousStatus,
      newState: 'revoked',
      reason,
    });

    return {
      previousStatus,
      newStatus: 'revoked',
      changed: true,
      ownership: 'NOT_OWNED',
      reason,
      notify:
        'Your access has been removed because your wallet no longer holds a qualifying NFT. ' +
        'You can regain access any time with /verify.',
    };
  }

  /** Live ownership check for a single user (used by /status and admin actions). */
  async recheckUser(user: UserRow, source: string): Promise<AccessDecision> {
    if (!user.wallet_address) {
      return {
        previousStatus: user.status,
        newStatus: user.status,
        changed: false,
        ownership: 'NOT_OWNED',
        reason: 'no_wallet_linked',
      };
    }
    const result = await this.ownership.ownsAtLeastOne(user.wallet_address);
    return this.applyOwnership(user, result.status, { source });
  }

  async createInvite(telegramUserId: string): Promise<string | null> {
    const link = await this.telegram.createSingleUseInviteLink(`user-${telegramUserId}`);
    if (!link.ok) {
      await this.db.recordAccessEvent({
        telegramUserId,
        action: 'invite_failed',
        reason: link.error,
      });
      return null;
    }
    await this.db.recordAccessEvent({
      telegramUserId,
      action: 'invite_created',
      reason: 'single_use_link',
    });
    return link.value.invite_link;
  }
}
