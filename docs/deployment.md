# Deployment

The whole path is: create two Cloudflare resources, put their ids in
`wrangler.jsonc`, set six secrets, migrate, deploy, point Telegram at it. No CI
setup, no GitHub secrets, no dashboard build configuration: those are optional
extras covered at the end, and most deployments never need them.

## Prerequisites

- Node.js ≥ 22.12 and pnpm
- A Cloudflare account (`pnpm exec wrangler login`)
- A Telegram bot and group: see [`telegram-setup.md`](telegram-setup.md)
- A Helius API key: <https://dashboard.helius.dev>

## 1. Create resources

```bash
pnpm exec wrangler d1 create telegram-nft-gate
```

```bash
pnpm exec wrangler kv namespace create KV
```

Each command prints an id. Put them in `wrangler.jsonc`, replacing the zero
placeholders: `database_id` from the first, the KV `id` from the second. Set
`name` too if you want the Worker called something other than
`telegram-nft-gate`.

That is all most deployments ever need to do with this file. Commit it to your
own fork like any other config.

<details>
<summary>Keeping your resource ids out of git</summary>

Only relevant if your fork is also a public template others copy from, as the
upstream repo is: committing your ids there hands every downstream fork a config
pointing at resources they cannot access.

Resource ids are not secrets: they are useless without your account
credentials: so this is about not confusing forks, not about exposure.

If you want them out of the committed file, copy it instead of editing it:

```bash
cp wrangler.jsonc wrangler.local.jsonc
```

Put the real ids in `wrangler.local.jsonc`, which is gitignored. Every
`pnpm run` script prefers it automatically when it exists, so nothing else
changes. `wrangler.jsonc` keeps its placeholders.

</details>

> Wrangler has no way to read `database_id`/KV `id` from the dashboard or from
> environment variables the way it reads vars and secrets: `wrangler deploy`
> treats its config file as the authoritative definition of the Worker,
> bindings included, on every deploy. They have to be in a file on disk at
> deploy time. `scripts/wrangler.mjs` picks which file: see
> [Deploying](#deploying) below.

## 2. Validate your collection id

Do this **before** deploying. Gating on the wrong id is silent and confusing;
this check makes it loud:

```bash
NFT_COLLECTION_ID=<id> HELIUS_API_KEY=<key> pnpm run validate:collection <mintA> <mintB> <mintC>
```

Details in [`solana-verification.md`](solana-verification.md).

## 3. Set secrets

```bash
for s in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET NFT_COLLECTION_ID HELIUS_API_KEY ADMIN_TELEGRAM_IDS SESSION_SECRET; do pnpm exec wrangler secret put "$s"; done
```

`HELIUS_API_KEY` is required unless you set `DAS_ENDPOINT` to a different
DAS-compatible provider instead. See
[`solana-verification.md`](solana-verification.md#ownership-queries).

`TELEGRAM_GROUP_ID` is optional: without it, add the bot to your group after
deploying and confirm it conversationally via `/setup`; see
[`telegram-setup.md`](telegram-setup.md#5-choose-which-group-to-gate-by-messaging-the-bot).

Generate the two random secrets (`SESSION_SECRET`, `TELEGRAM_WEBHOOK_SECRET`) with:

```bash
openssl rand -base64 32
```

Non-secret behaviour (`MIGRATION_MODE`, `ACCESS_GRACE_PERIOD_HOURS`,
`CHALLENGE_TTL_SECONDS`, `RECHECK_BATCH_SIZE`, `RECHECK_INTERVAL_HOURS`,
`APP_NAME`) is also set in the dashboard's "Variables and secrets" screen,
alongside the secrets above: as plain `Text` values, not `Secret`. Every one
has a safe fallback if you leave it unset (see `src/env.ts`).

`wrangler.jsonc` deliberately does **not** declare a `vars` block, and sets
`"keep_vars": true`. Both matter: Wrangler's actual default is to treat the
config file as authoritative for the Worker's *entire* var set on every
deploy: anything set in the dashboard but not declared in the file gets
silently **deleted**, not merely left alone. `keep_vars: true` is what turns
that off, so dashboard-configured values survive every future deploy. Without
it, an empty (or absent) `vars` block would wipe every var on the next
`wrangler deploy`: which is exactly what happened once during this project's
own setup, breaking the Worker until it was caught and fixed.

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

Point Telegram at the deployed Worker: see
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

## Deploying

```bash
pnpm run deploy
```

That builds the React bundle into `web/dist` and deploys. Run it whenever you
want to ship; nothing else is required, and this is how most deployments should
operate indefinitely.

Every wrangler-invoking script goes through `scripts/wrangler.mjs`, which picks
the config file so the same command works in all three situations:

| If | It uses |
| --- | --- |
| `wrangler.local.jsonc` exists | that file |
| `CF_D1_DATABASE_ID` + `CF_KV_NAMESPACE_ID` are set | `wrangler.jsonc` with those ids substituted in |
| neither | `wrangler.jsonc` as-is |

If none of those yields real ids, it stops with an explanation rather than
letting the deploy fail deep inside the Cloudflare API with
`KV namespace '000…0' not found`.

### Optional: deploy automatically on push

Not required. Manual `pnpm run deploy` is a complete, supported workflow.

Pick **one** of the two options below. Running both means two `wrangler deploy`
runs racing each other on every push.

<details>
<summary>Option A: Cloudflare Workers Builds (dashboard)</summary>

Connect the repo under **Workers &amp; Pages → your Worker → Settings → Build**.

Cloudflare's build runner has no `wrangler.local.jsonc`, so give it the ids as
**build** environment variables. These live under **Settings → Build**, which is
a different screen from the Worker's own **Variables and Secrets**: putting them
in the latter does nothing, because the build never sees runtime bindings.

| Build variable | Value |
| --- | --- |
| `D1_DATABASE_ID` | your `database_id` |
| `KV_NAMESPACE_ID` | your KV namespace id |

Then set:

- **Build command**: `pnpm install --frozen-lockfile && pnpm run build:web`
- **Deploy command**: `node scripts/wrangler.mjs deploy`

The deploy command reads those two build variables and substitutes them itself.

</details>

<details>
<summary>Option B: GitHub Actions</summary>

Keeps deploy config in the repo rather than a dashboard. Add four repository
secrets (**Settings → Secrets and variables → Actions**):

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | an API token from the **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | your account id |
| `CF_D1_DATABASE_ID` | your `database_id` |
| `CF_KV_NAMESPACE_ID` | your KV namespace id |

Then append this job to [`.github/workflows/ci.yml`](../.github/workflows/ci.yml):

```yaml
  deploy:
    needs: check
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build:web
      - uses: cloudflare/wrangler-action@v3
        env:
          CF_D1_DATABASE_ID: ${{ secrets.CF_D1_DATABASE_ID }}
          CF_KV_NAMESPACE_ID: ${{ secrets.CF_KV_NAMESPACE_ID }}
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy
```

If you use this, disconnect the Git integration in Option A so the two do not
both deploy.

</details>

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
alongside it: Vite proxies `/api` to the Worker on port 8787.

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
grace-period expiries land promptly: each run only picks up users who are due,
capped at `RECHECK_BATCH_SIZE`.

Sizing: with hourly runs and a batch of 100, the system re-checks up to 2,400
users a day. For a larger group, raise `RECHECK_BATCH_SIZE` or add more cron
entries.

---

## Migration procedure

For a group that already has members before gating is switched on.

### Phase 1: deploy with migration mode on

```
MIGRATION_MODE=true
```

Every member the bot observes is flagged `is_legacy_member`. Legacy members are
**never removed automatically**, no matter what their ownership check says. New
joiners are gated normally from day one.

This requires `chat_member` in the webhook's `allowed_updates`, otherwise the bot
never sees the members it is supposed to protect.

### Phase 2: get people verified

Announce the change and ask members to DM the bot and run `/verify`. Watch
progress with `/adminstats` in your own chat with the bot: it reports how many
legacy members still need to verify.

Give this real time. A week is reasonable; a day is not.

### Phase 3: switch enforcement on

When the legacy-unverified count is acceptably low:

1. Set `MIGRATION_MODE=false` in the dashboard's "Variables and secrets"
   screen (or `.dev.vars` for local dev) and redeploy.
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
being revoked while it is elevated (that is by design), but it does mean
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
