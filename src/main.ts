import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { createAdapters } from './adapters.ts';
import { openAgent } from './agent.ts';
import { Queue, Worker } from './queue.ts';
import { createWebhookServer } from './server.ts';

async function main() {
  process.umask(0o077);
  const directory = resolve(process.env.DATA_DIR ?? './data');
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const adapters = createAdapters(process.env);
  if (!adapters.length) throw new Error('Configure at least one messaging channel');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // pi-durable has no cross-process lock: never open its store in two processes.
  const release = await lockfile.lock(directory, { stale: 30_000, update: 10_000, retries: 0 });
  let queue: Queue | undefined;
  let agent: Awaited<ReturnType<typeof openAgent>> | undefined;
  try {
    queue = new Queue(join(directory, 'messages.sqlite'));
    const byChannel = new Map(adapters.map(adapter => [adapter.channel, adapter]));
    if (queue.pendingChannels().some(channel => !byChannel.has(channel))) {
      throw new Error('A channel with pending replies has been disabled; restore its configuration');
    }
    agent = await openAgent(join(directory, 'agent.sqlite'), process.env.MODEL_ID ?? 'gpt-6.1-sol');
    const server = createWebhookServer(adapters, queue);
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(port, process.env.HOST ?? '127.0.0.1', () => { server.off('error', reject); accept(); });
    });
    const worker = new Worker(queue, agent, async message => {
      const adapter = byChannel.get(message.channel);
      if (!adapter) throw new Error('Missing channel adapter');
      await adapter.send(message);
    });
    worker.start();
    console.log(JSON.stringify({ event: 'ready', port, channels: adapters.map(a => a.channel) }));
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeIdleConnections();
      const deadline = setTimeout(() => server.closeAllConnections(), 5000);
      await closed;
      clearTimeout(deadline);
      // Stop admission to workers before closing the harness. Closing cancels active
      // model work without aborting its durable submission, so restart can resume it.
      const drained = worker.stop();
      await agent!.close();
      await drained;
      queue!.close();
      await release();
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
      void stop().catch(() => { console.error('Shutdown failed'); process.exitCode = 1; });
    });
  } catch (error) {
    await agent?.close();
    queue?.close();
    await release();
    throw error;
  }
}

void main().catch(error => {
  // Config errors contain variable names only; third-party exceptions may carry credentials.
  console.error('Startup failed. Check channel credentials, model, data directory lock, and port.');
  if (error instanceof Error && /^(\w+ is required|Configure at least|Model not found|A channel with pending|Invalid PORT)/.test(error.message)) console.error(error.message);
  process.exitCode = 1;
});
