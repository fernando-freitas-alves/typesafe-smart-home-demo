const domains = { light: 'light', fan: 'fan', climate: 'thermostat', cover: 'cover', media_player: 'speaker', switch: 'appliance', lock: 'lock', sensor: 'sensor', binary_sensor: 'sensor' };
const sensorClasses = new Set(['temperature', 'humidity', 'illuminance', 'battery', 'power', 'energy', 'occupancy', 'motion', 'opening', 'door', 'window', 'moisture', 'smoke', 'gas', 'carbon_monoxide']);
const maintenance = /calibration|firmware|child.?lock|pairing|reverse|backlight|power.?switch|indicator|do.?not.?disturb|dust.?empty|mop.?wash|night.?sleep|smart.?sleep|location.?weather/i;
const attributes = ['brightness', 'supported_color_modes', 'supported_features', 'device_class', 'temperature', 'current_temperature', 'hvac_modes', 'min_temp', 'max_temp', 'target_temp_step', 'current_position', 'unit_of_measurement', 'volume_level', 'percentage', 'entity_id'];
export const liveIcons = { light: '💡', fan: '🌀', thermostat: '🌡️', cover: '🪟', speaker: '🔊', appliance: '🔌', lock: '🔒', sensor: '◉' };
export const kindLabels = { light: 'Lights', fan: 'Fans', thermostat: 'Climate', cover: 'Covers', speaker: 'Media', appliance: 'Switches', lock: 'Locks', sensor: 'Sensors' };

const subspaces = [
  { key: 'bathroom', name: 'bathroom', pattern: /\b(?:bathroom|washroom|banheiro|lavabo)\b/i },
  { key: 'closet', name: 'closet', pattern: /\b(?:closet|dressing room)\b/i },
];
const plainName = name => name.normalize('NFD').replace(/\p{M}/gu, '');

function physicalRoom(areaId, areaName, name, aliases) {
  // Some HA areas contain a main room and adjoining spaces. Keep HA untouched;
  // only separate spaces explicitly named by their entities, never fixture types.
  const subspace = subspaces.find(space => !space.pattern.test(plainName(areaName)) && space.pattern.test(plainName([name, ...aliases].join(' '))));
  return subspace ? { id: `${areaId}__space_${subspace.key}`, name: `${areaName} · ${subspace.name}`, space: subspace.key } : { id: areaId, name: areaName, space: 'main' };
}

export function buildLiveInventory(raw, { haSwitchEntities = [] } = {}) {
  const registry = new Map(raw.entities.map(e => [e.entity_id, e]));
  const hardware = new Map(raw.devices.map(d => [d.id, d]));
  const areaNames = new Map(raw.areas.map(a => [a.area_id, a.name]));
  const overrides = new Map(raw.states.filter(s => s.entity_id.startsWith('sensor.lighting_override_')).map(s => [s.attributes.light, { state: s.state, remainingMinutes: s.attributes.remaining_minutes, protected: s.attributes.protected }]));
  const devices = [];
  for (const state of raw.states) {
    const domain = state.entity_id.split('.')[0]; const kind = domains[domain];
    if (!kind) continue;
    const entry = registry.get(state.entity_id); const device = hardware.get(entry?.device_id);
    if (entry?.disabled_by || entry?.hidden_by || entry?.entity_category || device?.disabled_by) continue;
    const name = entry?.name || state.attributes.friendly_name || state.entity_id;
    if (maintenance.test(name + ' ' + state.entity_id)) continue;
    if (kind === 'sensor' && !sensorClasses.has(state.attributes.device_class)) continue;
    const areaId = entry?.area_id || device?.area_id || 'unassigned';
    const areaName = areaNames.get(areaId) || 'Unassigned';
    const aliases = entry?.aliases || [];
    const space = areaId === 'unassigned' ? { id: areaId, name: areaName, space: 'main' } : physicalRoom(areaId, areaName, name, aliases);
    const attrs = Object.fromEntries(attributes.filter(key => state.attributes[key] !== undefined).map(key => [key, state.attributes[key]]));
    const readOnly = kind === 'sensor' || kind === 'lock' || (domain === 'switch' && !haSwitchEntities.includes(state.entity_id));
    const available = !['unknown', 'unavailable'].includes(state.state);
    devices.push({ entity_id: state.entity_id, id: state.entity_id.replace('.', '__'), domain, kind, name, room: space.id,
      roomName: space.name, areaId, areaName, space: space.space, aliases, state: state.state, attributes: attrs,
      temperatureUnit: raw.temperatureUnit, available, readOnly,
      readOnlyReason: kind === 'sensor' ? 'Sensor · read only' : kind === 'lock' ? 'Locks are read only on this page.' : readOnly ? 'Switch control is not enabled in the local configuration.' : '',
      override: overrides.get(state.entity_id) || null });
  }
  const byId = new Map(devices.map(d => [d.entity_id, d]));
  for (const device of devices) if (Array.isArray(device.attributes.entity_id)) {
    device.groupRooms = [...new Set(device.attributes.entity_id.map(id => byId.get(id)?.room || 'unknown'))];
  }
  devices.sort((a, b) => a.roomName.localeCompare(b.roomName) || a.name.localeCompare(b.name));
  return { devices, rooms: [...new Map(devices.map(d => [d.room, { id: d.room, name: d.roomName, area: { id: d.areaId, name: d.areaName }, space: d.space }])).values()],
    updatedAt: new Date().toISOString(), counts: { total: devices.length, controllable: devices.filter(d => !d.readOnly).length, unavailable: devices.filter(d => !d.available).length } };
}

export function liveActive(device) {
  return device.available && ['on', 'playing', 'heat', 'cool', 'auto', 'heat_cool', 'dry', 'fan_only', 'open', 'opening', 'locked'].includes(device.state);
}
export function liveLabel(d) {
  if (!d.available) return d.state === 'unknown' ? 'Unknown state' : 'Unavailable';
  if (d.kind === 'sensor') return `${d.state}${d.attributes.unit_of_measurement ? ' ' + d.attributes.unit_of_measurement : ''}`;
  if (d.kind === 'thermostat') return `${d.state.replaceAll('_', ' ')}${Number.isFinite(d.attributes.temperature) ? ' · ' + d.attributes.temperature + d.temperatureUnit : ''}${Number.isFinite(d.attributes.current_temperature) ? ' · now ' + d.attributes.current_temperature + d.temperatureUnit : ''}`;
  if (d.kind === 'cover') return `${d.state}${Number.isFinite(d.attributes.current_position) ? ' · ' + d.attributes.current_position + '% open' : ''}`;
  if (d.kind === 'light' && d.state === 'on' && Number.isFinite(d.attributes.brightness)) return `On · ${Math.round(d.attributes.brightness / 255 * 100)}%`;
  return d.state.charAt(0).toUpperCase() + d.state.slice(1).replaceAll('_', ' ');
}
export function deviceFingerprint(d) {
  return JSON.stringify([d.state, d.attributes.brightness, d.attributes.temperature, d.attributes.current_position, d.available]);
}
export function availableActions(d) {
  if (!d.available || d.readOnly) return [];
  const actions = {
    light: ['turn_on', 'turn_off'], fan: ['turn_on', 'turn_off'], appliance: ['turn_on', 'turn_off'],
    speaker: ['turn_on', 'turn_off', 'media_play', 'media_pause'], cover: [], thermostat: [],
  }[d.kind] || [];
  if (d.kind === 'light' && d.attributes.supported_color_modes?.some(mode => !['onoff', 'unknown'].includes(mode))) actions.push('brightness');
  if (d.kind === 'cover') {
    const features = d.attributes.supported_features || 0;
    if (features & 1) actions.push('open_cover');
    if (features & 2) actions.push('close_cover');
    if (features & 8) actions.push('stop_cover');
    if (features & 4) actions.push('set_cover_position');
  }
  if (d.kind === 'thermostat') {
    if (d.attributes.hvac_modes?.length) actions.push('set_hvac_mode');
    if ((d.attributes.supported_features || 0) & 1) actions.push('set_temperature');
  }
  return actions;
}
export function validateLiveService(call, devices) {
  const device = devices.find(d => d.entity_id === call.data?.entity_id);
  if (!device || device.domain !== call.domain) throw new Error('This device is not in the current home inventory.');
  if (!device.available) throw new Error(`${device.name} is ${device.state}. No command was sent.`);
  if (device.readOnly) throw new Error(`${device.name}: ${device.readOnlyReason}`);
  const action = call.service === 'turn_on' && call.data.brightness_pct !== undefined ? 'brightness' : call.service;
  if (!availableActions(device).includes(action)) throw new Error(`${device.name} does not support this action.`);
  const allowed = { set_temperature: ['temperature'], set_hvac_mode: ['hvac_mode'], set_cover_position: ['position'], brightness: ['brightness_pct'] }[action] || [];
  if (Object.keys(call.data).some(k => k !== 'entity_id' && !allowed.includes(k))) throw new Error('Unsupported service parameters.');
  if (action === 'set_hvac_mode' && !device.attributes.hvac_modes.includes(call.data.hvac_mode)) throw new Error(`${device.name} does not support that HVAC mode.`);
  if (action === 'set_temperature') {
    const value = call.data.temperature;
    if (!Number.isFinite(value) || value < device.attributes.min_temp || value > device.attributes.max_temp || !Number.isFinite(device.attributes.min_temp) || !Number.isFinite(device.attributes.max_temp)) throw new Error(`Choose a temperature between ${device.attributes.min_temp} and ${device.attributes.max_temp}${device.temperatureUnit}.`);
  }
  for (const key of ['position', 'brightness_pct']) if (call.data[key] !== undefined && (!Number.isFinite(call.data[key]) || call.data[key] < 0 || call.data[key] > 100)) throw new Error('Use a percentage from 0 to 100.');
  return device;
}
export function serviceLabel(call, device) {
  const actions = { turn_on: 'Turn on', turn_off: 'Turn off', open_cover: 'Open', close_cover: 'Close', stop_cover: 'Stop', media_play: 'Resume playback', media_pause: 'Pause playback' };
  const action = call.data.brightness_pct !== undefined ? `Set brightness to ${call.data.brightness_pct}%` : call.service === 'set_temperature' ? `Set temperature to ${call.data.temperature}${device.temperatureUnit}` : call.service === 'set_hvac_mode' ? `Set mode to ${call.data.hvac_mode}` : call.service === 'set_cover_position' ? `Set to ${call.data.position}% open` : actions[call.service] || call.service;
  return `${action} · ${device.name} (${device.roomName})`;
}
export function serviceObserved(call, device) {
  if (!device?.available) return false;
  if (call.data.brightness_pct !== undefined) return device.state === 'on' && Math.abs((device.attributes.brightness || 0) / 255 * 100 - call.data.brightness_pct) < 2;
  if (call.service === 'set_hvac_mode') return device.state === call.data.hvac_mode;
  if (call.service === 'set_temperature') return device.attributes.temperature === call.data.temperature;
  if (call.service === 'set_cover_position') return Math.abs(device.attributes.current_position - call.data.position) < 2;
  return ({ turn_on: ['on', 'idle', 'playing', 'paused'], turn_off: ['off'], open_cover: ['open', 'opening'], close_cover: ['closed', 'closing'], stop_cover: ['open', 'closed'], media_play: ['playing'], media_pause: ['paused'] }[call.service] || []).includes(device.state);
}
