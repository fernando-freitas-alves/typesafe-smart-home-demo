import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStore } from '../chat-store.mjs';
import { ChatService } from '../chat-service.mjs';
import { LiveHome, buildLiveQuestions } from '../live-engine.mjs';
import { BridgeHomeClient } from '../bridge-client.mjs';
import { createChatBridge } from '../ha-chat-server.mjs';

const raw = () => ({ temperatureUnit: '°C', areas: [{ area_id: 'office', name: 'Fernando’s office' }], devices: [], entities: ['light.desk', 'light.mirror', 'light.ceiling'].map(entity_id => ({ entity_id, area_id: 'office' })), states: [
  ['light.desk', 'Office desk'], ['light.mirror', 'Office bathroom mirror'], ['light.ceiling', 'Office bathroom ceiling'],
].map(([entity_id, friendly_name]) => ({ entity_id, state: 'off', attributes: { friendly_name, supported_color_modes: ['onoff'] } })) });
function fakeHome(actor) {
  const client = { raw: raw(), writes: [], async inventory() { return structuredClone(this.raw); }, async callService(domain, service, data) { this.writes.push(data.entity_id); this.raw.states.find(item => item.entity_id === data.entity_id).state = 'on'; } };
  const received = [];
  const home = new LiveHome({ actor, client, settleMs: 0, settings: () => ({}), dependencies: { async evaluate(command, devices, context, signal, questions, user) {
    received.push(user);
    const values = { intent: 'smarthome_command', scope: command.includes('mirror') ? 'specific_device' : 'current_location', device_type: 'light', device: 'light__mirror', light_action: 'turn_on' };
    return { kind: 'typesafe', provider: 'TypeSafe', command, answers: Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, question.type === 'noul' ? { noul: 0 } : { choice: values[key] || Object.keys(question.criteria)[0] }])) };
  } } });
  return { home, client, received };
}
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ha-chat-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const actor = { id: 'user-one', name: 'Fernando Test' }; const store = new ChatStore(directory); const fake = fakeHome(actor);
  const service = new ChatService({ ...fake, actor, store, resolve: async command => ({ command }) });
  return { ...fake, actor, store, service, directory };
}
const location = 'office__space_bathroom';
test('follow-up resolution receives permitted fixture metadata and exact location, without identifying a voice speaker', async t => {
  const { service, client } = await setup(t);
  Object.assign(client.raw.entities[0], { icon: 'hue:bulb-group-spot-hung', aliases: ['Spotlights'], labels: ['spots'] });
  client.raw.labels = [{ label_id: 'spots', name: 'Spot lights' }];
  client.raw.states[0].attributes.private_token = 'must-not-reach-model';
  let context;
  service.resolve = async (text, previous, signal, model, metadata) => { context = metadata; return { command: text }; };
  await service.handle({ op: 'location', location });
  await service.handle({ op: 'send', text: 'Turn on that spot lights' });
  assert.equal(context.user.name, 'Fernando Test');
  assert.equal(context.user.location.id, location);
  assert.equal(context.user.location.space, 'bathroom');
  const desk = context.devices.find(device => device.entity_id === 'light.desk');
  assert.equal(desk.icon, 'hue:bulb-group-spot-hung');
  assert.deepEqual(desk.aliases, ['Spotlights']);
  assert.equal(desk.labels[0].name, 'Spot lights');
  assert.ok(!JSON.stringify(context).includes('must-not-reach-model'));
  await service.handle({ op: 'new', apiVersion: 1, client: { kind: 'voice', deviceId: 'mic' }, location });
  await service.handle({ op: 'send', text: 'Turn on the lights' });
  assert.equal(context.user.name, null); assert.equal(context.user.office, null);
  assert.equal(context.user.location.id, location);
  assert.equal(client.writes.length, 0);
});

async function pending(service) {
  await service.handle({ op: 'location', location });
  return service.handle({ op: 'send', text: 'Turn on the lights', requestId: crypto.randomUUID() });
}

test('location elicitation resumes the request and authenticated identity reaches Jev', async t => {
  const { service, client, received } = await setup(t);
  let result = await service.handle({ op: 'send', text: 'Turn on the lights', identity: 'flavia' });
  assert.equal(result.thread.messages.at(-1).form.kind, 'location');
  result = await service.handle({ op: 'location', location });
  assert.deepEqual(result.thread.messages.at(-1).form.actions.map(item => item.data.entity_id).sort(), ['light.ceiling', 'light.mirror']);
  assert.equal(received.at(-1).name, 'Fernando Test'); assert.equal(received.at(-1).office.id, 'office');
  assert.equal(received.at(-1).location.space, 'bathroom'); assert.equal(client.writes.length, 0);
});

test('an action selection is persisted before the first write, applied once, and never replayed', async t => {
  const { service, client, store, actor } = await setup(t); const result = await pending(service); const item = result.thread.messages.at(-1);
  const original = client.callService.bind(client);
  client.callService = async (...args) => { const saved = await store.load(actor.id); assert.equal(saved.threads[0].messages.find(m => m.id === item.id).form.status, 'applying'); return original(...args); };
  const applied = await service.handle({ op: 'apply', messageId: item.id, selected: [1], requestId: 'apply-one' });
  assert.equal(client.writes.length, 1); assert.equal(client.writes[0], item.form.actions[1].data.entity_id);
  assert.equal(applied.thread.messages.find(m => m.id === item.id).form.status, 'applied');
  assert.deepEqual(applied.thread.messages.find(m => m.id === item.id).form.selected, [1]);
  await service.handle({ op: 'apply', messageId: item.id, selected: [1], requestId: 'apply-one' });
  await assert.rejects(service.handle({ op: 'apply', messageId: item.id, selected: [1] }), /no longer active/);
  assert.equal(client.writes.length, 1);
});

test('typed approval respects the form selection and typing a refinement invalidates the previous plan', async t => {
  const { service, home, client } = await setup(t); const first = await pending(service); const id = first.thread.messages.at(-1).form.planId;
  let history;
  service.resolve = async (text, previous) => { history = previous; return { command: 'Turn on the bathroom mirror', durationMs: 1 }; };
  const refined = await service.handle({ op: 'send', text: 'Only the mirror' });
  assert.equal(home.pending.has(id), false); assert.equal(client.writes.length, 0);
  assert.ok(history.at(-2).proposedActions || history.at(-1).proposedActions);
  assert.equal(refined.thread.messages.at(-1).form.actions.length, 1);
  assert.equal(refined.thread.messages.at(-1).tools[0].name, 'Interpret follow-up');
  await service.handle({ op: 'send', text: 'yes', selected: [0] });
  assert.deepEqual(client.writes, ['light.mirror']);
});

test('cancelling, moving location, expired plans, and a restart cannot silently apply actions', async t => {
  const { service, home, client, store, actor } = await setup(t);
  await pending(service); await service.handle({ op: 'send', text: 'cancel' }); assert.equal(home.pending.size, 0);
  await pending(service); await service.handle({ op: 'location', location: 'office' }); assert.equal(home.pending.size, 0);
  await pending(service); home.pending.clear(); const restored = await service.handle({ op: 'open' });
  assert.equal(restored.thread.messages.at(-1).form.status, 'expired');
  await service.handle({ op: 'send', text: 'yes' }); assert.equal(client.writes.length, 0);
  const data = await store.load(actor.id); [...data.threads[0].messages].reverse().find(item => item.form?.kind === 'actions').form.status = 'applying'; await store.save(actor.id, data);
  const recovered = await service.handle({ op: 'open' }); assert.match(recovered.thread.messages.at(-1).text, /may have executed/);
  assert.equal(client.writes.length, 0);
});

test('chat history, locations, and approvals cannot cross user or thread boundaries', async t => {
  const { service, store, home, client } = await setup(t); const first = await pending(service); const item = first.thread.messages.at(-1);
  const second = await service.handle({ op: 'new' }); assert.equal(second.thread.location, '');
  await assert.rejects(service.handle({ op: 'apply', threadId: second.thread.id, messageId: item.id, selected: [0] }), /no longer active/);
  const other = new ChatService({ home, store, actor: { id: 'user-two', name: 'Flavia' } });
  await assert.rejects(other.handle({ op: 'open', threadId: first.thread.id }), /not available/);
  const restored = await service.handle({ op: 'open', threadId: first.thread.id }); assert.equal(restored.thread.location, location);
  assert.equal((await service.handle({ op: 'bootstrap' })).thread.id, first.thread.id);
  assert.equal(client.writes.length, 0); assert.equal((await stat(store.path('user-one'))).mode & 0o777, 0o600);
});

test('HA bridge filters current states and refuses writes outside the supplied permissions', async () => {
  let request;
  const client = new BridgeHomeClient({ haUrl: 'http://ha.test', fetchImpl: async (url, options) => { request = options; return Response.json([{ entity_id: 'light.desk', state: 'on', attributes: {} }, { entity_id: 'light.secret', state: 'on', attributes: {} }]); } });
  const inventory = raw(); inventory.controlEntities = ['light.desk'];
  client.begin({ inventory, accessToken: 'end-user-token' }); await client.inventory(); const fresh = await client.inventory();
  assert.deepEqual(fresh.states.map(s => s.entity_id), ['light.desk']); assert.equal(request.headers.Authorization, 'Bearer end-user-token');
  assert.throws(() => client.callService('light', 'turn_on', { entity_id: 'light.mirror' }), /cannot control/);
  const home = new LiveHome({ client, settings: () => ({}) }); client.firstRead = true;
  await assert.rejects(home.preview({ command: 'Mirror on', manual: { domain: 'light', service: 'turn_on', data: { entity_id: 'light.mirror' } } }), /cannot control/);
  client.end(); await assert.rejects(client.inventory(), /Reconnect/);
});

test('bridge requires its secret and forwards only the authenticated actor into isolated sessions', async t => {
  const { directory } = await setup(t); const actors = []; const secret = 'test-secret-'.repeat(4);
  const server = createChatBridge({ secret, directory, makeSession: (actor, store) => { actors.push(actor); return { client: { begin() {}, end() {} }, service: new ChatService({ ...fakeHome(actor), actor, store, resolve: async command => ({ command }) }) }; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/chat`;
  const post = (token, data) => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(data) });
  assert.equal((await post('wrong', {})).status, 401);
  const response = await post(secret, { actor: { id: 'actual-user', name: 'Fernando' }, accessToken: 'HA-user-secret', inventory: { ...raw(), controlEntities: [] }, input: { op: 'bootstrap', actor: { id: 'spoofed', name: 'Flavia' } } });
  const data = await response.json(); assert.equal(response.status, 200); assert.equal(data.user.id, 'actual-user'); assert.equal(actors.length, 1);
  assert.ok(!JSON.stringify(data).includes('HA-user-secret'));
  const saved = await readFile(new ChatStore(directory).path('actual-user'), 'utf8'); assert.ok(!saved.includes('HA-user-secret'));
});
