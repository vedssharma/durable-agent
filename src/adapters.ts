import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Adapter, Channel, Incoming, Outgoing } from './types.ts';

type Obj = Record<string, unknown>;
function obj(value: unknown): Obj { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {}; }
function str(value: unknown): string { return typeof value === 'string' ? value : ''; }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function scalar(value: unknown): string { return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : str(value); }
export function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function header(headers: IncomingHttpHeaders, key: string): string { return str(headers[key]); }
function json(raw: Buffer): Obj { return obj(JSON.parse(raw.toString('utf8'))); }
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
function allowlist(env: NodeJS.ProcessEnv, prefix: string): Set<string> {
  const values = required(env, `${prefix}_ALLOWED_SENDERS`).split(',').map(s => s.trim()).filter(Boolean);
  if (!values.length || values.includes('*')) throw new Error(`${prefix}_ALLOWED_SENDERS must list explicit sender IDs`);
  return new Set(values);
}
function message(channel: Channel, eventId: string, conversationKey: string, sender: string, text: string, destination: Record<string, string>): Incoming[] {
  if (!eventId || !conversationKey || !sender || !text.trim() || text.length > 32_000) return [];
  return [{ channel, eventId, conversationKey, sender, text, destination }];
}
async function post(url: string, headers: Record<string, string>, body: Obj): Promise<Obj> {
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    if (!response.ok) throw new Error('HTTP failure');
    return obj(await response.json());
  } catch { throw new Error('Channel delivery failed'); }
}
function authorized(ok: boolean): void { if (!ok) throw new Error('Unauthorized webhook'); }

export function createAdapters(env: NodeJS.ProcessEnv): Adapter[] {
  const adapters: Adapter[] = [];
  const enabled = (prefix: string) => Object.entries(env).some(([key, value]) => key.startsWith(`${prefix}_`) && value?.trim());
  if (enabled('TELEGRAM')) {
    if (env.TELEGRAM_MODE && !['polling', 'webhook'].includes(env.TELEGRAM_MODE)) throw new Error('Invalid TELEGRAM_MODE: use polling or webhook');
    const token = required(env, 'TELEGRAM_BOT_TOKEN');
    const secret = required(env, 'TELEGRAM_WEBHOOK_SECRET');
    const allowed = allowlist(env, 'TELEGRAM');
    adapters.push({
      channel: 'telegram', path: '/webhooks/telegram',
      receive(raw, headers, _url, method) {
        authorized(method === 'POST' && equal(header(headers, 'x-telegram-bot-api-secret-token'), secret));
        const payload = json(raw), m = obj(payload.message), from = obj(m.from), chat = obj(m.chat);
        const sender = scalar(from.id), chatId = scalar(chat.id), thread = scalar(m.message_thread_id);
        if (!chatId || !allowed.has(sender) || from.is_bot === true) return {};
        return { messages: message('telegram', scalar(payload.update_id), JSON.stringify([chatId, thread]), sender, str(m.text),
          { chatId, ...(thread ? { thread } : {}) }) };
      },
      async send(m) {
        const result = await post(`https://api.telegram.org/bot${token}/sendMessage`, {}, {
          chat_id: m.destination.chatId, text: m.text,
          ...(m.destination.thread ? { message_thread_id: Number(m.destination.thread) } : {}),
        });
        if (result.ok !== true) throw new Error('Telegram delivery rejected');
      },
    });
  }
  if (enabled('SLACK')) {
    const token = required(env, 'SLACK_BOT_TOKEN');
    const secret = required(env, 'SLACK_SIGNING_SECRET');
    const team = required(env, 'SLACK_TEAM_ID');
    const allowed = allowlist(env, 'SLACK');
    adapters.push({
      channel: 'slack', path: '/webhooks/slack',
      receive(raw, headers, _url, method) {
        const timestamp = header(headers, 'x-slack-request-timestamp');
        authorized(method === 'POST' && /^\d+$/.test(timestamp) && Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300);
        const signature = 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:`).update(raw).digest('hex');
        authorized(equal(signature, header(headers, 'x-slack-signature')));
        const payload = json(raw);
        if (payload.type === 'url_verification') return { body: str(payload.challenge) };
        if (payload.type !== 'event_callback' || payload.team_id !== team) return {};
        const e = obj(payload.event), sender = str(e.user), channel = str(e.channel);
        if (!channel || !allowed.has(sender) || e.bot_id || e.subtype || !(e.type === 'app_mention' || (e.type === 'message' && e.channel_type === 'im'))) return {};
        // Each public thread is separate; unthreaded DMs share a conversation.
        const thread = str(e.thread_ts) || (e.channel_type === 'im' ? '' : str(e.ts));
        return { messages: message('slack', str(payload.event_id), JSON.stringify([team, channel, thread]), sender, str(e.text),
          { channel, ...(thread ? { thread } : {}) }) };
      },
      async send(m) {
        const result = await post('https://slack.com/api/chat.postMessage', { authorization: `Bearer ${token}` }, {
          channel: m.destination.channel, text: m.text, unfurl_links: false, unfurl_media: false,
          ...(m.destination.thread ? { thread_ts: m.destination.thread } : {}),
        });
        if (result.ok !== true) throw new Error('Slack delivery rejected');
      },
    });
  }
  if (enabled('WHATSAPP')) {
    const token = required(env, 'WHATSAPP_ACCESS_TOKEN');
    const secret = required(env, 'WHATSAPP_APP_SECRET');
    const verify = required(env, 'WHATSAPP_VERIFY_TOKEN');
    const phone = required(env, 'WHATSAPP_PHONE_NUMBER_ID');
    const version = required(env, 'WHATSAPP_GRAPH_API_VERSION');
    if (!/^v\d+\.\d+$/.test(version) || !/^\d+$/.test(phone)) throw new Error('Invalid WhatsApp API version or phone ID');
    const allowed = allowlist(env, 'WHATSAPP');
    adapters.push({
      channel: 'whatsapp', path: '/webhooks/whatsapp',
      receive(raw, headers, url, method) {
        if (method === 'GET') {
          authorized(url.searchParams.get('hub.mode') === 'subscribe' && equal(url.searchParams.get('hub.verify_token') ?? '', verify));
          return { body: url.searchParams.get('hub.challenge') ?? '' };
        }
        const signature = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
        authorized(method === 'POST' && equal(signature, header(headers, 'x-hub-signature-256')));
        const payload = json(raw), messages: Incoming[] = [];
        if (payload.object !== 'whatsapp_business_account') return {};
        for (const entry of list(payload.entry)) for (const change of list(obj(entry).changes)) {
          const value = obj(obj(change).value);
          if (obj(value.metadata).phone_number_id !== phone) continue;
          for (const item of list(value.messages)) {
            const m = obj(item), sender = str(m.from);
            if (!allowed.has(sender) || m.type !== 'text') continue;
            messages.push(...message('whatsapp', str(m.id), JSON.stringify([phone, sender]), sender, str(obj(m.text).body), { to: sender }));
          }
        }
        return { messages };
      },
      async send(m) {
        const result = await post(`https://graph.facebook.com/${version}/${phone}/messages`, { authorization: `Bearer ${token}` }, {
          messaging_product: 'whatsapp', to: m.destination.to, type: 'text', text: { body: m.text },
        });
        if (!str(obj(list(result.messages)[0]).id)) throw new Error('WhatsApp delivery rejected');
      },
    });
  }
  if (enabled('IMESSAGE')) {
    const url = new URL(required(env, 'IMESSAGE_BRIDGE_URL'));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('iMessage bridge requires an HTTPS URL without credentials, query, or fragment');
    const outbound = required(env, 'IMESSAGE_BRIDGE_TOKEN');
    const inbound = required(env, 'IMESSAGE_WEBHOOK_TOKEN');
    const allowed = allowlist(env, 'IMESSAGE');
    adapters.push({
      channel: 'imessage', path: '/webhooks/imessage',
      receive(raw, headers, _url, method) {
        authorized(method === 'POST' && equal(header(headers, 'authorization'), `Bearer ${inbound}`));
        const m = json(raw), sender = str(m.sender), chatId = str(m.chatId);
        if (!allowed.has(sender) || m.isFromMe !== false || !chatId) return {};
        return { messages: message('imessage', str(m.id), chatId, sender, str(m.text), { chatId }) };
      },
      async send(m: Outgoing) {
        const result = await post(url.href, { authorization: `Bearer ${outbound}`, 'idempotency-key': m.id }, {
          id: m.id, chatId: m.destination.chatId, text: m.text,
        });
        if (result.ok !== true) throw new Error('iMessage bridge delivery rejected');
      },
    });
  }
  return adapters;
}
