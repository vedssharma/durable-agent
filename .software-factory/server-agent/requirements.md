# Requirements

Build a server-hosted durable agent on pi-durable with GPT-6.1 Sol and separate channel/chat conversations. Telegram, Slack and WhatsApp have real webhook/send adapters. iMessage requires an external Mac bridge, because the server cannot natively participate in iMessage.

Acceptance criteria:
- Persist incoming messages before acknowledgment and deduplicate retries.
- Preserve conversation routing and recover interrupted model work.
- Persist replies and progress through multi-part deliveries.
- Authenticate inbound requests and enforce explicit sender allowlists.
- Isolate channels, chats and supported threads/topics.
- Provide unattended server deployment configuration and setup documentation.
- Run deterministic tests without external credentials.

Assumptions: text only; OpenAI API-key authentication; one host/replica; no action tools, proactive scheduling, or cross-channel memory. Credentials, DNS, infrastructure and a Mac bridge are not provided. Live integrations cannot be verified locally.
