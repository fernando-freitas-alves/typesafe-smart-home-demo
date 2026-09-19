import { availableActions, liveActive, liveLabel, serviceLabel, validateLiveService } from './live-home.mjs';

// Tool-driven generative UI: model-selected entities become data for a closed
// component catalog. Neither models nor browsers supply executable markup.
const catalog = new Set(['light', 'thermostat', 'cover', 'sensor', 'fan', 'speaker', 'appliance', 'lock']);
const names = { turn_on: 'Turn on', turn_off: 'Turn off', open_cover: 'Open', close_cover: 'Close', stop_cover: 'Stop', media_play: 'Resume', media_pause: 'Pause' };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const words = value => String(value).replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());

export function deviceComponent(device, { controls = true, observed } = {}) {
  if (!device || !catalog.has(device.kind)) return null;
  const a = device.attributes || {}; const choices = controls ? availableActions(device) : [];
  const fields = [];
  for (const action of choices) {
    if (names[action]) {
      if ((action === 'turn_on' && liveActive(device)) || (action === 'turn_off' && device.state === 'off') || (action === 'media_play' && device.state === 'playing') || (action === 'media_pause' && device.state !== 'playing')) continue;
      fields.push({ action, type: 'button', label: names[action] });
    } else if (action === 'brightness') {
      fields.push({ action, type: 'range', label: 'Brightness', unit: '%', min: 0, max: 100, step: 1, value: device.state === 'off' ? 0 : finite(a.brightness) ? Math.round(a.brightness / 255 * 100) : 100 });
    } else if (action === 'set_cover_position') {
      fields.push({ action, type: 'range', label: 'Open position', unit: '%', min: 0, max: 100, step: 1, value: finite(a.current_position) ? a.current_position : 50 });
    } else if (action === 'set_temperature' && finite(a.min_temp) && finite(a.max_temp) && a.min_temp <= a.max_temp) {
      fields.push({ action, type: 'number', label: 'Target temperature', unit: device.temperatureUnit || '', min: a.min_temp, max: a.max_temp, step: finite(a.target_temp_step) && a.target_temp_step > 0 ? a.target_temp_step : 0.5, value: Math.max(a.min_temp, Math.min(a.max_temp, finite(a.temperature) ? a.temperature : finite(a.current_temperature) ? a.current_temperature : a.min_temp)) });
    } else if (action === 'set_hvac_mode') {
      fields.push({ action, type: 'select', label: 'Mode', value: a.hvac_modes.includes(device.state) ? device.state : a.hvac_modes[0], options: a.hvac_modes.map(value => ({ value, label: words(value) })) });
    }
  }
  const metrics = []; let value = device.available ? words(device.state) : liveLabel(device); let unit = '';
  if (device.kind === 'sensor' && device.available) {
    if (device.domain === 'binary_sensor') {
      const labels = { occupancy: ['Clear', 'Detected'], motion: ['Clear', 'Detected'], opening: ['Closed', 'Open'], door: ['Closed', 'Open'], window: ['Closed', 'Open'], moisture: ['Dry', 'Wet'], smoke: ['Clear', 'Detected'] }[a.device_class];
      if (labels && ['on', 'off'].includes(device.state)) value = labels[Number(device.state === 'on')];
    } else { value = device.state; unit = a.unit_of_measurement || ''; }
  }
  if (device.kind === 'thermostat' && device.available) {
    if (finite(a.current_temperature)) { value = a.current_temperature; unit = device.temperatureUnit || ''; metrics.push({ label: 'Reading', value: 'Current temperature' }); }
    if (finite(a.temperature)) metrics.push({ label: 'Target', value: a.temperature, unit: device.temperatureUnit || '' });
    metrics.push({ label: 'Mode', value: words(device.state) });
  }
  let progress;
  if (device.available && device.kind === 'light' && device.state === 'on' && finite(a.brightness)) { progress = Math.round(a.brightness / 255 * 100); metrics.push({ label: 'Brightness', value: progress, unit: '%' }); }
  if (device.available && device.kind === 'cover' && finite(a.current_position)) { progress = a.current_position; metrics.push({ label: 'Open', value: progress, unit: '%' }); }
  if (device.available && device.kind === 'fan' && finite(a.percentage)) metrics.push({ label: 'Speed', value: a.percentage, unit: '%' });
  if (device.available && device.kind === 'speaker' && finite(a.volume_level)) metrics.push({ label: 'Volume', value: Math.round(a.volume_level * 100), unit: '%' });
  return { type: device.kind, entityId: device.entity_id, name: device.name, room: device.roomName, value, unit, stateLabel: liveLabel(device), active: liveActive(device), available: device.available,
    deviceClass: a.device_class, metrics, ...(finite(progress) ? { progress: Math.max(0, Math.min(100, progress)) } : {}),
    note: !device.available ? 'Unavailable when this snapshot was taken.' : device.readOnly ? device.readOnlyReason : '',
    ...(observed !== undefined ? { observed } : {}), controls: fields };
}

export function deviceCollection(devices = [], { capturedAt, controls = true, calls = [] } = {}) {
  const unique = [...new Map(devices.map(device => [device.entity_id, device])).values()];
  const cards = unique.map(device => deviceComponent(device, { controls, observed: calls.length ? calls.filter(call => call.data.entity_id === device.entity_id).every(call => call.observed) : undefined })).filter(Boolean);
  if (!cards.length) return [];
  const rooms = [...new Set(cards.map(card => card.room))];
  return [{ version: 1, type: 'device_collection', title: rooms.length === 1 ? rooms[0] : 'Your home', capturedAt, cards }];
}

export function resolveComponentAction(input, thread, snapshot) {
  if (!input || typeof input !== 'object') throw new Error('Choose an action from a device card.');
  const source = thread.messages.find(message => message.id === input.messageId && message.role === 'assistant');
  const card = source?.components?.filter(component => component.type === 'device_collection' && component.version === 1).flatMap(component => component.cards).find(card => card.entityId === input.entityId);
  if (!card || !card.controls.some(control => control.action === input.action)) throw new Error('This action does not belong to a device card in this chat.');
  const device = snapshot.devices.find(device => device.entity_id === card.entityId);
  const control = deviceComponent(device)?.controls.find(control => control.action === input.action);
  if (!control) throw new Error('This control is no longer available. Ask for the device again to refresh it.');
  if (['range', 'number'].includes(control.type) && (!finite(input.value) || input.value < control.min || input.value > control.max || Math.abs((input.value - control.min) / control.step - Math.round((input.value - control.min) / control.step)) > 0.000001)) throw new Error(`Choose ${control.label.toLowerCase()} from ${control.min} to ${control.max}${control.unit} in steps of ${control.step}.`);
  if (control.type === 'select' && !control.options.some(option => option.value === input.value)) throw new Error('Choose a supported mode.');
  if (control.type === 'button' && input.value !== undefined) throw new Error('This action does not accept a value.');
  const key = { brightness: 'brightness_pct', set_temperature: 'temperature', set_cover_position: 'position', set_hvac_mode: 'hvac_mode' }[input.action];
  const off = input.action === 'brightness' && input.value === 0;
  const call = { domain: device.domain, service: input.action === 'brightness' ? off ? 'turn_off' : 'turn_on' : input.action, data: { entity_id: device.entity_id, ...(key && !off ? { [key]: input.value } : {}) } };
  validateLiveService(call, snapshot.devices);
  return { call, text: serviceLabel(call, device) };
}
