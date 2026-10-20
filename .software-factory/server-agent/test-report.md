# Test report

- 21/21 tests passed on Node 26.7.0 and on Node 24 via npx node@24.
- npm run check passed.
- npm audit --omit=dev: zero vulnerabilities.
- Docker Compose configuration validated with a temporary configuration override selecting .env.example (no real .env created).
- Docker build/run not attempted: daemon unavailable.

Coverage by behavior: real pi-durable SQLite reopening; SIGKILL mid-generation recovery; graceful interrupted-turn recovery; request deduplication; cross-channel isolation; per-conversation ordering/backoff; outbox partial-send recovery; Unicode chunking; Telegram/Slack/WhatsApp/iMessage authentication and sender filtering; Slack threading; outbound API-level rejection handling; HTTP persistence-before-ack, health, bad requests and body limits; process startup, storage locking and graceful shutdown.

No numeric coverage collected. No real model or channel API requests performed. Infrastructure, live account permissions, exact provider availability, external Mac bridge and container image remain unverified.
