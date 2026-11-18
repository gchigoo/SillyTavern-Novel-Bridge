import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { AppError, parse, schemas, uuid, chapterNumber, markdown } from './domain.mjs';
import { Store } from './store.mjs';
import { Hindsight, Analyzer, contextFor } from './hindsight.mjs';
import { Worker } from './worker.mjs';
import { ChatStore, ChatHindsight, ChatWorker, mountChatRoutes } from './chat-memory.mjs';

export function createApp({ store, hindsight, analyzer, chatHindsight = new ChatHindsight(hindsight), gatewaySecret, publicOrigin }) {
  if (!gatewaySecret || gatewaySecret.length < 24 || !publicOrigin) throw new Error('Missing required gateway configuration');
  const app = express(); app.disable('x-powered-by');
  app.get('/healthz', async (_req, res) => { try { await store.pool.query('SELECT 1'); res.json({ status: 'ok' }); } catch { res.status(503).json({ status: 'unavailable' }); } });
  app.use('/novel-bridge/api', (req, _res, next) => {
    const provided = req.get('X-Novel-Gateway') || '';
    const a = Buffer.from(provided), b = Buffer.from(gatewaySecret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(401, 'UNAUTHORIZED', '身份验证失败');
    const user = req.get('X-Novel-User') || '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(user)) throw new AppError(401, 'UNAUTHORIZED', '身份验证失败');
    req.owner = user;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (req.get('Origin') !== publicOrigin || !req.is('application/json'))) throw new AppError(403, 'CSRF_REJECTED', '请求来源或格式无效');
    next();
  });
  app.use('/novel-bridge/api', express.json({ limit: '2mb' }));
  const router = express.Router();
  mountChatRoutes(router, new ChatStore(store), chatHindsight);
  router.param('id', (req, _res, next, value) => { req.novelId = parse(uuid, value); next(); });
  router.param('number', (req, _res, next, value) => { if (!/^[1-9]\d*$/.test(value)) throw new AppError(400, 'INVALID_INPUT', '无效章节编号'); req.chapterNumber = parse(chapterNumber, Number(value)); next(); });
  router.get('/novels', async (req, res) => res.json({ novels: await store.list(req.owner) }));
  router.post('/novels', async (req, res) => { const input = parse(schemas.create, req.body); res.status(201).json(await store.create(req.owner, input.title)); });
  router.get('/novels/:id', async (req, res) => res.json(await store.detail(req.owner, req.novelId)));
  router.put('/novels/:id/canon', async (req, res) => res.json(await store.saveCanon(req.owner, req.novelId, parse(schemas.canon, req.body))));
  router.get('/novels/:id/chapters/:number', async (req, res) => res.json({ chapter: await store.chapter(req.owner, req.novelId, req.chapterNumber) }));
  router.get('/novels/:id/chapters/:number/export', async (req, res) => {
    const chapter = await store.chapter(req.owner, req.novelId, req.chapterNumber);
    if (!chapter) throw new AppError(404, 'NOT_FOUND', '章节不存在');
    res.set('Content-Disposition', `attachment; filename="chapter-${chapter.number}-r${chapter.revision}.md"`).type('text/markdown').send(markdown(chapter));
  });
  router.post('/novels/:id/context', async (req, res) => res.json(await contextFor(store, hindsight, req.owner, req.novelId, parse(schemas.context, req.body))));
  router.post('/novels/:id/analyze', async (req, res) => {
    const input = parse(schemas.analyze, req.body);
    const context = await contextFor(store, hindsight, req.owner, req.novelId, { chapterNumber: input.chapterNumber, query: input.query || '' });
    let result;
    try { result = await analyzer.analyze(context.contextText, input.content); } catch { throw new AppError(502, 'ANALYSIS_FAILED', '一致性检查失败，可稍后重试或手动填写摘要和状态变更'); }
    await store.checkEpoch(req.owner, req.novelId, context.epoch);
    res.json({ ...result, warnings: [...context.warnings, ...result.warnings] });
  });
  router.post('/novels/:id/chapters/:number/finalize', async (req, res) => res.json(await store.finalize(req.owner, req.novelId, req.chapterNumber, parse(schemas.finalize, req.body))));
  router.post('/novels/:id/jobs/:jobId/retry', async (req, res) => {
    if (!req.body || Object.getPrototypeOf(req.body) !== Object.prototype || Object.keys(req.body).length) throw new AppError(400, 'INVALID_INPUT', '重试请求格式无效');
    res.json(await store.retry(req.owner, req.novelId, parse(uuid, req.params.jobId)));
  });
  app.use('/novel-bridge/api', router);
  app.use('/novel-bridge/api', (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', '接口不存在')));
  app.use((error, _req, res, _next) => {
    if (error instanceof AppError) return res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: '请求过大' } });
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'JSON 格式无效' } });
    console.error('novel_bridge_request_failed');
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用' } });
  });
  return app;
}
export async function start(env = process.env) {
  for (const key of ['DATABASE_URL', 'GATEWAY_SECRET', 'PUBLIC_ORIGIN', 'HINDSIGHT_URL', 'HINDSIGHT_API_KEY', 'CPA_BASE_URL', 'CPA_API_KEY', 'EXPORT_ROOT']) if (!env[key]) throw new Error(`Missing ${key}`);
  const store = new Store(env.DATABASE_URL); await store.migrate();
  const hindsight = new Hindsight({ url: env.HINDSIGHT_URL, key: env.HINDSIGHT_API_KEY, recallTimeout: Number(env.RECALL_TIMEOUT_MS || 90000), operationTimeout: Number(env.OPERATION_TIMEOUT_MS || 15000) });
  const analyzer = new Analyzer({ url: env.CPA_BASE_URL, key: env.CPA_API_KEY, model: env.CPA_MODEL || 'gpt-5.6-luna', timeout: Number(env.ANALYSIS_TIMEOUT_MS || 300000) });
  const app = createApp({ store, hindsight, analyzer, gatewaySecret: env.GATEWAY_SECRET, publicOrigin: env.PUBLIC_ORIGIN });
  const worker = new Worker(store, hindsight, { exportRoot: env.EXPORT_ROOT });
  const chatWorker = new ChatWorker(new ChatStore(store), new ChatHindsight(hindsight), { exportRoot: env.EXPORT_ROOT });
  const server = app.listen(Number(env.PORT || 3100), '0.0.0.0', () => { worker.start(); chatWorker.start(); });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; server.close(); await Promise.all([worker.stop(), chatWorker.stop()]); await store.close(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return { app, store, worker, server, stop };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start().catch(() => { console.error('novel_bridge_start_failed'); process.exitCode = 1; });
