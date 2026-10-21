import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createAdapters } from '../src/adapters.ts';
import { Queue } from '../src/queue.ts';
import { startTelegramPolling } from '../src/telegram-polling.ts';

const env = { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'secret', TELEGRAM_ALLOWED_SENDERS: '42', TELEGRAM_MODE: 'polling' };
const update = (id: number, sender = 42) => ({ update_id: id, message: { from: { id: sender }, chat: { id: 7 }, text: 'hello' } });

test('polling commits before acknowledging, filters senders, deduplicates and stops in flight', { timeout: 5000 }, async () => {
  const queue = new Queue(':memory:');
  const adapter = createAdapters(env)[0]!;
  let calls = 0;
  const request: typeof fetch = async (url, options) => {
    calls++;
    if (calls === 1) {
      assert.ok(String(url).endsWith('/getWebhookInfo'));
      return Response.json({ ok: true, result: { url: '' } });
    }
    const body = JSON.parse(String(options?.body));
    assert.equal(body.timeout, 25);
    if (calls === 2) {
      assert.equal(body.offset, undefined);
      return Response.json({ ok: true, result: [update(1), update(1), update(2, 99)] });
    }
    assert.equal(body.offset, 3);
    assert.equal(queue.pending(), 1);
    await delay(60_000, undefined, { signal: options!.signal! });
    throw new Error('Should be aborted');
  };
  const polling = startTelegramPolling(adapter, queue, 'test-token', 'secret', request);
  try {
    while (calls < 3) await delay(5);
    await polling.stop();
    assert.equal(queue.pending(), 1);
  } finally {
    await polling.stop();
    queue.close();
  }
});

test('polling refuses to overwrite an existing webhook', async () => {
  const queue = new Queue(':memory:');
  const methods: string[] = [];
  const request: typeof fetch = async url => {
    methods.push(String(url).split('/').at(-1)!);
    return Response.json({ ok: true, result: { url: 'https://example.com/webhook' } });
  };
  const polling = startTelegramPolling(createAdapters(env)[0]!, queue, 'test-token', 'secret', request);
  await delay(10);
  await polling.stop();
  assert.deepEqual(methods, ['getWebhookInfo']);
  assert.equal(queue.pending(), 0);
  queue.close();
});

test('invalid Telegram delivery mode fails closed', () => {
  assert.throws(() => createAdapters({ ...env, TELEGRAM_MODE: 'typo' }), /Invalid TELEGRAM_MODE/);
});
