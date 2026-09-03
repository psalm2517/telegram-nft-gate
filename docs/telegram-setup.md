# Telegram setup

## 1. Create the bot

Message [@BotFather](https://t.me/BotFather):

```
/newbot
```

Save the token: it goes into `TELEGRAM_BOT_TOKEN`. Treat it like a password;
anyone holding it controls the bot.

Leave Group Privacy at its default (enabled). It only restricts a bot's view
of ordinary member messages, not `chat_member`/`my_chat_member`/service
updates: those reach any bot that's a group admin regardless, and this bot
is always added as one (see [§2](#2-required-permissions)). Disabling privacy
mode would just start delivering ordinary group chatter to the bot for no
benefit, and requires removing and re-adding the bot to the group to take
effect.

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
Telegram's documented way to kick without a permanent ban: so a user who
regains eligibility can rejoin with a fresh invite link.

> The bot cannot remove another administrator. Promote members to admin
> sparingly, and be aware that admins are effectively exempt from enforcement.

## 3. Register the webhook

This is the one step that can't be conversational: the bot has no way to talk
to you until Telegram knows where to send updates. Once the Worker is
deployed:

```bash
TELEGRAM_BOT_TOKEN=<your-bot-token> pnpm run setup:telegram https://<your-worker>.workers.dev
```

This generates a webhook secret if you don't already have one, registers the
webhook with the right `allowed_updates`, and confirms Telegram accepted it. It
only talks to the Telegram Bot API: it needs nothing from your Cloudflare
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
- **`chat_member`** must be in `allowed_updates`, or the bot cannot see other
  members joining/leaving: which migration mode depends on.
- **`my_chat_member`** must be in `allowed_updates`, or the bot cannot tell when
  *it itself* has been added to a group: which `/setup` (next section) depends
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
`ADMIN_TELEGRAM_IDS` *before* step 5: the bot only DMs ids already on that
list.

These are *numeric ids*, not usernames. Usernames can be changed and reassigned;
ids cannot.

## 5. Choose which group to gate, by messaging the bot

`TELEGRAM_GROUP_ID` does not need to be set before any of this. Instead:

1. Message the bot `/start` in a private chat, to confirm the webhook works.
2. Add the bot to your group (see permissions above) and promote it to admin.
3. The bot notices: it detects the `my_chat_member` update Telegram sends when
   it's added anywhere: and DMs every id in `ADMIN_TELEGRAM_IDS`:
   > I was just added to "Your Group" (-1001234567890).
   > Reply here with /setup confirm to make this the gated group.
4. Reply `/setup confirm`. That's it: no id to copy from anywhere.

`/setup` on its own shows current status (configured group, migration mode,
grace period, anything still pending confirmation). `/setup group <id>` pins a
group directly by id instead, if you already know it and would rather skip the
DM: the bot validates it can actually see that chat before accepting it.

A group confirmed this way always takes precedence over a `TELEGRAM_GROUP_ID`
env var, so `/setup` can also be used to re-point an existing deployment at a
different group later.

Once a group is confirmed, adding the bot to any other group does not open a
second confirmation flow. It leaves that group immediately and only sends
admins an informational DM, so being added somewhere unexpected can't be used
to trick an admin into repointing the gate.

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

Once an admin's numeric Telegram id is in `ADMIN_TELEGRAM_IDS`, they get these
extra commands in their private chat with the bot:

| Command | Does |
| --- | --- |
| `/setup` | Check or configure which group is gated (see step 5 above) |
| `/adminhelp` | Lists these commands |
| `/adminstats` | Membership counts and migration progress |
| `/adminusers <query>` | Search by Telegram id, username, or wallet substring |
| `/adminrecheck <telegram_id>` | Run a live ownership check on one user |
| `/adminrevoke <telegram_id> [reason]` | Remove a user's access |
| `/adminrestore <telegram_id>` | Restore access, but only if the linked wallet currently holds a qualifying NFT |

These are deliberately **not** added via `/setcommands`: they don't need to be
discoverable, and a non-admin (or an admin typing them from a group chat) gets
a generic `Unknown command.` reply rather than one that reveals the command
exists. Every admin action is written to `admin_audit_log`, including refused
restores.

## Bot behaviour notes

- Commands only work in **private chats**. In a group the bot replies "Please
  message me directly to verify" and does nothing else.
- The bot never requests seed phrases, private keys, or transactions, and the
  `/help` text says so explicitly: worth keeping, since it sets the expectation
  that any message asking for those is an impersonator.
- Invite links are single-use (`member_limit: 1`) and expire after an hour, so a
  leaked link is worth at most one join.
