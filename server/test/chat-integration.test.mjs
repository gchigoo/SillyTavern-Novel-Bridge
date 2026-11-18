import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { ChatStore, ChatHindsight, ChatWorker, messageHash, chatTag } from '../src/chat-memory.mjs';
import { createApp } from '../src/server.mjs';
import { startMockServices } from './mock-services.mjs';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^novel_bridge_test(?:_[a-z0-9]+)?$/.test(decodeURIComponent(new URL(url).pathname.slice(1)))) throw new Error('Refusing non-disposable integration database');
const secret = 'test-only-chat-memory-gateway-123456', origin = 'https://tavern.example';
const message = (content = '人物进入白塔', extra = {}) => { const m = { id: randomUUID(), role: 'assistant', name: '人物', content, ...extra }; return { ...m, hash: messageHash(m) }; };
const manifest = messages => messages.map(({ id, hash }) => ({ id, hash }));

test('automatic memory HTTP and durable PostgreSQL reconciliation with real HTTP provider simulation', async t => {
  const store = new Store(url); await store.migrate(); const chat = new ChatStore(store);
  const services = await startMockServices(), state = services.state;
  const provider = new ChatHindsight({ url: services.url, key: 'test', operationTimeout: 500, recallTimeout: 1000 });
  const app = createApp({ store, hindsight: provider, chatHindsight: provider, analyzer: {}, gatewaySecret: secret, publicOrigin: origin });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/novel-bridge/api`;
  const exportRoot = await mkdtemp(path.join(tmpdir(), 'nb-chat-'));
  const worker = () => new ChatWorker(chat, provider, { exportRoot, pollMs: 0, retryBaseMs: 0, maxAttempts: 2 });
  const request = async (route, body, options = {}) => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Novel-Gateway': options.secret || secret, 'X-Novel-User': options.owner || 'alice', Origin: options.origin || origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const open = async () => { const id = randomUUID(); assert.equal((await request('/chats', { id, binding: 'a'.repeat(64) })).status, 200); return id; };
  const stage = (id, messages) => request(`/chats/${id}/stage`, { messages });
  const sync = (id, expectedEpoch, messages) => request(`/chats/${id}/sync`, { expectedEpoch, entries: manifest(messages) });
  const context = (id, expectedEpoch, exclude = []) => request(`/chats/${id}/context`, { expectedEpoch, exclude, query: '白塔' });
  const jobs = async id => (await store.pool.query('SELECT * FROM nb_chat_jobs WHERE vault_id=$1 ORDER BY created_at,revision,id', [id])).rows;
  const reset = async () => {
    await store.pool.query('TRUNCATE nb_chat_jobs,nb_chat_entries,nb_chat_revisions,nb_chat_objects,nb_chat_vaults');
    state.operations.clear(); state.retains.length = 0; state.recalls.length = 0; state.deletes.length = 0;
    state.facts = []; state.operationTransport = false; state.deleteTransport = false; state.lostAcknowledgements = 0; state.onRecall = null;
  };
  const complete = async () => { for (const op of state.operations.values()) op.status = 'completed'; await worker().tick(); };
  const fact = (id, m, revision, extra = {}) => ({ text: m.content, type: 'world', document_id: `message-${m.id}`, metadata: { vault_id: id, message_id: m.id, revision: String(revision), role: m.role }, tags: [chatTag(m.id, revision)], ...extra });
  try {
    await t.test('ownership, gateway, CSRF, strict validation and bound vault identity', async () => {
      await reset(); const id = await open(), m = message();
      assert.equal((await request('/chats', { id, binding: 'a'.repeat(64) }, { owner: 'bob' })).status, 404);
      assert.equal((await request('/chats', { id, binding: 'b'.repeat(64) })).status, 409);
      for (const [route, body] of [[`/chats/${id}`], [`/chats/${id}/stage`, { messages: [m] }], [`/chats/${id}/sync`, { expectedEpoch: 0, entries: [] }], [`/chats/${id}/context`, { expectedEpoch: 0, query: '' }], [`/chats/${id}/retry`, {}]]) {
        assert.equal((await request(route, body, { owner: 'bob' })).status, 404, route);
        assert.equal((await request(route, body, { secret: 'bad' })).status, 401, route);
        if (body) assert.equal((await request(route, body, { origin: 'https://evil.test' })).status, 403, route);
      }
      assert.equal((await stage(id, [{ ...m, hash: 'b'.repeat(64) }])).status, 400);
      assert.equal((await sync(id, 0, [m])).body.error.code, 'MESSAGE_MISSING');
      assert.equal((await stage(id, [m])).status, 200);
      assert.equal((await sync(id, 0, [m, m])).status, 400);
    });
    await t.test('staging never indexes; atomic active manifest, idempotent lost receipt, revision, restore and reorder', async () => {
      await reset(); const id = await open(), a = message(), b = message('用户要求去黑塔', { role: 'user' });
      await stage(id, [a, b]); await worker().tick(); assert.equal(state.retains.length, 0);
      assert.deepEqual((await sync(id, 0, [a, b])).body, { epoch: 1 });
      assert.deepEqual((await sync(id, 0, [a, b])).body, { epoch: 1 }); assert.equal((await jobs(id)).length, 2);
      assert.equal((await sync(id, 0, [b, a])).status, 409);
      assert.equal((await sync(id, 1, [b, a])).body.epoch, 2); assert.equal((await jobs(id)).length, 2);
      const edited = message('人物改去黑塔', { id: a.id }); await stage(id, [edited]); await sync(id, 2, [edited, b]);
      await sync(id, 3, [b]); await sync(id, 4, [a, b]);
      assert.deepEqual((await jobs(id)).filter(j => j.message_id === a.id).map(j => j.revision), [1, 2, 3, 4]);
      assert.deepEqual((await chat.state('alice', id)).entries, manifest([a, b]));
      assert.equal((await store.pool.query('SELECT count(*)::int AS n FROM nb_chat_objects WHERE vault_id=$1', [id])).rows[0].n, 3);
    });
    await t.test('concurrent snapshots have one winner and failed outbox insertion rolls back every active change', async () => {
      await reset(); const id = await open(), a = message(), b = message('另一个回复'); await stage(id, [a, b]);
      assert.deepEqual((await Promise.all([sync(id, 0, [a]), sync(id, 0, [b])])).map(r => r.status).sort(), [200, 409]);
      const before = await chat.state('alice', id);
      await store.pool.query("CREATE FUNCTION nb_chat_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END $$");
      await store.pool.query('CREATE TRIGGER nb_chat_test_reject BEFORE INSERT ON nb_chat_jobs FOR EACH ROW EXECUTE FUNCTION nb_chat_test_reject()');
      try {
        assert.equal((await sync(id, 1, [])).status, 500);
        assert.deepEqual(await chat.state('alice', id), before);
      } finally { await store.pool.query('DROP TRIGGER nb_chat_test_reject ON nb_chat_jobs'); await store.pool.query('DROP FUNCTION nb_chat_test_reject()'); }
    });
    await t.test('recall filters unindexed, superseded, deleted, foreign, missing-source and excluded target facts', async () => {
      await reset(); const id = await open(), a = message(), b = message('用户提出去黑塔', { role: 'user' });
      await stage(id, [a, b]); await sync(id, 0, [a, b]);
      assert.equal((await context(id, 1)).body.sources.length, 0); assert.equal(state.recalls.length, 0);
      await worker().tick(); await complete();
      state.facts = [fact(id, a, 1), fact(id, b, 1), fact(id, a, 0), fact(id, a, 1, { metadata: {} }), fact(id, a, 1, { bank_id: 'chat-foreign' }), fact(id, a, 1, { type: 'observation' })];
      assert.equal((await context(id, 1)).body.sources.length, 2);
      assert.equal((await context(id, 1, [a.id])).body.sources.length, 1);
      const edited = message('改写后的剧情', { id: a.id }); await stage(id, [edited]); await sync(id, 1, [edited]);
      assert.equal((await context(id, 2)).body.sources.length, 0);
      await worker().tick(); await complete();
      state.facts.push(fact(id, edited, 2)); const r = await context(id, 2);
      assert.equal(r.body.sources.length, 1); assert.equal(r.body.sources[0].revision, 2);
      assert.match(r.body.contextText, /角色卡、世界书/);
    });
    await t.test('epoch drift during recall aborts stale context', async () => {
      await reset(); const id = await open(), a = message(); await stage(id, [a]); await sync(id, 0, [a]); await worker().tick(); await complete();
      state.onRecall = () => chat.sync('alice', id, { expectedEpoch: 1, entries: [] });
      assert.equal((await context(id, 1)).status, 409);
    });
    await t.test('oversized valid facts report server budget omission even when no source fits', async () => {
      await reset(); const id = await open(), a = message(); await stage(id, [a]); await sync(id, 0, [a]); await worker().tick(); await complete();
      state.facts = [fact(id, a, 1, { text: '史'.repeat(12001) })];
      const response = await context(id, 1);
      assert.equal(response.status, 200); assert.equal(response.body.sources.length, 0);
      assert.ok(response.body.warnings.some(warning => warning.includes('服务端上下文预算')));
      state.facts.push(fact(id, a, 1, { text: '可容纳的较短事实' }));
      const mixed = await context(id, 1); assert.equal(mixed.body.sources.length, 1); assert.equal(mixed.body.warnings.length, 1);
    });
    await t.test('unknown retain survives restart and blocks delete until confirmed complete; delete retries safely', async () => {
      await reset(); const id = await open(), a = message(); await stage(id, [a]); await sync(id, 0, [a]);
      const original = (await jobs(id))[0]; state.lostAcknowledgements = 1;
      await worker().tick(); assert.equal((await jobs(id))[0].status, 'retry');
      await sync(id, 1, []); await worker().tick(); assert.equal(state.retains.length, 1); assert.equal(state.deletes.length, 0);
      assert.equal((await jobs(id))[0].operation_id, original.operation_id);
      await complete(); state.deleteTransport = true; await worker().tick(); assert.equal((await jobs(id))[1].status, 'retry');
      state.deleteTransport = false; await worker().tick(); assert.equal((await jobs(id))[1].status, 'synced');
      assert.equal(state.deletes.length, 2);
      const exported = JSON.parse(await readFile(path.join(exportRoot, `chat-${id}`, a.id, 'r1.json'), 'utf8'));
      assert.equal(exported.content, a.content);
      assert.equal(JSON.parse(await readFile(path.join(exportRoot, `chat-${id}`, a.id, 'r2.json'), 'utf8')).deleted, true);
    });
    await t.test('paused unknown operations keep identity; terminal retry rotates identity; worker lock prevents double submission', async () => {
      await reset(); const id = await open(), a = message(); await stage(id, [a]); await sync(id, 0, [a]);
      const original = (await jobs(id))[0]; state.operationTransport = true; await worker().tick(); await worker().tick();
      assert.equal((await jobs(id))[0].status, 'paused');
      await request(`/chats/${id}/retry`, {}); assert.equal((await jobs(id))[0].operation_id, original.operation_id);
      state.operationTransport = false; await Promise.all([worker().tick(), worker().tick()]); assert.equal(state.retains.length, 1);
      state.operations.get(original.operation_id).status = 'failed'; await worker().tick();
      await request(`/chats/${id}/retry`, {}); assert.notEqual((await jobs(id))[0].operation_id, original.operation_id);
      await worker().tick(); assert.equal(state.retains.length, 2);
      const sent = state.retains[0].body.items[0]; assert.equal(sent.update_mode, 'replace'); assert.equal(sent.document_id, `message-${a.id}`);
      assert.equal(state.banks.at(-1).body.enable_observations, false);
    });
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await services.close(); await store.close(); await rm(exportRoot, { recursive: true, force: true });
  }
});
