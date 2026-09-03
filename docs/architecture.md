# Architecture

Everything runs in one Cloudflare Worker. There is no separate frontend host, no
Pages project, and no cross-origin configuration.

```
                        Telegram
                            │ webhook
                            ▼
┌───────────────────────────────────────────────────────────┐
│                   Cloudflare Worker                       │
│                                                           │
│  /telegram/webhook ──► grammY bot (incl. admin commands)  │
│  /api/verify/*     ──► verification service               │
│  everything else   ──► ASSETS  (React/Vite bundle)        │
│                                                           │
│  services: telegram · wallet · ownership · access · db    │
└───────┬────────────────┬───────────────┬──────────────────┘
        │                │               │
        ▼                ▼               ▼
       D1               KV          Helius DAS
   (state, audit)   (rate limits)   (ownership)
        ▲
        │  cron trigger
   scheduled recheck
```

## Request routing

`src/index.ts` matches the Worker's own paths first. Anything unmatched returns
`null` from the router and falls through to `env.ASSETS.fetch(request)`, which
serves the React bundle. `wrangler.jsonc` sets
`not_found_handling: "single-page-application"`, so `/verify` resolves to
`index.html`. There is no `/admin` page: administration is bot commands, see
below.

`run_worker_first: ["/api/*", "/telegram/*"]` keeps API and webhook traffic off
the static-asset fast path.

Note the distinction between *no route matched* (fall through to assets) and *a
handler threw a 404* (a real API answer, e.g. "no such user"). Conflating them
would silently return the SPA with a 200 for a missing API resource.

## Separation of responsibilities

| Module | Responsibility |
| --- | --- |
| `services/telegram.ts` | Outbound Bot API calls; every call returns an explicit success/failure |
| `services/wallet.ts` | Challenge text construction and ed25519 signature verification |
| `services/ownership.ts` | Helius DAS queries and collection validation |
| `services/access.ts` | The access state machine and Telegram membership actions |
| `services/verification.ts` | Orchestrates challenge issue → verify → ownership → access |
| `services/db.ts` | All D1 access |
| `services/ratelimit.ts` | KV-backed fixed-window throttling |
| `routes/*` | HTTP surface, request validation, authorization |
| `bot/bot.ts` | grammY command handlers (inbound Telegram) |

Inbound Telegram (grammY) and outbound Telegram (the client) are deliberately
separate: outbound membership actions need explicit, testable failure handling,
which a framework's fire-and-forget helpers do not give you.

## The access state machine

```
                    verify + owns
   unverified ──────────────────────► eligible
                                       │  ▲
                          lost NFT     │  │  ownership returns
                                       ▼  │
                                     grace ┘
                                       │
                          grace expires │
                                       ▼
                                    revoked ──── re-verify ──► eligible
```

Implemented in `services/access.ts`. Two rules govern every edge:

1. **`INDETERMINATE` is a no-op.** If ownership cannot be determined, nothing
   changes: not the status, and not even `last_ownership_check_at` (so the user
   stays at the front of the retry queue instead of waiting a full interval).
2. **A failed Telegram removal is not a revocation.** If `banChatMember` fails,
   the user stays in `grace` and the next cron run retries. The database never
   records a removal that did not happen.

While `MIGRATION_MODE=true`, users flagged `is_legacy_member` are never removed
automatically. An explicit admin revoke still goes through.

## Database schema

Cloudflare D1 (SQLite). Migrations live in `migrations/`. Timestamps are ISO-8601
UTC strings; Telegram ids are stored as strings because they are int64.

| Table | Purpose |
| --- | --- |
| `users` | One row per Telegram account: wallet, status, verification and grace timestamps |
| `verification_nonces` | Issued challenges with expiry and single-use `used_at` marker |
| `verification_events` | Every challenge, verification attempt and ownership check, with result and reason |
| `access_events` | Every Telegram membership action, with previous → new state |
| `admin_audit_log` | Every administrative action, including refused ones |

Two indexes carry security weight:

- `idx_users_wallet_unique`: a partial unique index on `wallet_address`,
  enforcing one wallet per Telegram account.
- `verification_nonces.nonce` is `UNIQUE`, and burning it is a conditional
  `UPDATE ... WHERE used_at IS NULL`, so concurrent replays cannot both win.

The database never stores private keys, seed phrases, or signing secrets.
Signatures are verified in flight and discarded.

## Ownership checks

A single DAS query answers the only question that matters:

```json
{
  "method": "searchAssets",
  "params": {
    "ownerAddress": "<wallet>",
    "tokenType": "nonFungible",
    "grouping": ["collection", "<NFT_COLLECTION_ID>"],
    "page": 1,
    "limit": 1
  }
}
```

`limit: 1` makes this O(1) rather than pulling a wallet's entire inventory. The
returned items are re-filtered locally by `group_key`/`group_value`, so the gate
never depends solely on a remote filter being correct.

Checks run at initial verification, on `/status`, on the cron schedule, and
on-demand via `/adminrecheck`.

## Scheduled rechecks

The cron handler (`src/scheduled.ts`) makes three passes:

1. Users whose last check is older than `RECHECK_INTERVAL_HOURS`.
2. Grace-period users whose window has closed, so revocation lands on time even
   if their ownership check is not otherwise due.
3. Members who joined but never completed verification within
   `JOIN_VERIFICATION_HOURS`, tracked via the `joined_group` `access_events`
   entry the `chat_member` handler writes on every join. A single-use invite
   link limits a leak to one join, but does not bind that join to the
   Telegram account it was minted for; whoever actually used it still has to
   verify, or gets removed here. Migration mode protects legacy members from
   this pass exactly as it does from ordinary revocation.

Work is capped at `RECHECK_BATCH_SIZE` per invocation, ordered oldest-check-first
so nobody is starved. One failing row cannot abort the batch. Expired nonces are
purged at the end of each run.

## Authentication and authorization

**Verification** uses a signed, HMAC-SHA256 `verify` token: minted by the bot
for `/verify`, 15-minute lifetime, delivered in a URL fragment (never sent to a
server or written to `Referer`) and scrubbed from the address bar on load. This
token is the *only* source of the acting Telegram user id; the request body
never gets to assert identity.

**Administration** has no separate login at all. `/adminstats`,
`/adminusers`, `/adminrecheck`, `/adminrevoke` and `/adminrestore`
(`src/bot/bot.ts`) check the caller's Telegram id against `ADMIN_TELEGRAM_IDS`
on every invocation, and only respond in a private chat. A non-admin (or an
admin id used from a group) gets a generic `Unknown command.` reply, so
probing command names cannot distinguish "does not exist" from "exists but
you're not authorized". Removing an id from `ADMIN_TELEGRAM_IDS` and
redeploying revokes admin access immediately.

## Group configuration

`TELEGRAM_GROUP_ID` is an optional deploy-time default, not the source of
truth. `src/config-store.ts` holds two KV-backed values that take precedence:

- `config:telegram_group_id`: the confirmed gate target, set by an admin via
  `/setup confirm` or `/setup group <id>` in `src/bot/bot.ts`.
- `pending:group_detect`: a group the bot was just added to (detected via the
  `my_chat_member` webhook update), awaiting that confirmation. Expires after
  seven days if nobody acts on it.

`context.ts` resolves the effective group id on every request: KV value if
present, else `TELEGRAM_GROUP_ID`, else an empty string. This lets an operator
either pin a group at deploy time (useful for reproducible, config-as-code
deployments) or skip that entirely and configure it conversationally after the
Worker is already live: `/setup` can always override a pinned value later,
since KV wins.

An unconfigured group is not a startup error: `loadConfig` never requires it.
Telegram calls that need a real chat id (invites, removals, membership checks)
simply fail with an ordinary `TelegramOutcome` error until one is confirmed,
which the rest of the system already treats the same way it treats any other
Telegram API failure.

## Rate limiting

KV-backed fixed windows on `/verify` and `/status` commands, challenge issuance
and submission (per Telegram user), and challenge issuance per IP. KV is
eventually consistent, so this is abuse control, not a hard quota. Correctness
of the verification flow rests on the single-use nonce in D1, not on the limiter.
