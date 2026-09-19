// AyVolt TS0601 _TZE284_q9xty0ad.
// Protocol reference: zigbee-herdsman-converters' _TZE204_q9xty0ad definition.
// DP8 (actual position) and DP9 (target) verified against this variant's reports.
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const tuya = require('zigbee-herdsman-converters/lib/tuya');
const e = exposes.presets;
const ea = exposes.access;

function position(value, invert) {
    if (!Number.isInteger(value) || value < 0 || value > 100) {
        throw new Error('Cover position must be an integer from 0 to 100.');
    }
    return invert ? 100 - value : value;
}
const ignoreAcknowledgement = { from: () => ({}) };
const commands = tuya.valueConverterBasic.lookup(options => options.invert_cover
    ? { OPEN: tuya.enum(2), STOP: tuya.enum(1), CLOSE: tuya.enum(0) }
    : { OPEN: tuya.enum(0), STOP: tuya.enum(1), CLOSE: tuya.enum(2) });

module.exports = [{
    fingerprint: tuya.fingerprint('TS0601', ['_TZE284_q9xty0ad']),
    model: 'AyVolt-Curtain',
    vendor: 'AyVolt',
    description: 'AyVolt Zigbee tubular curtain motor',
    // Includes the Tuya initialization handshake and gateway-status responses.
    extend: [tuya.modernExtend.tuyaBase({ dp: true })],
    options: [exposes.options.invert_cover()],
    exposes: [
        e.cover_position().setAccess('position', ea.STATE_SET),
        e.numeric('target_position', ea.STATE).withUnit('%').withValueMin(0).withValueMax(100)
            .withDescription('Target reported by the motor; not its measured position'),
        e.enum('motor_state', ea.STATE, ['opening', 'closing'])
            .withDescription('Last movement direction reported by the motor'),
        e.enum('motor_direction', ea.STATE_SET, ['normal', 'reversed']).withDescription('Motor rotation direction'),
    ],
    meta: {
        tuyaDatapoints: [
            // DP1 acknowledges an instruction, not arrival at the requested state.
            [1, null, ignoreAcknowledgement],
            [1, 'state', { to: commands.to }, { optimistic: false }],
            [3, null, { from: (value, meta, options) => {
                if (![0, 1].includes(value)) return {};
                const opening = options.invert_cover ? value === 1 : value === 0;
                return { motor_state: opening ? 'opening' : 'closing' };
            } }],
            [8, null, { from: (value, meta, options) => {
                // Uncalibrated/sentinel values must never become a false position.
                if (!Number.isInteger(value) || value < 0 || value > 100) return {};
                const actual = position(value, options.invert_cover);
                return { position: actual, state: actual === 0 ? 'CLOSE' : 'OPEN' };
            } }],
            // Read target acknowledgements separately. Only DP8 confirms position.
            [9, null, { from: (value, meta, options) => {
                if (!Number.isInteger(value) || value < 0 || value > 100) return {};
                return { target_position: position(value, options.invert_cover) };
            } }],
            [9, 'position', { to: (value, meta) => position(value, meta.options.invert_cover) }, { optimistic: false }],
            [11, 'motor_direction', tuya.valueConverter.tubularMotorDirection, { optimistic: false }],
        ],
    },
}];
