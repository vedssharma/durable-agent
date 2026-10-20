# Design

Authenticated webhooks normalize text into a common Incoming record. A synchronous FULL-mode SQLite inbox commits each batch before HTTP acknowledgment. Stable channel/event hashes deduplicate inputs. A four-slot worker preserves per-conversation ordering and independently retries failed deliveries.

Pi-durable stores agent conversations/tasks in a separate SQLite database. A typed session document atomically creates conversation routing. Stable submission request IDs reconcile the non-atomic boundary between the inbox database and the harness. Committed assistant answers become durable reply parts; each successful external send advances its checkpoint.

The runtime uses Node 24 native TypeScript stripping and SQLite. TypeScript checking enforces erasable syntax. proper-lockfile protects the single-process harness store. Docker Compose supplies supervision and persistent storage; HTTPS terminates at a host reverse proxy.

External sends are at least once: a crash between API acceptance and the sent checkpoint may duplicate replies. No exactly-once billing or host-power-loss guarantee. Model failures become generic user-facing responses; transport failures retry with capped exponential backoff. No broad host tools are installed.

Main modules: src/adapters.ts, src/agent.ts, src/queue.ts, src/server.ts, src/main.ts. See README.md for environment variables, security boundaries, bridge contract and operations.
