import { randomId } from '../lib/crypto.js';
import { nowIso, type Iso } from '../lib/time.js';

export type UserStatus = 'unverified' | 'eligible' | 'grace' | 'revoked';

export interface UserRow {
  id: string;
  telegram_user_id: string;
  telegram_username: string | null;
  wallet_address: string | null;
  status: UserStatus;
  is_legacy_member: number;
  verified_at: string | null;
  last_ownership_check_at: string | null;
  grace_period_started_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NonceRow {
  id: string;
  telegram_user_id: string;
  wallet_address: string;
  nonce: string;
  challenge: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface Stats {
  total: number;
  verified: number;
  eligible: number;
  ineligible: number;
  grace: number;
  revoked: number;
  unverified: number;
  legacyMembers: number;
  legacyUnverified: number;
}

export class Database {
  constructor(private readonly db: D1Database) {}

  // ---------------------------------------------------------------- users

  async getUserByTelegramId(telegramUserId: string): Promise<UserRow | null> {
    return this.db
      .prepare('SELECT * FROM users WHERE telegram_user_id = ?')
      .bind(telegramUserId)
      .first<UserRow>();
  }

  async getUserByWallet(walletAddress: string): Promise<UserRow | null> {
    return this.db
      .prepare('SELECT * FROM users WHERE wallet_address = ?')
      .bind(walletAddress)
      .first<UserRow>();
  }

  async upsertUser(
    telegramUserId: string,
    username: string | null,
    opts: { isLegacyMember?: boolean } = {},
  ): Promise<UserRow> {
    const existing = await this.getUserByTelegramId(telegramUserId);
    const ts = nowIso();
    if (existing) {
      // Username can change over time; everything else is left to the state machine.
      if (username !== null && username !== existing.telegram_username) {
        await this.db
          .prepare('UPDATE users SET telegram_username = ?, updated_at = ? WHERE id = ?')
          .bind(username, ts, existing.id)
          .run();
        return { ...existing, telegram_username: username, updated_at: ts };
      }
      return existing;
    }

    const row: UserRow = {
      id: randomId(),
      telegram_user_id: telegramUserId,
      telegram_username: username,
      wallet_address: null,
      status: 'unverified',
      is_legacy_member: opts.isLegacyMember ? 1 : 0,
      verified_at: null,
      last_ownership_check_at: null,
      grace_period_started_at: null,
      revoked_at: null,
      created_at: ts,
      updated_at: ts,
    };
    await this.db
      .prepare(
        `INSERT INTO users (id, telegram_user_id, telegram_username, wallet_address, status,
                            is_legacy_member, verified_at, last_ownership_check_at,
                            grace_period_started_at, revoked_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id, row.telegram_user_id, row.telegram_username, row.wallet_address, row.status,
        row.is_legacy_member, row.verified_at, row.last_ownership_check_at,
        row.grace_period_started_at, row.revoked_at, row.created_at, row.updated_at,
      )
      .run();
    return row;
  }

  async updateUser(
    telegramUserId: string,
    patch: Partial<Omit<UserRow, 'id' | 'telegram_user_id' | 'created_at'>>,
  ): Promise<void> {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    entries.push(['updated_at', nowIso()]);
    const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
    await this.db
      .prepare(`UPDATE users SET ${setClause} WHERE telegram_user_id = ?`)
      .bind(...entries.map(([, v]) => v as never), telegramUserId)
      .run();
  }

  /** Users whose ownership should be re-checked, oldest check first. */
  async listUsersDueForRecheck(cutoff: Iso, limit: number): Promise<UserRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM users
          WHERE status IN ('eligible', 'grace')
            AND wallet_address IS NOT NULL
            AND (last_ownership_check_at IS NULL OR last_ownership_check_at < ?)
          ORDER BY COALESCE(last_ownership_check_at, created_at) ASC
          LIMIT ?`,
      )
      .bind(cutoff, limit)
      .all<UserRow>();
    return results ?? [];
  }

  /** Grace-period users whose window has now closed. */
  async listExpiredGraceUsers(cutoff: Iso, limit: number): Promise<UserRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM users
          WHERE status = 'grace' AND grace_period_started_at IS NOT NULL
            AND grace_period_started_at < ?
          ORDER BY grace_period_started_at ASC
          LIMIT ?`,
      )
      .bind(cutoff, limit)
      .all<UserRow>();
    return results ?? [];
  }

  async searchUsers(query: string | null, status: string | null, limit = 50, offset = 0) {
    const clauses: string[] = [];
    const binds: unknown[] = [];
    if (query) {
      clauses.push('(telegram_user_id LIKE ? OR telegram_username LIKE ? OR wallet_address LIKE ?)');
      const like = `%${query}%`;
      binds.push(like, like, like);
    }
    if (status) {
      clauses.push('status = ?');
      binds.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { results } = await this.db
      .prepare(`SELECT * FROM users ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .bind(...(binds as never[]), limit, offset)
      .all<UserRow>();
    return results ?? [];
  }

  async stats(): Promise<Stats> {
    const { results } = await this.db
      .prepare('SELECT status, COUNT(*) AS n FROM users GROUP BY status')
      .all<{ status: UserStatus; n: number }>();
    const by = new Map((results ?? []).map((r) => [r.status, r.n]));
    const legacy = await this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status != 'eligible' THEN 1 ELSE 0 END) AS pending
           FROM users WHERE is_legacy_member = 1`,
      )
      .first<{ total: number; pending: number | null }>();

    const eligible = by.get('eligible') ?? 0;
    const grace = by.get('grace') ?? 0;
    const revoked = by.get('revoked') ?? 0;
    const unverified = by.get('unverified') ?? 0;
    return {
      total: eligible + grace + revoked + unverified,
      // "verified" means the user has completed verification at least once.
      verified: eligible + grace + revoked,
      eligible,
      ineligible: grace + revoked,
      grace,
      revoked,
      unverified,
      legacyMembers: legacy?.total ?? 0,
      legacyUnverified: legacy?.pending ?? 0,
    };
  }

  // --------------------------------------------------------------- nonces

  async createNonce(row: Omit<NonceRow, 'id' | 'created_at' | 'used_at'>): Promise<NonceRow> {
    const full: NonceRow = { ...row, id: randomId(), used_at: null, created_at: nowIso() };
    await this.db
      .prepare(
        `INSERT INTO verification_nonces
           (id, telegram_user_id, wallet_address, nonce, challenge, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        full.id, full.telegram_user_id, full.wallet_address, full.nonce,
        full.challenge, full.expires_at, full.used_at, full.created_at,
      )
      .run();
    return full;
  }

  async getNonce(nonce: string): Promise<NonceRow | null> {
    return this.db
      .prepare('SELECT * FROM verification_nonces WHERE nonce = ?')
      .bind(nonce)
      .first<NonceRow>();
  }

  /**
   * Atomically burn a nonce. Returns true only for the caller that won the race.
   *
   * The `used_at IS NULL` predicate lives in the UPDATE rather than in a prior
   * SELECT, so two concurrent submissions of the same nonce cannot both succeed.
   */
  async consumeNonce(nonce: string, at: Iso = nowIso()): Promise<boolean> {
    const res = await this.db
      .prepare('UPDATE verification_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL')
      .bind(at, nonce)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }

  /** Invalidate any outstanding challenges for a user, e.g. when a new one is issued. */
  async expireOutstandingNonces(telegramUserId: string, at: Iso = nowIso()): Promise<void> {
    await this.db
      .prepare(
        'UPDATE verification_nonces SET used_at = ? WHERE telegram_user_id = ? AND used_at IS NULL',
      )
      .bind(at, telegramUserId)
      .run();
  }

  async deleteExpiredNonces(before: Iso): Promise<number> {
    const res = await this.db
      .prepare('DELETE FROM verification_nonces WHERE expires_at < ?')
      .bind(before)
      .run();
    return res.meta?.changes ?? 0;
  }

  // --------------------------------------------------------------- events

  async recordVerificationEvent(e: {
    telegramUserId: string;
    walletAddress?: string | null;
    eventType: string;
    result: string;
    reason?: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO verification_events
           (id, telegram_user_id, wallet_address, event_type, result, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        randomId(), e.telegramUserId, e.walletAddress ?? null,
        e.eventType, e.result, e.reason ?? null, nowIso(),
      )
      .run();
  }

  async recordAccessEvent(e: {
    telegramUserId: string;
    action: string;
    previousState?: string | null;
    newState?: string | null;
    reason?: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO access_events
           (id, telegram_user_id, action, previous_state, new_state, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        randomId(), e.telegramUserId, e.action,
        e.previousState ?? null, e.newState ?? null, e.reason ?? null, nowIso(),
      )
      .run();
  }

  async recordAdminAction(e: {
    adminTelegramId: string;
    action: string;
    targetTelegramId?: string | null;
    details?: unknown;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO admin_audit_log
           (id, admin_telegram_id, action, target_telegram_id, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        randomId(), e.adminTelegramId, e.action, e.targetTelegramId ?? null,
        e.details === undefined ? null : JSON.stringify(e.details), nowIso(),
      )
      .run();
  }

  async listVerificationEvents(telegramUserId: string, limit = 50) {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM verification_events WHERE telegram_user_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .bind(telegramUserId, limit)
      .all();
    return results ?? [];
  }

  async listAccessEvents(telegramUserId: string, limit = 50) {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM access_events WHERE telegram_user_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .bind(telegramUserId, limit)
      .all();
    return results ?? [];
  }

  async listAdminAuditLog(limit = 100) {
    const { results } = await this.db
      .prepare('SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT ?')
      .bind(limit)
      .all();
    return results ?? [];
  }
}
