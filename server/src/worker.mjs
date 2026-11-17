import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { exportParts, markdown } from './domain.mjs';
import { ProviderError } from './hindsight.mjs';

export async function exportRevision(root, job) {
  const filename = path.resolve(root, ...exportParts(job.novel_id, job.chapter_no, job.revision));
  const content = markdown({ number: job.chapter_no, revision: job.revision, title: job.title, content: job.content });
  await mkdir(path.dirname(filename), { recursive: true });
  try { if (await readFile(filename, 'utf8') !== content) throw new ProviderError('export_mismatch'); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    try { await link(temporary, filename); }
    catch (error) { if (error.code !== 'EEXIST') throw error; if (await readFile(filename, 'utf8') !== content) throw new ProviderError('export_mismatch'); }
  } finally { await unlink(temporary).catch(() => {}); }
}
export class Worker {
  constructor(store, hindsight, { exportRoot, pollMs = 5000, maxAttempts = 8, retryBaseMs = 1000 } = {}) {
    Object.assign(this, { store, hindsight, exportRoot, pollMs, maxAttempts, retryBaseMs }); this.running = false; this.stopping = false;
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    let c, locked = false;
    try {
      c = await this.store.pool.connect();
      locked = (await c.query('SELECT pg_try_advisory_lock(784210611) AS locked')).rows[0].locked;
      if (!locked) return;
      const { rows } = await c.query(`SELECT j.*,r.title,r.content,r.summary,r.story_time FROM nb_jobs j JOIN nb_revisions r USING(novel_id,chapter_no,revision)
        WHERE j.status IN ('queued','processing','retry') AND j.retry_at<=now()
        AND NOT EXISTS(SELECT 1 FROM nb_jobs old WHERE old.novel_id=j.novel_id AND old.chapter_no=j.chapter_no AND old.revision<j.revision AND old.status<>'synced')
        ORDER BY j.retry_at,j.created_at,j.id LIMIT 10`);
      for (const job of rows) { if (this.stopping) break; await this.process(c, job); }
    } finally {
      if (locked) await c.query('SELECT pg_advisory_unlock(784210611)').catch(() => {});
      c?.release(); this.running = false;
    }
  }
  async process(c, job) {
    try {
      if (!job.exported) {
        try { await exportRevision(this.exportRoot, job); } catch (error) { throw error instanceof ProviderError ? error : new ProviderError('export_failed'); }
        await c.query('UPDATE nb_jobs SET exported=true WHERE id=$1', [job.id]);
      }
      const status = await this.hindsight.operation(job.novel_id, job.operation_id);
      if (status === 'completed') {
        await c.query(`UPDATE nb_jobs SET status='synced',terminal=true,error=NULL WHERE id=$1`, [job.id]); return;
      }
      if (['failed', 'cancelled'].includes(status)) {
        await c.query(`UPDATE nb_jobs SET status='failed',terminal=true,error=$2 WHERE id=$1`, [job.id, `operation_${status}`]); return;
      }
      if (status === 'not_found') { await this.hindsight.ensureBank(job.novel_id); await this.hindsight.retain(job); }
      await c.query(`UPDATE nb_jobs SET status='processing',error=NULL,retry_at=now()+($2::double precision * interval '1 millisecond') WHERE id=$1`, [job.id, this.pollMs]);
    } catch (error) {
      const attempts = job.attempts + 1;
      const category = error instanceof ProviderError ? error.category : 'worker_failure';
      await c.query(`UPDATE nb_jobs SET status=$2,attempts=$3,error=$4,retry_at=now()+($5::double precision * interval '1 millisecond') WHERE id=$1`, [job.id, attempts >= this.maxAttempts ? 'paused' : 'retry', attempts, category, Math.min(300000, this.retryBaseMs * 2 ** Math.min(attempts - 1, 16))]);
    }
  }
  start() {
    this.stopping = false;
    const loop = async () => {
      try { await this.tick(); } catch { console.error('novel_bridge_worker_database_unavailable'); }
      if (!this.stopping) this.timer = setTimeout(loop, this.pollMs);
    };
    this.loopPromise = loop();
  }
  async stop() {
    this.stopping = true; clearTimeout(this.timer);
    while (this.running) await new Promise(resolve => setTimeout(resolve, 20));
  }
}
