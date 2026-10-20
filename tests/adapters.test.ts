import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createAdapters } from '../src/adapters.ts';
import type { Adapter } from '../src/types.ts';

const url = new URL('https://agent.example/webhooks/test');
const telegramEnv = { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'secret', TELEGRAM_ALLOWED_SENDERS: '42' };
const slackEnv = { SLACK_BOT_TOKEN: 'test-token', SLACK_SIGNING_SECRET: 'secret', SLACK_ALLOWED_SENDERS: 'U1', SLACK_TEAM_ID: 'T1' };
const whatsappEnv = { WHATSAPP_ACCESS_TOKEN: 'test-token', WHATSAPP_APP_SECRET: 'secret', WHATSAPP_VERIFY_TOKEN: 'verify', WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_GRAPH_API_VERSION: 'v23.0', WHATSAPP_ALLOWED_SENDERS: '15550001111' };
const imessageEnv = { IMESSAGE_BRIDGE_URL: 'https://bridge.example/send', IMESSAGE_BRIDGE_TOKEN: 'outbound', IMESSAGE_WEBHOOK_TOKEN: 'inbound', IMESSAGE_ALLOWED_SENDERS: 'person@example.test' };
function telegram(sender = 42) {
  return Buffer.from(JSON.stringify({ update_id: 1, message: { from: { id: sender }, chat: { id: 99 }, text: 'hello' } }));
}
function slack(adapter: Adapter, payload: unknown, timestamp = String(Math.floor(Date.now() / 1000))) {
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = 'v0=' + createHmac('sha256', 'secret').update(`v0:${timestamp}:`).update(raw).digest('hex');
  return adapter.receive(raw, { 'x-slack-signature': signature, 'x-slack-request-timestamp': timestamp }, url, 'POST');
}
const slackPayload = { type: 'event_callback', team_id: 'T1', event_id: 'E1', event: { type: 'message', channel_type: 'im', user: 'U1', channel: 'D1', ts: '123', text: 'hello' } };
function whatsapp(adapter: Adapter, phone = '123', sender = '15550001111') {
  const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { phone_number_id: phone }, messages: [{ id: 'wamid.1', from: sender, type: 'text', text: { body: 'hello' } }] } }] }] }));
  const signature = 'sha256=' + createHmac('sha256', 'secret').update(raw).digest('hex');
  return adapter.receive(raw, { 'x-hub-signature-256': signature }, url, 'POST');
}

test('disabled channels absent and enabled channels fail closed without allowlists', () => {
  assert.deepEqual(createAdapters({}), []);
  assert.throws(() => createAdapters({ TELEGRAM_BOT_TOKEN: 'token' }));
  assert.throws(() => createAdapters({ ...telegramEnv, TELEGRAM_ALLOWED_SENDERS: '*' }));
  assert.throws(() => createAdapters({ ...slackEnv, SLACK_TEAM_ID: '' }));
});
test('Telegram verifies secret and filters unauthorized senders', () => {
  const [adapter] = createAdapters(telegramEnv);
  assert.throws(() => adapter.receive(telegram(), {}, url, 'POST'));
  assert.equal(adapter.receive(telegram(), { 'x-telegram-bot-api-secret-token': 'secret' }, url, 'POST').messages?.length, 1);
  assert.equal(adapter.receive(telegram(43), { 'x-telegram-bot-api-secret-token': 'secret' }, url, 'POST').messages?.length ?? 0, 0);
});
test('Telegram ignores bot, edited, and non-text events; isolates topics', () => {
  const [adapter] = createAdapters(telegramEnv), headers = { 'x-telegram-bot-api-secret-token': 'secret' };
  for (const data of [{ update_id: 1, edited_message: { text: 'ignore' } }, { update_id: 1, message: { from: { id: 42, is_bot: true }, text: 'ignore' } }]) {
    assert.equal(adapter.receive(Buffer.from(JSON.stringify(data)), headers, url, 'POST').messages?.length ?? 0, 0);
  }
  const payload = JSON.parse(telegram().toString());
  payload.message.message_thread_id = 1;
  const a = adapter.receive(Buffer.from(JSON.stringify(payload)), headers, url, 'POST').messages![0];
  payload.message.message_thread_id = 2;
  const b = adapter.receive(Buffer.from(JSON.stringify(payload)), headers, url, 'POST').messages![0];
  assert.notEqual(a.conversationKey, b.conversationKey);
});
test('Slack verifies raw signature, freshness, workspace, bot and sender filters', () => {
  const [adapter] = createAdapters(slackEnv);
  assert.equal(slack(adapter, slackPayload).messages?.length, 1);
  assert.throws(() => slack(adapter, slackPayload, '1'));
  assert.throws(() => adapter.receive(Buffer.from('{}'), { 'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)), 'x-slack-signature': 'bad' }, url, 'POST'));
  assert.equal(slack(adapter, { ...slackPayload, team_id: 'T2' }).messages?.length ?? 0, 0);
  for (const event of [{ ...slackPayload.event, user: 'U2' }, { ...slackPayload.event, bot_id: 'B1' }, { ...slackPayload.event, subtype: 'message_changed' }]) {
    assert.equal(slack(adapter, { ...slackPayload, event }).messages?.length ?? 0, 0);
  }
});
test('Slack challenge and thread isolation', () => {
  const [adapter] = createAdapters(slackEnv);
  assert.equal(slack(adapter, { type: 'url_verification', challenge: 'challenge' }).body, 'challenge');
  const a = slack(adapter, { ...slackPayload, event: { ...slackPayload.event, thread_ts: '1' } }).messages![0];
  const b = slack(adapter, { ...slackPayload, event: { ...slackPayload.event, thread_ts: '2' } }).messages![0];
  assert.notEqual(a.conversationKey, b.conversationKey);
  assert.equal(a.destination.thread, '1');
});
test('WhatsApp validates signature, configured phone and sender', () => {
  const [adapter] = createAdapters(whatsappEnv);
  assert.equal(whatsapp(adapter).messages?.length, 1);
  assert.equal(whatsapp(adapter, '456').messages?.length ?? 0, 0);
  assert.equal(whatsapp(adapter, '123', 'unauthorized').messages?.length ?? 0, 0);
  assert.throws(() => adapter.receive(Buffer.from('{}'), {}, url, 'POST'));
});
test('WhatsApp verification requires the verify token', () => {
  const [adapter] = createAdapters(whatsappEnv);
  const check = new URL('https://agent.example/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=abc');
  assert.equal(adapter.receive(Buffer.alloc(0), {}, check, 'GET').body, 'abc');
  check.searchParams.set('hub.verify_token', 'wrong');
  assert.throws(() => adapter.receive(Buffer.alloc(0), {}, check, 'GET'));
});
test('iMessage custom bridge requires authentication, sender allowlist and non-echo event', () => {
  const [adapter] = createAdapters(imessageEnv);
  const payload = { id: 'm1', chatId: 'chat1', sender: 'person@example.test', text: 'hello', isFromMe: false };
  const receive = (data: unknown) => adapter.receive(Buffer.from(JSON.stringify(data)), { authorization: 'Bearer inbound' }, url, 'POST');
  assert.equal(receive(payload).messages?.length, 1);
  assert.equal(receive({ ...payload, isFromMe: true }).messages?.length ?? 0, 0);
  assert.equal(receive({ ...payload, sender: 'other' }).messages?.length ?? 0, 0);
  assert.throws(() => adapter.receive(Buffer.from(JSON.stringify(payload)), { authorization: 'Bearer outbound' }, url, 'POST'));
  assert.throws(() => createAdapters({ ...imessageEnv, IMESSAGE_BRIDGE_URL: 'http://bridge.example/send' }));
});
test('outbound APIs validate API-level failure without leaking credentials', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false }), { status: 200 });
    for (const env of [telegramEnv, slackEnv, whatsappEnv, imessageEnv]) {
      const [adapter] = createAdapters(env);
      await assert.rejects(adapter.send({ id: 'm1', channel: adapter.channel, destination: { chatId: '1', channel: 'D1', to: '1' }, text: 'hello' }), error => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes('test-token'));
        return true;
      });
    }
    globalThis.fetch = async () => { throw new Error('secret credential URL'); };
    await assert.rejects(createAdapters(telegramEnv)[0].send({ id: '1', channel: 'telegram', destination: { chatId: '1' }, text: 'hello' }), { message: 'Channel delivery failed' });
  } finally { globalThis.fetch = original; }
});
