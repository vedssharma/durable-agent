import { setTimeout as delay } from 'node:timers/promises';
import type { Adapter } from './types.ts';
import type { Queue } from './queue.ts';

// Advance Telegram's offset only after SQLite has committed admission. Replayed
// updates after a crash are harmless: the queue deduplicates by update_id.
export function startTelegramPolling(
  adapter: Adapter, queue: Queue, token: string, secret: string,
  request: typeof fetch = fetch,
): { stop(): Promise<void> } {
  const controller = new AbortController();
  const signal = controller.signal;
  const run = async () => {
    let offset: number | undefined;
    let checkedWebhook = false;
    while (!signal.aborted) {
      try {
        const method = checkedWebhook ? 'getUpdates' : 'getWebhookInfo';
        const response = await request(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(checkedWebhook ? { offset, timeout: 25, limit: 100, allowed_updates: ['message'] } : {}),
          signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
        });
        const data = await response.json() as { ok?: boolean; result?: unknown };
        if (!response.ok || data.ok !== true) {
          console.error(JSON.stringify({ event: 'telegram_poll_retry', status: response.status }));
          throw new Error('Telegram request rejected');
        }
        if (!checkedWebhook) {
          if (!data.result || typeof data.result !== 'object' || !('url' in data.result)) throw new Error('Invalid webhook info');
          if (data.result.url) {
            console.error('Telegram polling requires removing the existing webhook first; no webhook was changed.');
            throw new Error('Webhook configured');
          }
          checkedWebhook = true;
          console.log(JSON.stringify({ event: 'telegram_polling_started' }));
          continue;
        }
        if (!Array.isArray(data.result)) throw new Error('Invalid updates');
        for (const update of data.result) {
          if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) throw new Error('Invalid update ID');
          const result = adapter.receive(Buffer.from(JSON.stringify(update)),
            { 'x-telegram-bot-api-secret-token': secret }, new URL('http://localhost/webhooks/telegram'), 'POST');
          const messages = result.messages ?? [];
          if (messages.length) {
            if (queue.pending() + messages.length > 10_000) throw new Error('Queue full');
            queue.accept(messages);
          }
          offset = update.update_id + 1;
        }
      } catch {
        if (signal.aborted) break;
        // Never log API exceptions: URLs contain the bot token.
        console.error(JSON.stringify({ event: 'telegram_poll_retry' }));
        await delay(3000, undefined, { signal }).catch(() => {});
      }
    }
  };
  const running = run();
  return { async stop() { controller.abort(); await running; } };
}
