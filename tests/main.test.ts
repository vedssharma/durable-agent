import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('service boots without model calls, locks storage, serves health and shuts down', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'durable-main-'));
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const env = { PATH: process.env.PATH, DATA_DIR: dir, PORT: String(port), OPENAI_API_KEY: 'not-a-real-key', TELEGRAM_BOT_TOKEN: 'not-a-real-token', TELEGRAM_WEBHOOK_SECRET: 'secret', TELEGRAM_ALLOWED_SENDERS: '42' };
  const start = () => spawn(process.execPath, ['src/main.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = start();
  try {
    const ready = await Promise.race([
      once(child.stdout, 'data').then(([data]) => String(data)),
      once(child, 'exit').then(() => { throw new Error('Service exited before ready'); }),
    ]);
    assert.ok(ready.includes('ready'));
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    const duplicate = start();
    let diagnostic = '';
    duplicate.stderr.on('data', data => { diagnostic += String(data); });
    const [code] = await once(duplicate, 'exit');
    assert.equal(code, 1);
    assert.match(diagnostic, /DATA_DIR is locked by another agent process/);
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    assert.equal((await exited)[0], 0);
  } finally {
    child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('occupied port reports an actionable error without exposing credentials', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'durable-port-'));
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const port = (occupied.address() as AddressInfo).port;
  const child = spawn(process.execPath, ['src/main.ts'], {
    env: {
      PATH: process.env.PATH, DATA_DIR: dir, PORT: String(port),
      OPENAI_API_KEY: 'private-test-key', TELEGRAM_BOT_TOKEN: 'private-test-token',
      TELEGRAM_WEBHOOK_SECRET: 'private-test-secret', TELEGRAM_ALLOWED_SENDERS: '42',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostic = '';
  child.stderr.on('data', data => { diagnostic += String(data); });
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.ok(diagnostic.includes(`PORT ${port} is already in use`));
    assert.match(diagnostic, /Set PORT in .env to a free port/);
    assert.doesNotMatch(diagnostic, /private-test/);
  } finally {
    child.kill('SIGKILL');
    await new Promise<void>(resolve => occupied.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
