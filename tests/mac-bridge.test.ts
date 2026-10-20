import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { BridgeStore, BridgeWorker, MessagesSource, bridgeConfig, createBridgeServer } from '../src/mac-bridge.ts';
import type { MacMessage, BridgeReply } from '../src/mac-bridge.ts';
import { createAdapters } from '../src/adapters.ts';
import { Queue } from '../src/queue.ts';
import { createWebhookServer } from '../src/server.ts';

const allowed = new Set(['+15550000000']);
const row = (rowid: number, patch: Partial<MacMessage> = {}): MacMessage => ({
  rowid, id: `message-${rowid}`, chatId: 'iMessage;-;friend', sender: '+15550000000',
  text: 'hello', isFromMe: 0, service: 'iMessage', associatedType: 0, itemType: 0, ...patch,
});
const reply = (id = 'reply-1'): BridgeReply => ({ id, chatId: 'iMessage;-;friend', text: 'hello back' });

async function listen(server: ReturnType<typeof createBridgeServer>) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: ReturnType<typeof createBridgeServer>) {
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections(); await closed;
}

test('capture filters echoes, SMS, reactions, attachments, non-allowed senders; cursor and spool survive restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mac-bridge-'));
  let store = new BridgeStore(join(dir, 'bridge.sqlite'));
  try {
    store.initialize(10); store.initialize(100);
    assert.equal(store.cursor(), 10);
    store.capture([
      row(11), row(12, { isFromMe: 1 }), row(13, { sender: 'stranger' }),
      row(14, { service: 'SMS' }), row(15, { associatedType: 2000 }),
      row(16, { itemType: 1 }), row(17, { text: null }), row(18, { text: ' ' }),
    ], allowed);
    assert.equal(store.pendingCount(), 1);
    assert.equal(store.cursor(), 18);
    store.close(); store = new BridgeStore(join(dir, 'bridge.sqlite'));
    store.capture([row(11)], allowed);
    assert.equal(store.pendingCount(), 1);
    assert.equal(store.accept(reply(), allowed), 'accepted');
    assert.equal(store.accept(reply(), allowed), 'accepted');
    assert.equal(store.accept({ ...reply(), text: 'changed' }, allowed), 'conflict');
    assert.equal(store.accept({ ...reply('other'), chatId: 'unknown' }, allowed), 'forbidden');
    assert.equal(store.accept(reply('revoked'), new Set()), 'forbidden');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('source scans the Messages schema without modifying it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mac-source-'));
  const path = join(dir, 'chat.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE message (guid TEXT, text TEXT, attributedBody BLOB, is_from_me INTEGER, service TEXT,
    associated_message_type INTEGER, item_type INTEGER, handle_id INTEGER);
    CREATE TABLE handle (id TEXT); CREATE TABLE chat (guid TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO handle VALUES ('+15550000000'); INSERT INTO chat VALUES ('iMessage;-;friend');
    INSERT INTO message VALUES ('guid','hello',NULL,0,'iMessage',0,0,1);
    INSERT INTO chat_message_join VALUES (1,1);`);
  db.close();
  const source = new MessagesSource(path, allowed, '/not-needed');
  try {
    assert.equal(source.latest(), 1);
    const rows = await source.read(0);
    assert.equal(rows[0].text, 'hello'); assert.equal(rows[0].chatId, 'iMessage;-;friend');
    assert.equal(rows[0].sender, '+15550000000');
    assert.throws(() => source.db.exec('DELETE FROM message'));
  } finally { source.close(); await rm(dir, { recursive: true, force: true }); }
});

test('first boot skips history, forward retries keep IDs and removed senders are discarded', async () => {
  const store = new BridgeStore(':memory:'); let scanned = -1; let fail = true;
  const deliveries: string[] = [];
  const source = { latest: () => 20, read: (after: number) => { scanned = after; return after < 21 ? [row(21)] : []; } };
  const worker = new BridgeWorker(store, source, allowed, async body => {
    deliveries.push(body); if (fail) throw new Error('offline');
  }, async () => {});
  try {
    await worker.tick(); assert.equal(scanned, 20); assert.equal(store.pendingCount(), 1);
    fail = false; await worker.tick();
    assert.equal(deliveries[0], deliveries[1]); assert.equal(store.pendingCount(), 0);
    store.capture([row(22)], allowed);
    await new BridgeWorker(store, source, new Set(), async () => { throw new Error('must not forward'); }, async () => {}).tick();
    assert.equal(store.pendingCount(), 0);
  } finally { store.close(); }
});

test('durable outgoing acceptance deduplicates and uncertain sends block only their chat', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mac-send-'));
  let store = new BridgeStore(join(dir, 'bridge.sqlite'));
  const source = { latest: () => 0, read: () => [] };
  try {
    store.initialize(0); store.capture([row(1), row(2, { chatId: 'iMessage;+;group' })], allowed);
    store.accept(reply(), allowed); store.accept(reply('second'), allowed);
    store.accept({ ...reply('group'), chatId: 'iMessage;+;group' }, allowed);
    let sends = 0;
    await new BridgeWorker(store, source, allowed, async () => {}, async () => { sends++; throw new Error('ambiguous'); }).tick();
    store.close(); store = new BridgeStore(join(dir, 'bridge.sqlite'));
    assert.equal(store.accept(reply(), allowed), 'accepted');
    const sent: string[] = [];
    const worker = new BridgeWorker(store, source, allowed, async () => {}, async r => { sends++; sent.push(r.id); });
    await worker.tick(); await worker.tick();
    assert.equal(sends, 2); assert.deepEqual(sent, ['group']);
    assert.equal(store.db.prepare("SELECT state FROM outbound WHERE id='reply-1'").get()?.state, 'sending');
    store.db.prepare("UPDATE outbound SET state='sent' WHERE id='reply-1'").run();
    await worker.tick(); assert.deepEqual(sent, ['group', 'second']);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('bridge HTTP authenticates and validates before durable acceptance', async () => {
  const store = new BridgeStore(':memory:'); store.initialize(0); store.capture([row(1)], allowed);
  const server = createBridgeServer(store, 'secret', allowed); const base = await listen(server);
  const headers = { authorization: 'Bearer secret', 'idempotency-key': 'reply-1' };
  const post = (body: unknown, h = headers) => fetch(base + '/send', { method: 'POST', headers: h, body: JSON.stringify(body) });
  try {
    assert.equal((await post(reply(), { ...headers, authorization: 'bad' })).status, 401);
    assert.equal((await post(reply(), { ...headers, 'idempotency-key': 'wrong' })).status, 400);
    assert.equal((await post({ ...reply(), chatId: 'arbitrary' })).status, 403);
    assert.equal((await post(reply())).status, 200);
    assert.equal((await post(reply())).status, 200);
    assert.equal((await post({ ...reply(), text: 'changed' })).status, 409);
    assert.equal((await post({ ...reply(), text: 'x'.repeat(256 * 1024) })).status, 413);
    assert.equal(store.db.prepare('SELECT count(*) n FROM outbound').get()?.n, 1);
    assert.equal((await fetch(base + '/healthz')).status, 200);
  } finally { await close(server); store.close(); }
});

test('bridge forwards real events through existing agent webhook and retries deduplicate', async () => {
  const queue = new Queue(':memory:');
  const adapters = createAdapters({ IMESSAGE_BRIDGE_URL: 'https://mac.example/send', IMESSAGE_BRIDGE_TOKEN: 'out', IMESSAGE_WEBHOOK_TOKEN: 'in', IMESSAGE_ALLOWED_SENDERS: '+15550000000' });
  const server = createWebhookServer(adapters, queue); const base = await listen(server);
  const store = new BridgeStore(':memory:'); store.initialize(0);
  let first = true;
  const worker = new BridgeWorker(store, { latest: () => 1, read: after => after ? [] : [row(1)] }, allowed, async body => {
    assert.equal((await fetch(base + '/webhooks/imessage', { method: 'POST', headers: { authorization: 'Bearer in' }, body })).status, 200);
    if (first) { first = false; throw new Error('lost acknowledgment'); }
  }, async () => {});
  try {
    await worker.tick(); await worker.tick();
    assert.equal(queue.pending(), 1); assert.equal(store.pendingCount(), 0);
    const job = queue.next(new Set())!;
    assert.equal(JSON.parse(job.input).destination.chatId, 'iMessage;-;friend');
  } finally { await close(server); queue.close(); store.close(); }
});

test('config requires HTTPS, distinct tokens and explicit sender allowlist', () => {
  const env = { MAC_AGENT_WEBHOOK_URL: 'https://agent.example/webhooks/imessage', MAC_WEBHOOK_TOKEN: 'in', MAC_BRIDGE_TOKEN: 'out', MAC_ALLOWED_SENDERS: '+15550000000' };
  assert.equal(bridgeConfig(env).port, 3040);
  for (const patch of [ { MAC_AGENT_WEBHOOK_URL: 'http://agent.example/webhooks/imessage' }, { MAC_ALLOWED_SENDERS: '*' }, { MAC_BRIDGE_TOKEN: 'in' }, { MAC_PORT: '0' }, { MAC_AGENT_WEBHOOK_URL: 'https://user:pass@agent.example/webhooks/imessage' } ]) {
    assert.throws(() => bridgeConfig({ ...env, ...patch }));
  }
});
