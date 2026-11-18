import test from 'node:test';
import assert from 'node:assert/strict';
import { compactRecallQuery, recallTokenCount, RECALL_QUERY_TOKENS } from '../src/recall-query.mjs';
import { Hindsight, ProviderError, recallFailure } from '../src/hindsight.mjs';
import { ChatHindsight } from '../src/chat-memory.mjs';
import { startMockServices } from './mock-services.mjs';

test('recall queries fit the cl100k limit for Chinese, English, emoji and special-token literals', () => {
  for (const filler of ['林岚面对山城危局，需要继续调查粮饷与账册。', 'Long fiction with a scene and political choices. ', '🧭𠮷👨‍👩‍👧‍👦', '<|endoftext|><|fim_prefix|>']) {
    const query = '当前要求：继续第二章，调查失踪账册。\n' + filler.repeat(800) + '\n最新线索：钥匙藏在白塔。';
    const bounded = compactRecallQuery(query);
    assert.ok(recallTokenCount(query) > 500);
    assert.ok(recallTokenCount(bounded) <= RECALL_QUERY_TOKENS);
    assert.ok(bounded.startsWith('当前要求：继续第二章'));
    assert.ok(bounded.endsWith('最新线索：钥匙藏在白塔。'));
    assert.ok(!bounded.includes('\uFFFD'));
  }
  assert.equal(compactRecallQuery('继续下一章'), '继续下一章');
  assert.equal(compactRecallQuery('<|endoftext|>'), '<|endoftext|>');
});

test('both provider paths bound real HTTP recall payloads, including an old client sending a full chapter', async () => {
  const services = await startMockServices();
  try {
    const options = { url: services.url, key: 'test', recallTimeout: 3000 };
    const id = '20feb9bd-3c23-44b6-b9a6-0d9b04b732a8';
    const query = '继续下一章。' + '中文长篇正文与人物交锋。'.repeat(500);
    await new Hindsight(options).recall(id, [{ number: 1, revision: 1 }], 2, query);
    await new ChatHindsight(options).recall(id, [{ message_id: id, revision: 1 }], query);
    assert.equal(services.state.recalls.length, 2);
    for (const call of services.state.recalls) {
      assert.ok(recallTokenCount(call.body.query) <= 480);
      assert.equal(call.body.tags_match, 'any_strict');
      assert.equal(call.body.tags.length, 1);
    }
  } finally { await services.close(); }
});

test('recall failures expose safe HTTP categories and a retry instruction without upstream bodies', () => {
  const failure = recallFailure(new ProviderError('provider_http', 400), true);
  assert.equal(failure.code, 'RECALL_FAILED');
  assert.match(failure.message, /HTTP 400/);
  assert.match(failure.message, /重新生成/);
  assert.match(recallFailure(new ProviderError('transport_uncertain')).message, /超时/);
});
