import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { BridgeStore, BridgeWorker, MessagesSource, bridgeConfig, createBridgeServer, sendWithMessages } from './mac-bridge.ts';

async function main() {
  process.umask(0o077);
  if (process.platform !== 'darwin') throw new Error('The bridge requires macOS');
  const directory = resolve(process.env.MAC_DATA_DIR ?? './mac-data');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(directory, { stale: 30_000, update: 10_000, retries: 0 });
  let store: BridgeStore | undefined;
  let source: MessagesSource | undefined;
  try {
    store = new BridgeStore(join(directory, 'bridge.sqlite'));
    const [command, id, action] = process.argv.slice(2);
    if (command === 'status') {
      console.log(JSON.stringify({ pending: store.pendingCount(), uncertain: store.db.prepare("SELECT id,seq FROM outbound WHERE state='sending' ORDER BY seq").all() }));
      store.close(); await release(); return;
    }
    if (command === 'resolve' && id && (action === 'sent' || action === 'retry')) {
      const result = store.db.prepare("UPDATE outbound SET state=? WHERE id=? AND state='sending'").run(action === 'sent' ? 'sent' : 'pending', id);
      if (result.changes !== 1) throw new Error('No uncertain reply matches that ID');
      console.log('Reply resolved'); store.close(); await release(); return;
    }
    if (command) throw new Error('Usage: mac-bridge [status | resolve <reply-id> sent|retry]');
    const config = bridgeConfig(process.env);
    const decoder = fileURLToPath(new URL('../.build/decode-message', import.meta.url));
    await access(decoder, constants.X_OK);
    source = new MessagesSource(process.env.MAC_MESSAGES_DB ?? join(homedir(), 'Library/Messages/chat.db'), config.allowed, decoder);
    store.initialize(source.latest());
    const worker = new BridgeWorker(store, source, config.allowed, async body => {
      const response = await fetch(config.webhook, {
        method: 'POST', headers: { authorization: `Bearer ${config.inboundToken}`, 'content-type': 'application/json' },
        body, redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
      // Consume/cancel the body so repeated deliveries do not leak connections.
      await response.body?.cancel();
      if (!response.ok) throw new Error('Agent rejected message');
    }, sendWithMessages);
    const server = createBridgeServer(store, config.outboundToken, config.allowed);
    await new Promise<void>((accept, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', () => { server.off('error', reject); accept(); });
    });
    let stopping = false;
    let active: Promise<void> = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      active = worker.tick().catch(() => {
        console.error(JSON.stringify({ event: 'mac_poll_retry' }));
      }).finally(() => { if (!stopping) timer = setTimeout(tick, 2000); });
    };
    tick();
    console.log(JSON.stringify({ event: 'mac_bridge_ready', port: config.port }));
    const stop = async () => {
      if (stopping) return;
      stopping = true; clearTimeout(timer);
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeIdleConnections();
      const deadline = setTimeout(() => server.closeAllConnections(), 5000);
      await closed; clearTimeout(deadline);
      await active; source!.close(); store!.close(); await release();
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
      void stop().catch(() => { console.error('Bridge shutdown failed'); process.exitCode = 1; });
    });
  } catch (error) {
    source?.close(); store?.close(); await release(); throw error;
  }
}
void main().catch(() => {
  console.error('Mac bridge failed. Check macOS, .env.mac, Full Disk Access, data lock and port. Stop the bridge before status/resolve commands.');
  process.exitCode = 1;
});
