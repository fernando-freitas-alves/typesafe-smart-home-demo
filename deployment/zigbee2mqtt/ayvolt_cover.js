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
    // This _TZE284 variant reports 0 at the physically open limit, unlike
    // the related _TZE204 definition. HA always defaults to 100 = open.
    return invert ? value : 100 - value;
}
const ignoreAcknowledgement = { from: () => ({}) };
const commands = tuya.valueConverterBasic.lookup(options => options.invert_cover
    ? { OPEN: tuya.enum(2), STOP: tuya.enum(1), CLOSE: tuya.enum(0) }
    : { OPEN: tuya.enum(0), STOP: tuya.enum(1), CLOSE: tuya.enum(2) });

const control = {
    key: ['state', 'position', 'motor_direction'],
    convertSet: async (entity, key, value, meta) => {
        if (Array.isArray(meta.mapped)) throw new Error('Send shade commands to individual devices.');
        // Avoid conflicting instructions in one message; Z2M calls each
        // converter only once even when several of its keys are present.
        if (Object.keys(meta.message).length !== 1) throw new Error('Send one shade control per request.');
        if (key === 'state') {
            const command = commands.to(value, meta).valueOf();
            await tuya.sendDataPointEnum(entity, 1, command);
        } else if (key === 'position') {
            await tuya.sendDataPointValue(entity, 9, position(value, meta.options.invert_cover));
        } else if (key === 'motor_direction') {
            const direction = tuya.valueConverter.tubularMotorDirection.to(value, meta).valueOf();
            await tuya.sendDataPointEnum(entity, 11, direction);
        } else {
            throw new Error(`Unsupported shade control: ${key}`);
        }
        // Deliberately omit a sequence argument: the helpers allocate a new
        // per-device transaction number. tz.datapoints hardcodes seq=1, which
        // makes successive instructions indistinguishable to some motors.
        // A successful send is not proof of movement or arrival.
        return { state: {} };
    },
};

module.exports = [{
    fingerprint: tuya.fingerprint('TS0601', ['_TZE284_q9xty0ad']),
    model: 'AyVolt-Curtain',
    vendor: 'AyVolt',
    description: 'AyVolt Zigbee tubular curtain motor',
    // Includes the Tuya initialization handshake and gateway-status responses.
    extend: [tuya.modernExtend.tuyaBase()],
    fromZigbee: [tuya.fz.datapoints],
    toZigbee: [control],
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
            [11, 'motor_direction', tuya.valueConverter.tubularMotorDirection, { optimistic: false }],
        ],
    },
}];
