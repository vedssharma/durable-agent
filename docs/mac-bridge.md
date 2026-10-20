# iMessage Mac bridge

This bridge connects **the durable agent in this repository** to Apple's Messages app. It does not connect to an interactive Pi terminal session or give the agent computer-control tools. Conversations remain isolated by iMessage chat.

## Requirements

- An always-on, signed-in Mac running Messages, with iMessage enabled and working manually.
- Node 24+ and Xcode Command Line Tools (`xcode-select --install`) for the small native text decoder.
- A deployed agent with an OpenAI key and an HTTPS endpoint.
- A private HTTPS route from the agent server to the Mac (a VPN plus an HTTPS reverse proxy is recommended).
- A sender **different from the Mac's Messages account**. Messages sent from the same Apple ID, including from your iPhone, are marked `is_from_me` and deliberately ignored. For a personal assistant, use a dedicated Apple ID and preferably a separate macOS user for the bridge, then message that account from your normal phone.

Nothing in setup grants permissions, changes power settings, sends messages, or registers a background service automatically.

## 1. Configure both ends

On the Mac, in this repository:

```sh
npm ci
npm run mac:build
cp .env.mac.example .env.mac
chmod 600 .env.mac
```

The build's `NSUnarchiver` deprecation warning is expected: Messages still uses legacy typedstream archives for attributed text. The native decoder handles `attributedBody` when `message.text` is null, including Unicode. It runs as an isolated subprocess and has no network access of its own.

Generate **two different** secrets (`openssl rand -hex 32`, twice). Edit files with a trusted editor, keeping tokens out of shell history:

| Mac `.env.mac` | Agent server `.env` |
| --- | --- |
| `MAC_WEBHOOK_TOKEN` | `IMESSAGE_WEBHOOK_TOKEN` (same value) |
| `MAC_BRIDGE_TOKEN` | `IMESSAGE_BRIDGE_TOKEN` (same value) |
| `MAC_ALLOWED_SENDERS` | `IMESSAGE_ALLOWED_SENDERS` (same identifiers) |

Set `MAC_AGENT_WEBHOOK_URL=https://agent.example.com/webhooks/imessage`.
Set the server's `IMESSAGE_BRIDGE_URL=https://mac.private.example/send` to your Mac's private HTTPS reverse proxy. Do not point it at the agent webhook or a BlueBubbles API. The bridge listens **only** on `127.0.0.1:3040`; a same-Mac reverse proxy terminates HTTPS. For example, with a hostname and valid certificate already configured:

```caddyfile
mac.private.example {
    reverse_proxy 127.0.0.1:3040
}
```

Restrict the hostname/proxy to your private network or agent host; do not expose the raw port publicly. Avoid proxy request/header logs. Both outbound clients refuse redirects. The default server adapter deliberately requires HTTPS even on a VPN.

Sender IDs are exact Messages handles, normally an E.164 phone number **with `+`**, or an Apple ID email. This differs from WhatsApp IDs. No wildcard is supported. On first connection, set only your own known handle; do not disable filtering to discover it.

Restart the agent after enabling its four `IMESSAGE_*` settings.

## 2. Grant macOS permissions and test

1. Grant **Full Disk Access** in System Settings → Privacy & Security to the terminal/runtime hosting the bridge. Restart that terminal afterward. The read-only source is `~/Library/Messages/chat.db` (including its live WAL).
2. Keep Messages open and signed in. Run `npm run mac:bridge` in that terminal.
3. Check for `mac_bridge_ready`. From your **other** account/device, send a fresh plain-text iMessage to the Mac's account. Approve the **Automation → Messages** permission when macOS asks the terminal/runtime or `osascript` to control Messages.
4. Confirm the event reaches the agent and a reply arrives in the **same** Messages conversation. Repeat after restarting the bridge and agent.

The initial start records the latest local message row and does **not** replay old chats. Subsequent starts resume the saved cursor, including messages received while the bridge was stopped. Send a new message after the first ready event. Replies can target only chats already admitted from an allowed incoming message; the HTTP endpoint cannot start arbitrary conversations.

`/healthz` on port 3040 checks HTTP liveness only, not macOS permissions, account connectivity, or agent availability. The bridge polls every two seconds, forwards one queued event and attempts one reply per cycle. Network failures retain their original event IDs. General logs omit text, handles and credentials.

Do not use an ordinary Linux container for this bridge. The agent can run on Linux; Messages and the bridge must run in the logged-in Mac user's session. Prevent sleep as appropriate for your machine; locking the screen is fine, signing out is not.

## 3. Run at login (optional)

First complete the foreground test. A user LaunchAgent can restart the bridge after crashes. Create `~/Library/LaunchAgents/local.durable-agent.imessage.plist`, replacing **every** absolute path (including the Node binary path from `command -v node`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.durable-agent.imessage</string>
  <key>ProgramArguments</key><array>
    <string>/absolute/path/to/node</string>
    <string>--env-file=/absolute/path/to/durable-agent/.env.mac</string>
    <string>/absolute/path/to/durable-agent/src/mac-main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>/absolute/path/to/durable-agent</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>/absolute/path/to/bridge.log</string>
  <key>StandardErrorPath</key><string>/absolute/path/to/bridge-error.log</string>
</dict></plist>
```

Stop the foreground bridge first, then:

```sh
plutil -lint ~/Library/LaunchAgents/local.durable-agent.imessage.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.durable-agent.imessage.plist
```

This is a **user LaunchAgent**, not a system daemon. TCC permissions can differ from a terminal run: verify Full Disk Access and Automation for the actual Node/osascript executable under launchd. Re-test a real exchange; a ready log is insufficient. Node upgrades can change its path and invalidate the plist/permissions. Protect and rotate log files. To stop:

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/local.durable-agent.imessage.plist
```

## Interrupted sends and recovery

Incoming events and outgoing accepts are committed to `MAC_DATA_DIR/bridge.sqlite` before acknowledgment. Repeating an identical reply ID is safe; reusing it with different text/chat returns HTTP 409. An outgoing `200 {"ok":true}` means **durably queued**, not delivered to the recipient.

Messages has no transactional send/idempotency API. Just before AppleScript runs, the bridge persists `sending`. A failure, timeout, or crash after that checkpoint leaves the send **uncertain**. It is not retried automatically, and later replies in that chat wait. Other chats continue. Even a permission error is conservatively treated as uncertain. Inspect logs for `mac_send_uncertain`; an abrupt crash may produce no log.

Stop the bridge (and boot out its LaunchAgent), then:

```sh
npm run mac:bridge -- status
# Inspect Messages manually for the corresponding reply. Then choose ONE:
npm run mac:bridge -- resolve '<reply-id-from-status>' sent
# OR, only if you are certain it did not send:
npm run mac:bridge -- resolve '<reply-id-from-status>' retry
```

Marking `sent` can lose an unsent reply; `retry` can duplicate a reply if you misjudge. Fix permissions/connectivity first, then restart the bridge. Never run two bridge processes against the same state directory; the heartbeat lock can take about 30 seconds to expire after a crash.

## Boundaries and troubleshooting

- Only iMessage text is supported. SMS/RCS, tapbacks/reactions, edits, attachments and outgoing echoes do not invoke the agent. Text captions may be included; attachment content is not forwarded. The macOS Messages database and AppleScript dictionary are private/system interfaces and can change with OS updates.
- A failed attributed-body decode logs `mac_poll_retry` and leaves the batch cursor untouched rather than silently losing text. Existing spooled work can still drain. Missing database permission/schema errors use the same non-sensitive log. Verify permissions and rebuild the decoder before investigating a specific archive; never upload private chat databases.
- If a sender is removed from the Mac allowlist, its queued inputs are discarded and its queued replies are not sent. Remove the sender on **both** ends and restart both services. Group replies remain visible to **all** group participants; allowlisting a sender is not an allowlist of everyone who can read that group.
- A soft 10,000-item pending backlog cap pauses polling/rejects new outgoing work. Disk space is still your responsibility. Completed deduplication receipts are retained indefinitely.
- `mac-data` contains unencrypted message text. Keep it on encrypted local disk with restricted permissions; back up only while stopped, or use a consistent SQLite backup. Do not delete state to clear errors: that loses the spool/deduplication history and resets the first-run cursor.
- Do not restore/swap the Messages database under a live bridge; row IDs must remain monotonic for its cursor. Database restoration/account migrations require a deliberate stopped-state migration.
- AppleScript text is passed as separate arguments, never interpolated as code. Local processes able to inspect process arguments may see outgoing text; use a dedicated, trusted macOS user.

## Verification

```sh
npm run mac:build   # macOS only
npm run check
npm test
```

Tests use synthetic Messages SQLite schemas, local HTTP, simulated crashes and (when built on macOS) a synthetic native attributed-text archive. They never read your actual chats or launch Messages. Live AppleScript delivery, macOS TCC approval, private HTTPS and launchd must still be verified on the intended Mac.
