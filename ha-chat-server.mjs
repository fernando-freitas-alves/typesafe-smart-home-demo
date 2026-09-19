import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeHomeClient } from './bridge-client.mjs';
import { LiveHome } from './live-engine.mjs';
import { ChatStore } from './chat-store.mjs';
import { ChatService } from './chat-service.mjs';
import { ChatApi, CHAT_OPERATIONS } from './chat-api.mjs';

const operations = new Set(CHAT_OPERATIONS);
export function createChatBridge({ secret, directory = './.local/chats', haUrl = 'http://127.0.0.1:8123', makeSession } = {}) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('CHAT_BRIDGE_TOKEN must contain at least 32 characters.');
  const sessions = new Map(); const store = new ChatStore(directory);
  const send = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  return createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/chat') return send(res, 404, { error: 'Not found.' });
    const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') || ''); const expected = Buffer.from(secret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(res, 401, { error: 'Unauthorized.' });
    let session; let timer; let input;
    try {
      let body = '';
      for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 2000000) return send(res, 413, { error: 'Request too large.' }); }
      const payload = JSON.parse(body);
      const { actor, inventory, accessToken } = payload; input = payload.input;
      if (!actor || typeof actor.id !== 'string' || !actor.id || typeof actor.name !== 'string' || !operations.has(input?.op) || !Array.isArray(inventory?.states) || !Array.isArray(inventory?.controlEntities) || typeof accessToken !== 'string' || !accessToken) return send(res, 400, { error: 'Invalid authenticated chat request.' });
      session = sessions.get(actor.id);
      if (!session) {
        if (sessions.size >= 100) { const idle = [...sessions].find(([, item]) => !item.busy); if (idle) sessions.delete(idle[0]); else return send(res, 429, { error: 'Chat is busy. Try again shortly.' }); }
        if (makeSession) session = makeSession(actor, store);
        else { const client = new BridgeHomeClient({ haUrl }); const home = new LiveHome({ client, actor }); session = { client, service: new ChatService({ home, actor, store }) }; }
        sessions.set(actor.id, session);
      }
      if (session.busy) { session = null; return send(res, 409, { error: 'Another request is running for your account. Wait for its result.', code: 'busy' }); }
      session.busy = true;
      session.service.actor.name = actor.name;
      session.client.begin(payload);
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 75000);
      // Keep processing after a browser disconnect: persist the result and never
      // replay physical actions to recover from a lost HTTP response.
      session.api ||= new ChatApi(session.service);
      const result = await (input.apiVersion === undefined ? session.service.handle(input, controller.signal) : session.api.handle(input, controller.signal));
      send(res, 200, result);
    } catch (error) { send(res, error.status || 400, { error: error instanceof SyntaxError ? 'Invalid JSON.' : error.message, code: error.code || 'operation_failed', ...(input?.apiVersion !== undefined ? { apiVersion: 1, requestId: input.requestId || null } : {}) }); }
    finally { clearTimeout(timer); if (session) { session.client.end(); session.busy = false; } }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createChatBridge({ secret: process.env.CHAT_BRIDGE_TOKEN, directory: process.env.CHAT_DATA_DIR || './.local/chats', haUrl: process.env.CHAT_HA_URL || 'http://127.0.0.1:8123' });
  server.listen(Number(process.env.CHAT_PORT || 5189), '127.0.0.1', () => console.log('Home chat bridge listening on loopback.'));
}
