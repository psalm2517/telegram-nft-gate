# Deployment

## Prerequisites

- Node.js ≥ 22.12 and pnpm
- A Cloudflare account (`pnpm exec wrangler login`)
- A Helius API key — <https://dashboard.helius.dev>
- A Telegram bot and group — see [`telegram-setup.md`](telegram-setup.md)

## 1. Create resources

```bash
pnpm exec wrangler d1 create telegram-nft-gate
```

```bash
pnpm exec wrangler kv namespace create KV
```

Copy the returned `database_id` and namespace `id` into `wrangler.jsonc`,
replacing the zero placeholders. Set `name` to whatever you want the Worker
called.

## 2. Validate your collection id

Do this **before** deploying. Gating on the wrong id is silent and confusing;
this check makes it loud:

```bash
NFT_COLLECTION_ID=<id> HELIUS_API_KEY=<key> pnpm run validate:collection <mintA> <mintB> <mintC>
```

Details in [`solana-verification.md`](solana-verification.md).

## 3. Set secrets

```bash
for s in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET NFT_COLLECTION_ID ADMIN_TELEGRAM_IDS SESSION_SECRET; do pnpm exec wrangler secret put "$s"; done
```

Two secrets are optional:

- `HELIUS_API_KEY` — without it, ownership checks fall back to the public
  Solana RPC (no key needed, no SLA). See
  [`solana-verification.md`](solana-verification.md#ownership-queries).
- `TELEGRAM_GROUP_ID` — without it, add the bot to your group after deploying
  and confirm it conversationally via `/setup`; see
  [`telegram-setup.md`](telegram-setup.md#5-choose-which-group-to-gate--by-messaging-the-bot).

Generate the two random secrets (`SESSION_SECRET`, `TELEGRAM_WEBHOOK_SECRET`) with:

```bash
openssl rand -base64 32
```

Non-secret behaviour (`MIGRATION_MODE`, `ACCESS_GRACE_PERIOD_HOURS`,
`CHALLENGE_TTL_SECONDS`, `RECHECK_BATCH_SIZE`, `RECHECK_INTERVAL_HOURS`,
`APP_NAME`) is also set in the dashboard's "Variables and secrets" screen,
alongside the secrets above — as plain `Text` values, not `Secret`. Every one
has a safe fallback if you leave it unset (see `src/env.ts`).

`wrangler.jsonc` deliberately does **not** declare a `vars` block. Cloudflare's
Git-integration deploys treat that file as authoritative for anything listed
there, so a checked-in default would silently overwrite whatever you configure
in the dashboard on every push
([cloudflare/workers-sdk#8871](https://github.com/cloudflare/workers-sdk/issues/8871)).

> Never commit secrets. `.dev.vars` and `.env` are gitignored; keep it that way.

## 4. Migrate and deploy

```bash
pnpm exec wrangler d1 migrations apply DB --remote
```

```bash
pnpm run deploy
```

`deploy` builds the React bundle into `web/dist` first, because the Worker uploads
that directory as its static assets. Deploying without building ships a stale (or
missing) frontend.

## 5. Register the webhook

Point Telegram at the deployed Worker — see
[`telegram-setup.md`](telegram-setup.md#5-register-the-webhook).

## 6. Verify the deployment

```bash
curl -s https://<your-worker>/api/health
```

```bash
curl -s https://<your-worker>/api/config
```

`/api/config` must show your collection id and **must not** contain your Helius
key. Then open `https://<your-worker>/` in a browser to confirm the Worker is
serving the React bundle, and run `/verify` end-to-end from Telegram.

---

## Local development

```bash
cp .env.example .dev.vars
```

```bash
pnpm run db:migrate:local && pnpm run build:web && pnpm run dev
```

That serves the built frontend and the API together on `localhost:8787`, exactly
as in production. For frontend work with hot reload, run `pnpm run dev:web`
alongside it — Vite proxies `/api` to the Worker on port 8787.

Telegram cannot reach `localhost`. To exercise the bot locally, expose the port
with a tunnel and point `setWebhook` at the public URL.

Trigger the cron handler without waiting for the schedule:

```bash
curl -s "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

---

## Cron configuration

```jsonc
"triggers": { "crons": ["0 * * * *"] }
```

The trigger fires the recheck pass; `RECHECK_INTERVAL_HOURS` decides who is
actually due. Running the trigger more often than the interval is fine and makes
grace-period expiries land promptly — each run only picks up users who are due,
capped at `RECHECK_BATCH_SIZE`.

Sizing: with hourly runs and a batch of 100, the system re-checks up to 2,400
users a day. For a larger group, raise `RECHECK_BATCH_SIZE` or add more cron
entries.

---

## Migration procedure

For a group that already has members before gating is switched on.

### Phase 1 — deploy with migration mode on

```
MIGRATION_MODE=true
```

Every member the bot observes is flagged `is_legacy_member`. Legacy members are
**never removed automatically**, no matter what their ownership check says. New
joiners are gated normally from day one.

This requires `chat_member` in the webhook's `allowed_updates`, otherwise the bot
never sees the members it is supposed to protect.

### Phase 2 — get people verified

Announce the change and ask members to DM the bot and run `/verify`. Watch
progress with `/adminstats` in your own chat with the bot — it reports how many
legacy members still need to verify.

Give this real time. A week is reasonable; a day is not.

### Phase 3 — switch enforcement on

When the legacy-unverified count is acceptably low:

1. Set `MIGRATION_MODE=false` in `wrangler.jsonc` and redeploy.
2. The next cron run treats legacy members like everyone else: unverified and
   non-holding members enter the grace period, get a warning DM, and are removed
   only after `ACCESS_GRACE_PERIOD_HOURS`.

Nobody is removed without a warning and a grace window, and re-verifying at any
point restores access.

### Rolling back

Set `MIGRATION_MODE=true` and redeploy. Protection resumes immediately for users
still flagged as legacy. Members already removed can rejoin by running `/verify`.

---

## Operations

**Watch the logs**

```bash
pnpm exec wrangler tail
```

Each cron run logs a summary: `checked`, `stillEligible`, `graceStarted`,
`restored`, `revoked`, `indeterminate`, `noncesPurged`, `errors`.

A rising `indeterminate` count means Helius trouble, not member churn. Nobody is
being revoked while it is elevated — that is by design — but it does mean
enforcement is paused, so it is worth alerting on.

**Rotate a secret**

```bash
pnpm exec wrangler secret put SESSION_SECRET
```

Rotating `SESSION_SECRET` immediately invalidates every outstanding verification
link and admin session. That is the fastest way to cut off a leaked link.

**Revoke an admin**

Remove the id from `ADMIN_TELEGRAM_IDS` and redeploy. The allow-list is checked
on every request, so access is cut immediately rather than at cookie expiry.

**Inspect the database**

```bash
pnpm exec wrangler d1 execute DB --remote --command "SELECT status, COUNT(*) FROM users GROUP BY status"
```
