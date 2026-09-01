# telegram-nft-gate — Claude Code Instructions

## 1. Project

Build `telegram-nft-gate`, an open-source, reusable system for verifying Solana NFT ownership and controlling access to private Telegram communities.

The initial private deployment is for the SBF Cabal and uses Solana Business Frogs (SBF) as the qualifying NFT collection.

### Open-Source Architecture

* `telegram-nft-gate` is the reusable public open-source software.
* SBF Cabal is one private deployment of that software.
* SBF-specific values must be configuration, not hard-coded application logic.
* The application must be designed so another community can deploy it with a different NFT collection.
* The repository may be developed privately and released publicly.
* Do not expose private deployment credentials, infrastructure, or operational data.

---

## 2. V1 Scope

V1 has one purpose:

> A Telegram user proves control of a Solana wallet that currently owns at least one NFT from a configured collection, and the system grants or removes access to a private Telegram group accordingly.

V1 includes:

* Telegram bot
* Wallet connection
* Cryptographic wallet verification
* Solana NFT ownership verification
* Telegram membership/access control
* Scheduled ownership rechecks
* Grace periods
* Reverification
* Migration mode
* Minimal admin dashboard
* Audit logging
* Tests
* Deployment documentation

V1 explicitly does **NOT** include:

* Trading
* Alpha calls
* Trade execution
* Pooled funds
* Custody
* Payments
* Subscriptions
* Revenue sharing
* Profit distributions
* Buybacks
* NFT sweeps
* Jackpots
* Portfolio tracking
* Trading analytics
* Token launches

Do not implement or begin designing these features.

---

## 3. Technology Stack

Use this stack for V1:

* TypeScript
* Cloudflare Workers
* grammY
* Cloudflare D1
* Cloudflare KV
* Cloudflare Cron Triggers
* Helius DAS API
* React
* Vite
* Solana Wallet Standard
* Zod
* Vitest
* pnpm
* Wrangler

The React/Vite frontend must be served as static assets by the same Cloudflare Worker that provides the backend.

Do **not** use Cloudflare Pages for V1.

Do not introduce Rust, Go, Ruby, or another backend language.

Do not create a custom Solana program.

V1 does not require on-chain program development.

---

## 4. Architecture

Use clear separation between services while deploying the frontend and backend through one Cloudflare Worker.

### Core architecture

```text
Telegram
    ↓
Cloudflare Worker
    ├── grammY Telegram webhook
    ├── Verification API
    ├── Admin API
    ├── React/Vite frontend
    ├── D1
    ├── KV
    ├── Cron Triggers
    └── Helius DAS API
```

### Telegram

```text
Telegram
→ grammY
→ Cloudflare Worker
→ application services
→ D1
```

### Solana ownership

```text
Application
→ Helius DAS API
→ ownership result
```

### Web verification

```text
React/Vite frontend
served by Cloudflare Worker
→ Worker API routes
→ wallet signature
→ verification service
→ Helius
→ D1
→ Telegram access control
```

The Worker must serve both:

* The compiled React/Vite frontend
* Backend API routes
* Telegram webhook routes
* Admin API routes

Use a same-origin architecture wherever practical.

The frontend should call the Worker API without requiring a separate frontend hosting service or cross-origin configuration.

Keep these responsibilities separated:

* Telegram service
* Wallet verification service
* NFT ownership service
* Access-control service
* Database service
* Admin service
* Static asset serving

The backend is authoritative.

Never trust ownership or verification state supplied by the frontend.

---

## 5. SBF Collection Verification — REQUIRED BEFORE IMPLEMENTATION

Before implementing the ownership checker, independently determine the **canonical on-chain certified collection ID for Solana Business Frogs**.

Do not guess.

Do not use:

* Marketplace slugs
* Collection names
* Collection symbols
* Creator addresses
* Candy Machine addresses
* Marketplace addresses
* An individual NFT mint address
* Any unverified address

# Verification Procedure

1. The operator provides the verified on-chain NFT collection ID through:

```env
NFT_COLLECTION_ID=<collection ID>
```

2. During initial setup, use the Helius DAS API to independently validate the configured collection ID.

3. Inspect multiple known NFT mint addresses from the configured collection using Helius DAS `getAsset`.

4. Confirm that the returned on-chain `grouping` / collection metadata references the configured `NFT_COLLECTION_ID`.

5. Confirm the collection metadata corresponds to the intended NFT collection.

6. If the configured collection ID cannot be independently validated, **fail setup and report the discrepancy**. Do not automatically substitute, infer, or discover a different collection ID.

7. Once validated, `NFT_COLLECTION_ID` becomes the authoritative collection identifier used by all runtime ownership checks.

8. The application must never dynamically discover or change the collection ID at runtime.

9. For each wallet verification:

   * Generate a cryptographically secure, short-lived, single-use challenge bound to the Telegram user and wallet.
   * Verify the wallet signature on the backend.
   * Query Helius DAS using the configured `NFT_COLLECTION_ID`.
   * Confirm the wallet currently owns at least one NFT belonging to that collection.
   * Grant Telegram access only if both signature verification and NFT ownership verification succeed.

10. A Helius timeout, API error, rate limit, or malformed response must be treated as an **indeterminate verification failure**, never as proof that the wallet does not own an NFT.

11. Subsequent ownership checks use the same configured `NFT_COLLECTION_ID`. If ownership is lost, apply the configured grace-period and revocation process.

12. Never request, receive, or store seed phrases, private keys, recovery phrases, or signing secrets.


## 6. Generic Collection Architecture

Although the initial deployment uses SBF, the application must be collection-agnostic.

The ownership service should conceptually support:

```text
configured collection
        ↓
ownership query
        ↓
wallet owns ≥1 qualifying NFT?
        ↓
true / false
```

SBF is simply the initial configuration.

Do not create SBF-specific branches throughout the codebase.

---

## 7. Helius DAS

Use Helius DAS as the Solana NFT ownership data source.

The ownership check must answer:

> Does wallet X currently own at least one NFT belonging to the configured collection?

Prefer collection-based DAS queries where appropriate rather than unnecessarily retrieving an entire wallet's asset inventory.

The implementation must correctly handle:

* Zero qualifying NFTs
* One qualifying NFT
* Multiple qualifying NFTs
* Wrong collection
* API errors
* Timeouts
* Rate limits
* Malformed responses
* Unexpected API responses

Never expose:

`HELIUS_API_KEY`

to the frontend.

A temporary Helius/API failure must **not** automatically be interpreted as proof that the user sold their NFT.

---

## 8. Wallet Verification

Users must prove control of the wallet through a non-transactional cryptographic signature.

Never request:

* Seed phrases
* Private keys
* Secret recovery phrases
* SOL transfers
* NFT transfers
* Any unnecessary blockchain transaction

The verification challenge must bind together:

* Application identity
* Telegram user ID
* Wallet address
* Cryptographically random nonce
* Creation timestamp
* Expiration timestamp

Requirements:

* Cryptographically secure nonce generation
* Short expiration
* Single-use nonce
* Replay protection
* Telegram-user binding
* Wallet binding
* Backend signature verification
* Ownership check after successful signature verification

Never store private keys or seed phrases.

---

## 9. Telegram Bot

Implement:

* `/start`
* `/verify`
* `/status`
* `/help`

Verification flow:

1. User starts a private chat with the bot.
2. User selects `/verify`.
3. Bot provides a secure link to the verification web app.
4. User connects a Solana wallet.
5. Backend creates a challenge.
6. User signs the challenge.
7. Backend verifies the signature.
8. Backend checks current NFT ownership through Helius.
9. If eligible, store the verified wallet.
10. Grant Telegram access.
11. Inform the user of the result.

The bot must never request private keys or seed phrases.

---

## 10. Telegram Access Control

The bot must be capable of managing the private Telegram group.

Requirements:

* Configurable Telegram group ID
* Grant access to eligible users
* Appropriate invite mechanism
* Remove/restrict ineligible users
* Handle users leaving and returning
* Handle Telegram API failures
* Prevent unauthorized access where technically possible

Document all Telegram permissions required by the bot.

The bot must have the administrative permissions necessary to manage membership.

---

## 11. Ownership Rechecks

Check ownership:

1. During initial verification
2. When `/status` is requested
3. During scheduled background checks

Use Cloudflare Cron Triggers for scheduled checks.

The interval must be configurable.

If a user no longer owns a qualifying NFT:

1. Mark them ineligible.
2. Start the grace period.
3. Notify the user.
4. Allow reverification.
5. Remove/restrict access after the grace period.

Default:

`ACCESS_GRACE_PERIOD_HOURS=24`

If ownership returns during the grace period, restore eligibility.

Do not revoke users solely because Helius temporarily fails.

---

## 12. Database

Use Cloudflare D1.

Create migrations for:

### users

Include:

* id
* telegram_user_id
* telegram_username
* wallet_address
* status
* verified_at
* last_ownership_check_at
* grace_period_started_at
* revoked_at
* created_at
* updated_at

### verification_nonces

Include:

* id
* telegram_user_id
* wallet_address
* nonce
* challenge
* expires_at
* used_at
* created_at

### verification_events

Record:

* user
* wallet
* event type
* result
* timestamp
* error/reason where applicable

### access_events

Record:

* user
* Telegram action
* previous state
* new state
* timestamp
* reason

### admin_audit_log

Record administrative actions.

Never store private keys or seed phrases.

---

## 13. Admin Dashboard

Build a minimal React admin dashboard.

Display:

* Total users
* Verified users
* Eligible users
* Ineligible users
* Grace-period users
* Revoked users
* Verification timestamps
* Wallet addresses
* Telegram usernames

Provide:

* Search
* Manual ownership check
* Revoke
* Restore after successful verification
* Verification history
* Access history

All administrative actions must be audited.

Do not create an ordinary ownership bypass mechanism.

Admin authentication must be secure.

Use:

`ADMIN_TELEGRAM_IDS`

for the initial admin authorization model.

---

## 14. Migration Mode

The existing SBF Cabal Telegram group has existing members.

Support:

`MIGRATION_MODE=true`

When enabled:

* Existing members must not automatically be removed.
* Existing members can verify normally.
* New members still require verification.
* The admin dashboard must show migration progress.

Once migration is complete:

`MIGRATION_MODE=false`

Normal enforcement becomes active.

Document the migration procedure.

---

## 15. Configuration

Use environment variables/secrets.

Required configuration:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_GROUP_ID
SBF_COLLECTION_ID
HELIUS_API_KEY
ADMIN_TELEGRAM_IDS
ACCESS_GRACE_PERIOD_HOURS=24
MIGRATION_MODE=true
```

Production secrets must use Cloudflare's secret-management mechanism.

Never commit secrets.

Provide:

`.env.example`

with safe placeholder values.

---

## 16. Security

Implement:

* Strict TypeScript
* Zod validation
* Secure random nonces
* Nonce expiration
* Single-use nonces
* Replay protection
* Telegram identity binding
* Wallet binding
* Rate limiting
* Input validation
* Secure admin authorization
* Audit logging
* Secure secret handling
* Backend-authoritative ownership verification

Protect against:

* Replay attacks
* Wallet substitution
* Challenge substitution
* Unauthorized admin access
* Frontend tampering
* Rate abuse

---

## 17. Testing

Use Vitest.

Test at minimum:

### Verification

* Valid signature
* Invalid signature
* Expired nonce
* Reused nonce
* Wrong Telegram user
* Wrong wallet
* Wallet substitution

### Ownership

* SBF holder
* Non-holder
* Multiple SBF NFTs
* Wrong collection
* Helius API error
* Helius timeout
* Helius rate limit
* Malformed response

### Access

* Grant access
* Grace period
* Revocation
* Reverification
* Regain eligibility
* Migration mode
* Normal enforcement

### Security

* Replay attempt
* Wallet substitution
* Unauthorized admin action
* Rate limiting

---

## 18. Documentation

Create:

```text
README.md
docs/architecture.md
docs/telegram-setup.md
docs/solana-verification.md
docs/deployment.md
```

Document:

* Architecture
* Installation
* Local development
* Environment variables
* Telegram setup
* Required Telegram permissions
* Helius setup
* Verified SBF collection ID
* Wallet verification flow
* Database migrations
* Cloudflare Worker deployment
* Worker static asset configuration
* Cron configuration
* Migration procedure
* How to configure another NFT collection

The README should make sense to someone who has never heard of SBF Cabal.

---

## 19. Open-Source Requirements

The repository is intended for public open-source release.

Keep the software reusable and collection-agnostic.

Do not commit:

* API keys
* Telegram bot tokens
* Production database information
* Admin IDs
* Private group IDs
* Private operational data
* Secrets

The SBF Cabal deployment is configuration, not proprietary application logic.

Do not assume the project is developed publicly merely because the repository will be public.

---

## 20. Development Process

Before significant implementation:

1. Read this entire file.
2. Inspect the repository.
3. Research current official documentation.
4. Verify Helius DAS behavior.
5. Resolve and verify the canonical SBF collection ID.
6. Verify Solana Wallet Standard behavior.
7. Check Cloudflare Workers compatibility.
8. Confirm React/Vite can be served by the Worker as static assets.
9. Produce a concise implementation plan.
10. Implement V1.

Do not rely on outdated API examples.

Keep V1 simple and production-oriented.

Do not over-engineer.

---

## 21. Definition of Done

V1 is complete when:

* Telegram `/start` works.
* Telegram `/verify` works.
* Wallet connection works.
* Wallet signature verification works.
* Replay protection works.
* The SBF collection ID has been independently verified.
* Helius ownership verification works.
* Eligible users receive Telegram access.
* Non-eligible users cannot complete verification.
* `/status` works.
* Scheduled ownership checks work.
* Grace periods work.
* Revocation works.
* Reverification works.
* Migration mode works.
* Admin dashboard works.
* Admin authorization works.
* Audit logging works.
* React/Vite frontend is served by the Worker.
* Tests pass.
* Type checking passes.
* Linting passes.
* Frontend builds.
* Worker builds.
* Database migrations work.
* Documentation is complete.

After V1 is complete:

**STOP.**

Do not implement V2 functionality.
