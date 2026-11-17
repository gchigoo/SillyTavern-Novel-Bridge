import { createHash } from 'node:crypto';
import { z } from 'zod';

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message); Object.assign(this, { status, code, details });
  }
}
export const uuid = z.uuid();
export const chapterNumber = z.number().int().min(1).max(100000);
const shortText = z.string().max(200);
export const deltaSchema = z.array(z.object({
  entity: z.string().min(1).max(100), field: z.string().min(1).max(100),
  value: z.string().max(2000).nullable(), evidence: z.string().max(2000),
}).strict()).max(200);
export const schemas = {
  create: z.object({ title: shortText.trim().min(1) }).strict(),
  canon: z.object({ canon: z.string().max(15000), expectedRevision: z.number().int().nonnegative() }).strict(),
  context: z.object({ chapterNumber, query: z.string().max(8000) }).strict(),
  analyze: z.object({ chapterNumber, content: z.string().min(1).max(250000), query: z.string().max(8000).optional() }).strict(),
  analysis: z.object({ summary: z.string().max(6000), stateDelta: deltaSchema, warnings: z.array(z.string().max(2000)).max(50) }).strict(),
  finalize: z.object({
    requestId: uuid, expectedRevision: z.number().int().nonnegative(), title: shortText,
    content: z.string().min(1).max(250000), summary: z.string().min(1).max(6000), stateDelta: deltaSchema,
    storyTime: z.string().max(200), sourceChatId: z.string().max(500),
  }).strict(),
};
export function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, 'INVALID_INPUT', '输入格式或长度不符合要求');
  return result.data;
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function hash(value) { return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex'); }
export function bankId(novelId) { return `novel-${parse(uuid, novelId)}`; }
export function revisionTag(number, revision) { return `ch-${number}-r-${revision}`; }
export function exportParts(novelId, number, revision) {
  parse(uuid, novelId); parse(chapterNumber, number);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new AppError(400, 'INVALID_REVISION', '无效版本');
  return [novelId, 'chapters', String(number), `r${revision}.md`];
}
export function markdown(chapter) {
  return `# ${chapter.title || `第 ${chapter.number} 章`}\n\n<!-- chapter:${chapter.number} revision:${chapter.revision} -->\n\n${chapter.content}\n`;
}
export function visibleChapters(chapters, target) {
  const prior = chapters.filter(c => c.number < target).sort((a, b) => a.number - b.number);
  const stale = prior.filter(c => c.needsReview).map(c => c.number);
  if (stale.length) throw new AppError(409, 'REVIEW_REQUIRED', '前序章节待复核，请重新确认定稿', { chapters: stale });
  return prior;
}
export function replayState(chapters, target) {
  const state = new Map();
  for (const chapter of visibleChapters(chapters, target)) {
    for (const change of chapter.stateDelta) {
      if (!state.has(change.entity)) state.set(change.entity, new Map());
      const fields = state.get(change.entity);
      if (change.value === null) fields.delete(change.field);
      else fields.set(change.field, { value: change.value, evidence: change.evidence, chapterNumber: chapter.number, revision: chapter.revision });
      if (!fields.size) state.delete(change.entity);
    }
  }
  return [...state].sort(([a], [b]) => a.localeCompare(b)).flatMap(([entity, fields]) =>
    [...fields].sort(([a], [b]) => a.localeCompare(b)).map(([field, value]) => ({ entity, field, ...value })));
}
export function filterFacts(results, novelId, chapters, target) {
  const allowed = new Map(visibleChapters(chapters, target).map(c => [c.number, c]));
  const facts = new Map();
  for (const fact of results) {
    if (!fact || !['world', 'experience'].includes(fact.type) || typeof fact.text !== 'string' || !fact.text.trim()) continue;
    const metadata = fact.metadata;
    if (!metadata || metadata.novel_id !== novelId || typeof metadata.chapter_no !== 'string' || typeof metadata.revision !== 'string') continue;
    const ch = allowed.get(Number(metadata.chapter_no));
    if (!ch || metadata.chapter_no !== String(ch.number) || metadata.revision !== String(ch.revision) || fact.document_id !== `chapter-${ch.number}`) continue;
    if (fact.bank_id !== undefined && fact.bank_id !== bankId(novelId)) continue;
    if (!Array.isArray(fact.tags) || !fact.tags.includes(revisionTag(ch.number, ch.revision))) continue;
    const item = { chapterNumber: ch.number, revision: ch.revision, text: fact.text };
    facts.set(canonical(item), item);
  }
  // Preserve provider relevance ranking when choosing which facts fit the budget.
  return [...facts.values()];
}
export function buildContext({ novel, chapters, chapterNumber: target, query, facts }, maxChars = 30000) {
  const visible = visibleChapters(chapters, target);
  const state = replayState(chapters, target);
  const summaries = visible.slice(-2).map(c => `[第${c.number}章 r${c.revision}] ${c.summary}`).join('\n');
  let contextText = `【作者设定】\n${novel.canon || '（未填写）'}\n\n【第${target}章之前的已确认状态】\n${JSON.stringify(state)}\n\n【最近两章定稿摘要】\n${summaries || '（无）'}\n\n【本章大纲】\n${query || '（未填写）'}\n\n【有来源的历史事实】\n`;
  if (contextText.length > maxChars) throw new AppError(422, 'CONTEXT_BUDGET', '作者设定、状态、摘要及大纲超出上下文预算，请手动精简');
  const sources = [], warnings = [];
  for (const fact of filterFacts(facts, novel.id, chapters, target)) {
    const line = `[第${fact.chapterNumber}章 r${fact.revision}] ${fact.text}\n`;
    if (contextText.length + line.length > maxChars) { if (!warnings.length) warnings.push('部分检索事实因上下文预算未注入'); continue; }
    contextText += line; sources.push(fact);
  }
  return { contextText, sources, epoch: novel.epoch, warnings };
}
