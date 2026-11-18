import http from 'node:http';

export async function startMockServices() {
  const state = { operations: new Map(), retains: [], recalls: [], banks: [], analyses: [], deletes: [], facts: [], lostAcknowledgements: 0, operationTransport: false, recallMalformed: false, analysisMalformed: false, onRecall: null };
  const server = http.createServer(async (req, res) => {
    let body;
    try { const chunks = []; for await (const chunk of req) chunks.push(chunk); body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null; }
    catch { res.writeHead(400).end(); return; }
    const json = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.url === '/chat/completions') {
      state.analyses.push(body);
      return json(200, { choices: [{ message: { content: state.analysisMalformed ? '{invalid' : JSON.stringify({ summary: '分析摘要', stateDelta: [{ entity: '主角', field: '位置', value: '山中', evidence: '进入山林' }], warnings: [] }) } }] });
    }
    const match = req.url.match(/^\/v1\/default\/banks\/((?:novel|chat)-[a-f0-9-]+)(.*)$/);
    if (!match) return json(404, {});
    const [, bank, suffix] = match;
    if (req.method === 'PUT' && !suffix) { state.banks.push({ bank, body }); return json(200, { bank_id: bank }); }
    if (req.method === 'DELETE' && suffix.startsWith('/documents/')) {
      state.deletes.push({ bank, document: suffix.slice('/documents/'.length) });
      if (state.deleteTransport) { req.socket.destroy(); return; }
      return json(200, { success: true, document_id: suffix.slice('/documents/'.length), memory_units_deleted: 1 });
    }
    if (req.method === 'GET' && suffix.startsWith('/operations/')) {
      if (state.operationTransport) { req.socket.destroy(); return; }
      const id = suffix.slice('/operations/'.length), operation = state.operations.get(id);
      return operation ? json(200, { operation_id: id, status: operation.status }) : json(404, { status: 'not_found' });
    }
    if (req.method === 'POST' && suffix === '/memories') {
      state.retains.push({ bank, body });
      if (!state.operations.has(body.operation_id)) state.operations.set(body.operation_id, { status: 'pending', body });
      if (state.lostAcknowledgements > 0) { state.lostAcknowledgements--; req.socket.destroy(); return; }
      return json(202, { operation_id: body.operation_id, status: state.operations.get(body.operation_id).status });
    }
    if (req.method === 'POST' && suffix === '/memories/recall') {
      state.recalls.push({ bank, body }); if (state.onRecall) await state.onRecall();
      if (state.recallMalformed) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{broken'); return; }
      return json(200, { results: state.facts });
    }
    return json(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
