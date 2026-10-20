import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

test('Mac executable boots against synthetic Messages, locks storage and stops cleanly', {
  skip: process.platform !== 'darwin' || !existsSync('.build/decode-message'), timeout: 15_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mac-main-'));
  const path = join(dir, 'chat.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE message (guid TEXT, text TEXT, attributedBody BLOB, is_from_me INTEGER,
    service TEXT, associated_message_type INTEGER, item_type INTEGER, handle_id INTEGER);
    CREATE TABLE handle (id TEXT); CREATE TABLE chat (guid TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);`);
  db.close();
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const env = { PATH: process.env.PATH, MAC_DATA_DIR: join(dir, 'state'), MAC_MESSAGES_DB: path,
    MAC_AGENT_WEBHOOK_URL: 'https://agent.invalid/webhooks/imessage', MAC_WEBHOOK_TOKEN: 'in',
    MAC_BRIDGE_TOKEN: 'out', MAC_ALLOWED_SENDERS: 'friend@example.com', MAC_PORT: String(port) };
  const start = () => spawn(process.execPath, ['src/mac-main.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = start();
  try {
    const ready = await Promise.race([
      once(child.stdout, 'data').then(([data]) => String(data)),
      once(child, 'exit').then(() => { throw new Error('Bridge exited before ready'); }),
    ]);
    assert.ok(ready.includes('mac_bridge_ready'));
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    const duplicate = start();
    assert.equal((await once(duplicate, 'exit'))[0], 1);
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    assert.equal((await exited)[0], 0);
    const status = spawn(process.execPath, ['src/mac-main.ts', 'status'], { env });
    let output = ''; status.stdout.on('data', data => { output += data; });
    assert.equal((await once(status, 'exit'))[0], 0);
    assert.deepEqual(JSON.parse(output), { pending: 0, uncertain: [] });
  } finally { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});
