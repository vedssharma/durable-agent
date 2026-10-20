import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, conversationId, eventId, chunks } from '../src/queue.ts';
import type { Incoming, Outgoing } from '../src/types.ts';
import type { Agent } from '../src/agent.ts';

const input: Incoming = { channel: 'telegram', eventId: '1', conversationKey: 'chat1', sender: 'u1', text: 'Hello', destination: { chatId: 'chat1' } };
const agent: Agent = { answer: async () => 'A'.repeat(3001), close: async () => {} };

test('channel and conversation isolation; event IDs are channel-scoped', () => {
  assert.notEqual(conversationId(input), conversationId({ ...input, channel: 'slack' }));
  assert.notEqual(conversationId(input), conversationId({ ...input, conversationKey: 'chat2' }));
  assert.notEqual(eventId(input), eventId({ ...input, channel: 'slack' }));
});
test('Unicode chunks preserve full code points', () => {
  const text = '🙂'.repeat(3001);
  const parts = chunks(text);
  assert.equal(parts.length, 2);
  assert.equal(parts.join(''), text);
  assert.equal(Array.from(parts[0]).length, 3000);
});
test('duplicate webhooks admit one job, including after delivery', async () => {
  const queue = new Queue(':memory:');
  try {
    queue.accept([input, input]);
    assert.equal(queue.pending(), 1);
    const sent: Outgoing[] = [];
    await queue.process(queue.next(new Set())!, agent, async m => { sent.push(m); });
    queue.accept([input]);
    assert.equal(queue.pending(), 0);
    assert.equal(sent.length, 2);
    assert.notEqual(sent[0].id, sent[1].id);
  } finally { queue.close(); }
});
test('oldest unfinished input blocks only its own conversation', () => {
  const queue = new Queue(':memory:');
  try {
    queue.accept([input, { ...input, eventId: '2' }, { ...input, eventId: '3', conversationKey: 'other' }]);
    const first = queue.next(new Set())!;
    queue.retry(first);
    assert.equal(queue.next(new Set())!.route, conversationId({ ...input, conversationKey: 'other' }));
    assert.equal(queue.next(new Set([conversationId({ ...input, conversationKey: 'other' })])), undefined);
  } finally { queue.close(); }
});
test('restart retries remaining outbox parts without generating a new answer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'durable-queue-'));
  const file = join(dir, 'queue.sqlite');
  let queue = new Queue(file), calls = 0;
  const counting: Agent = { answer: async () => { calls++; return 'A'.repeat(3001); }, close: async () => {} };
  try {
    queue.accept([input]);
    let sent = 0;
    await assert.rejects(queue.process(queue.next(new Set())!, counting, async () => {
      if (++sent === 2) throw new Error('network failure');
    }));
    queue.close();
    queue = new Queue(file);
    assert.equal(queue.pending(), 1);
    const replies: Outgoing[] = [];
    await queue.process(queue.next(new Set())!, counting, async m => { replies.push(m); });
    assert.equal(calls, 1);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].text, 'A');
    assert.equal(queue.pending(), 0);
  } finally { queue.close(); await rm(dir, { recursive: true, force: true }); }
});
test('failed generation stays queued and is retried with stable request ID', async () => {
  const queue = new Queue(':memory:');
  try {
    queue.accept([input]);
    const job = queue.next(new Set())!;
    await assert.rejects(queue.process(job, { ...agent, answer: async (_key, id) => {
      assert.equal(id, eventId(input)); throw new Error('crash');
    } }, async () => {}));
    assert.equal(queue.pending(), 1);
    assert.equal(queue.next(new Set())!.id, job.id);
  } finally { queue.close(); }
});
