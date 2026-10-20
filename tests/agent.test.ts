import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createAgent } from '../src/agent.ts';

async function open(file: string, tokensPerSecond?: number) {
  const faux = fauxProvider({ provider: 'openai', models: [{ id: 'test' }], tokensPerSecond });
  const models = createModels(); models.setProvider(faux.provider);
  const harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  harness.resume();
  return { faux, harness, agent: createAgent(harness, 'test') };
}

test('real pi-durable store reopens conversations and deduplicates submissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'durable-agent-'));
  let opened = await open(join(dir, 'agent.sqlite'));
  try {
    opened.faux.setResponses([fauxAssistantMessage([fauxText('Persistent answer')])]);
    assert.equal(await opened.agent.answer('telegram/chat1', 'event1', 'Hello'), 'Persistent answer');
    await opened.agent.close();
    opened = await open(join(dir, 'agent.sqlite'));
    assert.equal(await opened.agent.answer('telegram/chat1', 'event1', 'Hello'), 'Persistent answer');
    assert.equal(opened.faux.state.callCount, 0);
    opened.faux.setResponses([fauxAssistantMessage([fauxText('Separate answer')])]);
    assert.equal(await opened.agent.answer('slack/chat1', 'event1', 'Hello'), 'Separate answer');
    assert.equal(opened.faux.state.callCount, 1);
  } finally { await opened.agent.close(); await rm(dir, { recursive: true, force: true }); }
});

test('SIGKILL during generation resumes from the on-disk checkpoint', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'durable-kill-'));
  const file = join(dir, 'agent.sqlite');
  const child = fork(new URL('./fixtures/crash-agent.ts', import.meta.url), [file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  try {
    await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => { throw new Error('Crash fixture exited before generation'); }),
    ]);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const opened = await open(file);
    try {
      opened.faux.setResponses([fauxAssistantMessage([fauxText('Recovered after SIGKILL')])]);
      assert.equal(await opened.agent.answer('telegram/chat1', 'event1', 'Hello'), 'Recovered after SIGKILL');
      assert.equal(await opened.agent.answer('telegram/chat1', 'event1', 'Hello'), 'Recovered after SIGKILL');
      assert.equal(opened.faux.state.callCount, 1);
    } finally { await opened.agent.close(); }
  } finally {
    child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('interrupted model work resumes after reopening with no duplicate input', { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'durable-resume-'));
  let opened = await open(join(dir, 'agent.sqlite'), 1);
  try {
    opened.faux.setResponses([fauxAssistantMessage([fauxText('A very slow answer that will be interrupted')])]);
    const pending = opened.agent.answer('telegram/chat1', 'event1', 'Hello').catch(() => 'interrupted');
    for (let i = 0; i < 100 && opened.faux.state.callCount === 0; i++) await delay(10);
    assert.equal(opened.faux.state.callCount, 1);
    await opened.agent.close();
    await pending;
    opened = await open(join(dir, 'agent.sqlite'));
    opened.faux.setResponses([fauxAssistantMessage([fauxText('Recovered answer')])]);
    assert.equal(await opened.agent.answer('telegram/chat1', 'event1', 'Hello'), 'Recovered answer');
  } finally { await opened.agent.close(); await rm(dir, { recursive: true, force: true }); }
});
