import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ChatMemory, bodyHash, bodyOf, verifyChatCheckpoint } from '../../chat-memory.js';

function fixture() {
  const events = new Map(), calls = [], states = new Map();
  let prompt = '', message = '', hook, saves = 0, persisted = {}, ignoreMetadataSave = false;
  const c = { chatId: 'story', characterId: 0, characters: [{ avatar: 'card.png' }], chat: [], chatMetadata: { integrity: crypto.randomUUID() },
    saveMetadataDebounced() {}, async saveMetadata() { if (!ignoreMetadataSave) persisted = structuredClone(c.chatMetadata); }, async saveChat() { saves++; }, getTokenCountAsync: async text => text.length, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    eventTypes: Object.fromEntries(['CHAT_CHANGED', 'GENERATION_AFTER_COMMANDS', 'MESSAGE_RECEIVED', 'GENERATION_STOPPED', 'GENERATION_ENDED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED', 'MESSAGE_SENT'].map(s => [s, s])),
    eventSource: { on: (name, fn) => events.set(name, fn) },
  };
  const request = async (path, body) => {
    calls.push({ path, body: structuredClone(body) });
    if (hook) await hook(path, body);
    if (path === '/chats') { if (!states.has(body.id)) states.set(body.id, { epoch: 0, entries: [], jobs: [] }); return { id: body.id }; }
    const [, , id, action] = path.split('/'), state = states.get(id);
    if (!action) return structuredClone(state);
    if (action === 'stage') return {};
    if (action === 'sync') {
      if (JSON.stringify(state.entries) !== JSON.stringify(body.entries)) {
        if (body.expectedEpoch !== state.epoch) throw new Error('聊天记忆版本已变更');
        state.epoch++; state.entries = structuredClone(body.entries);
      }
      return { epoch: state.epoch };
    }
    if (action === 'context') return { contextText: '历史资料\n以前的人物关系', sources: [{ text: '以前的人物关系' }], warnings: [] };
    return {};
  };
  const memory = new ChatMemory({ context: () => c, request, setPrompt: value => { prompt = value; }, report: value => { message = value; }, verifyCheckpoint: (ctx, expected) => verifyChatCheckpoint(ctx, expected, async (route, options) => { calls.push({ path: route, body: JSON.parse(options.body) }); return { ok: true, json: async () => [{ chat_metadata: persisted }] }; }) });
  memory.installEvents();
  const emit = (name, ...args) => events.get(name)?.(...args);
  const flush = async () => { await delay(220); await memory.tail; clearTimeout(memory.timer); };
  const state = () => states.get(memory.settings().id);
  const user = text => ({ is_user: true, name: '作者', mes: text });
  const assistant = text => ({ is_user: false, name: '角色', mes: text });
  const dispose = () => { clearTimeout(memory.timer); clearTimeout(memory.finishTimer); };
  return { c, memory, calls, emit, flush, state, user, assistant, dispose, setHook: fn => { hook = fn; }, ignoreMetadataSave: value => { ignoreMetadataSave = value; }, prompt: () => prompt, status: () => message, saves: () => saves };
}

test('automatic ST lifecycle stores only complete selected replies, then updates edits, swipe and deletion', async () => {
  const f = fixture();
  try {
    f.c.chat = [f.user('续写去白塔的旅程')]; await f.memory.toggle(true);
    let aborted = false;
    await f.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
    await f.memory.intercept([], 32000, () => { aborted = true; }, 'normal');
    assert.equal(aborted, false); assert.match(f.prompt(), /历史资料/);
    assert.match(f.calls.find(x => x.path.endsWith('/context')).body.query, /续写去白塔/);
    const response = f.assistant('林岚到达白塔'); f.c.chat.push(response);
    await f.emit('MESSAGE_RECEIVED', 1); f.emit('GENERATION_ENDED'); await f.flush();
    assert.equal(f.state().entries.length, 2); assert.equal(f.c.chatMetadata.novelBridgeMemory.pending, undefined);
    const id = response.novelBridgeMemory.id, original = f.state().entries[1].hash;
    response.mes = '林岚到达黑塔'; await f.emit('MESSAGE_EDITED', 1); await f.memory.refresh();
    assert.equal(f.state().entries[1].id, id); assert.notEqual(f.state().entries[1].hash, original);
    response.mes = '林岚留在港口'; f.emit('MESSAGE_SWIPED', 1); await f.memory.refresh();
    assert.equal(f.state().entries[1].id, id);
    f.c.chat.pop(); f.emit('MESSAGE_DELETED', 1); await f.memory.refresh();
    assert.equal(f.state().entries.length, 1);
    assert.equal(f.c.characters[0].avatar, 'card.png');
  } finally { f.dispose(); }
});

test('stopped and errored streams do not enter memory; editing a partial reply accepts its revised text', async () => {
  for (const stopped of [true, false]) {
    const f = fixture();
    try {
      f.c.chat = [f.user('继续')]; await f.memory.toggle(true);
      f.memory.start('normal', {}, false); await f.memory.intercept([], 8000, () => assert.fail('aborted'), 'normal');
      f.c.chat.push(f.assistant('未完成的半句'));
      f.c.streamingProcessor = { isFinished: stopped, isStopped: !stopped, abortController: { signal: { aborted: true } }, messageId: 1 };
      f.emit('GENERATION_ENDED'); if (stopped) f.emit('GENERATION_STOPPED');
      await f.emit('MESSAGE_RECEIVED', 1); await f.flush();
      assert.equal(f.state().entries.length, 1);
      await f.memory.chatChanged(); assert.equal(f.state().entries.length, 1);
      f.c.chat[1].mes = '编辑完成后的整句'; await f.emit('MESSAGE_EDITED', 1); await f.memory.refresh();
      assert.equal(f.state().entries.length, 2);
    } finally { f.dispose(); }
  }
});

test('stream ENDED before a delayed received handler still accepts final text, but not an aborted stream', async () => {
  const f = fixture();
  try {
    f.c.chat = [f.user('继续')]; await f.memory.toggle(true);
    f.memory.start('normal', {}, false); await f.memory.intercept([], 8000, () => {}, 'normal');
    f.c.chat.push(f.assistant('完整的流式回复'));
    f.c.streamingProcessor = { isFinished: true, isStopped: false, abortController: { signal: { aborted: false } }, messageId: 1 };
    f.emit('GENERATION_ENDED'); await f.flush();
    assert.equal(f.state().entries.length, 2);
  } finally { f.dispose(); }
});

test('continue excludes the replaced source from recall; regenerate removes the prior reply; crash recovery excludes unfinished text', async () => {
  const f = fixture();
  try {
    f.c.chat = [f.user('继续'), f.assistant('原回复')]; await f.memory.toggle(true);
    const id = f.c.chat[1].novelBridgeMemory.id;
    f.memory.start('continue', {}, false); await f.memory.intercept([], 8000, () => {}, 'continue');
    assert.deepEqual(f.calls.filter(x => x.path.endsWith('/context')).at(-1).body.exclude, [id]);
    f.c.chat[1].mes += ' 中断的续写';
    // Reload without any terminal event simulates browser closure/crash.
    await f.memory.chatChanged(); assert.equal(f.state().entries.length, 1);
    f.c.chat[1].mes = '原回复'; await f.emit('MESSAGE_EDITED', 1); await f.memory.refresh(); assert.equal(f.state().entries.length, 2);
    f.memory.start('regenerate', {}, false); f.c.chat.pop(); f.emit('MESSAGE_DELETED', 1);
    await f.memory.intercept([], 8000, () => {}, 'regenerate');
    assert.equal(f.state().entries.length, 1);
  } finally { f.dispose(); }
});

test('late cleanup after stopped stream stays excluded, including when swiping back; explicit edit can accept it', async () => {
  const f = fixture();
  try {
    f.c.chat = [f.user('继续')]; await f.memory.toggle(true);
    f.memory.start('normal', {}, false); await f.memory.intercept([], 8000, () => {}, 'normal');
    f.c.chat.push({ ...f.assistant('未完成的句子...'), swipe_id: 0, gen_started: '2026-11-18T00:00:00Z' });
    f.c.streamingProcessor = { isFinished: true, isStopped: false, abortController: { signal: { aborted: true } }, messageId: 1 };
    f.emit('GENERATION_STOPPED'); await f.flush(); assert.equal(f.state().entries.length, 1);
    f.c.chat[1].mes = '未完成的句子';
    await f.emit('MESSAGE_RECEIVED', 1); await f.memory.refresh(); assert.equal(f.state().entries.length, 1);
    f.c.chat[1].swipe_id = 1; f.c.chat[1].mes = '先前完整的另一条回复';
    f.emit('MESSAGE_SWIPED', 1); await f.memory.refresh(); assert.equal(f.state().entries.length, 2);
    f.c.chat[1].swipe_id = 0; f.c.chat[1].mes = '未完成的句子';
    f.emit('MESSAGE_SWIPED', 1); await f.memory.refresh(); assert.equal(f.state().entries.length, 1);
    await f.emit('MESSAGE_EDITED', 1); await f.memory.refresh(); assert.equal(f.state().entries.length, 2);
  } finally { f.dispose(); }
});

test('stopping a continuation before any content changes preserves the previously complete reply', async () => {
  const f = fixture();
  try {
    f.c.chat = [f.user('继续'), f.assistant('先前完整的回复')]; await f.memory.toggle(true);
    f.memory.start('continue', {}, false); await f.memory.intercept([], 8000, () => {}, 'continue');
    f.c.streamingProcessor = { isFinished: true, isStopped: false, abortController: { signal: { aborted: true } }, messageId: 1 };
    f.emit('GENERATION_STOPPED'); await f.emit('MESSAGE_RECEIVED', 1); await f.flush();
    assert.equal(f.state().entries.length, 2);
  } finally { f.dispose(); }
});

test('stopped variants are latched before hashing and cannot be accepted by an immediate swipe away and back', async () => {
  for (const stopEvent of ['GENERATION_STOPPED', 'GENERATION_ENDED']) {
    const f = fixture(); let release;
    try {
      f.c.chat = [f.user('继续'), { ...f.assistant('原先完整回复'), swipe_id: 0 }]; await f.memory.toggle(true);
      f.memory.start('swipe', {}, false); await f.memory.intercept([], 8000, () => {}, 'swipe');
      const response = f.c.chat[1]; response.swipe_id = 1; response.mes = '中止候选半句话';
      f.c.streamingProcessor = { isFinished: true, isStopped: false, messageId: 1, abortController: { signal: { aborted: true } } };
      const gate = new Promise(r => { release = r; }); f.memory.enqueue(() => gate);
      f.emit(stopEvent);
      assert.equal(response.novelBridgeMemory.incomplete.length, 1);
      assert.equal(response.novelBridgeMemory.incomplete[0].hash, null);
      response.swipe_id = 0; response.mes = '原先完整回复'; const away = f.emit('MESSAGE_SWIPED', 1);
      response.swipe_id = 1; response.mes = '中止候选半句话'; const back = f.emit('MESSAGE_SWIPED', 1);
      release(); await Promise.all([away, back]); await f.flush();
      assert.equal(f.state().entries.length, 1);
      assert.ok(response.novelBridgeMemory.incomplete[0].hash);
      response.swipe_id = 0; response.mes = '原先完整回复'; await f.emit('MESSAGE_SWIPED', 1); await f.memory.refresh();
      assert.equal(f.state().entries.length, 2);
      await f.memory.chatChanged();
      response.swipe_id = 1; response.mes = '中止候选半句话'; await f.emit('MESSAGE_SWIPED', 1); await f.memory.refresh();
      assert.equal(f.state().entries.length, 1);
      await f.emit('MESSAGE_EDITED', 1); await f.memory.refresh(); assert.equal(f.state().entries.length, 2);
    } finally { release?.(); f.dispose(); }
  }
});

test('a new generation cannot cancel the stopped-variant latch or stage its partial text', async () => {
  const f = fixture();
  try {
    f.c.chat = [f.user('继续')]; await f.memory.toggle(true);
    f.memory.start('normal', {}, false); await f.memory.intercept([], 8000, () => {}, 'normal');
    f.c.chat.push({ ...f.assistant('中止后立刻继续的半句话'), swipe_id: 0 });
    f.c.streamingProcessor = { isFinished: true, isStopped: false, messageId: 1, abortController: { signal: { aborted: true } } };
    f.emit('GENERATION_STOPPED');
    f.memory.start('continue', {}, false);
    await f.memory.intercept([], 8000, () => assert.fail('new generation aborted'), 'continue');
    assert.equal(f.state().entries.length, 1);
    assert.ok(!f.calls.filter(call => call.path.endsWith('/stage')).flatMap(call => call.body.messages).some(message => message.content === '中止后立刻继续的半句话'));
    f.c.chat[1].mes = '后续真正完成的完整回复';
    f.c.streamingProcessor = { isFinished: true, isStopped: false, messageId: 1, abortController: { signal: { aborted: false } } };
    await f.emit('MESSAGE_RECEIVED', 1); f.emit('GENERATION_ENDED'); await f.flush();
    assert.equal(f.state().entries.length, 2);
  } finally { f.dispose(); }
});

test('a provisional stopped marker saved before hashing survives reload while another swipe is selected', async () => {
  const f = fixture(), restored = fixture(); let release;
  try {
    f.c.chat = [f.user('继续'), { ...f.assistant('旧的完整回复'), swipe_id: 0 }]; await f.memory.toggle(true);
    f.memory.start('swipe', {}, false); await f.memory.intercept([], 8000, () => {}, 'swipe');
    f.c.chat[1].mes = '崩溃前的半句'; f.c.chat[1].swipe_id = 1;
    f.c.streamingProcessor = { isFinished: true, isStopped: false, messageId: 1, abortController: { signal: { aborted: true } } };
    const gate = new Promise(r => { release = r; }); f.memory.enqueue(() => gate); f.emit('GENERATION_STOPPED');
    f.c.chat[1].mes = '旧的完整回复'; f.c.chat[1].swipe_id = 0;
    restored.c.chat = structuredClone(f.c.chat); restored.c.chatMetadata = structuredClone(f.c.chatMetadata);
    assert.equal(restored.c.chat[1].novelBridgeMemory.incomplete[0].hash, null);
    release(); await f.memory.tail;
    await restored.memory.chatChanged(); assert.equal(restored.state().entries.length, 2);
    restored.c.chat[1].mes = '崩溃前的半句'; restored.c.chat[1].swipe_id = 1;
    await restored.emit('MESSAGE_SWIPED', 1); await restored.memory.refresh();
    assert.equal(restored.state().entries.length, 1);
  } finally { release?.(); f.dispose(); restored.dispose(); }
});

test('copied chat metadata forks memory; system/tool messages and unselected swipes stay out', async () => {
  const f = fixture();
  try {
    f.c.chat = [f.user('a'), { ...f.assistant('selected'), swipes: ['old', 'selected'] }, { is_system: true, mes: 'tool data' }, { mes: 'call', extra: { tool_invocations: [{}] } }];
    await f.memory.toggle(true); const first = f.memory.settings().id;
    f.c.chatId = 'branch'; f.c.chatMetadata = structuredClone(f.c.chatMetadata);
    await f.memory.chatChanged(); assert.notEqual(f.memory.settings().id, first);
    assert.equal(f.state().entries.length, 2);
    assert.ok(!f.calls.filter(x => x.path.endsWith('/stage')).flatMap(x => x.body.messages).some(x => x.content === 'old' || x.content === 'tool data' || x.content === 'call'));
  } finally { f.dispose(); }
});

test('delayed recall cannot inject across a chat switch, edit or disabled mode', async () => {
  for (const change of ['switch', 'edit', 'disable']) {
    const f = fixture();
    try {
      f.c.chat = [f.user('query')]; await f.memory.toggle(true);
      f.setHook(async path => { if (!path.endsWith('/context')) return; if (change === 'switch') { f.c.chatId = 'other'; f.c.chatMetadata = {}; } else if (change === 'edit') f.c.chat[0].mes = 'new query'; else await f.memory.toggle(false); });
      let aborted = false; await f.memory.intercept([], 8000, () => { aborted = true; }, 'normal');
      assert.equal(aborted, true); assert.equal(f.prompt(), '');
    } finally { f.dispose(); }
  }
});

test('network failure preserves local source; stale competing session cannot silently overwrite remote manifest', async () => {
  const f = fixture();
  try {
    f.c.chat = [f.user('one')]; await f.memory.toggle(true);
    const original = structuredClone(f.state().entries);
    f.c.chat[0].mes = 'two'; f.setHook(path => { if (path.endsWith('/sync')) throw new Error('offline'); });
    await assert.rejects(f.memory.refresh(), /offline/); assert.deepEqual(f.state().entries, original);
    f.setHook(null); f.state().epoch++;
    await assert.rejects(f.memory.refresh(), /版本已变更/); assert.deepEqual(f.state().entries, original);
    assert.equal(f.c.chat[0].mes, 'two');
  } finally { f.dispose(); }
});

test('recall uses bounded chat text, token budget and valid hashes; quiet/dry runs never synchronize', async () => {
  const f = fixture();
  try {
    f.c.chat = [f.user('作者要求')]; await f.memory.toggle(true);
    assert.equal(f.state().entries[0].hash, await bodyHash(bodyOf(f.c.chat[0])));
    const before = f.calls.length;
    f.memory.start('normal', {}, true); assert.equal(f.memory.generation, null);
    await f.memory.intercept([], 1000, () => assert.fail('aborted quiet'), 'quiet'); assert.equal(f.calls.length, before);
    await f.memory.intercept([], 10, () => assert.fail('aborted'), 'normal'); assert.equal(f.prompt(), '');
  } finally { f.dispose(); }
});

test('group speaker changes and single-chat avatar rename preserve vault and pending state; freshness checks are read-only', async () => {
  for (const group of [false, true]) {
    const f = fixture();
    try {
      if (group) f.c.groupId = 'group-one';
      f.c.characters.push({ avatar: 'second.png' }); f.c.chat = [f.user('继续')];
      await f.memory.toggle(true);
      const id = f.memory.settings().id, ticket = f.memory.ticket();
      f.memory.start('normal', {}, false); await f.memory.intercept([], 8000, () => assert.fail('aborted'), 'normal');
      const pending = structuredClone(f.memory.settings().pending);
      if (group) f.c.characterId = 1; else f.c.characters[0].avatar = 'renamed.png';
      assert.equal(f.memory.key(), ticket.key); assert.equal(f.memory.settings().id, id);
      assert.deepEqual(f.memory.settings().pending, pending); assert.equal(f.memory.valid(ticket), true);
      if (group) assert.ok(f.calls.some(call => call.path === '/api/chats/group/get' && call.body.id === 'story'));
      else assert.ok(f.calls.some(call => call.path === '/api/chats/get' && call.body.avatar_url === 'card.png'));
      f.c.chatId = 'another-chat'; const before = structuredClone(f.c.chatMetadata);
      assert.equal(f.memory.valid(ticket), false); assert.deepEqual(f.c.chatMetadata, before);
    } finally { f.dispose(); }
  }
});

test('edits and valid swipe selection during the generation close-out window remain effective', async () => {
  for (const event of ['MESSAGE_EDITED', 'MESSAGE_SWIPED']) {
    const f = fixture();
    try {
      f.c.chat = [f.user('继续')]; await f.memory.toggle(true);
      f.memory.start('normal', {}, false); await f.memory.intercept([], 8000, () => {}, 'normal');
      f.c.chat.push(f.assistant('完整生成回复')); await f.emit('MESSAGE_RECEIVED', 1);
      f.emit('GENERATION_ENDED');
      f.c.chat[1].mes = '作者最终选择的正文'; if (event === 'MESSAGE_SWIPED') f.c.chat[1].swipe_id = 1;
      await f.emit(event, 1); await f.flush();
      assert.equal(f.state().entries.length, 2);
      assert.equal(f.state().entries[1].hash, await bodyHash(bodyOf(f.c.chat[1])));
      assert.equal(f.c.chat[1].novelBridgeMemory.interrupted, undefined);
    } finally { f.dispose(); }
  }
});

test('an edit or valid swipe queued while interrupted close-out is running clears its new rejection afterward', async () => {
  for (const event of ['MESSAGE_EDITED', 'MESSAGE_SWIPED']) {
  const f = fixture();
  try {
    f.c.chat = [f.user('继续')]; await f.memory.toggle(true);
    f.memory.start('normal', {}, false); await f.memory.intercept([], 8000, () => {}, 'normal');
    f.c.chat.push(f.assistant('中止文本'));
    f.c.streamingProcessor = { isFinished: true, isStopped: false, messageId: 1, abortController: { signal: { aborted: true } } };
    let release, entered;
    const gate = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
    const original = f.memory.rejectUnfinished.bind(f.memory);
    f.memory.rejectUnfinished = async (...args) => { entered(); await gate; return original(...args); };
    f.emit('GENERATION_STOPPED'); await started;
    f.c.chat[1].mes = '作者最终选择的正文';
    if (event === 'MESSAGE_SWIPED') f.c.chat[1].swipe_id = 1;
    const edit = f.emit(event, 1); release();
    await edit; await f.memory.tail; await f.memory.refresh();
    assert.equal(f.state().entries.length, 2); assert.equal(f.c.chat[1].novelBridgeMemory.interrupted, undefined);
  } finally { f.dispose(); }
  }
});

test('a resolved-but-skipped ST save and a stale checkpoint both abort before recall or generation', async () => {
  const f = fixture();
  try {
    f.c.chat = [f.user('继续')]; await f.memory.toggle(true);
    f.ignoreMetadataSave(true); let aborted = false;
    await f.memory.intercept([], 8000, () => { aborted = true; }, 'normal');
    assert.equal(aborted, true); assert.match(f.status(), /尚未确认保存聊天/);
    assert.equal(f.calls.filter(c => c.path.endsWith('/context')).length, 0);
    f.ignoreMetadataSave(false); await f.memory.intercept([], 8000, () => assert.fail('verified save aborted'), 'normal');
    f.ignoreMetadataSave(true); aborted = false;
    await f.memory.intercept([], 8000, () => { aborted = true; }, 'normal');
    assert.equal(aborted, true); assert.equal(f.calls.filter(c => c.path.endsWith('/context')).length, 1);
  } finally { f.dispose(); }
});

test('persisted complete-message evidence survives a stale pending baseline after page closure', async () => {
  const f = fixture();
  try {
    f.c.chat = [f.user('继续')]; await f.memory.toggle(true);
    f.memory.start('normal', {}, false); await f.memory.intercept([], 8000, () => {}, 'normal');
    f.c.chat.push(f.assistant('已经完成但清理标记还没存盘的回复')); await f.emit('MESSAGE_RECEIVED', 1);
    assert.ok(f.c.chatMetadata.novelBridgeMemory.pending);
    await f.memory.chatChanged(); assert.equal(f.state().entries.length, 2);
  } finally { f.dispose(); }
});
