import { createServer } from 'node:http';
import type { Adapter } from './types.ts';
import type { Queue } from './queue.ts';

export function createWebhookServer(adapters: Adapter[], queue: Queue) {
  const routes = new Map(adapters.map(adapter => [adapter.path, adapter]));
  let windowStart = Date.now(), requests = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz' && req.method === 'GET') { res.end('ok'); return; }
      const adapter = routes.get(url.pathname);
      if (!adapter) { res.writeHead(404).end('Not found'); return; }
      if (!['GET', 'POST'].includes(req.method ?? '')) { res.writeHead(405).end('Method not allowed'); return; }
      if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); requests = 0; }
      if (++requests > 600) { res.writeHead(429).end('Rate limited'); return; }
      let size = 0;
      const buffers: Buffer[] = [];
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > 256 * 1024) { res.writeHead(413).end('Payload too large'); return; }
        buffers.push(buffer);
      }
      const result = adapter.receive(Buffer.concat(buffers), req.headers, url, req.method ?? '');
      if (result.messages?.length) {
        if (queue.pending() + result.messages.length > 10_000) { res.writeHead(503).end('Queue full; retry later'); return; }
        // The sender is acknowledged only after SQLite commits the whole batch.
        queue.accept(result.messages);
      }
      res.writeHead(result.status ?? 200).end(result.body ?? 'ok');
    } catch {
      // Never echo request bodies or upstream exceptions into responses/logs.
      res.writeHead(400).end('Webhook rejected');
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
