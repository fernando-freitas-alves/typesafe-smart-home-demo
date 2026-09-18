import { el, duration, timing, renderStages } from '/trace-ui.js';
import { initialDevices, normalizeDevices, rooms, deviceIcons, examples, isActive, stateLabel, MockHomeAssistant } from '/home.mjs';

const $ = id => document.getElementById(id);
const storageKey = 'typesafe-smart-home-demo-v1';
let devices = initialDevices();
let records = [];
let current = null;
let busy = false;
let selectedDevice = null;
let lastRequest = '';
try {
  const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
  if (saved?.devices) devices = normalizeDevices(saved.devices);
} catch { /* Corrupt/blocked storage should not prevent using the demo. */ }
const contextValue = new URL(location.href).searchParams.get('context');
if (contextValue === 'devices') $('context').value = 'devices';

function save() { try { localStorage.setItem(storageKey, JSON.stringify({ devices })); } catch { /* Private browsing can disable local storage. */ } }
function announce(text) { $('announcement').textContent = text; }
function setBusy(value) {
  busy = value;
  $('send').disabled = value;
  $('send').textContent = value ? 'Sending…' : 'Send';
  $('command').readOnly = value;
  for (const node of document.querySelectorAll('.example, .device, #reset, #replay, #context, #preset')) node.disabled = value;
  $('trace').setAttribute('aria-busy', String(value));
}
function renderHome(changed = []) {
  $('rooms').replaceChildren(...rooms.map(room => {
    const section = el('section', 'room');
    const heading = el('h3');
    const icon = el('span', 'room-icon', room.icon);
    icon.setAttribute('aria-hidden', 'true');
    heading.append(icon, document.createTextNode(room.name));
    const grid = el('div', 'device-grid');
    for (const device of devices.filter(d => d.room === room.id)) {
      const button = el('button', `device ${isActive(device) ? 'active' : 'off'}${changed.includes(device.entity_id) ? ' changed' : ''}`);
      button.type = 'button';
      button.disabled = busy;
      button.dataset.entity = device.entity_id;
      button.setAttribute('aria-label', `${room.name} ${device.name}: ${stateLabel(device)}. Open controls`);
      const deviceIcon = el('span', 'device-icon', device.kind === 'lock' && device.state === 'unlocked' ? '🔓' : deviceIcons[device.kind]);
      deviceIcon.setAttribute('aria-hidden', 'true');
      const copy = el('span', 'device-copy');
      copy.append(el('span', 'device-name', device.name), el('span', 'device-state', stateLabel(device)));
      const dot = el('span', 'state-dot');
      dot.setAttribute('aria-hidden', 'true');
      button.append(deviceIcon, copy, dot);
      button.addEventListener('click', () => openDevice(device.entity_id));
      grid.append(button);
    }
    section.append(heading, grid);
    return section;
  }));
}

function renderResult(result) {
  $('request-label').hidden = false;
  $('request-label').textContent = `“${result.command}”`;
  $('timing').hidden = false;
  $('replay').hidden = false;
  timing(result, $('timing'));
  $('trace').replaceChildren(renderStages(result));
  $('history').replaceChildren();
  for (const record of records.slice(0, -1)) {
    const details = el('details', 'history-row');
    details.append(el('summary', '', `“${record.command}” (${duration(record.durationMs)})`));
    details.addEventListener('toggle', () => { if (details.open && details.childElementCount === 1) details.append(renderStages(record)); });
    $('history').append(details);
  }
  // The reference keeps previous requests above the latest trace. Start at the
  // current request when history grows, while leaving the history reachable.
  $('trace-scroll').scrollTop = $('history').offsetHeight;
}

async function submit(command) {
  if (busy) return;
  command = command.trim();
  if (!command) { $('command').focus(); return; }
  lastRequest = command;
  $('command').value = command;
  $('error').hidden = true;
  $('request-label').hidden = false;
  $('request-label').textContent = `“${command}”`;
  $('timing').hidden = true;
  $('replay').hidden = true;
  const pending = el('p', 'empty-state pending');
  const spinner = el('span', 'spinner');
  spinner.setAttribute('aria-hidden', 'true');
  pending.append(spinner, document.createTextNode('Evaluating all 12 questions…'));
  $('trace').replaceChildren(pending);
  setBusy(true);
  announce('Evaluating request.');
  try {
    const response = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, devices, context: $('context').value }), signal: AbortSignal.timeout(70000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The request failed. Please retry.');
    devices = normalizeDevices(result.devices);
    current = result;
    records.push(result);
    records = records.slice(-20);
    save();
    renderHome(result.changed);
    renderResult(result);
    announce(result.outcome);
    refreshConfig();
  } catch (error) {
    const message = error.name === 'TimeoutError' ? 'The request timed out. Please retry. No devices were changed.' : error.message === 'Failed to fetch' ? 'The local server is unavailable. Run npm run demo, then retry.' : error.message;
    $('error').replaceChildren(document.createTextNode(message));
    const retry = el('button', '', 'Retry');
    retry.type = 'button'; retry.addEventListener('click', () => submit(lastRequest));
    $('error').append(retry);
    $('error').hidden = false;
    $('trace').replaceChildren(el('p', 'empty-state', 'Request failed. Your mock devices are unchanged.'));
    $('command').focus();
    announce(message);
  } finally { setBusy(false); }
}

function updateDevice(domain, service, data) {
  const home = new MockHomeAssistant(devices);
  home.callService(domain, service, data);
  devices = home.getStates();
  save(); renderHome([data.entity_id]); renderDeviceControls();
  const device = devices.find(d => d.entity_id === data.entity_id);
  announce(`${device.name}: ${stateLabel(device)}.`);
}
function openDevice(entity) {
  selectedDevice = entity;
  renderDeviceControls();
  $('device-dialog').showModal();
}
function renderDeviceControls() {
  const device = devices.find(d => d.entity_id === selectedDevice);
  $('device-title').textContent = device.name;
  $('device-entity').textContent = device.entity_id;
  $('device-json').textContent = JSON.stringify(device, null, 2);
  const controls = $('device-controls'); controls.replaceChildren();
  const domain = device.entity_id.split('.')[0];
  if (device.kind === 'thermostat') {
    const label = el('label', '', 'HVAC mode');
    const select = el('select'); select.name = 'hvac_mode';
    for (const [value, text] of [['off', 'Off'], ['cool', 'A/C'], ['heat', 'Heat']]) { const option = el('option', '', text); option.value = value; option.selected = device.state === value; select.append(option); }
    select.addEventListener('change', () => { updateDevice(domain, 'set_hvac_mode', { entity_id: device.entity_id, hvac_mode: select.value }); $('device-controls').querySelector('select')?.focus(); });
    label.append(select); controls.append(label);
  } else {
    const toggle = el('button', '', device.kind === 'lock' ? (isActive(device) ? 'Unlock' : 'Lock') : isActive(device) ? 'Turn off' : 'Turn on');
    toggle.addEventListener('click', () => { updateDevice(domain, device.kind === 'lock' ? (isActive(device) ? 'unlock' : 'lock') : isActive(device) ? 'turn_off' : 'turn_on', { entity_id: device.entity_id }); $('device-controls').querySelector('button')?.focus(); });
    controls.append(toggle);
  }
  if (device.kind === 'light') {
    const value = Math.round(device.attributes.brightness / 255 * 100);
    const label = el('label', '', `Brightness · ${value}%`);
    const slider = el('input'); slider.type = 'range'; slider.name = 'brightness'; slider.min = '1'; slider.max = '100'; slider.value = value;
    slider.setAttribute('aria-label', 'Brightness');
    slider.addEventListener('input', () => { label.firstChild.textContent = `Brightness · ${slider.value}%`; });
    slider.addEventListener('change', () => { updateDevice(domain, 'turn_on', { entity_id: device.entity_id, brightness_pct: Number(slider.value) }); $('device-controls').querySelector('input')?.focus(); });
    label.append(slider); controls.append(label);
  }
}
async function refreshConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error();
    const settings = await response.json();
    $('connection').textContent = settings.typesafe ? `TypeSafe live · ${settings.llm}` : 'TypeSafe key missing';
  } catch { $('connection').textContent = 'Local server unavailable'; }
}

$('examples').replaceChildren(...examples.map(command => {
  const button = el('button', 'example', command); button.type = 'button';
  button.addEventListener('click', () => submit(command)); return button;
}));
$('command-form').addEventListener('submit', event => { event.preventDefault(); submit($('command').value); });
$('replay').addEventListener('click', () => { if (current) submit(current.command); });
$('context').addEventListener('change', () => {
  const url = new URL(location.href);
  if ($('context').value === 'devices') url.searchParams.set('context', 'devices'); else url.searchParams.delete('context');
  history.replaceState(null, '', url);
});
$('reset').addEventListener('click', () => {
  const previous = { devices: structuredClone(devices), records: [...records], current };
  devices = initialDevices(); records = []; current = null; save(); renderHome();
  $('history').replaceChildren(); $('request-label').hidden = true; $('timing').hidden = true; $('replay').hidden = true; $('error').hidden = true;
  const empty = el('p', 'empty-state', 'Home reset. ');
  const undo = el('button', 'quiet', 'Undo');
  undo.addEventListener('click', () => { devices = previous.devices; records = previous.records; current = previous.current; save(); renderHome(); if (current) renderResult(current); else $('trace').replaceChildren(el('p', 'empty-state', 'Submit a request to see the decision trace')); announce('Reset undone.'); }, { once: true });
  empty.append(undo); $('trace').replaceChildren(empty);
  announce('Mock home reset to the video’s starting state.');
});
$('close-device').addEventListener('click', () => $('device-dialog').close());
$('device-dialog').addEventListener('close', () => document.querySelector(`[data-entity="${selectedDevice}"]`)?.focus());
renderHome(); refreshConfig();
