# Telegram setup

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
start - Get started
verify - Connect a wallet and prove NFT ownership
status - Check your verification and access status
help - Show available commands
```

## 2. Required permissions

Add the bot to your private group **as an administrator**. It needs:

| Permission | Why |
| --- | --- |
| **Invite users via link** | Mint the single-use invite links issued to verified users |
| **Ban users** | Remove members after the grace period expires |

Everything else can be left off. In particular the bot does not need to delete
messages, pin messages, manage the chat, or post as the group.

Removal uses `banChatMember` immediately followed by `unbanChatMember`, which is
Telegram's documented way to kick without a permanent ban — so a user who
regains eligibility can rejoin with a fresh invite link.

> The bot cannot remove another administrator. Promote members to admin
> sparingly, and be aware that admins are effectively exempt from enforcement.

## 3. Group id and webhook — the easy way

Once the Worker is deployed, this does the rest of the Telegram-side setup for
you: finds `TELEGRAM_GROUP_ID` automatically, generates a webhook secret if you
don't already have one, registers the webhook with the right `allowed_updates`,
and confirms Telegram accepted it.

```bash
TELEGRAM_BOT_TOKEN=<your-bot-token> pnpm run setup:telegram https://<your-worker>.workers.dev
```

It walks you through adding the bot to your group and sending a message, then
polls for it — nothing to copy-paste between commands. At the end it prints
`TELEGRAM_GROUP_ID` and `TELEGRAM_WEBHOOK_SECRET` for you to paste into the
Cloudflare dashboard (or `.dev.vars` locally).

It only talks to the Telegram Bot API, so it needs nothing from your Cloudflare
account.

## 4. Find admin Telegram user ids

Each admin messages [@userinfobot](https://t.me/userinfobot), or check the `from.id`
field in `getUpdates` (see below). Put them comma-separated into
`ADMIN_TELEGRAM_IDS`.

These are *numeric ids*, not usernames. Usernames can be changed and reassigned;
ids cannot.

## Doing it by hand

If you'd rather not run a script, or want to see exactly what it's doing, here
is the manual version of step 3.

**Find the group id.** Add the bot to the group, send any message there, then:

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" | jq '.result[].message.chat'
```

Supergroup ids are negative and begin with `-100`, e.g. `-1001234567890`. That is
`TELEGRAM_GROUP_ID`. If this returns nothing, a webhook is already registered —
delete it first with `deleteWebhook`, read the id, then set the webhook again.

**Register the webhook.** After deploying the Worker:

```bash
curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d '{
        "url": "https://<your-worker>/telegram/webhook",
        "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
        "allowed_updates": ["message", "chat_member"],
        "drop_pending_updates": true
      }'
```

Two details are load-bearing:

- **`secret_token`** must match your `TELEGRAM_WEBHOOK_SECRET`. Telegram does not
  sign webhook requests, so this shared header is the only thing distinguishing
  real updates from anyone who guesses the URL. The Worker rejects mismatches
  with a 403.
- **`chat_member`** must be in `allowed_updates`. It is not delivered by default,
  and without it the bot cannot see joins and leaves — which migration mode
  depends on to flag pre-existing members.

Verify:

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo" | jq
```

`pending_update_count` should stay near zero and `last_error_message` should be
absent.

## 6. Confirm it works

In a direct chat with the bot:

| Command | Expected |
| --- | --- |
| `/start` | Welcome message; a `users` row is created |
| `/help` | Command list, plus the "never asks for your seed phrase" notice |
| `/verify` | A button linking to your Worker's `/verify` page |
| `/status` | Prompt to verify, or a live ownership check if a wallet is linked |

Admins additionally see a note on `/status` pointing them to `/adminhelp`.

## Admin commands

Once an admin's numeric Telegram id is in `ADMIN_TELEGRAM_IDS`, they get five
extra commands in their private chat with the bot:

| Command | Does |
| --- | --- |
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
  message me directly to verify" and does nothing else.
- The bot never requests seed phrases, private keys, or transactions, and the
  `/help` text says so explicitly — worth keeping, since it sets the expectation
  that any message asking for those is an impersonator.
- Invite links are single-use (`member_limit: 1`) and expire after an hour, so a
  leaked link is worth at most one join.
