import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AppError, hash } from './domain.mjs';

const novelView = r => ({ id: r.id, title: r.title, canon: r.canon, canonRevision: r.canon_revision, epoch: r.epoch });
const chapterView = r => ({ number: r.chapter_no, title: r.title, revision: r.revision, content: r.content, summary: r.summary, stateDelta: r.state_delta, storyTime: r.story_time, needsReview: r.needs_review });
const chapterQuery = `SELECT r.*, c.needs_review FROM nb_chapters c JOIN nb_revisions r ON (r.novel_id,r.chapter_no,r.revision)=(c.novel_id,c.chapter_no,c.active_revision) WHERE c.novel_id=$1`;
const contextQuery = chapterQuery.replace('r.*', 'r.chapter_no,r.title,r.revision,r.summary,r.state_delta,r.story_time');
export class Store {
  constructor(connectionString, options = {}) { this.pool = new pg.Pool({ connectionString, max: 8, ...options }); }
  async migrate() { await this.pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8')); }
  async close() { await this.pool.end(); }
  async transaction(fn, isolation = '') {
    const c = await this.pool.connect();
    try { await c.query(`BEGIN ${isolation}`); const value = await fn(c); await c.query('COMMIT'); return value; }
    catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; } finally { c.release(); }
  }
  async owned(c, owner, id, lock = '') {
    const { rows } = await c.query(`SELECT * FROM nb_novels WHERE id=$1 AND owner=$2 ${lock}`, [id, owner]);
    if (!rows.length) throw new AppError(404, 'NOT_FOUND', '小说不存在');
    return rows[0];
  }
  async list(owner) { return (await this.pool.query('SELECT * FROM nb_novels WHERE owner=$1 ORDER BY created_at,id', [owner])).rows.map(novelView); }
  async create(owner, title) { return novelView((await this.pool.query('INSERT INTO nb_novels(id,owner,title) VALUES($1,$2,$3) RETURNING *', [randomUUID(), owner, title])).rows[0]); }
  async snapshot(owner, id, target = 100001) {
    return this.transaction(async c => {
      const novel = novelView(await this.owned(c, owner, id));
      const chapters = (await c.query(contextQuery + ' AND c.chapter_no<$2 ORDER BY c.chapter_no', [id, target])).rows.map(chapterView);
      return { novel, chapters };
    }, 'ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }
  async detail(owner, id) {
    return this.transaction(async c => {
      const novel = novelView(await this.owned(c, owner, id));
      const chapters = (await c.query(contextQuery + ' ORDER BY c.chapter_no', [id])).rows.map(chapterView);
      const jobs = (await c.query(`SELECT j.*, EXISTS(SELECT 1 FROM nb_jobs old WHERE old.novel_id=j.novel_id AND old.chapter_no=j.chapter_no AND old.revision<j.revision AND old.status<>'synced') AS blocked FROM nb_jobs j WHERE novel_id=$1 ORDER BY chapter_no,revision`, [id])).rows.map(j => ({ id: j.id, chapterNumber: j.chapter_no, revision: j.revision, status: j.status, attempts: j.attempts, ...(j.error ? { error: j.error } : {}), blockedByEarlierJob: j.blocked }));
      return { novel, chapters: chapters.map(c => ({ number: c.number, title: c.title, revision: c.revision, needsReview: c.needsReview, summary: c.summary, syncStatus: jobs.find(j => j.chapterNumber === c.number && j.revision === c.revision)?.status || 'queued' })), jobs };
    }, 'ISOLATION LEVEL REPEATABLE READ READ ONLY');
  }
  async chapter(owner, id, number) {
    await this.owned(this.pool, owner, id);
    const rows = (await this.pool.query(chapterQuery + ' AND c.chapter_no=$2', [id, number])).rows;
    return rows.length ? chapterView(rows[0]) : null;
  }
  async checkEpoch(owner, id, epoch) {
    const novel = await this.owned(this.pool, owner, id);
    if (novel.epoch !== epoch) throw new AppError(409, 'CONTEXT_CHANGED', '小说内容已变更，请重新召回记忆');
  }
  async saveCanon(owner, id, input) {
    return this.transaction(async c => {
      const novel = await this.owned(c, owner, id, 'FOR UPDATE');
      if (novel.canon_revision !== input.expectedRevision) throw new AppError(409, 'REVISION_CONFLICT', '设定已更新，请重新载入');
      await c.query('INSERT INTO nb_canon_revisions(novel_id,revision,canon) VALUES($1,$2,$3)', [id, novel.canon_revision + 1, input.canon]);
      await c.query('UPDATE nb_chapters SET needs_review=true WHERE novel_id=$1', [id]);
      return novelView((await c.query('UPDATE nb_novels SET canon=$2,canon_revision=canon_revision+1,epoch=epoch+1 WHERE id=$1 RETURNING *', [id, input.canon])).rows[0]);
    });
  }
  async finalize(owner, id, number, input) {
    return this.transaction(async c => {
      await this.owned(c, owner, id, 'FOR UPDATE');
      const payloadHash = hash({ number, ...input });
      const prior = (await c.query('SELECT * FROM nb_requests WHERE novel_id=$1 AND request_id=$2', [id, input.requestId])).rows[0];
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '此请求编号已用于不同内容');
        return prior.receipt;
      }
      const current = (await c.query('SELECT active_revision FROM nb_chapters WHERE novel_id=$1 AND chapter_no=$2', [id, number])).rows[0];
      if ((current?.active_revision || 0) !== input.expectedRevision) throw new AppError(409, 'REVISION_CONFLICT', '章节版本已变化，请载入后合并');
      const revision = input.expectedRevision + 1;
      await c.query(`INSERT INTO nb_revisions(novel_id,chapter_no,revision,title,content,summary,state_delta,story_time,source_chat_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, number, revision, input.title, input.content, input.summary, JSON.stringify(input.stateDelta), input.storyTime, input.sourceChatId]);
      await c.query(`INSERT INTO nb_chapters(novel_id,chapter_no,active_revision) VALUES($1,$2,$3) ON CONFLICT(novel_id,chapter_no) DO UPDATE SET active_revision=$3,needs_review=false`, [id, number, revision]);
      const invalidated = (await c.query('UPDATE nb_chapters SET needs_review=true WHERE novel_id=$1 AND chapter_no>$2 RETURNING chapter_no', [id, number])).rows.map(r => r.chapter_no).sort((a, b) => a - b);
      const jobId = randomUUID();
      await c.query('INSERT INTO nb_jobs(id,novel_id,chapter_no,revision,operation_id) VALUES($1,$2,$3,$4,$5)', [jobId, id, number, revision, randomUUID()]);
      const receipt = { chapterNumber: number, revision, jobId, syncStatus: 'queued', invalidatedChapters: invalidated };
      await c.query('INSERT INTO nb_requests(novel_id,request_id,payload_hash,receipt) VALUES($1,$2,$3,$4)', [id, input.requestId, payloadHash, JSON.stringify(receipt)]);
      await c.query('UPDATE nb_novels SET epoch=epoch+1 WHERE id=$1', [id]);
      return receipt;
    });
  }
  async retry(owner, id, jobId) {
    return this.transaction(async c => {
      await this.owned(c, owner, id, 'FOR UPDATE');
      const j = (await c.query('SELECT * FROM nb_jobs WHERE id=$1 AND novel_id=$2 FOR UPDATE', [jobId, id])).rows[0];
      if (!j) throw new AppError(404, 'NOT_FOUND', '同步任务不存在');
      if (j.status === 'synced') return { status: 'synced' };
      // The worker owns in-flight jobs; a manual retry never resets an active submission.
      if (['queued', 'processing', 'retry'].includes(j.status)) return { status: j.status };
      await c.query(`UPDATE nb_jobs SET status='queued',operation_id=$2,attempts=0,error=NULL,retry_at=now(),terminal=false WHERE id=$1`, [jobId, j.terminal ? randomUUID() : j.operation_id]);
      return { status: 'queued' };
    });
  }
}
