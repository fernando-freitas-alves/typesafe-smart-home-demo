// Opt-in integration check: this makes billable requests using the root .env.
import assert from 'node:assert/strict';
import { initialDevices, examples } from './home.mjs';
import { runRequest } from './engine.mjs';

const expected = [
  ['light.living_room_overhead', 'light.living_room_lamp'],
  ['light.living_room_overhead', 'light.living_room_lamp', 'light.kitchen_light', 'light.bedroom_light', 'light.office_light'],
  ['light.bedroom_light'], [], ['media_player.living_room_speaker'], ['switch.kitchen_coffee_maker'], [], ['fan.living_room_fan'],
  ['light.kitchen_light', 'lock.office_lock'], ['lock.office_lock'], ['climate.bedroom_thermostat'], [],
  ['light.living_room_overhead', 'light.living_room_lamp', 'light.kitchen_light', 'switch.kitchen_coffee_maker'],
];
let failures = 0;
for (const [index, command] of examples.entries()) {
  try {
    const result = await runRequest({ command, devices: initialDevices() });
    assert.deepEqual(result.calls.map(call => call.service_data.entity_id), expected[index]);
    if (index === 3) assert.match(result.stages.at(-1).text, /Kitchen Lights: On/);
    if (index === 6) assert.match(result.outcome, /No matching device/);
    if (index === 11) assert.equal(result.stages[0].answers.intent.choice, 'information_request');
    if ([8, 12].includes(index)) assert.ok(result.stages.some(stage => stage.kind === 'split'));
    console.log(`PASS ${command} (${result.durationMs}ms; ${[...new Set(result.stages.map(s => s.provider))].join(', ')})`);
  } catch (error) { failures++; console.error(`FAIL ${command}: ${error.message}`); }
}
console.log(`${examples.length - failures}/${examples.length} recorded examples passed. All Home Assistant operations were mocked.`);
process.exitCode = failures ? 1 : 0;
