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
const read = (dp, value, invert_cover = false) => JSON.parse(JSON.stringify(definition.meta.tuyaDatapoints.find(entry => entry[0] === dp)[2].from(value, {}, { invert_cover })));
assert.equal(definition.fingerprint[0].manufacturerName, '_TZE284_q9xty0ad');
// Physical observation: OPEN acknowledged DP1=0 and DP9=0, then reached DP8=0.
assert.deepEqual(read(8, 0), { position: 100, state: 'OPEN' });
assert.deepEqual(read(8, 100), { position: 0, state: 'CLOSE' });
assert.deepEqual(read(8, 64), { position: 36, state: 'OPEN' });
assert.deepEqual(read(8, 100, true), { position: 100, state: 'OPEN' });
for (const invalid of [-1, 101, 255, null, '50', 1.5]) assert.deepEqual(read(8, invalid), {});
assert.deepEqual(read(9, 0), { target_position: 100 });
assert.deepEqual(read(9, 20, true), { target_position: 20 });
assert.deepEqual(read(1, 2), {});
assert.deepEqual(read(3, 0), { motor_state: 'opening' });
assert.deepEqual(read(3, 1, true), { motor_state: 'opening' });
assert.deepEqual(read(3, 255), {});
(async () => {
    const calls = [];
    class Endpoint {
        ID = 1;
        deviceIeeeAddress = '0x0000000000000001';
        async command(...args) { calls.push(args); }
    }
    const entity = new Endpoint();
    const write = (key, value, options = {}) => definition.toZigbee[0].convertSet(entity, key, value, {
        mapped: definition, message: { [key]: value }, options,
    });
    for (const [key, value, dp, bytes, invert_cover = false] of [
        ['state', 'OPEN', 1, [0]], ['state', 'CLOSE', 1, [2]], ['state', 'STOP', 1, [1]],
        ['position', 35, 9, [0, 0, 0, 65]], ['position', 35, 9, [0, 0, 0, 35], true],
        ['state', 'OPEN', 1, [2], true], ['motor_direction', 'normal', 11, [0]],
    ]) {
        const result = await write(key, value, { invert_cover });
        const [cluster, command, payload] = calls.at(-1);
        assert.equal(cluster, 'manuSpecificTuya'); assert.equal(command, 'dataRequest');
        assert.equal(payload.dpValues[0].dp, dp); assert.deepEqual([...payload.dpValues[0].data], bytes);
        assert.deepEqual(JSON.parse(JSON.stringify(result.state)), {}); // A send/ack must not claim physical arrival.
    }
    // A quick movement/stop pair must have distinct Tuya transaction numbers.
    await write('state', 'OPEN');
    await write('state', 'STOP');
    assert.notEqual(calls.at(-2)[2].seq, calls.at(-1)[2].seq);
    assert.equal(new Set(calls.map(call => call[2].seq)).size, calls.length);
    const count = calls.length;
    for (const value of [-1, 101, null, '50', 1.5]) await assert.rejects(write('position', value));
    await assert.rejects(write('state', 'TOGGLE'));
    await assert.rejects(write('motor_direction', 'invalid'));
    await assert.rejects(definition.toZigbee[0].convertSet(entity, 'state', 'OPEN', {
        mapped: definition, message: { state: 'OPEN', position: 50 }, options: {},
    }));
    assert.equal(calls.length, count);
    entity.command = async () => { throw new Error('Transport failed'); };
    await assert.rejects(write('state', 'STOP'), /Transport failed/);
    console.log('PASS: observed AyVolt polarity, actual/target separation, unique command sequences, command encoding, invalid input, transport failure, and no optimistic state.');
})().catch(error => { console.error(error); process.exitCode = 1; });
