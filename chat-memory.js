import { draftHash } from './helpers.mjs';

const FIELD = 'novelBridgeMemory';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const supported = type => ['normal', 'continue', 'regenerate', 'swipe'].includes(type || 'normal');
export const bodyOf = message => ({ role: message.is_user ? 'user' : 'assistant', name: String(message.name ?? ''), content: String(message.mes ?? '') });
export const bodyHash = body => draftHash(JSON.stringify([body.role, body.name, body.content]));
const usable = m => !m.is_system && !m.extra?.tool_invocations && typeof m.mes === 'string' && m.mes.trim() && m.mes !== '...';
const stale = () => new Error('聊天已变化，本次记忆操作已取消');
const variant = m => JSON.stringify([m.swipe_id ?? 0, m.gen_started ? String(new Date(m.gen_started).getTime()) : '']);
const isGroup = c => c.groupId !== undefined && c.groupId !== null && c.groupId !== '';
const sameBody = (a, b) => a && a.role === b.role && a.name === b.name && a.content === b.content;
const incomplete = (data, candidate, hash) => data.incomplete?.some(item => item.variant === candidate || (item.hash && item.hash === hash));
const acceptBody = (data, candidate, hash) => {
  delete data.interrupted;
  data.rejected = (data.rejected || []).filter(value => value !== hash);
  data.incomplete = (data.incomplete || []).filter(item => item.variant !== candidate && item.hash !== hash);
  data.completedHash = hash;
};

// saveMetadata() in ST can resolve without writing. Read the persisted header
// through ST's authenticated API before allowing generation to begin.
export async function verifyChatCheckpoint(c, expected, request = fetch) {
  const group = isGroup(c), character = c.characters?.[c.characterId];
  if (!group && !character?.avatar) return false;
  const response = await request(group ? '/api/chats/group/get' : '/api/chats/get', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000), headers: c.getRequestHeaders(),
    body: JSON.stringify(group ? { id: c.chatId } : { ch_name: character.name || c.name2 || '', file_name: c.chatId, avatar_url: character.avatar }),
  });
  if (!response.ok) return false;
  const data = await response.json(), saved = data?.[0]?.chat_metadata?.[FIELD];
  return saved?.id === expected.id && saved.binding === expected.binding && saved.pending?.id === expected.pending.id && JSON.stringify(saved.pending.entries) === JSON.stringify(expected.pending.entries);
}

// This controller uses ST's existing generation and event pipeline. It never calls
// a writing model, edits a character/world book, or chooses a reply for the user.
export class ChatMemory {
  constructor({ context, request, setPrompt, report = () => {}, preview = () => {}, changed = () => {}, verifyCheckpoint = verifyChatCheckpoint }) {
    Object.assign(this, { context, request, setPrompt, report, preview, changed, verifyCheckpoint });
    this.version = 0; this.tail = Promise.resolve(); this.remote = null; this.generation = null;
  }
  key() {
    const c = this.context();
    // ST 1.19 gives each chat a persistent integrity UUID, including group chats.
    // It survives avatar rename; a group speaker never participates in identity.
    const identity = c.chatMetadata.integrity || (isGroup(c) ? '' : (c.characters?.[c.characterId]?.avatar ?? c.characterId ?? ''));
    return c.chatId ? JSON.stringify([isGroup(c) ? String(c.groupId) : '', String(identity), String(c.chatId)]) : '';
  }
  settings() {
    const metadata = this.context().chatMetadata, binding = this.key();
    let s = metadata[FIELD];
    if (!s || s.binding !== binding) {
      s = metadata[FIELD] = { enabled: s?.enabled ?? false, binding, id: crypto.randomUUID(), ...(s?.pending ? { pending: s.pending } : {}) };
      this.context().saveMetadataDebounced();
    }
    return s;
  }
  enabled() { return !!this.key() && !!this.settings().enabled; }
  ticket() { return { key: this.key(), version: this.version, id: this.settings().id }; }
  valid(t) { const s = this.context().chatMetadata[FIELD]; return !!s?.enabled && t.key === this.key() && t.version === this.version && t.id === s.id && s.binding === t.key; }
  check(t) { if (!this.valid(t)) throw stale(); }
  enqueue(action) {
    const task = this.tail.then(action);
    this.tail = task.catch(() => {});
    return task;
  }
  clear() { this.setPrompt(''); }
  async toggle(enabled) {
    this.settings().enabled = enabled; this.version++; this.clear();
    this.context().saveMetadataDebounced(); this.changed(enabled);
    if (enabled) await this.chatChanged();
    else { clearTimeout(this.timer); this.report('当前聊天已关闭自动记忆'); }
  }
  async snapshot(t) {
    this.check(t);
    const c = this.context(), messages = [], seen = new Set(); let dirty = false;
    // Capture values before awaits; a fingerprint guards any edits during hashing.
    const fingerprint = this.fingerprint();
    for (const source of c.chat) {
      if (!usable(source)) continue;
      if (!uuid.test(source[FIELD]?.id) || seen.has(source[FIELD].id)) {
        source[FIELD] = { id: crypto.randomUUID() }; dirty = true;
      }
      seen.add(source[FIELD].id);
      const body = bodyOf(source);
      if (body.content.length > 250000 || body.name.length > 200) throw new Error('单条消息超出记忆容量，请缩短消息后同步');
      messages.push({ id: source[FIELD].id, ...body, source });
    }
    if (messages.length > 10000) throw new Error('单个聊天最多同步 10000 条消息，请创建后续聊天');
    const result = [];
    for (const message of messages) {
      const hash = await bodyHash(message);
      if (message.source[FIELD].interrupted !== variant(message.source) && !message.source[FIELD].rejected?.includes(hash) && !incomplete(message.source[FIELD], variant(message.source), hash)) {
        const { source: _source, ...body } = message; result.push({ ...body, hash });
      }
    }
    this.check(t);
    if (fingerprint !== this.fingerprint()) throw stale();
    if (dirty) { await c.saveChat(); this.check(t); }
    return { messages: result, entries: result.map(({ id, hash }) => ({ id, hash })), fingerprint };
  }
  fingerprint() { return JSON.stringify(this.context().chat.map(m => [!!m.is_user, !!m.is_system, !!m.extra?.tool_invocations, m.name, m.mes, variant(m), m[FIELD]?.rejected, m[FIELD]?.interrupted, m[FIELD]?.incomplete])); }
  async connect(t) {
    if (this.remote?.id === t.id) return;
    await this.request('/chats', { id: t.id, binding: await draftHash(t.key) }); this.check(t);
    const state = await this.request(`/chats/${t.id}`); this.check(t);
    this.remote = { id: t.id, epoch: state.epoch, entries: state.entries };
  }
  async synchronize(t) {
    this.check(t);
    const snap = await this.snapshot(t);
    await this.connect(t); this.check(t);
    const known = new Map(this.remote.entries.map(e => [e.id, e.hash]));
    const missing = snap.messages.filter(m => known.get(m.id) !== m.hash);
    let chunk = [], size = 0;
    const upload = async () => {
      if (!chunk.length) return;
      this.check(t); if (snap.fingerprint !== this.fingerprint()) throw stale();
      await this.request(`/chats/${t.id}/stage`, { messages: chunk }); this.check(t); chunk = []; size = 0;
    };
    for (const message of missing) {
      const bytes = new TextEncoder().encode(JSON.stringify(message)).length;
      if (chunk.length && (chunk.length >= 20 || size + bytes > 1000000)) await upload();
      chunk.push(message); size += bytes;
    }
    await upload(); this.check(t);
    if (snap.fingerprint !== this.fingerprint()) throw stale();
    const result = await this.request(`/chats/${t.id}/sync`, { expectedEpoch: this.remote.epoch, entries: snap.entries });
    this.check(t);
    this.remote = { id: t.id, epoch: result.epoch, entries: snap.entries };
    if (snap.fingerprint !== this.fingerprint()) throw stale();
    this.report(`已保存 ${snap.entries.length} 条当前消息，记忆索引在后台更新`);
    return { ...snap, epoch: result.epoch };
  }
  schedule() {
    this.clear(); clearTimeout(this.timer);
    if (!this.enabled() || this.generation) return;
    const t = this.ticket();
    this.timer = setTimeout(() => this.enqueue(() => this.synchronize(t)).catch(e => { if (this.valid(t)) this.report(e.message, true); }), 350);
  }
  async rejectUnfinished(pending, accepted = new Map()) {
    const t = this.ticket(), before = new Map(pending.entries.map(e => [e.id, e.hash]));
    const c = this.context();
    for (const message of c.chat) {
      if (!usable(message) || message.is_user) continue;
      message[FIELD] ||= { id: crypto.randomUUID() };
      const data = message[FIELD], hash = await bodyHash(bodyOf(message)); this.check(t);
      if (before.get(data.id) === hash || accepted.get(data.id) === hash || data.completedHash === hash) continue;
      data.interrupted = variant(message);
      data.rejected = [...new Set([...(data.rejected || []), hash])];
    }
    this.check(t); delete this.settings().pending;
    await c.saveChat(); this.check(t);
  }
  async chatChanged() {
    this.version++; this.clear(); clearTimeout(this.timer); clearTimeout(this.finishTimer);
    this.remote = null; this.generation = null;
    this.changed(this.enabled());
    if (!this.enabled()) { this.report('启用后，发送与生成仍使用 ST 当前角色卡、世界书和模型'); return; }
    const t = this.ticket();
    try {
      await this.enqueue(async () => {
        this.check(t);
        if (this.settings().pending) await this.rejectUnfinished(this.settings().pending);
        await this.synchronize(t);
      });
    } catch (e) { if (this.valid(t)) this.report(e.message, true); }
  }
  start(type, _options, dryRun) {
    if (dryRun || !supported(type) || !this.enabled()) return;
    this.clear(); clearTimeout(this.timer); clearTimeout(this.finishTimer);
    // Preserve received results through automatic continuation/tool recursion.
    this.generation = { key: this.key(), stopped: false, accepted: this.generation?.accepted || new Map() };
  }
  received(index) {
    const g = this.generation, c = this.context(), message = c.chat[index];
    if (!this.enabled() || !message || !usable(message) || message.is_user || (g && g.key !== this.key())) return;
    const stream = c.streamingProcessor?.messageId === index ? c.streamingProcessor : null;
    if (!g && !stream) { this.schedule(); return; }
    const complete = !g?.stopped && (!stream || (stream.isFinished && !stream.isStopped && !stream.abortController?.signal.aborted));
    message[FIELD] ||= { id: crypto.randomUUID() };
    const data = message[FIELD], body = bodyOf(message), t = this.ticket(), candidate = variant(message);
    const baseline = this.settings().pending?.entries.find(e => e.id === data.id)?.hash;
    return this.enqueue(async () => {
      const hash = await bodyHash(body); if (!this.valid(t)) return;
      if (complete) { g?.accepted.set(data.id, hash); acceptBody(data, candidate, hash); }
      else if (hash !== baseline) {
        data.interrupted = candidate; data.rejected = [...new Set([...(data.rejected || []), hash])];
        data.incomplete ||= [];
        if (!data.incomplete.some(item => item.variant === candidate)) data.incomplete.push({ variant: candidate, hash });
      }
      if (!g) this.schedule();
    });
  }
  edited(index) { return this.acceptSelection(index, true); }
  selected(index) { return this.acceptSelection(index, false); }
  acceptSelection(index, edit) {
    if (!this.enabled()) return;
    const message = this.context().chat[index];
    if (!message || !usable(message)) { this.schedule(); return; }
    message[FIELD] ||= { id: crypto.randomUUID() };
    const t = this.ticket(), body = bodyOf(message), candidate = variant(message), data = message[FIELD];
    const interrupted = data.interrupted, rejected = [...(data.rejected || [])];
    return this.enqueue(async () => {
      const hash = await bodyHash(body);
      if (!this.valid(t) || message.mes !== body.content || variant(message) !== candidate) return;
      // A selected stopped swipe remains rejected unless the author explicitly edits it.
      if (edit || (interrupted !== candidate && !rejected.includes(hash) && !incomplete(data, candidate, hash))) {
        acceptBody(data, candidate, hash); this.generation?.accepted.set(data.id, hash);
      }
      this.schedule();
    });
  }
  latchUnfinished() {
    const g = this.generation, c = this.context();
    if (!g?.baseline || g.key !== this.key() || !this.enabled()) return;
    const index = c.streamingProcessor?.messageId ?? c.chat.length - 1, message = c.chat[index];
    if (!message || !usable(message) || message.is_user) return;
    message[FIELD] ||= { id: crypto.randomUUID() };
    const data = message[FIELD], body = bodyOf(message), before = g.baseline.get(data.id), candidate = variant(message), t = this.ticket();
    if (sameBody(before, body)) return;
    // Capture the actual stopped variant synchronously, before another swipe or
    // generation can replace the visible text. A null hash still blocks that
    // variant if ST saves it before the asynchronous digest finishes.
    data.incomplete ||= [];
    if (data.incomplete.some(item => item.variant === candidate)) return;
    const marker = { variant: candidate, hash: null }; data.incomplete.push(marker);
    this.enqueue(async () => {
      const hash = await bodyHash(body); if (!this.valid(t)) return;
      if (before?.hash === hash || g.accepted.get(data.id) === hash || data.completedHash === hash) {
        data.incomplete = data.incomplete.filter(item => item !== marker);
      } else {
        marker.hash = hash;
        data.rejected = [...new Set([...(data.rejected || []), hash])];
      }
      await c.saveChat();
    }).catch(e => { if (this.valid(t)) this.report(e.message, true); });
  }
  stopped() { if (this.generation) this.generation.stopped = true; this.latchUnfinished(); this.ended(); }
  ended() {
    if (!this.generation) return;
    const stream = this.context().streamingProcessor;
    if (stream?.isStopped || stream?.abortController?.signal.aborted) this.latchUnfinished();
    if (stream?.isFinished && !stream.isStopped && !stream.abortController?.signal.aborted) this.received(stream.messageId);
    clearTimeout(this.finishTimer);
    const g = this.generation, t = this.ticket();
    // ST may emit ENDED just before MESSAGE_RECEIVED during stream finalization.
    this.finishTimer = setTimeout(() => this.enqueue(async () => {
      if (!this.valid(t) || this.generation !== g) return;
      if (this.settings().pending) await this.rejectUnfinished(this.settings().pending, g.accepted);
      if (this.generation !== g) return;
      this.generation = null;
      await this.synchronize(t);
    }).catch(e => { if (this.valid(t)) { this.generation = null; this.report(e.message, true); } }), 150);
  }
  async intercept(_chat, contextSize, abort, type) {
    this.clear(); if (!this.enabled() || !supported(type)) return;
    clearTimeout(this.timer);
    const t = this.ticket();
    try {
      const snapshot = await this.enqueue(() => this.synchronize(t)); this.check(t);
      if (this.generation?.key === t.key) this.generation.baseline = new Map(snapshot.messages.map(message => [message.id, message]));
      // A durable baseline prevents recovery from treating a crashed partial reply as completed.
      const settings = this.settings();
      settings.pending = { id: crypto.randomUUID(), entries: snapshot.entries };
      const checkpoint = structuredClone({ id: settings.id, binding: settings.binding, pending: settings.pending });
      const c = this.context();
      await c.saveMetadata(); this.check(t);
      if (!await this.verifyCheckpoint(c, checkpoint)) throw new Error('ST 尚未确认保存聊天，已暂停生成；请等待聊天保存完成后重试');
      this.check(t);
      const last = snapshot.messages.at(-1);
      const exclude = ['swipe', 'continue'].includes(type) && last?.role === 'assistant' ? [last.id] : [];
      const query = snapshot.messages.slice(-8).map(m => `${m.role} ${m.name}: ${m.content.slice(-3000)}`).join('\n').slice(-8000);
      const result = await this.request(`/chats/${t.id}/context`, { expectedEpoch: snapshot.epoch, query, exclude });
      this.check(t); if (snapshot.fingerprint !== this.fingerprint()) throw stale();
      // Memory is auxiliary: leave most of the context to cards, books and ST's chat.
      const budget = Math.max(0, Math.min(3000, Math.floor(contextSize * 0.2)));
      if (!Number.isFinite(budget)) throw new Error('无法读取 ST 上下文预算');
      let text = result.contextText, trimmed = false;
      while (text) {
        const tokens = await this.context().getTokenCountAsync(text);
        if (!Number.isFinite(tokens)) throw new Error('无法计算记忆的上下文占用');
        if (tokens <= budget) break;
        const end = text.lastIndexOf('\n'); text = end > 0 ? text.slice(0, end) : ''; trimmed = true;
      }
      this.check(t); if (snapshot.fingerprint !== this.fingerprint()) throw stale();
      if (trimmed) result.warnings.push('部分历史记忆因上下文预算未注入');
      this.setPrompt(text); this.preview({ ...result, contextText: text });
      this.report(result.warnings.join('\n') || `已召回 ${result.sources.length} 条历史记忆，交由 ST 生成`);
    } catch (e) { abort(true); if (this.valid(t)) { this.clear(); this.generation = null; delete this.settings().pending; this.context().saveMetadataDebounced(); this.report(e.message, true); } }
  }
  async refresh(retry = false) {
    if (!this.enabled()) throw new Error('请先启用当前聊天自动记忆');
    if (this.generation) throw new Error('请等待本次生成完成');
    const t = this.ticket();
    return this.enqueue(async () => {
      await this.synchronize(t);
      if (retry) { await this.request(`/chats/${t.id}/retry`, {}); this.check(t); }
      const state = await this.request(`/chats/${t.id}`); this.check(t);
      const labels = { queued: '排队', processing: '处理中', retry: '重试中', paused: '已暂停', failed: '失败', synced: '完成' };
      this.report(`${state.entries.length} 条当前消息；历史索引任务：${state.jobs.map(j => `${labels[j.status] || j.status} ${j.count}`).join('，') || '暂无'}。中止回复可编辑后入库。`);
    });
  }
  installEvents() {
    const c = this.context(), on = (name, fn) => { if (c.eventTypes[name]) c.eventSource.on(c.eventTypes[name], fn); };
    on('CHAT_CHANGED', () => this.chatChanged());
    on('GENERATION_AFTER_COMMANDS', (...args) => this.start(...args));
    on('MESSAGE_RECEIVED', index => this.received(index));
    on('MESSAGE_EDITED', index => this.edited(index));
    on('MESSAGE_SWIPED', index => this.selected(index));
    on('GENERATION_STOPPED', () => this.stopped());
    on('GENERATION_ENDED', () => this.ended());
    for (const name of ['MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SENT']) on(name, () => this.schedule());
  }
}
