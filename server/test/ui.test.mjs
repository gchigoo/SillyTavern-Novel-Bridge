import test from 'node:test';
import assert from 'node:assert/strict';
import { RaceGuard, canReplaceDraft, FinalizationIdentity, parseStateDelta, draftHash, reconcileCanon } from '../../helpers.mjs';

test('canon reload reconciles a lost save acknowledgement without discarding divergent edits', () => {
  const novel = { canon: '已保存设定', canonRevision: 2 };
  assert.deepEqual(reconcileCanon({ canon: '已保存设定', expectedRevision: 1 }, novel), { canon: '已保存设定', expectedRevision: 2, keepDraft: false, conflict: false });
  assert.deepEqual(reconcileCanon({ canon: '保存期间继续修改', expectedRevision: 1 }, novel), { canon: '保存期间继续修改', expectedRevision: 1, keepDraft: true, conflict: true });
  assert.deepEqual(reconcileCanon({ canon: '未保存改动', expectedRevision: 2 }, novel), { canon: '未保存改动', expectedRevision: 2, keepDraft: true, conflict: false });
});

test('chat, novel, chapter changes and switch-away-and-back invalidate pending response', () => {
  let selection = { chatId: 'a', novelId: 'n', chapterNumber: 1 };
  const guard = new RaceGuard(() => selection);
  for (const change of [{ chatId: 'b' }, { novelId: 'm' }, { chapterNumber: 2 }]) {
    const ticket = guard.begin(); const original = selection; selection = { ...selection, ...change }; assert.equal(guard.valid(ticket), false); selection = original;
  }
  const ticket = guard.begin(); guard.invalidate(); assert.equal(guard.valid(ticket), false);
});
test('latest request wins within a channel without invalidating generation from interceptor', () => {
  const guard = new RaceGuard(() => ({ chatId: 'a', novelId: 'n', chapterNumber: 1 }));
  const generation = guard.begin('generation'), old = guard.begin('recall');
  const newer = guard.begin('recall'); guard.begin('interceptor');
  assert.equal(guard.valid(old), false); assert.equal(guard.valid(newer), true); assert.equal(guard.valid(generation), true);
});
test('generated content never replaces edits made while request was running', () => {
  assert.equal(canReplaceDraft({ ticketValid: true, originalDraft: '旧稿', currentDraft: '新稿' }), false);
  assert.equal(canReplaceDraft({ ticketValid: false, originalDraft: '旧稿', currentDraft: '旧稿' }), false);
  assert.equal(canReplaceDraft({ ticketValid: true, originalDraft: '旧稿', currentDraft: '旧稿' }), false);
  assert.equal(canReplaceDraft({ ticketValid: true, originalDraft: '', currentDraft: '' }), true);
});
test('unchanged finalization payload reuses request ID; changed draft or base revision gets new ID', () => {
  let counter = 0; const identity = new FinalizationIdentity(() => String(++counter));
  assert.equal(identity.forPayload({ content: '稿', expectedRevision: 0 }), '1');
  assert.equal(identity.forPayload({ expectedRevision: 0, content: '稿' }), '1');
  assert.equal(identity.forPayload({ content: '新稿', expectedRevision: 0 }), '2');
  assert.equal(identity.forPayload({ content: '新稿', expectedRevision: 1 }), '3');
});
test('editable deltas reject malformed shape and allow explicit deletion', () => {
  assert.deepEqual(parseStateDelta('[{"entity":"人","field":"伤","value":null,"evidence":"痊愈"}]'), [{ entity: '人', field: '伤', value: null, evidence: '痊愈' }]);
  assert.throws(() => parseStateDelta('{}')); assert.throws(() => parseStateDelta('[{"entity":"人"}]'));
});
test('browser source hash matches exact UTF-8 draft', async () => {
  assert.equal(await draftHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(await draftHash('正文'), await draftHash('正文\n'));
});
