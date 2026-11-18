export function selectionKey(selection) { return JSON.stringify([selection.chatId, selection.novelId, selection.chapterNumber]); }
export class RaceGuard {
  constructor(readSelection) { this.readSelection = readSelection; this.epoch = 0; this.channels = new Map(); }
  invalidate() { this.epoch++; }
  begin(channel = 'default') {
    const sequence = (this.channels.get(channel) || 0) + 1; this.channels.set(channel, sequence);
    return { key: selectionKey(this.readSelection()), epoch: this.epoch, channel, sequence };
  }
  valid(ticket) { return ticket.epoch === this.epoch && ticket.key === selectionKey(this.readSelection()) && this.channels.get(ticket.channel) === ticket.sequence; }
}
export function canReplaceDraft({ ticketValid, originalDraft, currentDraft }) { return ticketValid && !originalDraft.trim() && originalDraft === currentDraft; }
export function reconcileCanon(saved, novel) {
  if (!saved || saved.canon === novel.canon) return { canon: novel.canon, expectedRevision: novel.canonRevision, keepDraft: false, conflict: false };
  return { ...saved, keepDraft: true, conflict: saved.expectedRevision !== novel.canonRevision };
}
export function stablePayload(value) {
  if (Array.isArray(value)) return '[' + value.map(stablePayload).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stablePayload(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export class FinalizationIdentity {
  constructor(randomId = () => crypto.randomUUID()) { this.randomId = randomId; this.key = null; this.id = null; }
  forPayload(payload) { const key = stablePayload(payload); if (key !== this.key) { this.key = key; this.id = this.randomId(); } return this.id; }
}
export function parseStateDelta(text) {
  const value = JSON.parse(text || '[]');
  if (!Array.isArray(value) || value.length > 200 || value.some(item => !item || typeof item.entity !== 'string' || !item.entity || item.entity.length > 100 || typeof item.field !== 'string' || !item.field || item.field.length > 100 || !(item.value === null || typeof item.value === 'string' && item.value.length <= 2000) || typeof item.evidence !== 'string' || item.evidence.length > 2000 || Object.keys(item).some(k => !['entity', 'field', 'value', 'evidence'].includes(k)))) throw new Error('状态变更须为 entity、field、value、evidence 对象的 JSON 数组');
  return value;
}
export async function draftHash(content) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map(n => n.toString(16).padStart(2, '0')).join('');
}

// A recall query is a search cue, not a second copy of the chapter. Keep the
// author's latest request first, then the latest scene; never alter stored text.
export function buildRecallQuery(messages) {
  const latestUser = messages.findLast(m => m.role === 'user');
  const latestScene = messages.findLast(m => m.role === 'assistant');
  const clip = (text, head, tail) => {
    const points = Array.from(String(text || '').replace(/\s+/g, ' ').trim());
    return points.length <= head + tail ? points.join('') : points.slice(0, head).join('') + ' … ' + points.slice(-tail).join('');
  };
  const scene = String(latestScene?.content || '').replace(/<(SUOT|think|thinking)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '').trim();
  return [latestUser && `当前续写要求：${clip(latestUser.content, 350, 250)}`,
    scene && `最近正文线索：${clip(scene, 180, 450)}`].filter(Boolean).join('\n') || '当前聊天的人物、地点、事件与未解决的伏笔';
}
