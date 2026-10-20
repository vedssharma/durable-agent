# Summary

Implemented the initial durable multi-channel text assistant in the workspace root using pinned pi-durable/pi-ai/chord 1.0.0 packages. GPT-6.1 Sol resolves to openai/gpt-6.1-sol in the catalog. Conversations are separate by channel/chat and supported threads/topics.

Setup: copy .env.example to .env, supply OpenAI and channel credentials, run npm ci/check/test/start or docker compose up -d --build, then configure HTTPS webhooks. See README.md.

21 tests pass on Node 24 and Node 26; type checking and production dependency audit pass. Container daemon was unavailable. No live model/channel validation or server deployment was performed. iMessage is a documented custom bridge contract; a separate always-on Mac implementation is still required.
