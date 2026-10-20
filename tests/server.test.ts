import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Queue } from '../src/queue.ts';
import { createAdapters } from '../src/adapters.ts';
import { createWebhookServer } from '../src/server.ts';

async function setup() {
  const queue = new Queue(':memory:');
  const server = createWebhookServer(createAdapters({ TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_WEBHOOK_SECRET: 'secret', TELEGRAM_ALLOWED_SENDERS: '42' }), queue);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async () => {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closed; queue.close();
  };
  return { queue, base, close };
}

test('webhooks persist before acknowledging and HTTP retries deduplicate', async () => {
  const app = await setup();
  try {
    const body = JSON.stringify({ update_id: 1, message: { from: { id: 42 }, chat: { id: 99 }, text: 'hello' } });
    const send = () => fetch(app.base + '/webhooks/telegram', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'secret' }, body });
    assert.equal((await send()).status, 200);
    assert.equal(app.queue.pending(), 1);
    assert.equal((await send()).status, 200);
    assert.equal(app.queue.pending(), 1);
  } finally { await app.close(); }
});
test('HTTP rejects unauthenticated, malformed, oversized and unknown requests', async () => {
  const app = await setup();
  try {
    assert.equal((await fetch(app.base + '/healthz')).status, 200);
    assert.equal((await fetch(app.base + '/missing')).status, 404);
    assert.equal((await fetch(app.base + '/webhooks/telegram', { method: 'POST', body: '{}' })).status, 400);
    assert.equal((await fetch(app.base + '/webhooks/telegram', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'secret' }, body: 'not json' })).status, 400);
    assert.equal((await fetch(app.base + '/webhooks/telegram', { method: 'POST', body: 'x'.repeat(256 * 1024 + 1) })).status, 413);
    assert.equal((await fetch(app.base + '/webhooks/telegram', { method: 'DELETE' })).status, 405);
    assert.equal(app.queue.pending(), 0);
  } finally { await app.close(); }
});
