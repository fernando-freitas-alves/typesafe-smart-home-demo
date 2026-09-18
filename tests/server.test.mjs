import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createDemoServer } from '../server.mjs';

test('local server serves only public assets, protects its API, and never returns keys', async t => {
  let calls = 0;
  const server = createDemoServer({ settings: () => ({ typesafeKey: 'SECRET_TEST_KEY', typesafeModel: 'jev-latest' }), run: async input => { calls++; return { command: input.command, calls: [] }; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = await (await fetch(`${base}/api/config`)).text();
  assert.ok(!config.includes('SECRET_TEST_KEY'));
  assert.equal(JSON.parse(config).llm, 'Local fallback');
  for (const path of ['/.env', '/server.mjs', '/providers.mjs', '/%2e%2e/.env', '/photos/test.jpg']) assert.equal((await fetch(base + path)).status, 404);
  const page = await fetch(base);
  assert.equal(page.status, 200); assert.ok(page.headers.get('content-security-policy').includes("connect-src 'self'"));
  assert.match(await page.text(), /Decision Trace/);
  const rejected = await fetch(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other-site.example' }, body: '{"command":"test"}' });
  assert.equal(rejected.status, 403); assert.equal(calls, 0);
  const malformed = await fetch(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(malformed.status, 400); assert.equal(calls, 0);
  const large = await fetch(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'a'.repeat(33000) }) });
  assert.equal(large.status, 413); assert.equal(calls, 0);
  const good = await fetch(`${base}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{"command":"test"}' });
  assert.equal(good.status, 200); assert.equal(calls, 1);
  assert.equal((await good.json()).command, 'test');
});

test('live routes preserve origin/file boundaries and apply only the server-held preview ID', async t => {
  const operations = [];
  const server = createDemoServer({ settings: () => ({ haToken: 'PRIVATE_HA_TOKEN', haUrl: 'http://private-home', typesafeKey: 'PRIVATE_MODEL_KEY' }), live: {
    snapshot: async () => ({ devices: [], rooms: [] }),
    preview: async input => { operations.push(['preview', input.command]); return { planId: 'server-plan', actions: [] }; },
    apply: async planId => { operations.push(['apply', planId]); return { outcome: 'Observed' }; },
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/live', '/live.js', '/live.css', '/live-home.mjs', '/trace-ui.js']) assert.equal((await fetch(base + path)).status, 200);
  for (const path of ['/ha-client.mjs', '/live-engine.mjs', '/.local/ha-inventory.json', '/.env']) assert.equal((await fetch(base + path)).status, 404);
  const metadata = await (await fetch(base + '/api/config')).text(); assert.ok(!metadata.includes('PRIVATE_')); assert.ok(!metadata.includes('private-home'));
  assert.equal((await fetch(base + '/api/live/home', { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/live/apply', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' }, body: '{"planId":"server-plan"}' })).status, 403);
  assert.equal(operations.length, 0);
  const response = await fetch(base + '/api/live/apply', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ planId: 'server-plan', services: [{ domain: 'lock', service: 'unlock' }] }) });
  assert.equal(response.status, 200); assert.deepEqual(operations, [['apply', 'server-plan']]);
});
