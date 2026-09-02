# Telegram setup

Two groups are involved:

- **Gate group** — public, anyone can join. The bot posts a "Verify" button
  when someone joins. Not access-controlled; it's a lobby.
- **Main group** — private and invite-only. Nobody can join without a
  bot-issued single-use link, which only exists after verification succeeds.

If you only want one group, see [the note at the end](#running-with-only-one-group).

## 1. Create the bot

Message [@BotFather](https://t.me/BotFather):

```
/newbot
```

Save the token — it goes into `TELEGRAM_BOT_TOKEN`. Treat it like a password;
anyone holding it controls the bot.

Then disable group privacy mode, so the bot receives the membership updates it
needs:

```
/setprivacy  →  select your bot  →  Disable
```

Optionally register the command list so they autocomplete:

```
/setcommands
```

```
start - Get started and verify
verify - Connect a wallet and prove NFT ownership
status - Check your verification and access status
help - Show available commands
```

## 2. Create both groups and add the bot

**Gate group** — create it, make it discoverable however you like (public
username, a link in your bio, wherever). Add the bot as an ordinary member;
it only needs to *send messages* there, not administer it.

**Main group** — this is the one being protected. Add the bot **as an
administrator** with:

| Permission | Why |
| --- | --- |
| **Invite users via link** | Mint the single-use invite links issued to verified users |
| **Ban users** | Remove members after the grace period expires |

Everything else can be left off in both groups. In particular the bot does not
need to delete messages, pin messages, manage the chat, or post as the group.

Removal from the main group uses `banChatMember` immediately followed by
`unbanChatMember`, which is Telegram's documented way to kick without a
permanent ban — so a user who regains eligibility can rejoin with a fresh
invite link.

> The bot cannot remove another administrator. Promote members to admin
> sparingly in the main group, and be aware that admins are effectively exempt
> from enforcement there.

## 3. Register the webhook

This is the one step that can't be conversational: the bot has no way to talk
to you until Telegram knows where to send updates. Once the Worker is
deployed:

```bash
TELEGRAM_BOT_TOKEN=<your-bot-token> pnpm run setup:telegram https://<your-worker>.workers.dev
```

This generates a webhook secret if you don't already have one, registers the
webhook with the right `allowed_updates`, and confirms Telegram accepted it. It
only talks to the Telegram Bot API — it needs nothing from your Cloudflare
account. Set the printed `TELEGRAM_WEBHOOK_SECRET` in the dashboard (or
`.dev.vars` locally) if it generated one for you.

<details>
<summary>Doing it by hand instead</summary>

```bash
curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d '{
        "url": "https://<your-worker>/telegram/webhook",
        "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
        "allowed_updates": ["message", "chat_member", "my_chat_member"],
        "drop_pending_updates": true
      }'
```

Three details are load-bearing:

- **`secret_token`** must match your `TELEGRAM_WEBHOOK_SECRET`. Telegram does not
  sign webhook requests, so this shared header is the only thing distinguishing
  real updates from anyone who guesses the URL. The Worker rejects mismatches
  with a 403.
- **`chat_member`** must be in `allowed_updates`, or the bot cannot see members
  joining/leaving either group — needed for migration mode (main) and the
  verify-button greeting (gate).
- **`my_chat_member`** must be in `allowed_updates`, or the bot cannot tell when
  *it itself* has been added to a group — which `/setup` (next section) depends
  on entirely.

Verify:

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo" | jq
```

`pending_update_count` should stay near zero and `last_error_message` should be
absent.
</details>

## 4. Find admin Telegram user ids

Each admin messages [@userinfobot](https://t.me/userinfobot), or checks the
`from.id` field on any update. Put them comma-separated into
`ADMIN_TELEGRAM_IDS` *before* step 5 — the bot only DMs ids already on that
list.

These are *numeric ids*, not usernames. Usernames can be changed and reassigned;
ids cannot.

## 5. Assign the two groups — by messaging the bot

Neither `TELEGRAM_GROUP_ID` (main) nor `GATE_GROUP_ID` (gate) needs to be set
before any of this:

1. Message the bot `/start` in a private chat, to confirm the webhook works.
2. Add the bot to a group (see step 2 above).
3. The bot notices — it detects the `my_chat_member` update Telegram sends when
   it's added anywhere — and DMs every id in `ADMIN_TELEGRAM_IDS`:
   > I was just added to "Your Group" (-1001234567890). Is this your MAIN
   > group or your GATE group?
   > Reply /setup main confirm or /setup gate confirm.
4. Reply with whichever it is.
5. Repeat for the second group.

`/setup` on its own shows the status of both groups, migration mode, and grace
period. `/setup main group <id>` or `/setup gate group <id>` pins one directly
by id instead, if you already know it and would rather skip the DM — the bot
validates it can actually see that chat before accepting it.

A group assigned this way always takes precedence over the matching env var, so
`/setup` can also re-point either group on an existing deployment later.

## 6. Confirm it works

In a direct chat with the bot:

| Command | Expected |
| --- | --- |
| `/start` | Welcome message with an inline **Verify wallet** button |
| `/help` | Command list, plus the "never asks for your seed phrase" notice |
| `/status` | Prompt to verify, or a live ownership check if a wallet is linked |

Then in the gate group, join with a second (test) account — the bot should
post a welcome message with a **Verify** button that opens a DM with the bot
and immediately shows the same wallet-connect button as `/start`.

Admins additionally see a note on `/status` pointing them to `/adminhelp`.

## Admin commands

Once an admin's numeric Telegram id is in `ADMIN_TELEGRAM_IDS`, they get these
extra commands in their private chat with the bot:

| Command | Does |
| --- | --- |
| `/setup` | Check or configure the gate and main groups (see step 5 above) |
| `/adminhelp` | Lists these commands |
| `/adminstats` | Membership counts and migration progress |
| `/adminusers <query>` | Search by Telegram id, username, or wallet substring |
| `/adminrecheck <telegram_id>` | Run a live ownership check on one user |
| `/adminrevoke <telegram_id> [reason]` | Remove a user's access |
| `/adminrestore <telegram_id>` | Restore access, but only if the linked wallet currently holds a qualifying NFT |

These are deliberately **not** added via `/setcommands` — they don't need to be
discoverable, and a non-admin (or an admin typing them from a group chat) gets
a generic `Unknown command.` reply rather than one that reveals the command
exists. Every admin action is written to `admin_audit_log`, including refused
restores.

## Bot behaviour notes

- Commands only work in **private chats**. In a group the bot replies "Please
  message me directly to verify" and does nothing else — except in the gate
  group, where it posts the welcome/verify message for new joiners.
- The bot never requests seed phrases, private keys, or transactions, and the
  `/help` text says so explicitly — worth keeping, since it sets the expectation
  that any message asking for those is an impersonator.
- Invite links to the main group are single-use (`member_limit: 1`) and expire
  after an hour, so a leaked link is worth at most one join.
- The bot can message someone who has never started a chat with it *only*
  because they tap a `t.me/<bot>?start=verify` deep link themselves — that's
  why the gate group's button works, and why the bot can't proactively DM a
  new joiner directly.

## Running with only one group

If you don't want a public lobby, skip the gate group entirely: never assign a
`gate` role via `/setup`, and just tell members to DM the bot `/start`
directly (e.g. from an announcement elsewhere). Everything else — the main
group, invites, grace periods, admin commands — works exactly the same either
way, since the gate group is not part of the access-control model at all.
