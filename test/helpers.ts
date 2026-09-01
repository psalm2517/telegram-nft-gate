import { env } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { createContext, type AppContext } from '../src/context.js';
import type { Env } from '../src/env.js';
import type { OwnershipResult, OwnershipStatus } from '../src/services/ownership.js';
import type { TelegramOutcome } from '../src/services/telegram.js';

export const TEST_COLLECTION = 'J7rxtKmEpNJEtrfkagiTF1gsmLyVus6BQZFY4ouBkeMG';

/**
 * Truncate all tables between tests.
 *
 * Done explicitly rather than relying on the pool's per-test storage isolation,
 * so the suite is deterministic regardless of that default.
 */
export async function resetDatabase(): Promise<void> {
  for (const table of [
    'admin_audit_log', 'access_events', 'verification_events',
    'verification_nonces', 'users',
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

/** A throwaway ed25519 keypair standing in for a Solana wallet. */
export function makeWallet() {
  const secretKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secretKey);
  return {
    address: base58.encode(publicKey),
    sign(message: string): string {
      return base58.encode(ed25519.sign(new TextEncoder().encode(message), secretKey));
    },
  };
}

/** Programmable stand-in for the Helius DAS client. */
export class FakeOwnership {
  public calls: string[] = [];
  private responses = new Map<string, OwnershipResult>();
  private fallback: OwnershipResult = { status: 'NOT_OWNED', count: 0 };

  set(address: string, status: OwnershipStatus, extra: Partial<OwnershipResult> = {}) {
    this.responses.set(address, { status, ...extra });
    return this;
  }

  setDefault(status: OwnershipStatus, extra: Partial<OwnershipResult> = {}) {
    this.fallback = { status, ...extra };
    return this;
  }

  async ownsAtLeastOne(address: string): Promise<OwnershipResult> {
    this.calls.push(address);
    return this.responses.get(address) ?? this.fallback;
  }

  async countOwned(address: string): Promise<OwnershipResult> {
    return this.ownsAtLeastOne(address);
  }
}

/** Records outbound Telegram calls instead of making them. */
export class FakeTelegram {
  public messages: { chatId: string; text: string }[] = [];
  public removed: string[] = [];
  public invites: string[] = [];
  public membership = new Map<string, boolean>();
  public failInvites = false;
  public failRemovals = false;

  async sendMessage(chatId: string, text: string): Promise<TelegramOutcome<{ message_id: number }>> {
    this.messages.push({ chatId, text });
    return { ok: true, value: { message_id: this.messages.length } };
  }

  async createSingleUseInviteLink(name: string): Promise<TelegramOutcome<{ invite_link: string }>> {
    if (this.failInvites) return { ok: false, error: 'invite_unavailable' };
    const link = `https://t.me/+fake-${name}-${this.invites.length}`;
    this.invites.push(link);
    return { ok: true, value: { invite_link: link } };
  }

  async isMember(userId: string): Promise<TelegramOutcome<boolean>> {
    return { ok: true, value: this.membership.get(userId) ?? false };
  }

  async removeMember(userId: string): Promise<TelegramOutcome<void>> {
    if (this.failRemovals) return { ok: false, error: 'telegram_unavailable' };
    this.removed.push(userId);
    this.membership.set(userId, false);
    return { ok: true, value: undefined };
  }

  async getChatMember() {
    return { ok: true as const, value: { status: 'member' } };
  }

  async revokeInviteLink() {
    return { ok: true as const, value: null };
  }

  async getMe() {
    return {
      ok: true as const,
      value: {
        id: 123456789, is_bot: true as const, first_name: 'Test Bot', username: 'test_bot',
        can_join_groups: true as const, can_read_all_group_messages: true as const,
        supports_inline_queries: false as const, can_connect_to_business: false as const,
        has_main_web_app: false as const,
      },
    };
  }
}

export interface TestContext extends AppContext {
  fakeOwnership: FakeOwnership;
  fakeTelegram: FakeTelegram;
}

/** Build a real AppContext with the network-facing services swapped for fakes. */
export async function buildContext(overrides: Partial<Env> = {}): Promise<TestContext> {
  const ctx = await createContext({ ...(env as unknown as Env), ...overrides }, 'https://gate.example/');
  const fakeOwnership = new FakeOwnership();
  const fakeTelegram = new FakeTelegram();

  // The services hold each other by reference, so replacing the fields on the
  // already-constructed instances is what actually rewires the graph.
  const rewire = (target: object, field: string, value: unknown) => {
    Object.defineProperty(target, field, { value, writable: true, configurable: true });
  };
  rewire(ctx, 'ownership', fakeOwnership);
  rewire(ctx, 'telegram', fakeTelegram);
  rewire(ctx.access, 'ownership', fakeOwnership);
  rewire(ctx.access, 'telegram', fakeTelegram);
  rewire(ctx.verification, 'ownership', fakeOwnership);

  return Object.assign(ctx, { fakeOwnership, fakeTelegram });
}
