import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceComponent, deviceCollection, resolveComponentAction } from '../chat-components.mjs';
import { renderDeviceCollections, renderReviewAction } from '../custom_components/typesafe_chat/www/chat-components.js';
import { ChatService } from '../chat-service.mjs';
import { ChatStore } from '../chat-store.mjs';
import { LiveHome } from '../live-engine.mjs';

const light = (extra = {}) => ({ entity_id: 'light.desk', domain: 'light', kind: 'light', name: 'Desk lamp', roomName: 'Office', available: true, readOnly: false, state: 'on', attributes: { brightness: 128, supported_color_modes: ['brightness'] }, ...extra });
const climate = () => light({ entity_id: 'climate.office', domain: 'climate', kind: 'thermostat', state: 'heat', temperatureUnit: '°C', attributes: { current_temperature: 22.5, temperature: 24, min_temp: 16, max_temp: 30, target_temp_step: 0.5, hvac_modes: ['off', 'heat'], supported_features: 1 } });
const threadFor = (devices = [light()]) => ({ messages: [{ id: 'query', role: 'assistant', components: deviceCollection(devices, { capturedAt: '2026-09-18T23:45:00Z' }) }] });

test('the component catalog renders domain-specific data without exporting raw device metadata', () => {
  const lamp = deviceComponent(light({ attributes: { ...light().attributes, authorization: 'not-public' } }));
  assert.equal(lamp.type, 'light'); assert.equal(lamp.progress, 50); assert.equal(lamp.controls.find(c => c.action === 'brightness').value, 50);
  assert.ok(!JSON.stringify(lamp).includes('not-public'));
  const ac = deviceComponent(climate()); assert.equal(ac.value, 22.5); assert.equal(ac.unit, '°C'); assert.equal(ac.controls.find(c => c.action === 'set_temperature').step, 0.5);
  const sensor = deviceComponent(light({ kind: 'sensor', domain: 'sensor', state: '0', attributes: { unit_of_measurement: 'W', device_class: 'power' }, readOnly: true }));
  assert.equal(sensor.value, '0'); assert.equal(sensor.unit, 'W'); assert.deepEqual(sensor.controls, []);
  const presence = deviceComponent(light({ kind: 'sensor', domain: 'binary_sensor', state: 'off', attributes: { device_class: 'occupancy' }, readOnly: true }));
  assert.equal(presence.value, 'Clear');
  const cover = deviceComponent(light({ kind: 'cover', domain: 'cover', state: 'open', attributes: { current_position: 42, supported_features: 7 } }));
  assert.equal(cover.progress, 42); assert.ok(cover.controls.some(c => c.action === 'set_cover_position'));
  assert.equal(deviceComponent({ kind: 'script' }), null);
});

test('unavailable, read-only, and unsupported controls never appear; receipts preserve unconfirmed states', () => {
  assert.deepEqual(deviceComponent(light({ available: false, state: 'unavailable' })).controls, []);
  assert.deepEqual(deviceComponent(light({ readOnly: true })).controls, []);
  assert.ok(!deviceComponent(light({ attributes: { supported_color_modes: ['onoff'] } })).controls.some(c => c.action === 'brightness'));
  const cards = deviceCollection([light(), light()], { controls: false, calls: [{ data: { entity_id: 'light.desk' }, observed: false }] })[0].cards;
  assert.equal(cards.length, 1); assert.equal(cards[0].observed, false); assert.deepEqual(cards[0].controls, []);
});

test('card actions are bound to their conversation and fresh device capabilities', () => {
  const thread = threadFor(); const snapshot = { devices: [light()] };
  const input = { messageId: 'query', entityId: 'light.desk', action: 'brightness', value: 35 };
  assert.deepEqual(resolveComponentAction(input, thread, snapshot).call, { domain: 'light', service: 'turn_on', data: { entity_id: 'light.desk', brightness_pct: 35 } });
  assert.deepEqual(resolveComponentAction({ ...input, value: 0 }, thread, snapshot).call, { domain: 'light', service: 'turn_off', data: { entity_id: 'light.desk' } });
  for (const patch of [{ messageId: 'other-chat' }, { entityId: 'light.secret' }, { action: 'unlock' }, { value: 101 }, { value: -1 }, { value: '35' }, { value: 35.3 }]) assert.throws(() => resolveComponentAction({ ...input, ...patch }, thread, snapshot));
  assert.throws(() => resolveComponentAction(input, thread, { devices: [] }), /no longer available/);
  assert.throws(() => resolveComponentAction(input, thread, { devices: [light({ readOnly: true })] }), /no longer available/);
  assert.throws(() => resolveComponentAction(input, thread, { devices: [light({ available: false })] }), /no longer available/);
  const ac = climate(); const acThread = threadFor([ac]); const action = { messageId: 'query', entityId: ac.entity_id, action: 'set_temperature', value: 22.5 };
  assert.equal(resolveComponentAction(action, acThread, { devices: [ac] }).call.data.temperature, 22.5);
  assert.throws(() => resolveComponentAction({ ...action, value: 22.1 }, acThread, { devices: [ac] }), /steps/);
  assert.throws(() => resolveComponentAction({ ...action, action: 'set_hvac_mode', value: 'cool' }, acThread, { devices: [ac] }), /supported mode/);
});

test('rendered components escape untrusted names, retain fallbacks, and collapse long collections', () => {
  const components = deviceCollection(Array.from({ length: 8 }, (_, i) => light({ entity_id: `light.item_${i}`, name: '<img src=x onerror=alert(1)>', roomName: '<script>bad</script>' })));
  const html = renderDeviceCollections(components, 'message', { busy: true });
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script>')); assert.match(html, /&lt;img/);
  assert.match(html, /Show 2 more devices/); assert.match(html, /Snapshot|Saved snapshot/); assert.match(html, /disabled/);
  assert.equal(renderDeviceCollections([{ version: 99, type: 'device_collection', cards: [deviceComponent(light())] }]), '');
  assert.equal(renderDeviceCollections(undefined), '');
  const review = renderReviewAction({ name: '<unsafe>', roomName: 'Office', before: 'Off', label: 'Turn on · Desk', component: deviceComponent(light()) }, 1, true);
  assert.match(review, /&lt;unsafe&gt;/); assert.match(review, /value="1" checked/); assert.match(review, /action-transition/);
});

test('a real query produces only matched cards; card interaction previews, approval writes once, and history survives reload', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gen-ui-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const actor = { id: 'fernando', name: 'Fernando' }; const store = new ChatStore(directory);
  let writes = 0; let evaluations = 0; let state = 'off';
  const client = { async inventory() { return { areas: [{ area_id: 'office', name: 'Office' }], devices: [], entities: ['light.desk', 'light.other'].map(entity_id => ({ entity_id, area_id: 'office' })), states: ['light.desk', 'light.other'].map(entity_id => ({ entity_id, state, attributes: { friendly_name: entity_id, supported_color_modes: ['onoff'] } })) }; }, async callService() { writes++; state = 'on'; } };
  const home = new LiveHome({ actor, client, settings: () => ({}), settleMs: 0, dependencies: { async evaluate(command) { evaluations++; return { kind: 'typesafe', command, answers: { intent: { choice: 'smarthome_query' }, compound: { noul: 0 }, scope: { choice: 'specific_device' }, device_type: { choice: 'light' }, device: { choice: 'light__desk' } } }; } } });
  const service = new ChatService({ actor, store, home, resolve: async command => ({ command }) });
  const result = await service.handle({ op: 'send', text: 'Is the desk light on?' }); const message = result.thread.messages.at(-1);
  assert.deepEqual(message.components[0].cards.map(c => c.entityId), ['light.desk']); assert.equal(writes, 0);
  const action = { messageId: message.id, entityId: 'light.desk', action: 'turn_on' };
  const preview = await service.handle({ op: 'send', threadId: result.thread.id, componentAction: action });
  const form = preview.thread.messages.at(-1); assert.equal(form.form.actions[0].component.type, 'light'); assert.equal(form.form.actions[0].data.entity_id, 'light.desk'); assert.equal(writes, 0); assert.equal(evaluations, 1);
  await service.handle({ op: 'apply', messageId: form.id, selected: [0], requestId: 'apply-card' }); assert.equal(writes, 1);
  const reopened = await new ChatService({ actor, store, home }).handle({ op: 'open', threadId: result.thread.id });
  assert.equal(reopened.thread.messages.at(-1).components[0].cards[0].observed, true);
  assert.equal(reopened.thread.messages.find(m => m.id === message.id).components[0].cards[0].value, 'Off');
  await service.handle({ op: 'apply', messageId: form.id, selected: [0], requestId: 'apply-card' }); assert.equal(writes, 1);
  const other = await service.handle({ op: 'new' });
  await assert.rejects(service.handle({ op: 'send', threadId: other.thread.id, componentAction: action }), /does not belong/);
});
