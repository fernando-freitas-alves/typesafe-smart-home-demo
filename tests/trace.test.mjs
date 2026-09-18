import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { redactDiagnostics } from '../trace-utils.mjs';
import { evaluate, contextualizeChat } from '../providers.mjs';
import { ChatService } from '../chat-service.mjs';
import { ChatStore } from '../chat-store.mjs';

function key(t, name, value) { const before = process.env[name]; process.env[name] = value; t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; }); }

test('diagnostics retain usage and public payloads but redact credentials recursively', () => {
  const value = { authorization: 'Bearer private', body: { apiKey: 'secret', access_token: 'hidden', nested: [{ cookie: 'session=secret', message: 'runtime-secret-value and Bearer random-token and sk-ant-test-secret' }], usage: { input_tokens: 21, output_tokens: 3 } } };
  const redacted = redactDiagnostics(value, ['runtime-secret-value']);
  assert.equal(redacted.authorization, '[redacted]'); assert.equal(redacted.body.apiKey, '[redacted]');
  assert.equal(redacted.body.access_token, '[redacted]'); assert.equal(redacted.body.nested[0].cookie, '[redacted]');
  assert.deepEqual(redacted.body.usage, { input_tokens: 21, output_tokens: 3 });
  assert.equal(redacted.body.nested[0].message, '[redacted] and Bearer [redacted] and [redacted]');
  assert.equal(value.body.apiKey, 'secret');
});

test('Jev diagnostics contain the actual body, answers, timing, status, usage, and request ID without headers', async t => {
  key(t, 'TYPESAFE_API_KEY', 'private-typesafe-key'); let sent;
  const answer = { answers: {}, model: 'jev-test', usage: { input_tokens: 100, output_tokens: 20 } };
  t.mock.method(globalThis, 'fetch', async (url, options) => { sent = { url, method: options.method, body: JSON.parse(options.body) }; return Response.json(answer, { headers: { 'x-request-id': 'request-123' } }); });
  const result = await evaluate('Turn on the lights', [{ id: 'light.test' }], 'devices', undefined, {}, { name: 'Fernando', location: { id: 'bathroom' } });
  assert.deepEqual(result.diagnostics.request, sent); assert.deepEqual(result.diagnostics.response.body, answer);
  assert.equal(result.diagnostics.response.status, 200); assert.equal(result.diagnostics.response.requestId, 'request-123');
  assert.equal(result.diagnostics.attempts.length, 1); assert.ok(result.diagnostics.durationMs >= 0);
  assert.ok(!JSON.stringify(result.diagnostics).includes('private-typesafe-key'));
});

test('provider errors expose safe request diagnostics without retaining an upstream credential echo', async t => {
  key(t, 'TYPESAFE_API_KEY', 'private-error-key');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ authorization: 'Bearer private-error-key' }, { status: 401 }));
  await assert.rejects(evaluate('Lights on', [], 'none', undefined, {}), error => {
    assert.equal(error.diagnostics.response.status, 401); assert.equal(error.diagnostics.request.body.state, 'Lights on');
    assert.equal(error.diagnostics.response.body, undefined); assert.ok(!JSON.stringify(error.diagnostics).includes('private-error-key')); return true;
  });
});

test('Anthropic follow-up retains the actual context request and parsed provider response', async t => {
  key(t, 'ANTHROPIC_API_KEY', 'private-anthropic-key'); let sent;
  t.mock.method(globalThis, 'fetch', async (url, options) => { sent = JSON.parse(options.body); return Response.json({ model: 'claude-test', content: [{ type: 'text', text: '{"command":"Turn on the bathroom mirror","clarification":null}' }], usage: { input_tokens: 20 }, stop_reason: 'end_turn' }); });
  const result = await contextualizeChat('Only the mirror', [{ role: 'user', text: 'Turn on the lights' }]);
  assert.deepEqual(result.diagnostics.request.body, sent); assert.equal(result.command, 'Turn on the bathroom mirror');
  assert.equal(result.diagnostics.response.body.model, 'claude-test'); assert.ok(!JSON.stringify(result.diagnostics).includes('private-anthropic-key'));
});

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'chat-traces-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ChatStore(directory); const actor = { id: 'owner', name: 'Fernando' };
  const home = { pending: new Map(), reads: 0, previews: 0, async snapshot() { this.reads++; return { rooms: [], devices: [] }; }, async preview() { this.previews++; return { rooms: [], devices: [], stages: [{ kind: 'response', text: 'Answer', diagnostics: { request: { body: { marker: 'unique-payload-content', authorization: 'hidden' } }, response: { body: { answer: 'Answer' } } } }], outcome: 'Done' }; } };
  return { store, actor, home, service: new ChatService({ home, actor, store, resolve: async command => ({ command }) }) };
}

test('payloads are stored privately outside chat history and inspection does not re-run any tools', async t => {
  const { service, home, store, actor } = await setup(t);
  const reply = await service.handle({ op: 'send', text: 'Hello' }); const tool = reply.thread.messages.at(-1).tools.at(-1);
  assert.ok(tool.detailsId); assert.ok(!JSON.stringify(reply).includes('unique-payload-content'));
  assert.ok(!(await readFile(store.path(actor.id), 'utf8')).includes('unique-payload-content'));
  const reads = home.reads;
  const expanded = await service.handle({ op: 'open', threadId: reply.thread.id, toolDetailsId: tool.detailsId });
  assert.equal(expanded.details.request.body.marker, 'unique-payload-content'); assert.equal(expanded.details.request.body.authorization, '[redacted]');
  assert.equal(home.previews, 1); assert.equal(home.reads, reads);
  assert.equal((await stat(store.detailsPath(actor.id, tool.detailsId))).mode & 0o777, 0o600);
  const reloaded = new ChatService({ home, actor, store });
  assert.deepEqual(await reloaded.handle({ op: 'open', threadId: reply.thread.id, toolDetailsId: tool.detailsId }), expanded);
});

test('tool details require the owning user and conversation; missing diagnostics preserve the chat', async t => {
  const { service, home, store } = await setup(t); const first = await service.handle({ op: 'send', text: 'Hello' }); const id = first.thread.messages.at(-1).tools.at(-1).detailsId;
  const second = await service.handle({ op: 'new' });
  await assert.rejects(service.handle({ op: 'open', threadId: second.thread.id, toolDetailsId: id }), /do not belong/);
  const guest = new ChatService({ home, store, actor: { id: 'someone-else', name: 'Guest' } });
  await assert.rejects(guest.handle({ op: 'open', threadId: first.thread.id, toolDetailsId: id }), /not available/);
  await assert.rejects(store.loadDetails('owner', '../../secrets'), /unavailable/);
  store.saveDetails = async () => { throw new Error('Disk unavailable'); };
  const result = await service.handle({ op: 'send', threadId: second.thread.id, text: 'Hello again' });
  assert.equal(result.thread.messages.at(-1).text, 'Answer'); assert.match(result.thread.messages.at(-1).tools.at(-1).detailsNote, /could not be saved/);
});
