import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatStore } from '../chat-store.mjs';
import { ChatService } from '../chat-service.mjs';
import { ChatApi, validateChatRequest } from '../chat-api.mjs';
import { LiveHome } from '../live-engine.mjs';
import { createChatBridge } from '../ha-chat-server.mjs';
import { createChatRequest, createChatClient, createHttpTransport } from '../custom_components/typesafe_chat/www/chat-client.js';

const voice = deviceId => ({ kind: 'voice', deviceId });
const req = (op, fields = {}, client = { kind: 'web' }) => createChatRequest(op, fields, client);
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'chat-api-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const actor = { id: 'owner', name: 'Fernando' }; const store = new ChatStore(directory);
  const raw = { temperatureUnit: '°C', areas: [{ area_id: 'office', name: 'Fernando’s office' }, { area_id: 'kitchen', name: 'Kitchen' }], devices: [],
    entities: [{ entity_id: 'light.office', area_id: 'office' }, { entity_id: 'light.bath', area_id: 'office' }, { entity_id: 'light.kitchen', area_id: 'kitchen' }],
    states: ['office', 'bath', 'kitchen'].map(name => ({ entity_id: `light.${name}`, state: 'off', attributes: { friendly_name: name === 'bath' ? 'Office bathroom light' : `${name} light`, supported_color_modes: ['onoff'] } })) };
  const client = { writes: [], async inventory() { return structuredClone(raw); }, async callService(domain, service, data) { this.writes.push(data.entity_id); raw.states.find(item => item.entity_id === data.entity_id).state = 'on'; } };
  const visitors = []; let evaluations = 0;
  const home = new LiveHome({ actor, client, settings: () => ({}), settleMs: 0, dependencies: { async evaluate(command, devices, context, signal, questions, user) {
    evaluations++; visitors.push(user);
    return { kind: 'typesafe', provider: 'TypeSafe', command, answers: { intent: { choice: command.startsWith('Which') ? 'smarthome_query' : 'smarthome_command' }, compound: { noul: 0 }, scope: { choice: 'current_location' }, device_type: { choice: 'light' }, light_action: { choice: 'turn_on' } } };
  } } });
  const service = new ChatService({ home, store, actor, resolve: async command => ({ command }) });
  return { api: new ChatApi(service), service, store, actor, home, client, visitors, directory, evaluations: () => evaluations };
}

test('v1 requires explicit conversations, authenticated context, and well-formed requests', () => {
  for (const [input, code] of [
    [{ ...req('bootstrap'), apiVersion: 2 }, 'unsupported_version'],
    [req('send', { text: 'yes' }), 'thread_required'],
    [{ ...req('new'), requestId: '' }, 'request_id_required'],
    [req('new', {}, { kind: 'voice' }), 'invalid_client'],
    [req('new', { actor: { name: 'Flavia' } }), 'invalid_request'],
    [req('new', { activate: true }), 'invalid_request'],
    [req('new', { threadId: 'existing' }), 'invalid_request'],
    [req('send', { threadId: 'x', text: 3 }), 'invalid_request'],
    [req('send', { threadId: 'x', text: 'hi', componentAction: {} }), 'invalid_request'],
    [req('send', { threadId: 'x', text: 'hi', model: { id: 'x' } }), 'invalid_request'],
    [req('new', { model: '' }), 'invalid_request'],
    [req('open', { threadId: 'x', model: 'auto' }), 'invalid_request'],
    [req('apply', { threadId: 'x', messageId: 'p', selected: [-1] }), 'invalid_request'],
  ]) assert.throws(() => validateChatRequest(input), error => error.code === code);
});

test('model choices persist per conversation, survive reopen, and stay within the authenticated account', async t => {
  const { api, service, store, home, client } = await setup(t);
  const allowed = new Set(['default', 'auto', 'fast-model', 'reasoning-model']);
  service.llm = { async validateModel(model) { if (!allowed.has(model)) throw new Error('Unavailable model'); } };
  const routed = [];
  service.resolve = async (command, history, signal, model) => { routed.push(['context', model]); return { command }; };
  const preview = home.preview.bind(home);
  home.preview = (input, signal) => { routed.push(['preview', input.model]); return preview(input, signal); };
  const first = await api.handle(req('new', { model: 'fast-model', location: 'office' }));
  const second = await api.handle(req('new', { model: 'reasoning-model', location: 'kitchen' }));
  const result = await api.handle(req('send', { threadId: first.thread.id, text: 'Which lights are on?', model: 'reasoning-model' }));
  assert.equal(result.thread.model, 'reasoning-model'); assert.equal(result.conversation.model, 'reasoning-model');
  assert.deepEqual(routed, [['context', 'reasoning-model'], ['preview', 'reasoning-model']]);
  assert.equal((await new ChatApi(service).handle(req('open', { threadId: first.thread.id }))).thread.model, 'reasoning-model');
  assert.equal((await api.handle(req('open', { threadId: second.thread.id }))).thread.model, 'reasoning-model');
  await api.handle(req('send', { threadId: first.thread.id, text: 'Which lights are on?', model: 'auto' }));
  assert.equal((await api.handle(req('open', { threadId: second.thread.id }))).thread.model, 'reasoning-model');
  const before = await store.load(service.actor.id);
  await assert.rejects(api.handle(req('send', { threadId: first.thread.id, text: 'Invalid selection', model: 'made-up' })), /Unavailable model/);
  const after = await store.load(service.actor.id);
  assert.deepEqual(after.threads, before.threads);
  const other = new ChatApi(new ChatService({ home, store, actor: { id: 'other-user', name: 'Guest' }, llm: service.llm }));
  await assert.rejects(other.handle(req('send', { threadId: first.thread.id, text: 'Hello', model: 'auto' })), error => error.code === 'thread_not_found');
  assert.equal((await other.handle(req('new'))).thread.model, 'default');
  assert.equal(client.writes.length, 0);
});

test('selecting a model does not prevent pending approvals when ChatGPT is offline', async t => {
  const { api, service, client } = await setup(t);
  const chat = await api.handle(req('new', { location: 'kitchen' }));
  const plan = await api.handle(req('send', { threadId: chat.thread.id, text: 'Turn on the lights' }));
  service.llm = { validateModel() { throw new Error('ChatGPT offline'); } };
  const result = await api.handle(req('send', { threadId: chat.thread.id, text: 'yes', model: 'fast-model', confirmationId: plan.reply.elicitation.id }));
  assert.deepEqual(client.writes, ['light.kitchen']);
  assert.equal(result.thread.model, 'default');
});

test('two voice devices retain separate locations and cannot confirm each other’s actions', async t => {
  const { api, store, actor, client, visitors } = await setup(t);
  const web = await api.handle(req('bootstrap'));
  const office = await api.handle(req('new', { location: 'office__space_bathroom' }, voice('office-mic')));
  const kitchen = await api.handle(req('new', { location: 'kitchen' }, voice('kitchen-mic')));
  assert.equal((await store.load(actor.id)).activeThreadId, web.thread.id);
  assert.equal(office.conversation.speaker.known, false);
  const plan = await api.handle(req('send', { threadId: office.thread.id, text: 'Turn on the lights' }, voice('office-mic')));
  assert.equal(plan.reply.status, 'awaiting_confirmation'); assert.equal(plan.reply.continueConversation, true);
  assert.deepEqual(plan.reply.elicitation.actions.map(action => action.entityId), ['light.bath']);
  assert.match(plan.reply.speech, /Office bathroom light/); assert.match(plan.reply.speech, /Say yes/); assert.doesNotMatch(plan.reply.speech, /click|below/i);
  assert.equal(visitors.at(-1).name, null); assert.equal(visitors.at(-1).office, null); assert.equal(visitors.at(-1).location.space, 'bathroom');
  const confirmationId = plan.reply.elicitation.id;
  await assert.rejects(api.handle(req('send', { threadId: office.thread.id, text: 'yes', confirmationId }, voice('kitchen-mic'))), error => error.code === 'conversation_mismatch');
  await assert.rejects(api.handle(req('send', { threadId: kitchen.thread.id, text: 'yes', confirmationId }, voice('kitchen-mic'))), error => error.code === 'confirmation_mismatch');
  await assert.rejects(api.handle(req('send', { threadId: office.thread.id, text: 'yes' }, voice('office-mic'))), error => error.code === 'confirmation_mismatch');
  assert.equal(client.writes.length, 0);
  const applied = await api.handle(req('send', { threadId: office.thread.id, text: 'yes', confirmationId }, voice('office-mic')));
  assert.equal(applied.reply.continueConversation, false); assert.deepEqual(client.writes, ['light.bath']);
  assert.equal((await store.load(actor.id)).activeThreadId, web.thread.id);
});

test('voice without a location receives structured elicitation; a supplied space resumes the request', async t => {
  const { api, client } = await setup(t);
  const discovery = await api.handle(req('bootstrap', {}, voice('mic')));
  assert.equal(discovery.conversation, undefined); assert.equal(discovery.reply, null); assert.ok(discovery.rooms.length);
  const chat = await api.handle(req('new', {}, voice('mic')));
  const question = await api.handle(req('send', { threadId: chat.thread.id, text: 'Turn on the lights' }, voice('mic')));
  assert.equal(question.reply.status, 'awaiting_location'); assert.ok(question.reply.elicitation.options.some(option => option.id === 'office__space_bathroom'));
  assert.equal(question.reply.speech, 'Which room or space are you in?');
  const resumed = await api.handle(req('location', { threadId: chat.thread.id, location: 'office__space_bathroom' }, voice('mic')));
  assert.equal(resumed.reply.status, 'awaiting_confirmation'); assert.equal(client.writes.length, 0);
  const unknown = await api.handle(req('send', { threadId: chat.thread.id, text: 'Turn on my office lights' }, voice('mic')));
  assert.equal(unknown.reply.status, 'awaiting_reply'); assert.match(unknown.reply.speech, /Which person/);
});

test('persisted request IDs prevent duplicate new chats, evaluations, and physical writes after restart', async t => {
  const { api, service, store, actor, client, evaluations } = await setup(t);
  const create = req('new', { location: 'kitchen' }, voice('mic'));
  const created = await api.handle(create); assert.equal((await store.load(actor.id)).threads.length, 1);
  let restarted = new ChatApi(service);
  const duplicate = await restarted.handle(create); assert.equal(duplicate.thread.id, created.thread.id); assert.equal(duplicate.replayed, true); assert.equal(duplicate.reply, null);
  const send = req('send', { threadId: created.thread.id, text: 'Turn on the lights' }, voice('mic'));
  const plan = await restarted.handle(send); await new ChatApi(service).handle(send); assert.equal(evaluations(), 1);
  const apply = req('apply', { threadId: created.thread.id, messageId: plan.reply.elicitation.id, selected: [0] }, voice('mic'));
  await restarted.handle(apply); assert.deepEqual(client.writes, ['light.kitchen']);
  restarted = new ChatApi(service); const replay = await restarted.handle(apply);
  assert.equal(replay.replayed, true); assert.equal(replay.reply, null); assert.deepEqual(client.writes, ['light.kitchen']);
  await assert.rejects(restarted.handle({ ...send, text: 'Turn off the lights' }), error => error.code === 'request_conflict');
  const saved = JSON.parse(await readFile(store.path(actor.id), 'utf8')); assert.ok(saved.requestRecords.every(record => !('text' in record) && !('accessToken' in record)));
});

test('a delayed yes cannot approve a revised proposal or a preview invalidated by a restart', async t => {
  const { api, home, client } = await setup(t);
  const created = await api.handle(req('new', { location: 'kitchen' })); const threadId = created.thread.id;
  const first = await api.handle(req('send', { threadId, text: 'Turn on the lights' }));
  const second = await api.handle(req('send', { threadId, text: 'Turn on the lights please' }));
  await assert.rejects(api.handle(req('send', { threadId, text: 'yes', confirmationId: first.reply.elicitation.id })), error => error.code === 'confirmation_mismatch');
  home.pending.clear();
  await assert.rejects(api.handle(req('send', { threadId, text: 'yes', confirmationId: second.reply.elicitation.id })), /no longer active/);
  assert.equal(client.writes.length, 0);
});

test('interrupted request records fail closed and failed requests do not re-execute', async t => {
  const { api, service, store, actor } = await setup(t);
  const created = await api.handle(req('new')); const input = req('rename', { threadId: created.thread.id, title: 'Renamed' });
  await api.handle(input);
  const data = await store.load(actor.id); data.requestRecords.find(record => record.id === input.requestId).status = 'processing'; await store.save(actor.id, data);
  await assert.rejects(new ChatApi(service).handle(input), error => error.code === 'request_incomplete');
  const bad = req('location', { threadId: created.thread.id, location: 'not-a-room' });
  await assert.rejects(api.handle(bad), /Choose a location/);
  let called = false; service.handle = async () => { called = true; };
  await assert.rejects(api.handle(bad), /Choose a location/); assert.equal(called, false);
});

test('voice archives stay in the device conversation and remain readable/restorable', async t => {
  const { api } = await setup(t); const device = voice('mic');
  const created = await api.handle(req('new', {}, device)); const threadId = created.thread.id;
  const archived = await api.handle(req('archive', { threadId }, device));
  assert.equal(archived.thread.id, threadId); assert.equal(archived.reply.status, 'archived');
  await assert.rejects(api.handle(req('send', { threadId, text: 'hi' }, device)), /Restore this archived chat/);
  const restored = await api.handle(req('archive', { threadId, archived: false }, device)); assert.equal(restored.thread.archived, false);
});

test('web and voice use the same authenticated HTTP bridge and shared transport client', async t => {
  const { directory, service, client } = await setup(t); const secret = 'api-test-secret-'.repeat(3);
  const server = createChatBridge({ secret, directory, makeSession: () => ({ client: { begin() {}, end() {} }, service }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const transport = async input => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify({ actor: service.actor, accessToken: 'private-token', inventory: { states: [], controlEntities: [] }, input }) });
    return response.json();
  };
  const sdk = createChatClient({ transport, client: voice('test-mic') });
  const payload = sdk.prepare('new', { location: 'kitchen' }); const result = await sdk.execute(payload);
  assert.equal(result.apiVersion, 1); assert.equal(result.conversation.source.deviceId, 'test-mic');
  assert.equal((await sdk.execute(payload)).replayed, true);
  await assert.rejects(sdk.call('send', { text: 'yes' }), error => error.code === 'thread_required');
  assert.equal(client.writes.length, 0);
  const other = new ChatApi(new ChatService({ store: service.store, home: service.home, actor: { id: 'other', name: 'Other' } }));
  await assert.rejects(other.handle(req('open', { threadId: result.thread.id })), error => error.code === 'thread_not_found');
});

test('HTTP client keeps credentials in headers, supports refresh, and never retries automatically', async () => {
  let calls = 0;
  const transport = createHttpTransport({ baseUrl: 'https://ha.example', token: async () => 'private-token', fetchImpl: async (url, options) => {
    calls++; assert.equal(url.pathname, '/api/typesafe_chat'); assert.equal(options.headers.Authorization, 'Bearer private-token'); assert.equal(options.redirect, 'error');
    assert.ok(!options.body.includes('private-token')); return Response.json({ error: 'Busy', code: 'busy' }, { status: 409 });
  } });
  await assert.rejects(transport(req('bootstrap')), error => error.code === 'busy' && error.status === 409); assert.equal(calls, 1);
  assert.throws(() => createHttpTransport({ baseUrl: 'https://user:secret@ha.example' }));
});

test('read-only voice queries return actual device readings alongside optional visual components', async t => {
  const { api, client } = await setup(t); const device = voice('kitchen-mic');
  const created = await api.handle(req('new', { location: 'kitchen' }, device));
  const result = await api.handle(req('send', { threadId: created.thread.id, text: 'Which lights are in this room?' }, device));
  assert.equal(result.reply.status, 'complete'); assert.match(result.reply.speech, /kitchen light.*Off/i);
  assert.equal(result.reply.components[0].cards[0].entityId, 'light.kitchen');
  assert.ok(result.reply.tools[0].detailsId); assert.equal(client.writes.length, 0);
  const details = await api.handle(req('open', { threadId: created.thread.id, toolDetailsId: result.reply.tools[0].detailsId }, device));
  assert.ok(details.details.response); assert.equal(details.reply, null);
});

test('simultaneous voice requests get an explicit busy response instead of mixing account context', async t => {
  const { directory, service } = await setup(t); const secret = 'concurrency-test-'.repeat(3);
  let unblock; let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { unblock = resolve; });
  const handle = service.handle.bind(service);
  service.handle = async (input, signal) => { if (input.op === 'send') { entered(); await hold; } return handle(input, signal); };
  const server = createChatBridge({ secret, directory, makeSession: () => ({ client: { begin() {}, end() {} }, service }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const post = input => fetch(`http://127.0.0.1:${server.address().port}/chat`, { method: 'POST', headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify({ actor: service.actor, accessToken: 'private-token', inventory: { states: [], controlEntities: [] }, input }) });
  const device = voice('mic'); const created = await (await post(req('new', { location: 'kitchen' }, device))).json();
  const first = post(req('send', { threadId: created.thread.id, text: 'Which lights are in this room?' }, device));
  await enteredPromise;
  try { const second = await post(req('new', {}, voice('other-mic'))); assert.equal(second.status, 409); assert.equal((await second.json()).code, 'busy'); }
  finally { unblock(); }
  assert.equal((await first).status, 200);
});

test('deselecting every action blocks approval but still allows a typed revision', async t => {
  const { api, client } = await setup(t);
  const created = await api.handle(req('new', { location: 'kitchen' })); const threadId = created.thread.id;
  const plan = await api.handle(req('send', { threadId, text: 'Turn on the lights' }));
  await assert.rejects(api.handle(req('send', { threadId, text: 'yes', confirmationId: plan.reply.elicitation.id, selected: [] })), /Select at least one action/);
  const revised = await api.handle(req('send', { threadId, text: 'Turn on the lights please', confirmationId: plan.reply.elicitation.id, selected: [] }));
  assert.equal(revised.reply.status, 'awaiting_confirmation'); assert.notEqual(revised.reply.elicitation.id, plan.reply.elicitation.id); assert.equal(client.writes.length, 0);
});
