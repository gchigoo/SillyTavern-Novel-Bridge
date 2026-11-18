import { extension_prompt_types, extension_prompt_roles } from '/script.js';
import { RaceGuard, FinalizationIdentity, canReplaceDraft, parseStateDelta, draftHash, reconcileCanon } from './helpers.mjs';
import { ChatMemory } from './chat-memory.js';

const API = '/novel-bridge/api';
const PROMPT = 'novel_bridge_memory';
const ctx = () => SillyTavern.getContext();
let root, expectedRevision = 0, canonRevision = 0, currentEditorKey = '', currentChat = null, finalizing = false;
let activeNovel = null;
let chatMemory;
let canonLoadSequence = 0;
let canonSaving = false;
let canonSaveTask = Promise.resolve();
const identities = new Map();
const fieldNames = ['title', 'outline', 'storyTime', 'draft', 'summary', 'delta'];
const $ = name => root.querySelector(`[data-nb="${name}"]`);
const chatId = () => String(ctx().chatId ?? '');
const config = () => {
  const metadata = ctx().chatMetadata;
  if (!metadata.novelBridge) metadata.novelBridge = { enabled: false, novelId: '', chapterNumber: 1, editors: {} };
  metadata.novelBridge.editors ||= {};
  metadata.novelBridge.canonEditors ||= {};
  return metadata.novelBridge;
};
const selection = () => ({ chatId: chatId(), novelId: config().novelId || '', chapterNumber: Number(config().chapterNumber || 1) });
const guard = new RaceGuard(selection);
const clearPrompt = () => ctx().setExtensionPrompt(PROMPT, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('nb-error', error); }
function fail(error) { clearPrompt(); status(error.message || '操作失败，请重试', true); }
function requireSelection() {
  const s = selection();
  if (!s.chatId) throw new Error('请先打开一个聊天');
  if (!s.novelId) throw new Error('请先选择或新建小说');
  return s;
}
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  clearPrompt();
  const result = await fetch(API + path, { method, credentials: 'same-origin', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  let data; try { data = await result.json(); } catch { throw new Error('服务返回了无效响应'); }
  if (!result.ok) { const error = new Error(data.error?.message || '请求失败'); error.code = data.error?.code; if (data.error?.details?.chapters) error.message += `：第 ${data.error.details.chapters.join('、')} 章`; throw error; }
  return data;
}
function persistEditor() {
  if (!currentEditorKey || currentChat !== chatId()) return;
  const value = Object.fromEntries(fieldNames.map(name => [name, $(name).value]));
  config().editors[currentEditorKey] = { ...value, expectedRevision };
  ctx().saveMetadataDebounced();
}
function renderEditor() {
  const s = selection(); currentEditorKey = `${s.novelId}:${s.chapterNumber}`;
  const saved = config().editors[currentEditorKey];
  for (const name of fieldNames) $(name).value = saved?.[name] ?? (name === 'delta' ? '[]' : '');
  expectedRevision = saved?.expectedRevision || 0;
  $('revision').textContent = `编辑基于 r${expectedRevision}；载入定稿可查看当前版本`;
  $('context').textContent = ''; $('sources').textContent = ''; $('warnings').textContent = ''; $('download').hidden = !s.novelId;
  $('download').href = `${API}/novels/${encodeURIComponent(s.novelId)}/chapters/${s.chapterNumber}/export`;
}
function showContext(result) {
  $('warnings').textContent = result.warnings.join('\n');
  $('context').textContent = result.contextText;
  $('sources').textContent = result.sources.map(s => `第${s.chapterNumber}章 r${s.revision}：${s.text}`).join('\n') || '没有可用的历史检索事实';
}
async function refreshJobs() {
  const s = requireSelection(), ticket = guard.begin('jobs');
  const detail = await api(`/novels/${s.novelId}`);
  if (!guard.valid(ticket)) return;
  $('jobs').replaceChildren();
  for (const job of detail.jobs) {
    const line = document.createElement('div');
    const labels = { queued: '排队', processing: '处理中', retry: '自动重试', paused: '已暂停', synced: '已同步', failed: '已失败' };
    line.textContent = `第${job.chapterNumber}章 r${job.revision} · ${labels[job.status] || job.status}${job.blockedByEarlierJob ? '（等待同章较早版本完成，请先处理较早任务）' : ''}${job.error ? ` · ${job.error}` : ''}`;
    if (['failed', 'paused'].includes(job.status)) {
      const button = document.createElement('button'); button.className = 'menu_button'; button.textContent = '重试';
      button.addEventListener('click', async () => { if (!guard.valid(ticket)) return; button.disabled = true; try { await api(`/novels/${s.novelId}/jobs/${job.id}/retry`, {}); if (guard.valid(ticket)) await refreshJobs(); } catch (error) { if (guard.valid(ticket)) fail(error); } finally { if (button.isConnected) button.disabled = false; } });
      line.append(button);
    }
    $('jobs').append(line);
  }
  if (!detail.jobs.length) $('jobs').textContent = '暂无同步任务';
}
async function loadNovel() {
  const editorLoad = ++canonLoadSequence;
  // Keep the editor read-only until its server revision is known.
  $('canon').readOnly = true;
  const s = selection();
  const previous = activeNovel?.id === s.novelId ? { novel: activeNovel, revision: canonRevision, canon: $('canon').value } : null;
  activeNovel = null; canonRevision = 0; $('canon').value = config().canonEditors[s.novelId]?.canon || ''; $('jobs').replaceChildren();
  if (!s.novelId) return;
  const ticket = guard.begin('novel');
  try {
  // A refresh started during PUT must read only after that save settles.
  await canonSaveTask;
  if (!guard.valid(ticket) || editorLoad !== canonLoadSequence) return;
  const detail = await api(`/novels/${s.novelId}`);
  if (!guard.valid(ticket) || editorLoad !== canonLoadSequence) return;
  activeNovel = detail.novel;
  const editor = reconcileCanon(config().canonEditors[s.novelId], detail.novel);
  canonRevision = editor.expectedRevision;
  $('canon').value = editor.canon;
  if (!editor.keepDraft) { delete config().canonEditors[s.novelId]; ctx().saveMetadataDebounced(); }
  $('canon').readOnly = canonSaving;
  if (editor.conflict) status('服务器设定版本已更新，草稿已保留。请先复制草稿，再载入服务器设定并合并后保存。', true);
  const chapter = detail.chapters.find(c => c.number === s.chapterNumber);
  $('revision').textContent = `编辑基于 r${expectedRevision}；服务器 ${chapter ? `r${chapter.revision}${chapter.needsReview ? '（待复核）' : ''}` : '未定稿'}`;
  await refreshJobs();
  } catch (error) {
    if (guard.valid(ticket) && editorLoad === canonLoadSequence && previous && !activeNovel) {
      activeNovel = previous.novel; canonRevision = previous.revision; $('canon').value = previous.canon;
    }
    throw error;
  } finally { if (guard.valid(ticket) && editorLoad === canonLoadSequence) $('canon').readOnly = canonSaving || !activeNovel; }
}
async function refreshNovels() {
  const ticket = guard.begin('list'), result = await api('/novels');
  if (!guard.valid(ticket)) return;
  const selected = config().novelId;
  $('novel').replaceChildren(new Option('请选择小说', ''));
  for (const novel of result.novels) $('novel').append(new Option(novel.title, novel.id));
  $('novel').value = selected;
  await loadNovel();
}
async function loadChapter() {
  const s = requireSelection();
  if ($('draft').value && !confirm('载入服务器定稿将替换当前编辑区。继续？')) return;
  const ticket = guard.begin('editor'), original = JSON.stringify(fieldNames.map(name => $(name).value));
  const result = await api(`/novels/${s.novelId}/chapters/${s.chapterNumber}`);
  if (!guard.valid(ticket) || original !== JSON.stringify(fieldNames.map(name => $(name).value))) return;
  if (!result.chapter) { status('本章尚未定稿，当前草稿已保留'); return; }
  const ch = result.chapter;
  $('title').value = ch.title; $('draft').value = ch.content; $('summary').value = ch.summary;
  $('delta').value = JSON.stringify(ch.stateDelta, null, 2); $('storyTime').value = ch.storyTime;
  expectedRevision = ch.revision; $('revision').textContent = `编辑基于 r${expectedRevision}${ch.needsReview ? '（待复核）' : ''}`;
  persistEditor(); status(ch.needsReview ? '请复核内容、摘要和状态变更后重新确认定稿' : '已载入定稿');
}
async function recall() {
  const s = requireSelection(), ticket = guard.begin('recall'), outline = $('outline').value;
  clearPrompt(); status('正在召回记忆…');
  const result = await api(`/novels/${s.novelId}/context`, { chapterNumber: s.chapterNumber, query: outline });
  if (!guard.valid(ticket) || outline !== $('outline').value) return;
  showContext(result); status(['记忆预览已更新', ...result.warnings].join('\n'));
}
async function analyze() {
  const s = requireSelection(), ticket = guard.begin('analysis');
  const content = $('draft').value, summary = $('summary').value, delta = $('delta').value;
  if (!content.trim()) throw new Error('请先填写或生成草稿');
  status('正在检查一致性，分析结果需作者确认…');
  const result = await api(`/novels/${s.novelId}/analyze`, { chapterNumber: s.chapterNumber, content, query: $('outline').value });
  if (!guard.valid(ticket) || $('draft').value !== content || $('summary').value !== summary || $('delta').value !== delta) return;
  const sourceHash = await draftHash(content);
  if (!guard.valid(ticket) || $('draft').value !== content || $('summary').value !== summary || $('delta').value !== delta) return;
  if (sourceHash !== result.sourceHash) throw new Error('分析草稿版本不匹配，请重新检查');
  $('summary').value = result.summary; $('delta').value = JSON.stringify(result.stateDelta, null, 2); persistEditor();
  status(['分析完成：请编辑摘要及状态变更后再确认定稿', ...result.warnings].join('\n'));
}
async function finalize() {
  if (finalizing) return;
  const s = requireSelection();
  const payload = { expectedRevision, title: $('title').value, content: $('draft').value, summary: $('summary').value, stateDelta: parseStateDelta($('delta').value), storyTime: $('storyTime').value, sourceChatId: s.chatId };
  if (!payload.content.trim() || !payload.summary.trim()) throw new Error('定稿前请填写正文和摘要；分析不可用时可手动填写');
  if (!confirm(`确认定稿第 ${s.chapterNumber} 章，r${expectedRevision} → r${expectedRevision + 1}？\n\n摘要：\n${payload.summary}\n\n状态变更：\n${JSON.stringify(payload.stateDelta, null, 2)}\n\n定稿将写入历史并排队同步记忆；后续已定稿章节需复核。`)) return;
  const identityKey = JSON.stringify(s);
  if (!identities.has(identityKey)) identities.set(identityKey, new FinalizationIdentity());
  const requestId = identities.get(identityKey).forPayload(payload);
  const ticket = guard.begin('finalize'); finalizing = true; $('finalize').disabled = true;
  try {
    const result = await api(`/novels/${s.novelId}/chapters/${s.chapterNumber}/finalize`, { ...payload, requestId });
    if (!guard.valid(ticket)) return;
    // Preserve edits made while the request was in flight; only advance their base revision.
    expectedRevision = result.revision; $('revision').textContent = `编辑基于 r${expectedRevision}`; persistEditor(); clearPrompt();
    status(`第${result.chapterNumber}章 r${result.revision} 已保存，同步任务已排队。${result.invalidatedChapters.length ? `第 ${result.invalidatedChapters.join('、')} 章待复核。` : ''}`);
    await refreshJobs();
  } finally { finalizing = false; $('finalize').disabled = false; }
}
async function generate() {
  requireSelection(); if (!config().enabled) throw new Error('请先启用当前聊天的小说记忆');
  const send = document.querySelector('#send_textarea'); if (!send) throw new Error('找不到 SillyTavern 输入框');
  const outline = $('outline').value.trim(); if (!outline) throw new Error('请填写本章大纲');
  const previousInput = send.value;
  if (previousInput.trim() && previousInput !== outline) throw new Error('聊天输入框已有未发送内容，请先保存或发送后再生成章节');
  const ticket = guard.begin('generation'), originalDraft = $('draft').value;
  const originalMessages = ctx().chat.map(message => ({ message, text: message.mes }));
  send.value = outline; send.dispatchEvent(new Event('input', { bubbles: true }));
  status('正在使用 SillyTavern 当前写作模型生成…');
  await ctx().generate('normal');
  if (!guard.valid(ticket)) return;
  const messages = ctx().chat;
  const result = [...messages].reverse().find(message => !message.is_user && !message.is_system && typeof message.mes === 'string' && message.mes.trim());
  const changed = result && !originalMessages.some(old => old.message === result && old.text === result.mes);
  if (changed && canReplaceDraft({ ticketValid: guard.valid(ticket), originalDraft, currentDraft: $('draft').value })) {
    $('draft').value = result.mes; persistEditor(); status('已填入生成草稿，尚未定稿');
  } else if (changed) status('生成已完成；编辑区已有草稿，未覆盖。请从聊天复制需要的正文');
  else status('未获得新的生成正文，请检查酒馆模型连接或生成错误提示');
}
window.novelBridgeInterceptor = async (_chat, contextSize, abort, type) => {
  clearPrompt();
  if (chatMemory?.enabled()) return chatMemory.intercept(_chat, contextSize, abort, type);
  if (!root || !config().enabled || !['normal', 'continue', 'regenerate', 'swipe'].includes(type || 'normal')) return;
  const ticket = guard.begin('interceptor');
  try {
    const s = requireSelection(), outline = $('outline').value;
    const result = await api(`/novels/${s.novelId}/context`, { chapterNumber: s.chapterNumber, query: outline });
    if (!guard.valid(ticket) || !config().enabled || outline !== $('outline').value) { abort(true); return; }
    const tokens = await ctx().getTokenCountAsync(result.contextText);
    if (!guard.valid(ticket) || !config().enabled || outline !== $('outline').value) { abort(true); return; }
    if (!Number.isFinite(tokens) || !Number.isFinite(contextSize) || tokens > Math.floor(contextSize * 0.5)) throw new Error('记忆超过当前模型一半的上下文预算，请精简设定、状态或大纲');
    ctx().setExtensionPrompt(PROMPT, result.contextText, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    showContext(result);
    if (result.warnings.length) status(result.warnings.join('\n'));
  } catch (error) { abort(true); if (guard.valid(ticket)) fail(error); }
};
async function chatChanged() {
  guard.invalidate(); clearPrompt(); currentChat = chatId();
  const settings = config(); $('enabled').checked = !!settings.enabled; $('chapter').value = settings.chapterNumber || 1;
  renderEditor(); status('仅“确认定稿”会写入记忆');
  const ticket = guard.begin('lifecycle'); try { await refreshNovels(); } catch (error) { if (guard.valid(ticket)) fail(error); }
}
function install() {
  if (document.querySelector('#novel_bridge_drawer')) return;
  const mount = document.querySelector('#extensions_settings2'); if (!mount) return;
  root = document.createElement('div'); root.id = 'novel_bridge_drawer'; root.className = 'extension_container';
  root.innerHTML = `<div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>长篇小说记忆</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content">
    <section data-nb="autoPanel"><label><input type="checkbox" data-nb="autoEnabled"> 当前聊天启用自动记忆</label>
    <div class="nb-help">照常使用 ST 发送、重生成和续写。生成前自动召回，完整回复后自动保存；编辑、切换回复和删除会同步修订。角色卡、世界书与写作模型仍由 ST 管理。启用时会同步当前聊天已有消息。</div>
    <div class="nb-actions"><button class="menu_button" data-nb="autoRefresh">同步并查看状态</button><button class="menu_button" data-nb="autoRetry">重试失败任务</button></div>
    <div class="nb-status" role="status" data-nb="autoStatus"></div><details><summary>本次召回与来源</summary><pre data-nb="autoContext"></pre></details></section>
    <details><summary>手动章节工作台（可选）</summary>
    <label><input type="checkbox" data-nb="enabled"> 启用手动章节记忆（与自动模式互斥）</label>
    <label>小说<select data-nb="novel"></select></label><div class="nb-actions"><button class="menu_button" data-nb="create">新建小说</button><button class="menu_button" data-nb="refresh">刷新</button></div>
    <div class="nb-grid"><label>章节编号<input type="number" min="1" max="100000" data-nb="chapter" value="1"></label><label>章节标题<input maxlength="200" data-nb="title"></label></div>
    <label>本章大纲<textarea maxlength="8000" data-nb="outline"></textarea></label><label>故事时间（原文标签）<input maxlength="200" data-nb="storyTime"></label>
    <div class="nb-actions"><button class="menu_button" data-nb="recall">召回记忆</button><button class="menu_button" data-nb="generate">生成章节</button><button class="menu_button" data-nb="analyze">一致性检查</button><button class="menu_button" data-nb="finalize">确认定稿</button></div>
    <div data-nb="status" class="nb-status" role="status"></div><div data-nb="warnings" class="nb-status" role="alert"></div><div data-nb="revision" class="nb-help"></div><div class="nb-actions"><button class="menu_button" data-nb="load">载入定稿</button><a class="menu_button" data-nb="download" download>下载 Markdown</a></div>
    <label>正文草稿<textarea class="nb-draft" maxlength="250000" data-nb="draft"></textarea></label><label>定稿摘要（可手动编辑）<textarea maxlength="6000" data-nb="summary"></textarea></label><label>状态变更 JSON（作者确认后生效）<textarea data-nb="delta">[]</textarea></label>
    <div class="nb-help">状态格式：[{"entity":"人物名","field":"位置","value":"地点","evidence":"原文证据"}]；value 为 null 表示删除。草稿与检查不会写入小说记忆。</div>
    <details><summary>作者设定</summary><textarea maxlength="15000" data-nb="canon" readonly></textarea><button class="menu_button" data-nb="saveCanon">保存作者设定</button><button class="menu_button" data-nb="loadCanon">载入服务器设定</button><div class="nb-help">修改设定后，已有定稿章节需逐章复核。载入服务器设定会在确认后替换本地草稿。</div></details>
    <details><summary>上下文与来源</summary><pre data-nb="context"></pre><pre data-nb="sources"></pre></details>
    <details><summary>记忆同步任务</summary><button class="menu_button" data-nb="jobsRefresh">刷新任务</button><div class="nb-jobs" data-nb="jobs"></div></details>
  </details></div></div>`;
  mount.append(root);
  chatMemory = new ChatMemory({ context: ctx, request: api,
    setPrompt: text => ctx().setExtensionPrompt(PROMPT, text, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM),
    report: (text, error = false) => { $('autoStatus').textContent = text; $('autoStatus').classList.toggle('nb-error', error); },
    preview: result => { $('autoContext').textContent = [result.contextText || '暂无匹配的历史记忆', ...result.warnings].join('\n'); },
    changed: enabled => { $('autoEnabled').checked = enabled; if (enabled) { config().enabled = false; $('enabled').checked = false; ctx().saveMetadataDebounced(); } },
  });
  $('autoEnabled').addEventListener('change', () => chatMemory.toggle($('autoEnabled').checked).catch(e => chatMemory.report(e.message, true)));
  for (const [name, retry] of [['autoRefresh', false], ['autoRetry', true]]) $(name).addEventListener('click', async () => { $(name).disabled = true; try { await chatMemory.refresh(retry); } catch (e) { chatMemory.report(e.message, true); } finally { $(name).disabled = false; } });
  const bind = (name, action) => $(name).addEventListener('click', async () => { const ticket = guard.begin(`button:${name}`); $(name).disabled = true; try { await action(); } catch (error) { if (guard.valid(ticket)) fail(error); } finally { $(name).disabled = false; } });
  bind('recall', recall); bind('generate', generate); bind('analyze', analyze); bind('finalize', finalize); bind('load', loadChapter); bind('refresh', refreshNovels); bind('jobsRefresh', refreshJobs);
  bind('create', async () => {
    if (!chatId()) throw new Error('请先打开一个聊天');
    const title = prompt('小说名称'); if (!title?.trim()) return;
    const ticket = guard.begin('create'), novel = await api('/novels', { title: title.trim() });
    if (!guard.valid(ticket)) return;
    persistEditor(); config().novelId = novel.id; config().chapterNumber = 1; $('chapter').value = 1; guard.invalidate(); clearPrompt(); renderEditor(); ctx().saveMetadataDebounced(); await refreshNovels(); status('小说已创建，请填写设定和本章大纲');
  });
  bind('saveCanon', async () => {
    const s = requireSelection(); if (!activeNovel) throw new Error('请先载入小说');
    if ($('canon').readOnly || canonSaving) throw new Error('设定正在加载或保存，请稍后再试');
    if (!confirm('保存作者设定会将现有定稿章节标记为待复核。继续？')) return;
    const ticket = guard.begin('canon'), canon = $('canon').value;
    canonSaving = true; $('canon').readOnly = true;
    try {
    const pending = api(`/novels/${s.novelId}/canon`, { canon, expectedRevision: canonRevision }, 'PUT');
    canonSaveTask = pending.then(() => undefined, () => undefined);
    const novel = await pending;
    if (!guard.valid(ticket)) return;
    activeNovel = novel; canonRevision = novel.canonRevision;
    if ($('canon').value === canon) delete config().canonEditors[s.novelId];
    else config().canonEditors[s.novelId] = { canon: $('canon').value, expectedRevision: canonRevision };
    ctx().saveMetadataDebounced(); clearPrompt(); status('作者设定已保存；请复核已有章节');
    } finally { canonSaving = false; $('canon').readOnly = !activeNovel; }
  });
  bind('loadCanon', async () => {
    const s = requireSelection();
    if (canonSaving) throw new Error('设定正在保存，请稍后再载入');
    if (!confirm('载入服务器设定将替换当前设定草稿。请先复制需要保留的改动。继续？')) return;
    const ticket = guard.begin('canonReload'), original = $('canon').value;
    const editorLoad = ++canonLoadSequence;
    $('canon').readOnly = true;
    try {
      const detail = await api(`/novels/${s.novelId}`);
      if (!guard.valid(ticket) || editorLoad !== canonLoadSequence || $('canon').value !== original) return;
      activeNovel = detail.novel; canonRevision = detail.novel.canonRevision; $('canon').value = detail.novel.canon;
      delete config().canonEditors[s.novelId]; ctx().saveMetadataDebounced(); status('已载入服务器设定，可以合并改动后保存');
    } finally { if (editorLoad === canonLoadSequence) $('canon').readOnly = canonSaving || !activeNovel; }
  });
  $('enabled').addEventListener('change', async () => { config().enabled = $('enabled').checked; if (config().enabled) await chatMemory.toggle(false); guard.invalidate(); clearPrompt(); ctx().saveMetadataDebounced(); const ticket = guard.begin('lifecycle'); try { await loadNovel(); } catch (error) { if (guard.valid(ticket)) fail(error); } });
  $('novel').addEventListener('change', async () => { persistEditor(); config().novelId = $('novel').value; guard.invalidate(); clearPrompt(); renderEditor(); ctx().saveMetadataDebounced(); const ticket = guard.begin('lifecycle'); try { await loadNovel(); } catch (error) { if (guard.valid(ticket)) fail(error); } });
  $('chapter').addEventListener('change', async () => { const number = Number($('chapter').value); if (!Number.isInteger(number) || number < 1 || number > 100000) { $('chapter').value = config().chapterNumber; return; } persistEditor(); config().chapterNumber = number; guard.invalidate(); clearPrompt(); renderEditor(); ctx().saveMetadataDebounced(); const ticket = guard.begin('lifecycle'); try { await loadNovel(); } catch (error) { if (guard.valid(ticket)) fail(error); } });
  for (const name of fieldNames) $(name).addEventListener('input', () => { if (name === 'outline') clearPrompt(); persistEditor(); });
  $('canon').addEventListener('input', () => { const id = selection().novelId; if (id && activeNovel) { config().canonEditors[id] = { canon: $('canon').value, expectedRevision: canonRevision }; ctx().saveMetadataDebounced(); } });
  ctx().eventSource.on(ctx().eventTypes.CHAT_CHANGED, chatChanged);
  chatMemory.installEvents();
  chatChanged();
  chatMemory.chatChanged();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true }); else install();
