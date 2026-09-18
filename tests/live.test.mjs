import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveHome, buildLiveQuestions, planLiveDecision } from '../live-engine.mjs';
import { buildLiveInventory, validateLiveService } from '../live-home.mjs';
import { HomeAssistantClient } from '../ha-client.mjs';
import { identityProfile } from '../live-identity.mjs';

function fixture() {
  const states = [
    { entity_id: 'light.study', state: 'off', attributes: { friendly_name: 'Study light', supported_color_modes: ['brightness'], brightness: 128, private_token: 'never-expose' } },
    { entity_id: 'light.hall', state: 'on', attributes: { friendly_name: 'Hall light', supported_color_modes: ['onoff'] } },
    { entity_id: 'climate.study', state: 'off', attributes: { friendly_name: 'Study AC', hvac_modes: ['off', 'cool', 'heat'], supported_features: 1, min_temp: 16, max_temp: 30, temperature: 22, current_temperature: 24 } },
    { entity_id: 'cover.study', state: 'open', attributes: { friendly_name: 'Study shade', supported_features: 15, current_position: 100 } },
    { entity_id: 'switch.valve', state: 'on', attributes: { friendly_name: 'Water valve' } },
    { entity_id: 'switch.desk', state: 'off', attributes: { friendly_name: 'Desk plug' } },
    { entity_id: 'lock.door', state: 'locked', attributes: { friendly_name: 'Front door' } },
    { entity_id: 'sensor.study_temperature', state: '24', attributes: { friendly_name: 'Study temperature', device_class: 'temperature', unit_of_measurement: '°C' } },
    { entity_id: 'sensor.network', state: 'secret-address', attributes: { friendly_name: 'Network address' } },
    { entity_id: 'switch.calibration', state: 'off', attributes: { friendly_name: 'Calibration' } },
    { entity_id: 'light.disabled', state: 'off', attributes: { friendly_name: 'Disabled' } },
  ];
  return { temperatureUnit: '°C', states, areas: [{ area_id: 'study', name: 'Study' }], devices: [{ id: 'hardware', area_id: 'study' }], entities: states.map(s => ({ entity_id: s.entity_id, device_id: 'hardware', disabled_by: s.entity_id === 'light.disabled' ? 'user' : null })) };
}
function fakeClient(raw = fixture()) {
  return { raw, writes: [], async inventory() { return structuredClone(this.raw); }, async callService(domain, service, data) {
    this.writes.push({ domain, service, data });
    const state = this.raw.states.find(s => s.entity_id === data.entity_id);
    state.state = service === 'turn_on' ? 'on' : service === 'turn_off' ? 'off' : state.state;
    if (data.brightness_pct !== undefined) state.attributes.brightness = Math.round(data.brightness_pct / 100 * 255);
  } };
}
const manual = (entity_id = 'light.study', service = 'turn_on', extra = {}) => ({ domain: entity_id.split('.')[0], service, data: { entity_id, ...extra } });
const create = client => new LiveHome({ client, settings: () => ({}), settleMs: 0 });
function stage(devices, values = {}, command = 'Turn on the study light') {
  const questions = buildLiveQuestions(devices);
  const selected = { intent: 'smarthome_command', scope: 'specific_device', device_type: 'light', device: 'light__study', room: 'study', light_action: 'turn_on', ...values };
  const answers = Object.fromEntries(Object.entries(questions).map(([key, q]) => [key, q.type === 'noul' ? { type: 'noul', noul: values.compound || 0 } : { type: 'choice', choice: selected[key] || Object.keys(q.criteria)[0], confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === (selected[key] || Object.keys(q.criteria)[0]) ? 1 : 0])) }]));
  return { kind: 'typesafe', provider: 'TypeSafe', command, questions, answers, durationMs: 1 };
}

function peopleFixture() {
  const raw = fixture();
  raw.areas = [{ area_id: 'study', name: 'Fernando’s office' }, { area_id: 'studio_b', name: 'Flavia’s office' }];
  raw.entities.find(e => e.entity_id === 'light.hall').area_id = 'studio_b';
  return raw;
}

test('profile offices follow runtime HA names and reject missing or ambiguous mappings', () => {
  for (const name of ['Fernando’s office', "Fernando's office", 'Fernando office', 'Escritório do Fernando']) {
    assert.equal(identityProfile('fernando', [{ id: 'arbitrary', name }]).office.id, 'arbitrary');
  }
  assert.equal(identityProfile('flavia', [{ id: 'a', name: 'Escritório da Flávia' }]).office.id, 'a');
  assert.equal(identityProfile('fernando', [{ id: 'a', name: 'Flavia’s office' }]).office, null);
  assert.equal(identityProfile('fernando', [{ id: 'a', name: 'Fernando office' }, { id: 'b', name: 'Fernando’s office' }]).office, null);
  assert.equal(identityProfile('other', [{ id: 'a', name: 'Fernando’s office' }]).office, null);
});

test('both identities and a separate location reach every Jev request without rewriting the command', async () => {
  const client = fakeClient(peopleFixture()); const received = [];
  const home = new LiveHome({ client, settings: () => ({}), dependencies: {
    evaluate: async (command, devices, context, signal, questions, user) => {
      received.push({ command, context, user });
      return stage(devices, { scope: 'area', room: /here/.test(command) ? user.location.id : user.office.id }, command);
    },
  } });
  for (const [identity, name, office, entity] of [['fernando', 'Fernando', 'study', 'light.study'], ['flavia', 'Flavia', 'studio_b', 'light.hall']]) {
    for (const context of ['none', 'devices']) {
      const command = 'Turn on all my office lights';
      const result = await home.preview({ command, identity, location: 'studio_b', context });
      assert.equal(received.at(-1).command, command); assert.equal(received.at(-1).context, context);
      assert.deepEqual(result.user, { name, office: { id: office, name: `${name}’s office` }, location: { id: 'studio_b', name: 'Flavia’s office' } });
      assert.deepEqual(received.at(-1).user, result.user);
      assert.deepEqual(result.actions.map(a => a.data.entity_id), [entity]);
    }
  }
  const here = await home.preview({ command: 'Turn on all lights here', identity: 'fernando', location: 'studio_b' });
  assert.deepEqual(here.actions.map(a => a.data.entity_id), ['light.hall']);
  const guest = await home.preview({ command: 'Turn on all lights here', identity: 'other', location: 'study' });
  assert.equal(guest.user.name, null); assert.equal(guest.user.office, null);
  assert.deepEqual(guest.actions.map(a => a.data.entity_id), ['light.study']);
  assert.equal(client.writes.length, 0);
});

test('unknown personal references, stale locations, invalid identities, and conflicting room filters stop before Jev', async () => {
  const client = fakeClient(peopleFixture()); let evaluated = 0;
  const home = new LiveHome({ client, settings: () => ({}), dependencies: { evaluate: async () => { evaluated++; throw new Error('Should not evaluate'); } } });
  for (const command of ['Turn on all my office lights', 'Acenda as luzes do meu escritório']) {
    await assert.rejects(home.preview({ command, identity: 'other' }), /choose Fernando or Flavia/);
    await assert.rejects(home.preview({ command, identity: 'fernando', room: 'studio_b' }), /Select that room or All rooms/);
  }
  for (const command of ['Turn on the lights here', 'Acenda as luzes aqui']) {
    await assert.rejects(home.preview({ command, identity: 'fernando' }), /select Where I am/);
    await assert.rejects(home.preview({ command, identity: 'fernando', location: 'studio_b', room: 'study' }), /Select that room or All rooms/);
  }
  await assert.rejects(home.preview({ command: 'Lights on', identity: '__proto__' }), /Choose Fernando/);
  await assert.rejects(home.preview({ command: 'Lights on', location: 'removed' }), /location is no longer available/);
  await assert.rejects(home.preview({ command: 'Lights on', location: { id: 'study' } }), /location is no longer available/);
  client.raw.areas[0].name = 'Renamed room';
  await assert.rejects(home.preview({ command: 'Turn on my office lights', identity: 'fernando' }), /Could not identify one office/);
  assert.equal(evaluated, 0); assert.equal(client.writes.length, 0); assert.equal(home.pending.size, 0);
});

test('compound requests retain the same selected context through splitting and each evaluation', async () => {
  const client = fakeClient(peopleFixture()); const contexts = [];
  const command = 'Turn on my office lights and turn off the lights here';
  const home = new LiveHome({ client, settings: () => ({}), dependencies: {
    evaluate: async (part, devices, context, signal, questions, user) => {
      contexts.push(user);
      return stage(devices, part === command ? { compound: 1 } : { scope: 'area', room: part.includes('here') ? user.location.id : user.office.id, light_action: part.includes('off') && !part.includes('office') ? 'turn_off' : 'turn_on' }, part);
    },
    splitCommand: async (part, signal, user) => {
      assert.equal(part, command); contexts.push(user);
      return { kind: 'split', commands: ['Turn on my office lights', 'Turn off the lights here'] };
    },
  } });
  const result = await home.preview({ command, identity: 'fernando', location: 'studio_b' });
  assert.equal(contexts.length, 4); for (const user of contexts) assert.deepEqual(user, result.user);
  assert.deepEqual(result.actions.map(a => [a.service, a.data.entity_id]), [['turn_on', 'light.study'], ['turn_off', 'light.hall']]);
  assert.equal(client.writes.length, 0);
});

test('explicit rooms and manual controls stay independent of selected identity and location', async () => {
  const client = fakeClient(peopleFixture());
  const home = new LiveHome({ client, settings: () => ({}), dependencies: {
    evaluate: async (command, devices) => stage(devices, { scope: 'area', room: 'studio_b' }, command),
  } });
  const result = await home.preview({ command: 'Turn on all Flavia’s office lights', identity: 'fernando', location: 'study' });
  assert.deepEqual(result.actions.map(a => a.data.entity_id), ['light.hall']);
  const explicit = await home.preview({ command: 'Turn on', manual: manual('light.hall'), identity: 'fernando', location: 'study' });
  assert.deepEqual(explicit.actions.map(a => a.data.entity_id), ['light.hall']);
  assert.equal(client.writes.length, 0);
});

test('general answers receive the same identity and location context as Jev', async () => {
  const client = fakeClient(peopleFixture()); let answered;
  const home = new LiveHome({ client, settings: () => ({}), dependencies: {
    evaluate: async (command, devices) => stage(devices, { intent: 'information_request' }, command),
    answerQuestion: async (command, signal, user) => { answered = user; return { kind: 'response', text: user.name }; },
  } });
  const result = await home.preview({ command: 'Who am I?', identity: 'flavia', location: 'study' });
  assert.deepEqual(answered, result.user); assert.equal(answered.name, 'Flavia'); assert.equal(answered.location.id, 'study');
  assert.equal(result.planId, undefined); assert.equal(client.writes.length, 0);
});

test('live discovery uses HA areas, filters maintenance/private attributes, and protects switches and locks', () => {
  const data = buildLiveInventory(fixture(), { haSwitchEntities: ['switch.desk'] });
  assert.equal(data.devices.find(d => d.entity_id === 'light.study').roomName, 'Study');
  assert.ok(!JSON.stringify(data).includes('never-expose'));
  for (const id of ['sensor.network', 'switch.calibration', 'light.disabled']) assert.ok(!data.devices.some(d => d.entity_id === id));
  assert.ok(data.devices.find(d => d.entity_id === 'switch.valve').readOnly);
  assert.ok(data.devices.find(d => d.entity_id === 'lock.door').readOnly);
  assert.equal(data.devices.find(d => d.entity_id === 'switch.desk').readOnly, false);
});
test('live service validation rejects unavailable devices, extra payload fields, unsupported actions, and bad ranges', () => {
  const devices = buildLiveInventory(fixture()).devices;
  for (const call of [manual('light.missing'), manual('switch.valve'), manual('lock.door', 'unlock'), manual('light.study', 'turn_on', { target: 'all' }), manual('light.hall', 'turn_on', { brightness_pct: 50 }), manual('climate.study', 'set_temperature', { temperature: 40 }), manual('climate.study', 'set_hvac_mode', { hvac_mode: 'dry' }), manual('cover.study', 'set_cover_position', { position: 110 })]) assert.throws(() => validateLiveService(call, devices));
  devices[0].available = false;
  assert.throws(() => validateLiveService(manual(devices[0].entity_id), devices));
});
test('preview reads server inventory, ignores supplied device state, and performs no writes', async () => {
  const client = fakeClient(); const home = create(client);
  const result = await home.preview({ command: 'Turn on Study', manual: manual(), devices: [{ entity_id: 'light.attacker' }] });
  assert.equal(client.writes.length, 0); assert.ok(result.planId); assert.equal(result.actions[0].data.entity_id, 'light.study');
  assert.equal(result.actions[0].before, 'Off');
});
test('apply executes once and verifies observed HA state; replay is rejected', async () => {
  const client = fakeClient(); const home = create(client);
  const preview = await home.preview({ command: 'Turn on Study', manual: manual() });
  const result = await home.apply(preview.planId);
  assert.equal(client.writes.length, 1); assert.equal(result.calls[0].observed, true); assert.match(result.outcome, /1 action observed/);
  await assert.rejects(home.apply(preview.planId), /already applied/); assert.equal(client.writes.length, 1);
});
test('changed states and expired previews block physical writes', async () => {
  const client = fakeClient(); let now = 1000;
  const home = new LiveHome({ client, settings: () => ({}), settleMs: 0, now: () => now });
  const preview = await home.preview({ command: 'Turn on Study', manual: manual() });
  client.raw.states[0].state = 'on';
  await assert.rejects(home.apply(preview.planId), /changed since/);
  const next = await home.preview({ command: 'Turn off Study', manual: manual('light.study', 'turn_off') });
  now += 120001; await assert.rejects(home.apply(next.planId), /expired/); assert.equal(client.writes.length, 0);
});
test('a successful HTTP response is not presented as observed device success', async () => {
  const client = fakeClient(); client.callService = async () => {};
  const home = create(client); const preview = await home.preview({ command: 'Turn on Study', manual: manual() });
  const result = await home.apply(preview.planId);
  assert.equal(result.calls[0].observed, false); assert.equal(result.changed.length, 0); assert.match(result.outcome, /0 observed/);
});
test('query plans are read only and quantitative commands preserve units and percentages', () => {
  const devices = buildLiveInventory(fixture()).devices;
  assert.equal(planLiveDecision(stage(devices, { intent: 'smarthome_query' }), devices).services.length, 0);
  const climate = planLiveDecision(stage(devices, { device_type: 'thermostat', device: 'climate__study', thermostat_action: 'set_temperature' }, 'Set Study AC to 77°F'), devices);
  assert.equal(climate.services[0].data.temperature, 25);
  const cover = planLiveDecision(stage(devices, { device_type: 'cover', device: 'cover__study', cover_action: 'set_cover_position' }, 'Set study shade to 35%'), devices);
  assert.equal(cover.services[0].data.position, 35);
});
test('a failed subcommand prevents the whole compound preview from producing a plan', async () => {
  const client = fakeClient(); const home = new LiveHome({ client, settings: () => ({}), settleMs: 0, dependencies: {
    evaluate: async (command, devices) => stage(devices, command === 'both' ? { compound: 1 } : command === 'blocked' ? { device_type: 'appliance', device: 'switch__valve', appliance_action: 'turn_off' } : {}, command),
    splitCommand: async () => ({ kind: 'split', commands: ['valid', 'blocked'] }),
  } });
  await assert.rejects(home.preview({ command: 'both' }), /not enabled/); assert.equal(client.writes.length, 0); assert.equal(home.pending.size, 0);
});
test('partial failure stops remaining calls, never retries, and reports observed results', async () => {
  const client = fakeClient(); const normal = client.callService.bind(client);
  client.callService = async (...args) => { if (client.writes.length === 1) { client.writes.push({ failed: true }); throw new Error('Not confirmed'); } return normal(...args); };
  const home = new LiveHome({ client, settings: () => ({}), settleMs: 0, dependencies: {
    evaluate: async (command, devices) => stage(devices, command === 'both' ? { compound: 1 } : command === 'hall' ? { device: 'light__hall', light_action: 'turn_off' } : {}, command),
    splitCommand: async () => ({ kind: 'split', commands: ['study', 'hall', 'study'] }),
  } });
  const preview = await home.preview({ command: 'both' }); const result = await home.apply(preview.planId);
  assert.equal(client.writes.length, 2); assert.equal(result.calls.length, 2); assert.equal(result.calls[0].observed, true); assert.match(result.outcome, /Stopped after 2 of 3/);
  await assert.rejects(home.apply(preview.planId)); assert.equal(client.writes.length, 2);
});
test('concurrent apply is rejected while a physical request is in progress', async () => {
  const client = fakeClient(); let release;
  client.callService = () => new Promise(resolve => { release = resolve; });
  const home = create(client); const preview = await home.preview({ command: 'Turn on', manual: manual() });
  const applying = home.apply(preview.planId);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(home.apply(preview.planId), /Another command/);
  release(); await applying;
});
test('HA transport never retries physical writes or exposes token/upstream error bodies', async () => {
  let requests = 0;
  const client = new HomeAssistantClient({ settings: () => ({ haUrl: 'http://ha.test:8123', haToken: 'private-token' }), fetchImpl: async (url, options) => {
    requests++; assert.equal(url, 'http://ha.test:8123/api/services/light/turn_on'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer private-token'); return new Response('private-token internal error', { status: 500 });
  } });
  await assert.rejects(client.callService('light', 'turn_on', { entity_id: 'light.study' }), error => /HTTP 500/.test(error.message) && !error.message.includes('private-token'));
  assert.equal(requests, 1);
});

test('temperature questions include the climate current-temperature reading', () => {
  const devices = buildLiveInventory(fixture()).devices;
  const plan = planLiveDecision(stage(devices, { intent: 'smarthome_query', scope: 'area', device_type: 'sensor', sensor_type: 'temperature' }, 'What is the room temperature?'), devices);
  assert.deepEqual(plan.targets.map(d => d.entity_id).sort(), ['climate.study', 'sensor.study_temperature']);
  assert.equal(plan.services.length, 0);
});

test('broad groups explicitly skip unavailable devices while named unavailable targets fail', () => {
  const raw = fixture(); raw.states.find(d => d.entity_id === 'light.hall').state = 'unavailable';
  const devices = buildLiveInventory(raw).devices;
  const result = planLiveDecision(stage(devices, { scope: 'whole_house' }, 'Turn off all lights'), devices);
  assert.deepEqual(result.services.map(c => c.data.entity_id), ['light.study']);
  assert.deepEqual(result.skipped.map(d => d.entity_id), ['light.hall']);
  assert.throws(() => planLiveDecision(stage(devices, { device: 'light__hall' }), devices), /unavailable/);
});
test('a combined HVAC mode and explicit temperature preserves both requested actions', () => {
  const devices = buildLiveInventory(fixture()).devices;
  const result = planLiveDecision(stage(devices, { device_type: 'thermostat', device: 'climate__study', thermostat_action: 'heat_on' }, 'Heat Study to 24°C'), devices);
  assert.deepEqual(result.services.map(c => c.service), ['set_hvac_mode', 'set_temperature']);
  assert.equal(result.services[1].data.temperature, 24);
});

test('HTTP preview and apply reach the HA REST adapter, then read back state without exposing credentials', async t => {
  const { createServer } = await import('node:http'); const { once } = await import('node:events');
  const { createDemoServer } = await import('../server.mjs'); const raw = fixture(); let writes = 0;
  const fakeHA = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer local-test-token');
    if (req.method === 'POST') {
      assert.equal(req.url, '/api/services/light/turn_on');
      let data = ''; for await (const chunk of req) data += chunk;
      assert.deepEqual(JSON.parse(data), { entity_id: 'light.study' });
      raw.states[0].state = 'on'; writes++; res.end('[]');
    } else { assert.equal(req.url, '/api/states'); res.end(JSON.stringify(raw.states)); }
  });
  fakeHA.listen(0, '127.0.0.1'); await once(fakeHA, 'listening');
  const settings = () => ({ haUrl: `http://127.0.0.1:${fakeHA.address().port}`, haToken: 'local-test-token' });
  const client = new HomeAssistantClient({ settings });
  client.inventory = async () => ({ ...raw, states: await client.request('states') });
  const demo = createDemoServer({ settings, live: new LiveHome({ client, settings, settleMs: 0 }) });
  demo.listen(0, '127.0.0.1'); await once(demo, 'listening');
  t.after(() => { demo.closeAllConnections(); fakeHA.closeAllConnections(); demo.close(); fakeHA.close(); });
  const base = `http://127.0.0.1:${demo.address().port}`;
  const post = async (path, body) => { const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) }); assert.equal(response.status, 200); return response.json(); };
  const preview = await post('/api/live/preview', { command: 'Turn on Study', manual: manual() });
  assert.equal(writes, 0);
  const applied = await post('/api/live/apply', { planId: preview.planId });
  assert.equal(writes, 1); assert.equal(applied.calls[0].observed, true);
  assert.ok(!JSON.stringify(applied).includes('local-test-token'));
});
