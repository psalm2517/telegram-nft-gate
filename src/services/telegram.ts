/**
 * Thin Bot API client used for access control.
 *
 * grammY owns the *inbound* webhook/command surface; this client owns the
 * *outbound* membership actions so they can be unit-tested and so every call
 * returns an explicit success/failure that the caller must handle. Telegram
 * being down must never silently look like a successful revocation.
 */
import type { UserFromGetMe } from 'grammy/types';

export type TelegramOutcome<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: number; retryAfter?: number };

export interface TelegramClientOptions {
  botToken: string;
  groupId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Called when Telegram reports the configured group was upgraded to a
   * supergroup (a routine, unprompted event — happens automatically past a
   * member-count threshold, or when certain admin features are first used).
   * The chat id changes permanently when this happens. Wire this to persist
   * the new id (e.g. to KV), or every group-scoped call keeps failing after
   * the first migration even though this client self-heals for its own
   * remaining lifetime.
   */
  onGroupMigrated?: (newChatId: string) => void | Promise<void>;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export class TelegramClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  /** Mutable: updated in place when Telegram reports a group migration. */
  private groupId: string;

  constructor(private readonly options: TelegramClientOptions) {
    // Bound explicitly — see the identical fix/comment in services/ownership.ts.
    // Storing the bare global `fetch` and calling it as `this.fetchImpl(...)`
    // throws "Illegal invocation" in Workers, since that call syntax rebinds
    // `this` away from globalThis.
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.groupId = options.groupId;
  }

  private async call<T>(
    method: string,
    payload: Record<string, unknown>,
    retriedAfterMigration = false,
  ): Promise<TelegramOutcome<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(
        `https://api.telegram.org/bot${this.options.botToken}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );
      const json = (await res.json().catch(() => null)) as TelegramApiResponse<T> | null;

      if (!json) return { ok: false, error: 'malformed_response', code: res.status };
      if (!json.ok) {
        const migrateTo = json.parameters?.migrate_to_chat_id;
        // Only follow the migration for a call that was actually scoped to
        // *our* configured group — an unrelated failure (e.g. getChat on some
        // other chat_id during /setup) must not overwrite it.
        if (
          migrateTo !== undefined &&
          !retriedAfterMigration &&
          payload.chat_id === this.groupId
        ) {
          const newChatId = String(migrateTo);
          this.groupId = newChatId;
          await this.options.onGroupMigrated?.(newChatId);
          return this.call(method, { ...payload, chat_id: newChatId }, true);
        }
        return {
          ok: false,
          error: json.description ?? 'telegram_error',
          code: json.error_code,
          retryAfter: json.parameters?.retry_after,
        };
      }
      return { ok: true, value: json.result as T };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      return { ok: false, error: aborted ? 'timeout' : 'network_error' };
    } finally {
      clearTimeout(timer);
    }
  }

  async sendMessage(
    chatId: string,
    text: string,
    extra: Record<string, unknown> = {},
  ): Promise<TelegramOutcome<{ message_id: number }>> {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  }

  /**
   * Mint a single-use, short-lived invite link for one verified user.
   *
   * member_limit=1 means a leaked link is worth exactly one join, and it stops
   * working the moment it is used.
   */
  async createSingleUseInviteLink(
    name: string,
    expiresInSeconds = 3600,
  ): Promise<TelegramOutcome<{ invite_link: string }>> {
    return this.call('createChatInviteLink', {
      chat_id: this.groupId,
      name: name.slice(0, 32),
      expire_date: Math.floor(Date.now() / 1000) + expiresInSeconds,
      member_limit: 1,
      creates_join_request: false,
    });
  }

  async revokeInviteLink(inviteLink: string): Promise<TelegramOutcome<unknown>> {
    return this.call('revokeChatInviteLink', {
      chat_id: this.groupId,
      invite_link: inviteLink,
    });
  }

  async getChatMember(
    userId: string,
  ): Promise<TelegramOutcome<{ status: string; user?: { id: number; username?: string } }>> {
    return this.call('getChatMember', { chat_id: this.groupId, user_id: userId });
  }

  /**
   * Look up an arbitrary chat by id — unlike every other method here, this is
   * not scoped to the configured group, because it exists to validate a chat
   * *before* it becomes the configured group (see /setup group <id>).
   */
  async getChat(chatId: string): Promise<TelegramOutcome<{ id: number; type: string; title?: string }>> {
    return this.call('getChat', { chat_id: chatId });
  }

  /** True when the user is currently inside the group in any non-exiting state. */
  async isMember(userId: string): Promise<TelegramOutcome<boolean>> {
    const res = await this.getChatMember(userId);
    if (!res.ok) return res;
    return { ok: true, value: ['creator', 'administrator', 'member', 'restricted'].includes(res.value.status) };
  }

  /**
   * Remove a user. `banChatMember` + `unbanChatMember` is the documented way to
   * kick without a permanent ban, so a user who regains eligibility can rejoin
   * with a fresh invite link.
   */
  async removeMember(userId: string): Promise<TelegramOutcome<void>> {
    const banned = await this.call('banChatMember', {
      chat_id: this.groupId,
      user_id: userId,
      revoke_messages: false,
    });
    if (!banned.ok) return banned as TelegramOutcome<void>;

    const unbanned = await this.call('unbanChatMember', {
      chat_id: this.groupId,
      user_id: userId,
      only_if_banned: true,
    });
    if (!unbanned.ok) return unbanned as TelegramOutcome<void>;
    return { ok: true, value: undefined };
  }

  async getMe(): Promise<TelegramOutcome<UserFromGetMe>> {
    return this.call('getMe', {});
  }
}
