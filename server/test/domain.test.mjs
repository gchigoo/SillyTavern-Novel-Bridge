import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { filterFacts, replayState, buildContext, exportParts, hash, parse, schemas, visibleChapters } from '../src/domain.mjs';
import { exportRevision } from '../src/worker.mjs';

const id = '20feb9bd-3c23-44b6-b9a6-0d9b04b732a8';
const chapter = (number, revision = 1, extra = {}) => ({ number, revision, needsReview: false, summary: `摘要${number}`, stateDelta: [], ...extra });
const fact = (number, revision = 1, extra = {}) => ({ text: `事实${number}`, type: 'world', document_id: `chapter-${number}`, metadata: { novel_id: id, chapter_no: String(number), revision: String(revision) }, tags: [`ch-${number}-r-${revision}`], ...extra });

test('recall rejects future, stale, wrong novel/bank/document/tag and missing provenance', () => {
  const valid = fact(1, 2);
  const results = [valid, fact(1), fact(2), fact(1, 2, { metadata: {} }), fact(1, 2, { document_id: 'chapter-99' }), fact(1, 2, { tags: [] }), fact(1, 2, { bank_id: 'novel-other' }), fact(1, 2, { type: 'observation' }), fact(1, 2, { metadata: { novel_id: randomUUID(), chapter_no: '1', revision: '2' } }), fact(1, 2, { metadata: { novel_id: id, chapter_no: 1, revision: '2' } })];
  assert.deepEqual(filterFacts(results, id, [chapter(1, 2), chapter(2)], 2), [{ chapterNumber: 1, revision: 2, text: '事实1' }]);
});
test('review gate names all prior chapters and excludes the chapter being reviewed', () => {
  assert.throws(() => visibleChapters([chapter(1, 1, { needsReview: true }), chapter(2, 1, { needsReview: true })], 3), error => error.code === 'REVIEW_REQUIRED' && error.details.chapters.join() === '1,2');
  assert.equal(visibleChapters([chapter(2, 1, { needsReview: true })], 2).length, 0);
});
test('state replay uses chapter order, deletion, revision provenance and prototype-safe keys', () => {
  const chapters = [chapter(2, 3, { stateDelta: [{ entity: '__proto__', field: 'location', value: '城外', evidence: '离城' }, { entity: '人', field: '伤势', value: null, evidence: '痊愈' }] }), chapter(1, 1, { stateDelta: [{ entity: '__proto__', field: 'location', value: '城内', evidence: '入城' }, { entity: '人', field: '伤势', value: '轻伤', evidence: '受伤' }] }), chapter(3, 1, { stateDelta: [{ entity: '__proto__', field: 'location', value: '未来', evidence: '后文' }] })];
  assert.deepEqual(replayState(chapters, 3), [{ entity: '__proto__', field: 'location', value: '城外', evidence: '离城', chapterNumber: 2, revision: 3 }]);
  assert.equal({}.location, undefined);
});
test('mandatory context budget errors; optional fact exclusion is explicit and bounded', () => {
  const input = { novel: { id, canon: '设定', epoch: 4 }, chapters: [chapter(1)], chapterNumber: 2, query: '提纲', facts: [fact(1, 1, { text: '长'.repeat(500) })] };
  assert.throws(() => buildContext(input, 20), { code: 'CONTEXT_BUDGET' });
  const result = buildContext(input, 250);
  assert.ok(result.contextText.length <= 250); assert.equal(result.sources.length, 0); assert.equal(result.warnings.length, 1); assert.equal(result.epoch, 4);
});
test('context preserves relevance ranking and includes only last two summaries', () => {
  const input = { novel: { id, canon: '设定', epoch: 1 }, chapters: [chapter(3), chapter(1), chapter(2)], chapterNumber: 4, query: '大纲', facts: [fact(3), fact(1)] };
  const result = buildContext(input);
  assert.equal(result.sources[0].chapterNumber, 3); assert.equal(result.sources[1].chapterNumber, 1);
  assert.ok(!result.contextText.includes('摘要1')); assert.ok(result.contextText.includes('摘要2')); assert.ok(result.contextText.includes('摘要3'));
  const budget = buildContext({ ...input, facts: [] }).contextText.length + '[第3章 r1] 事实3\n'.length;
  assert.deepEqual(buildContext(input, budget).sources, [result.sources[0]]);
});
test('export filename rejects traversal and unsafe identifiers', () => {
  assert.deepEqual(exportParts(id, 1, 2), [id, 'chapters', '1', 'r2.md']);
  assert.throws(() => exportParts('../outside', 1, 1)); assert.throws(() => exportParts(id, -1, 1)); assert.throws(() => exportParts(id, 1, 0));
});
test('hash is exact for text and canonical for payload key order', () => {
  assert.equal(hash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(hash('正文'), hash('正文\n')); assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
});
test('validation bounds content, delta and rejects unknown fields without normalizing story time', () => {
  const input = { requestId: randomUUID(), expectedRevision: 0, title: '', content: '正文', summary: '摘要', stateDelta: [], storyTime: '前朝三年腊月', sourceChatId: 'chat' };
  assert.equal(parse(schemas.finalize, input).storyTime, input.storyTime);
  assert.throws(() => parse(schemas.finalize, { ...input, content: 'x'.repeat(250001) }));
  assert.throws(() => parse(schemas.finalize, { ...input, owner: 'mallory' }));
  assert.throws(() => parse(schemas.finalize, { ...input, stateDelta: Array(201).fill({ entity: '人', field: '地', value: '城', evidence: '' }) }));
});
test('immutable export is reproducible and never overwrites mismatching content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nb-export-test-'));
  const job = { novel_id: id, chapter_no: 1, revision: 1, title: '../../unsafe', content: '正文' };
  try {
    await exportRevision(root, job); await exportRevision(root, job);
    const filename = path.join(root, ...exportParts(id, 1, 1));
    assert.ok((await readFile(filename, 'utf8')).includes('正文'));
    await writeFile(filename, 'different');
    await assert.rejects(exportRevision(root, job), { category: 'export_mismatch' });
    assert.equal(await readFile(filename, 'utf8'), 'different');
  } finally { await rm(root, { recursive: true, force: true }); }
});
