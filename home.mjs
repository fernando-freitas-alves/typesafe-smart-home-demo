// These fixtures model HA states and service calls. Nothing connects to a real home.
const fixture = [
  ['light.living_room_overhead', 'Overhead Lights', 'living_room', 'light', 'on', { brightness: 204 }],
  ['light.living_room_lamp', 'Floor Lamp', 'living_room', 'light', 'off', { brightness: 128 }],
  ['fan.living_room_fan', 'Ceiling Fan', 'living_room', 'fan', 'off', {}],
  ['media_player.living_room_speaker', 'Smart Speaker', 'living_room', 'speaker', 'off', {}],
  ['light.kitchen_light', 'Kitchen Lights', 'kitchen', 'light', 'on', { brightness: 255 }],
  ['switch.kitchen_coffee_maker', 'Coffee Maker', 'kitchen', 'appliance', 'off', {}],
  ['light.bedroom_light', 'Bedroom Light', 'bedroom', 'light', 'off', { brightness: 77 }],
  ['climate.bedroom_thermostat', 'Thermostat', 'bedroom', 'thermostat', 'cool', { temperature: 72, temperature_unit: '°F', hvac_modes: ['off', 'cool', 'heat'] }],
  ['light.office_light', 'Desk Lamp', 'office', 'light', 'on', { brightness: 153 }],
  ['lock.office_lock', 'Door Lock', 'office', 'lock', 'locked', {}],
];

export const rooms = [
  { id: 'living_room', name: 'Living Room', icon: '🛋️' },
  { id: 'kitchen', name: 'Kitchen', icon: '🍳' },
  { id: 'bedroom', name: 'Bedroom', icon: '🛏️' },
  { id: 'office', name: 'Office', icon: '💻' },
];
export const deviceIcons = { light: '💡', fan: '🌀', speaker: '🔊', appliance: '☕', thermostat: '🌡️', lock: '🔒' };
export const examples = [
  'Turn on the living room lights', 'Turn off all the lights', "Turn on my kid’s light",
  'Is the kitchen light on?', 'Shut off all the music in the house', 'Get the coffee boiling',
  'Let’s get some outside music going', 'It’s going to be a hot day — turn on all the fans',
  'Turn off the kitchen lights and lock the office door', 'Lock up the whole house',
  'Set the bedroom to heat', 'Who won the World Series in 1989?',
  'Turn on the living room lights and turn off the kitchen. Oh, and can you get the coffee started?',
];

export function initialDevices() {
  return fixture.map(([entity_id, name, room, kind, state, attributes]) => ({
    entity_id, id: entity_id.split('.')[1], name, room, kind, state,
    attributes: { friendly_name: name, ...structuredClone(attributes) },
  }));
}

export function normalizeDevices(input) {
  const canonical = initialDevices();
  if (input === undefined) return canonical;
  if (!Array.isArray(input) || input.length !== canonical.length) throw new Error('Invalid mock home. Reset the home and try again.');
  return canonical.map(device => {
    const matches = input.filter(d => d?.entity_id === device.entity_id);
    const incoming = matches[0];
    const allowed = device.kind === 'lock' ? ['locked', 'unlocked'] : device.kind === 'thermostat' ? ['off', 'cool', 'heat'] : ['on', 'off'];
    if (matches.length !== 1 || !allowed.includes(incoming.state)) throw new Error('Invalid device state. Reset the home and try again.');
    device.state = incoming.state;
    if (device.kind === 'light') {
      const brightness = incoming.attributes?.brightness;
      if (!Number.isInteger(brightness) || brightness < 0 || brightness > 255) throw new Error('Invalid light brightness.');
      device.attributes.brightness = brightness;
    }
    return device;
  });
}

export function isActive(device) { return !['off', 'unlocked'].includes(device.state); }
export function stateLabel(device) {
  if (device.kind === 'lock') return device.state === 'locked' ? 'Locked' : 'Unlocked';
  if (device.kind === 'thermostat') return device.state === 'off' ? 'Off' : `${device.state === 'heat' ? 'Heat' : 'A/C'} · ${device.attributes.temperature}°F`;
  if (device.state === 'off') return 'Off';
  return device.kind === 'light' ? `On · ${Math.round(device.attributes.brightness / 255 * 100)}%` : 'On';
}

export class MockHomeAssistant {
  constructor(devices = initialDevices()) { this.devices = normalizeDevices(devices); this.calls = []; }
  getStates() { return structuredClone(this.devices); }
  callService(domain, service, data) {
    const device = this.devices.find(d => d.entity_id === data.entity_id);
    if (!device || device.entity_id.split('.')[0] !== domain) throw new Error('Unknown mock entity.');
    const supported = { light: ['turn_on', 'turn_off'], fan: ['turn_on', 'turn_off'], switch: ['turn_on', 'turn_off'], media_player: ['turn_on', 'turn_off'], lock: ['lock', 'unlock'], climate: ['set_hvac_mode'] };
    if (!supported[domain]?.includes(service)) throw new Error('Unsupported mock HA service.');
    if (domain === 'climate' && !['off', 'heat', 'cool'].includes(data.hvac_mode)) throw new Error('Unsupported HVAC mode.');
    if (data.brightness_pct !== undefined && (domain !== 'light' || !Number.isFinite(data.brightness_pct) || data.brightness_pct < 0 || data.brightness_pct > 100)) throw new Error('Invalid brightness.');
    if (domain === 'lock') device.state = service === 'lock' ? 'locked' : 'unlocked';
    else if (domain === 'climate') device.state = data.hvac_mode;
    else device.state = service === 'turn_off' ? 'off' : 'on';
    if (domain === 'light' && data.brightness_pct !== undefined) device.attributes.brightness = Math.round(data.brightness_pct / 100 * 255);
    this.calls.push({ domain, service, service_data: structuredClone(data), mocked: true });
    return structuredClone(device);
  }
}
