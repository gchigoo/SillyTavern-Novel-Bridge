import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Hindsight, Analyzer } from '../src/hindsight.mjs';
import { Worker } from '../src/worker.mjs';
import { createApp } from '../src/server.mjs';
import { startMockServices } from './mock-services.mjs';

const databaseURL = process.env.TEST_DATABASE_URL;
if (!databaseURL || !/^novel_bridge_test(?:_[a-z0-9]+)?$/.test(decodeURIComponent(new URL(databaseURL).pathname.slice(1)))) {
  throw new Error('Integration refused: TEST_DATABASE_URL must explicitly name a disposable novel_bridge_test or novel_bridge_test_<suffix> database');
}
const secret = 'test-only-gateway-secret-0123456789';
const origin = 'https://tavern.example';
const input = (expectedRevision = 0, extra = {}) => ({ requestId: randomUUID(), expectedRevision, title: '第一章', content: '主角进入山林。', summary: '主角出发入山。', stateDelta: [{ entity: '主角', field: '位置', value: '山中', evidence: '进入山林' }], storyTime: '前朝三年腊月', sourceChatId: 'test-chat', ...extra });

test('HTTP, PostgreSQL transactions and durable worker against real local HTTP stand-ins', async t => {
  const store = new Store(databaseURL); await store.migrate();
  const services = await startMockServices();
  const exportRoot = await mkdtemp(path.join(tmpdir(), 'nb-integration-'));
  const hindsight = new Hindsight({ url: services.url, key: 'test-key', operationTimeout: 500, recallTimeout: 1000 });
  const analyzer = new Analyzer({ url: services.url, key: 'test-key', timeout: 1000 });
  const app = createApp({ store, hindsight, analyzer, gatewaySecret: secret, publicOrigin: origin });
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  const base = `http://127.0.0.1:${server.address().port}/novel-bridge/api`;
  const worker = () => new Worker(store, hindsight, { exportRoot, pollMs: 0, retryBaseMs: 0, maxAttempts: 2 });
  const request = async (route, body, { user = 'alice', token = secret, requestOrigin = origin, method = body === undefined ? 'GET' : 'POST', contentType = 'application/json' } = {}) => {
    const res = await fetch(base + route, { method, headers: { 'X-Novel-Gateway': token, 'X-Novel-User': user, ...(body === undefined ? {} : { Origin: requestOrigin, 'Content-Type': contentType }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const content = res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text();
    return { status: res.status, body: content, headers: res.headers };
  };
  const create = async () => (await request('/novels', { title: '测试小说' })).body;
  const finalize = (id, number, body = input()) => request(`/novels/${id}/chapters/${number}/finalize`, body);
  const job = async id => (await store.pool.query('SELECT * FROM nb_jobs WHERE id=$1', [id])).rows[0];
  const counts = async () => (await store.pool.query('SELECT (SELECT count(*)::int FROM nb_revisions) revisions,(SELECT count(*)::int FROM nb_jobs) jobs,(SELECT count(*)::int FROM nb_requests) requests')).rows[0];
  async function reset() {
    await store.pool.query('TRUNCATE nb_requests,nb_jobs,nb_chapters,nb_revisions,nb_canon_revisions,nb_novels');
    const state = services.state; state.operations.clear(); state.retains.length = 0; state.recalls.length = 0; state.banks.length = 0; state.analyses.length = 0; state.facts = []; state.lostAcknowledgements = 0; state.operationTransport = false; state.recallMalformed = false; state.analysisMalformed = false; state.onRecall = null;
  }
  try {
    await t.test('gateway, CSRF, malformed JSON and ownership on every resource family', async () => {
      await reset(); const novel = await create();
      assert.equal((await request('/novels', undefined, { token: 'wrong' })).status, 401);
      assert.equal((await request('/novels', undefined, { user: '../invalid' })).status, 401);
      assert.equal((await request('/novels', { title: 'x' }, { requestOrigin: 'https://evil.test' })).status, 403);
      assert.equal((await request('/novels', { title: 'x' }, { contentType: 'text/plain' })).status, 403);
      const malformed = await fetch(base + '/novels', { method: 'POST', headers: { 'X-Novel-Gateway': secret, 'X-Novel-User': 'alice', Origin: origin, 'Content-Type': 'application/json' }, body: '{' });
      assert.equal(malformed.status, 400);
      assert.equal((await request('/novels', undefined, { user: 'bob' })).body.novels.length, 0);
      const saved = await finalize(novel.id, 1);
      for (const [route, body, method] of [
        [`/novels/${novel.id}`, undefined, 'GET'], [`/novels/${novel.id}/chapters/1`, undefined, 'GET'], [`/novels/${novel.id}/chapters/1/export`, undefined, 'GET'],
        [`/novels/${novel.id}/canon`, { canon: '侵入', expectedRevision: 0 }, 'PUT'], [`/novels/${novel.id}/context`, { chapterNumber: 2, query: '' }, 'POST'],
        [`/novels/${novel.id}/analyze`, { chapterNumber: 2, content: '草稿' }, 'POST'], [`/novels/${novel.id}/chapters/2/finalize`, input(), 'POST'], [`/novels/${novel.id}/jobs/${saved.body.jobId}/retry`, {}, 'POST'],
      ]) assert.equal((await request(route, body, { user: 'bob', method })).status, 404, route);
      assert.equal(services.state.recalls.length, 0); assert.equal(services.state.analyses.length, 0);
    });
    await t.test('finalization is idempotent, payload-conflict protected, durable and safely downloadable', async () => {
      await reset(); const novel = await create(), body = input(0, { title: '../../unsafe\r\nname' });
      const first = await finalize(novel.id, 1, body), repeated = await finalize(novel.id, 1, body);
      assert.equal(first.status, 200); assert.deepEqual(repeated.body, first.body);
      assert.equal((await finalize(novel.id, 1, { ...body, content: '更改' })).status, 409);
      assert.deepEqual(await counts(), { revisions: 1, jobs: 1, requests: 1 });
      assert.equal((await store.chapter('alice', novel.id, 1)).storyTime, '前朝三年腊月');
      const exported = await request(`/novels/${novel.id}/chapters/1/export`);
      assert.match(exported.headers.get('content-disposition'), /chapter-1-r1\.md/); assert.ok(exported.body.includes('主角进入山林'));
      assert.equal(services.state.retains.length, 0);
    });
    await t.test('concurrent revisions serialize to exactly one winner', async () => {
      await reset(); const novel = await create();
      const replies = await Promise.all([finalize(novel.id, 1), finalize(novel.id, 1)]);
      assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]); assert.deepEqual(await counts(), { revisions: 1, jobs: 1, requests: 1 });
    });
    await t.test('job insertion failure rolls back chapter revision, active selection, epoch and receipt', async () => {
      await reset(); const novel = await create();
      await store.pool.query(`CREATE OR REPLACE FUNCTION nb_test_reject_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rejection'; END $$`);
      await store.pool.query('CREATE TRIGGER nb_test_reject_job BEFORE INSERT ON nb_jobs FOR EACH ROW EXECUTE FUNCTION nb_test_reject_job()');
      try { assert.equal((await finalize(novel.id, 1)).status, 500); assert.deepEqual(await counts(), { revisions: 0, jobs: 0, requests: 0 }); assert.equal((await store.snapshot('alice', novel.id)).novel.epoch, 0); assert.equal(await store.chapter('alice', novel.id, 1), null); }
      finally { await store.pool.query('DROP TRIGGER nb_test_reject_job ON nb_jobs'); await store.pool.query('DROP FUNCTION nb_test_reject_job()'); }
    });
    await t.test('earlier revision and canon changes invalidate downstream chapters; review clears one at a time', async () => {
      await reset(); const novel = await create();
      await finalize(novel.id, 1); await finalize(novel.id, 2); await finalize(novel.id, 3);
      const revised = await finalize(novel.id, 1, input(1)); assert.deepEqual(revised.body.invalidatedChapters, [2, 3]);
      const blocked = await request(`/novels/${novel.id}/context`, { chapterNumber: 4, query: '' });
      assert.equal(blocked.status, 409); assert.deepEqual(blocked.body.error.details.chapters, [2, 3]); assert.equal(services.state.recalls.length, 0);
      await finalize(novel.id, 2, input(1)); assert.equal((await store.chapter('alice', novel.id, 2)).needsReview, false); assert.equal((await store.chapter('alice', novel.id, 3)).needsReview, true);
      const canon = await request(`/novels/${novel.id}/canon`, { expectedRevision: 0, canon: '新设定' }, { method: 'PUT' }); assert.equal(canon.status, 200);
      assert.equal((await request(`/novels/${novel.id}/canon`, { expectedRevision: 0, canon: '冲突' }, { method: 'PUT' })).status, 409);
      await request(`/novels/${novel.id}/canon`, { expectedRevision: 1, canon: '第二版设定' }, { method: 'PUT' });
      assert.deepEqual((await store.pool.query('SELECT revision,canon FROM nb_canon_revisions WHERE novel_id=$1 ORDER BY revision', [novel.id])).rows, [{ revision: 1, canon: '新设定' }, { revision: 2, canon: '第二版设定' }]);
      assert.deepEqual((await store.snapshot('alice', novel.id)).chapters.map(c => c.needsReview), [true, true, true]);
    });
    await t.test('empty novel skips recall; provenance filtering rejects future and superseded data', async () => {
      await reset(); const novel = await create();
      assert.equal((await request(`/novels/${novel.id}/context`, { chapterNumber: 1, query: '开篇' })).status, 200); assert.equal(services.state.recalls.length, 0);
      await finalize(novel.id, 1); await finalize(novel.id, 1, input(1)); await finalize(novel.id, 2);
      const fact = (number, revision, extra = {}) => ({ text: `事实${number}-${revision}`, type: 'world', document_id: `chapter-${number}`, metadata: { novel_id: novel.id, chapter_no: String(number), revision: String(revision) }, tags: [`ch-${number}-r-${revision}`], ...extra });
      services.state.facts = [fact(1, 2), fact(1, 1), fact(2, 1), fact(1, 2, { metadata: {} }), fact(1, 2, { type: 'observation' })];
      const result = await request(`/novels/${novel.id}/context`, { chapterNumber: 2, query: '继续' });
      assert.equal(result.status, 200); assert.deepEqual(result.body.sources, [{ chapterNumber: 1, revision: 2, text: '事实1-2' }]);
      assert.deepEqual(services.state.recalls[0].body.tags, ['ch-1-r-2']); assert.equal(services.state.recalls[0].body.tags_match, 'any_strict');
      assert.deepEqual(services.state.recalls[0].body.types, ['world', 'experience']);
    });
    await t.test('novel epoch change during external recall rejects stale snapshot', async () => {
      await reset(); const novel = await create(); await finalize(novel.id, 1);
      services.state.onRecall = async () => { await store.saveCanon('alice', novel.id, { expectedRevision: 0, canon: 'changed' }); };
      const result = await request(`/novels/${novel.id}/context`, { chapterNumber: 2, query: '' });
      assert.equal(result.status, 409); assert.equal(result.body.error.code, 'CONTEXT_CHANGED');
    });
    await t.test('analysis remains read-only, validates JSON and recall failure aborts analysis', async () => {
      await reset(); const novel = await create();
      const before = await counts();
      const result = await request(`/novels/${novel.id}/analyze`, { chapterNumber: 1, content: '主角进入山林。' });
      assert.equal(result.status, 200); assert.equal(result.body.sourceHash.length, 64); assert.deepEqual(await counts(), before);
      assert.equal(services.state.analyses[0].model, 'gpt-5.6-luna');
      services.state.analysisMalformed = true;
      const bad = await request(`/novels/${novel.id}/analyze`, { chapterNumber: 1, content: '草稿' }); assert.equal(bad.status, 502); assert.equal(bad.body.error.code, 'ANALYSIS_FAILED');
      await finalize(novel.id, 1); services.state.recallMalformed = true;
      const numberOfAnalyses = services.state.analyses.length;
      assert.equal((await request(`/novels/${novel.id}/analyze`, { chapterNumber: 2, content: '草稿' })).body.error.code, 'RECALL_FAILED'); assert.equal(services.state.analyses.length, numberOfAnalyses);
    });
    await t.test('analysis surfaces fact-budget warnings from context construction', async () => {
      await reset(); const novel = await create();
      await store.saveCanon('alice', novel.id, { expectedRevision: 0, canon: '设'.repeat(14900) });
      await finalize(novel.id, 1, input(0, { summary: '摘'.repeat(5900) }));
      services.state.facts = [{ text: '史'.repeat(5000), type: 'world', document_id: 'chapter-1', metadata: { novel_id: novel.id, chapter_no: '1', revision: '1' }, tags: ['ch-1-r-1'] }];
      const response = await request(`/novels/${novel.id}/analyze`, { chapterNumber: 2, content: '草稿', query: '纲'.repeat(7900) });
      assert.equal(response.status, 200);
      assert.ok(response.body.warnings.includes('部分检索事实因上下文预算未注入'));
    });
    await t.test('lost retain acknowledgement recovers after worker restart by polling same persisted operation', async () => {
      await reset(); const novel = await create(), receipt = (await finalize(novel.id, 1)).body;
      const original = await job(receipt.jobId); services.state.lostAcknowledgements = 1;
      await worker().tick(); assert.equal((await job(receipt.jobId)).status, 'retry'); assert.equal(services.state.retains.length, 1);
      await worker().tick(); assert.equal((await job(receipt.jobId)).status, 'processing'); assert.equal(services.state.retains.length, 1);
      services.state.operations.get(original.operation_id).status = 'completed';
      await worker().tick(); const done = await job(receipt.jobId); assert.equal(done.status, 'synced'); assert.equal(done.operation_id, original.operation_id); assert.equal(done.exported, true);
      assert.equal(services.state.banks[0].body.enable_observations, false); assert.equal(services.state.banks[0].body.enable_temporal_retrieval, false);
      assert.equal(services.state.retains[0].body.items[0].update_mode, 'replace');
    });
    await t.test('paused unknown operation preserves UUID on manual retry and blocks only its own later revisions', async () => {
      await reset(); const novel = await create(), first = (await finalize(novel.id, 1)).body;
      const second = (await finalize(novel.id, 1, input(1))).body, other = (await finalize(novel.id, 2)).body;
      const original = await job(first.jobId); services.state.operationTransport = true;
      await worker().tick(); await worker().tick(); assert.equal((await job(first.jobId)).status, 'paused');
      assert.equal((await job(second.jobId)).status, 'queued'); assert.equal((await job(other.jobId)).status, 'paused');
      services.state.operationTransport = false;
      assert.equal((await request(`/novels/${novel.id}/jobs/${first.jobId}/retry`, {})).status, 200); assert.equal((await job(first.jobId)).operation_id, original.operation_id);
      await request(`/novels/${novel.id}/jobs/${other.jobId}/retry`, {});
      await worker().tick(); assert.equal((await job(first.jobId)).status, 'processing'); assert.equal((await job(other.jobId)).status, 'processing'); assert.equal((await job(second.jobId)).status, 'queued');
      const detail = await store.detail('alice', novel.id); assert.equal(detail.jobs.find(j => j.id === second.jobId).blockedByEarlierJob, true);
    });
    await t.test('terminal failure retry allocates a new durable identity and same-chapter ordering stays serial', async () => {
      await reset(); const novel = await create(), first = (await finalize(novel.id, 1)).body, second = (await finalize(novel.id, 1, input(1))).body;
      await worker().tick(); const original = await job(first.jobId); services.state.operations.get(original.operation_id).status = 'failed';
      await worker().tick(); assert.equal((await job(first.jobId)).status, 'failed'); assert.equal((await job(second.jobId)).status, 'queued');
      await request(`/novels/${novel.id}/jobs/${first.jobId}/retry`, {}); const retried = await job(first.jobId); assert.notEqual(retried.operation_id, original.operation_id);
      await worker().tick(); services.state.operations.get(retried.operation_id).status = 'completed'; await worker().tick();
      assert.equal((await job(first.jobId)).status, 'synced'); await worker().tick();
      assert.equal((await job(second.jobId)).status, 'processing');
      assert.deepEqual(services.state.retains.map(r => r.body.items[0].metadata.revision), ['1', '1', '2']);
    });
    await t.test('disk export failure retains immutable SQL chapter and exposes retry status without submission', async () => {
      await reset(); const novel = await create(), receipt = (await finalize(novel.id, 1)).body;
      const blockedRoot = path.join(exportRoot, 'file-as-root'); await writeFile(blockedRoot, 'block');
      await new Worker(store, hindsight, { exportRoot: blockedRoot, retryBaseMs: 0 }).tick();
      assert.equal((await job(receipt.jobId)).status, 'retry'); assert.equal((await job(receipt.jobId)).error, 'export_failed'); assert.equal(services.state.retains.length, 0);
      assert.equal((await store.chapter('alice', novel.id, 1)).content, '主角进入山林。');
    });
    await t.test('two worker instances cannot submit overlapping updates', async () => {
      await reset(); const novel = await create(); await finalize(novel.id, 1);
      await Promise.all([worker().tick(), worker().tick()]); assert.equal(services.state.retains.length, 1);
    });
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await services.close(); await store.close(); await rm(exportRoot, { recursive: true, force: true });
  }
});
