import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { createWebSearchTool } from '../src/web.ts';

const api = {} as ToolExecutionApi; // This tool intentionally uses no harness API operations.
const result = {
  status: 'completed',
  output: [
    { type: 'web_search_call', action: { sources: [{ url: 'https://example.com/news', title: 'News' }, { url: 'file:///etc/passwd' }] } },
    { type: 'message', content: [{ type: 'output_text', text: 'Current news', annotations: [{ type: 'url_citation', url: 'https://example.com/news', title: 'News' }] }] },
  ],
};

test('web search uses fixed endpoint, live search, minimal query and preserves source URLs', async () => {
  const tool = createWebSearchTool({ apiKey: 'test-key', fetch: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-key');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.input, 'latest news');
    assert.equal(body.store, false);
    assert.deepEqual(body.tools, [{ type: 'web_search' }]);
    assert.equal(body.tool_choice, 'required');
    assert.deepEqual(body.include, ['web_search_call.action.sources']);
    assert.ok(init?.signal);
    return Response.json(result);
  } });
  const answer = await tool.execute({ query: 'latest news' }, api, BACKGROUND_CONTEXT);
  assert.deepEqual(JSON.parse(answer.content![0]!.type === 'text' ? answer.content![0]!.text : ''), {
    untrustedWebContent: true,
    summary: 'Current news',
    sources: [{ url: 'https://example.com/news', title: 'News' }],
  });
  assert.equal(tool.replay, 'safe');
});

test('web search reports sanitized failures rather than pretending results are current', async () => {
  for (const status of [401, 429, 500]) {
    const tool = createWebSearchTool({ apiKey: 'test', fetch: async () => new Response('secret upstream diagnostics', { status }) });
    await assert.rejects(tool.execute({ query: 'news' }, api, BACKGROUND_CONTEXT), {
      message: `Web search failed (HTTP ${status}). No current information was verified.`,
    });
  }
  for (const data of [{}, { status: 'incomplete', output: result.output }, { status: 'completed', output: [] }]) {
    const tool = createWebSearchTool({ apiKey: 'test', fetch: async () => Response.json(data) });
    await assert.rejects(tool.execute({ query: 'news' }, api, BACKGROUND_CONTEXT), /No current information was verified/);
  }
  const tool = createWebSearchTool({ apiKey: 'test', fetch: async () => { throw new Error('sensitive details'); } });
  await assert.rejects(tool.execute({ query: 'news' }, api, BACKGROUND_CONTEXT), /Web search could not connect/);
  await assert.rejects(tool.execute({ query: '  ' }, api, BACKGROUND_CONTEXT), /must not be blank/);
});

test('web search respects cancellation and bounds model-visible output', async () => {
  const controller = new AbortController();
  controller.abort();
  const { withAbortSignal } = await import('@earendil-works/chord/context');
  const tool = createWebSearchTool({ apiKey: 'test', fetch: async (_url, init) => {
    assert.equal(init?.signal?.aborted, true);
    throw new Error('aborted');
  } });
  await assert.rejects(tool.execute({ query: 'news' }, api, withAbortSignal(controller.signal, BACKGROUND_CONTEXT)), /cancelled/);
  const large = createWebSearchTool({ apiKey: 'test', fetch: async () => Response.json({
    status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'a'.repeat(20_000) }] }],
  }) });
  const answer = await large.execute({ query: 'news' }, api, BACKGROUND_CONTEXT);
  const block = answer.content![0]!;
  assert.equal(block.type === 'text' && JSON.parse(block.text).summary.length, 16_000);
});
