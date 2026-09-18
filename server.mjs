import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config } from './providers.mjs';
import { runRequest } from './engine.mjs';
import { LiveHome } from './live-engine.mjs';

const publicFiles = new Map([
  ['/', ['public/index.html', 'text/html']], ['/index.html', ['public/index.html', 'text/html']],
  ['/app.js', ['public/app.js', 'text/javascript']], ['/style.css', ['public/style.css', 'text/css']],
  ['/home.mjs', ['home.mjs', 'text/javascript']],
  ['/trace-ui.js', ['public/trace-ui.js', 'text/javascript']],
  ['/live', ['public/live.html', 'text/html']], ['/live/', ['public/live.html', 'text/html']],
  ['/live.js', ['public/live.js', 'text/javascript']], ['/live.css', ['public/live.css', 'text/css']],
  ['/live-home.mjs', ['live-home.mjs', 'text/javascript']],
  ['/live-identity.mjs', ['live-identity.mjs', 'text/javascript']],
]);
function send(response, status, data) { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); }

export function createDemoServer({ run = runRequest, settings = config, live = new LiveHome({ settings }) } = {}) {
  let inFlight = 0;
  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let path;
    try { path = new URL(request.url, 'http://localhost').pathname; } catch { return send(response, 400, { error: 'Invalid URL.' }); }
    const expectedOrigins = [`http://${request.headers.host}`];
    // This server holds an API key; unrelated websites cannot trigger paid requests.
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(request.headers.host ?? '') || (request.headers.origin && !expectedOrigins.includes(request.headers.origin))) return send(response, 403, { error: 'Open the demo from its localhost address.' });
    if (request.method === 'GET' && path === '/api/config') {
      const s = settings();
      return send(response, 200, { typesafe: Boolean(s.typesafeKey), model: s.typesafeModel, llm: s.anthropicKey ? 'Anthropic' : 'Local fallback', mockedHome: true, liveConfigured: Boolean(s.haToken && s.haUrl) });
    }
    if (request.method === 'GET' && path === '/api/live/home') {
      try { return send(response, 200, await live.snapshot()); }
      catch (error) { return send(response, 503, { error: error.message }); }
    }
    if (request.method === 'POST' && ['/api/command', '/api/live/preview', '/api/live/apply'].includes(path)) {
      if (!request.headers['content-type']?.startsWith('application/json')) return send(response, 415, { error: 'Use JSON for commands.' });
      if (inFlight >= 4) return send(response, 429, { error: 'The demo is busy. Wait for the current requests, then retry.' });
      inFlight++;
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 65000);
      response.on('close', () => { if (!response.writableEnded) controller.abort(); });
      try {
        let body = '';
        for await (const chunk of request) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 32000) { send(response, 413, { error: 'The request is too large.' }); return; }
        }
        let input;
        try { input = JSON.parse(body); } catch { return send(response, 400, { error: 'Invalid JSON request.' }); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return send(response, 400, { error: 'Enter a command.' });
        const result = path === '/api/live/preview' ? await live.preview(input, controller.signal) : path === '/api/live/apply' ? await live.apply(input.planId, controller.signal) : await run(input, undefined, controller.signal);
        send(response, 200, result);
      } catch (error) {
        if (!response.destroyed) send(response, 400, { error: controller.signal.aborted ? (path === '/api/live/apply' ? 'The request timed out. Some actions may have executed. Refresh device states before trying again.' : 'The request timed out. Please retry. No devices were changed.') : error.message });
      } finally { clearTimeout(deadline); inFlight--; }
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, { error: 'Method not allowed.' });
    const file = publicFiles.get(path);
    if (!file) return send(response, 404, { error: 'Not found.' });
    try {
      const content = await readFile(new URL(file[0], import.meta.url));
      response.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch { send(response, 500, { error: 'Demo assets are missing. Check the local files.' }); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.DEMO_PORT || 5188);
  const server = createDemoServer();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Run DEMO_PORT=${port + 1} npm run demo.` : error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Mock demo: http://localhost:${port}\nLive Home Assistant: http://localhost:${port}/live\nKeys stay on the server.`));
}
