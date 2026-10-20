# Durable channel agent

A server-hosted, text-only personal assistant using **@earendil-works/pi-durable** and **OpenAI GPT-6.1 Sol** (`gpt-6.1-sol`, present in the pinned pi-ai catalog). Conversations and unfinished model work survive restarts. Telegram, Slack and WhatsApp use authenticated webhooks. iMessage uses the included **Mac bridge** running alongside Apple's Messages app.

This is an initial implementation, not a running deployment. Live credentials, provider permissions and an HTTPS hostname are required. Model availability in your OpenAI account has not been verified.

## Quick start

Use Node 24+ (current Node 24 patch recommended) on a server with local persistent disk.

```sh
npm ci
cp .env.example .env
# Edit .env: OPENAI_API_KEY and at least one complete channel configuration.
npm run check
npm test
npm start
```

Set `TELEGRAM_BOT_TOKEN`, a random `TELEGRAM_WEBHOOK_SECRET`, and `TELEGRAM_ALLOWED_SENDERS` (comma-separated numeric Telegram user IDs) for the simplest initial setup. Use `openssl rand -hex 32` to generate secrets. All enabled channels require explicit sender IDs; empty allowlists and wildcards are rejected. Configuring any nonempty variable for a channel enables that channel and requires its other settings.

Only the OpenAI API-key path is wired up; this service does not read your Pi CLI login. `MODEL_ID` defaults to `gpt-6.1-sol` and is validated against the pinned catalog. It configures newly created conversations; existing conversations retain their stored model.

### Always-on Docker deployment

```sh
docker compose up -d --build
docker compose logs -f
```

The container runs unprivileged, restarts unless stopped, and stores state in the `agent-data` volume. **Do not use `docker compose down -v` unless you intend to delete all conversations.** Put Caddy/nginx or your preferred reverse proxy on the host in front of `127.0.0.1:3000`, serve HTTPS on your domain, and limit inbound bodies to 256 KiB. For example, Caddy:

```caddyfile
agent.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

The example Docker setup is not yet tested against a live server. Run exactly one replica. A heartbeat lock prevents cooperating service processes from opening the same data directory simultaneously; an unclean crash can require about 30 seconds for the lock to expire. Do not open the agent database with other pi-durable hosts. Store on local disk, not NFS. Monitor health, restart frequency, logs and disk usage. `/healthz` is a liveness check, not a provider/connectivity test.

## Channels

### Telegram

Create a bot with BotFather and fill in its three `.env` settings. Register your webhook with the Telegram Bot API's `setWebhook` operation using:

- `url`: `https://agent.example.com/webhooks/telegram`
- `secret_token`: the same `TELEGRAM_WEBHOOK_SECRET`
- `allowed_updates`: `["message"]`

Use a trusted API client and keep the bot token out of shell history and proxy logs. Telegram authenticates with `X-Telegram-Bot-Api-Secret-Token`. DMs and group chats are separate; forum topics are isolated too. In groups, permitted senders share that chat's context. Edited messages and bot messages are ignored. Configure BotFather group privacy according to whether the bot should receive ordinary group messages.

### Slack

Create/install a Slack app with a bot token, signing secret, and workspace ID. Set all four `SLACK_*` variables. Subscribe to `message.im` and `app_mention`, use `https://agent.example.com/webhooks/slack` as the Events API request URL, and grant the corresponding scopes (`im:history`, `app_mentions:read`, `chat:write`). Reinstall the app when scopes change. Allowlisted values are member IDs such as `U012345`, not names.

Only DMs and explicit app mentions are admitted. Signatures are checked over the raw body with a five-minute timestamp window. Workspace IDs must match. Unthreaded DMs share a conversation; threads are separate. Public mentions start a separate conversation per thread and replies stay in that thread. Bot/subtype events are ignored to prevent loops.

### WhatsApp

This uses **Meta WhatsApp Business Cloud API**, not a personal WhatsApp session. Set all six `WHATSAPP_*` variables. Choose a currently supported Graph API version from your Meta app; the service deliberately does not guess it. Subscribe the app to messages and configure:

- Webhook: `https://agent.example.com/webhooks/whatsapp`
- Verify token: `WHATSAPP_VERIFY_TOKEN`

POSTs require Meta's app-secret HMAC; inbound phone-number IDs must match. Sender allowlists use WhatsApp's `from` identifier (typically digits with country code and no `+`). Only incoming text messages trigger responses; status callbacks are ignored. Each phone-number/sender pair is isolated.

Replies use free-form session messages. Meta's customer-service window still applies: delayed replies outside the allowed window can be rejected. Template messages, account onboarding and token renewal are not implemented. Failed deliveries retry with capped exponential backoff and block only that conversation; inspect logs and correct configuration/permissions before resuming.

### iMessage: included Mac bridge

Run the agent on your server and the bridge on an always-on Mac signed into Messages. A dedicated bridge Apple ID is recommended: messages from the Mac's own Apple ID are outgoing echoes and are intentionally ignored.

On the Mac:

```sh
npm ci
npm run mac:build
cp .env.mac.example .env.mac
# Configure .env.mac, macOS permissions and private HTTPS routing first.
npm run mac:bridge
```

See **[Mac bridge setup and recovery](docs/mac-bridge.md)** for matching the four server `IMESSAGE_*` variables, Full Disk Access/Automation permissions, HTTPS/VPN setup, a login LaunchAgent, and live verification.

The bridge polls Messages read-only, decodes native attributed text, durably spools allowed incoming messages, and sends replies through AppleScript to the original chat. First launch skips existing history; restarts resume the saved cursor. SMS/RCS, attachments, reactions and outgoing echoes are ignored. Allowed participants in a group share its context; replies are visible to the whole group.

Reply IDs deduplicate durable acceptance. If AppleScript fails or the process crashes during a send, the reply is marked **uncertain** and that chat waits for manual resolution rather than risking an automatic duplicate. HTTP acknowledgment means queued, not recipient-delivered. This uses Apple's local database/app interfaces, not BlueBubbles or a Linux iMessage client. Live macOS delivery still requires verification.

The wire contract remains available for alternative bridges: inbound POST `/webhooks/imessage` uses `Authorization: Bearer <IMESSAGE_WEBHOOK_TOKEN>` and `{id,chatId,sender,text,isFromMe:false}`. Outgoing POST to `IMESSAGE_BRIDGE_URL` uses `Authorization: Bearer <IMESSAGE_BRIDGE_TOKEN>`, `Idempotency-Key: <id>`, and `{id,chatId,text}`; successful durable acceptance returns `{"ok":true}`.

## Durability and isolation

```text
Authenticated webhook -> messages.sqlite inbox -> pi-durable agent.sqlite
                      -> persisted reply parts -> channel API
```

- Incoming batches commit before HTTP acknowledgment. A channel-scoped event ID deduplicates retries.
- A pi-durable session document atomically creates and remembers channel/chat conversation routes. No cross-channel shared memory or automatic identity linking.
- Stable request IDs make resubmission safe if the process crashes after handing input to pi-durable but before saving the answer in the outbox.
- Answers and each delivered reply-part checkpoint are stored in `messages.sqlite`. Replies split into 3,000-code-point plain-text parts.
- Four conversations may run concurrently. Inputs in a conversation are processed in receipt order, including through delivery backoff.
- Incomplete model work resumes on restart. Model requests may be repeated and incur charges after interruption; durable state is not exactly-once billing.
- **External delivery is at least once**, not exactly once. A send accepted just before a crash may be repeated. iMessage bridges can deduplicate reply IDs; no such guarantee is claimed for the other APIs.
- pi-durable SQLite uses WAL/`synchronous=NORMAL`: process crashes are recoverable, but a host/power failure may lose its newest commits. The separate inbox/outbox uses `FULL`. This is not a promise of zero data loss on disk/host failure.
- Pi-durable is experimental. Dependencies are pinned; test upgrades against copies of your data first.

## Security and operational boundaries

- No shell, file, or arbitrary external-action tools are enabled. This version converses; it does not yet browse, schedule reminders or proactively execute tasks. Add action tools only with a deliberate permissions/approval model.
- HTTPS and explicit sender allowlists are required. Group contexts are shared within each admitted group/thread, never with other groups or channels.
- The service limits body size, request frequency and backlog, but it is not a complete billing quota system. Set OpenAI project spending/rate limits and monitor usage before exposing it publicly.
- General operational logs omit message bodies and upstream exception details. Do not enable reverse-proxy request/header logging that captures credentials.
- SQLite stores message contents **unencrypted**. Use encrypted disks, private backups and access controls. Retention/erasure automation is not included; completed job receipts are retained for deduplication and databases grow over time.
- Back up **both** databases and their state together while stopped (or use a tested consistent SQLite backup procedure). Copying live SQLite files without their WAL is unsafe. Never place `.env` in public artifacts.
- Delivery failures retry indefinitely (maximum five-minute interval); logs identify the job and retry count. There is no admin dashboard/dead-letter/replay API yet. Pending jobs prevent startup if their channel is disabled, avoiding silently stranded replies.

## Verification

```sh
npm run check
npm test
```

Tests use Pi's faux provider and local SQLite; they do not spend model tokens or contact real messaging APIs. They exercise real pi-durable restart recovery/deduplication, queue recovery, conversation ordering/isolation, webhook authentication/filtering, outbound rejection handling and HTTP admission. Mac bridge tests also cover synthetic Messages schemas, durable forwarding/send recovery, reply deduplication and a synthetic native attributed-text archive (when built on macOS). Live provider/channel setup, macOS permissions/AppleScript delivery and Docker/server deployment still need end-to-end verification.
