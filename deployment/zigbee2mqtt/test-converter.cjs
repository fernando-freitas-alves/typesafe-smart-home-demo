// Run with Zigbee2MQTT's installed dependencies, without accessing any hardware:
// docker exec -i zigbee2mqtt node < deployment/zigbee2mqtt/test-converter.cjs
// Set AYVOLT_CONVERTER if the converter is staged outside /app/data/external_converters.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const requireZ2m = createRequire('/app/package.json');
const moduleObject = { exports: {} };
const path = process.env.AYVOLT_CONVERTER || '/app/data/external_converters/ayvolt_cover.js';
vm.runInNewContext(fs.readFileSync(path, 'utf8'), { require: requireZ2m, module: moduleObject });
const definition = moduleObject.exports[0];
const tuya = requireZ2m('zigbee-herdsman-converters/lib/tuya');
const read = (dp, value, invert_cover = false) => JSON.parse(JSON.stringify(definition.meta.tuyaDatapoints.find(entry => entry[0] === dp)[2].from(value, {}, { invert_cover })));
assert.equal(definition.fingerprint[0].manufacturerName, '_TZE284_q9xty0ad');
assert.deepEqual(read(8, 0), { position: 0, state: 'CLOSE' });
assert.deepEqual(read(8, 100), { position: 100, state: 'OPEN' });
assert.deepEqual(read(8, 64), { position: 64, state: 'OPEN' });
assert.deepEqual(read(8, 100, true), { position: 0, state: 'CLOSE' });
for (const invalid of [-1, 101, 255, null, '50', 1.5]) assert.deepEqual(read(8, invalid), {});
assert.deepEqual(read(9, 0), { target_position: 0 });
assert.deepEqual(read(9, 20, true), { target_position: 80 });
assert.deepEqual(read(1, 2), {});
assert.deepEqual(read(3, 0), { motor_state: 'opening' });
assert.deepEqual(read(3, 1, true), { motor_state: 'opening' });
assert.deepEqual(read(3, 255), {});
(async () => {
    const calls = [];
    const entity = { command: async (...args) => calls.push(args) };
    for (const [key, value, dp, bytes, invert_cover = false] of [
        ['state', 'OPEN', 1, [0]], ['state', 'CLOSE', 1, [2]], ['state', 'STOP', 1, [1]],
        ['position', 35, 9, [0, 0, 0, 35]], ['position', 35, 9, [0, 0, 0, 65], true],
        ['state', 'OPEN', 1, [2], true], ['motor_direction', 'normal', 11, [0]],
    ]) {
        const result = await tuya.tz.datapoints.convertSet(entity, key, value, { mapped: definition, message: { [key]: value }, options: { invert_cover } });
        const [cluster, command, payload] = calls.at(-1);
        assert.equal(cluster, 'manuSpecificTuya'); assert.equal(command, 'dataRequest');
        assert.equal(payload.dpValues[0].dp, dp); assert.deepEqual([...payload.dpValues[0].data], bytes);
        assert.deepEqual(result.state, {}); // A send/ack must not claim physical arrival.
    }
    const count = calls.length;
    await assert.rejects(tuya.tz.datapoints.convertSet(entity, 'position', 101, { mapped: definition, message: { position: 101 }, options: {} }));
    assert.equal(calls.length, count);
    console.log('PASS: real AyVolt position reports, target/actual separation, inversion, command encoding, invalid input, and no optimistic state.');
})().catch(error => { console.error(error); process.exitCode = 1; });
