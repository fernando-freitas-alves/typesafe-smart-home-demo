import { el, timing, renderStages } from '/trace-ui.js';
import { liveIcons, liveActive, liveLabel, availableActions, serviceLabel } from '/live-home.mjs';
import { identityProfile } from '/live-identity.mjs';
const $ = id => document.getElementById(id);
const identityStorageKey = 'typesafe-live-identity';
const locationStorageKey = 'typesafe-live-location';
let savedLocation = '';
try { $('identity').value = identityProfile(localStorage.getItem(identityStorageKey) || 'other').id; } catch { $('identity').value = 'other'; }
try { savedLocation = localStorage.getItem(locationStorageKey) || ''; } catch { /* Location can still be selected without storage. */ }
let home = { devices: [], rooms: [] }, busy = false, connected = false, refreshing = false;
let current = null, pending = null, selected = null, records = [], homeSignature = '', connectionError = '';
const announce = text => { $('announcement').textContent = text; };
function error(text) { $('error').textContent = text; $('error').hidden = !text; }
function setBusy(value) {
  busy = value; $('send').disabled = value || !connected; $('send').textContent = value ? 'Working…' : 'Preview';
  $('command').readOnly = value;
  for (const node of document.querySelectorAll('#refresh, #room-filter, #identity, #location, #context, .example, #device-controls button, #apply-plan')) node.disabled = value;
  $('trace').setAttribute('aria-busy', String(value));
}
async function api(path, data) {
  let response;
  try { response = await fetch(path, { ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }), signal: AbortSignal.timeout(70000) }); }
  catch { throw new Error(path.endsWith('/apply') ? 'The result could not be confirmed. Some actions may have executed. Refresh your devices before trying again.' : 'The local server could not be reached. Start npm run demo, then refresh.'); }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request failed.');
  return result;
}
function invalidate() { pending = null; $('action-preview').hidden = true; $('action-preview').replaceChildren(); }
function updateIdentityHint() {
  const person = identityProfile($('identity').value, home.rooms);
  const location = home.rooms.find(room => room.id === savedLocation);
  $('identity-hint').textContent = location ? `“Turn on the lights” → ${location.name}` : person.office ? `“My office” → ${person.office.name} · Select where you are for “the lights”.` : 'Select where you are, or name a room in your request.';
}
function updateHome(next) {
  const room = $('room-filter').value; const signature = JSON.stringify(next.devices);
  const roomsChanged = JSON.stringify(home.rooms) !== JSON.stringify(next.rooms);
  home = next; connected = !next.stale;
  if (roomsChanged) {
    $('room-filter').replaceChildren(el('option', '', 'All rooms'));
    $('room-filter').firstChild.value = '';
    for (const area of home.rooms) { const option = el('option', '', area.name); option.value = area.id; $('room-filter').append(option); }
    if (home.rooms.some(r => r.id === room)) $('room-filter').value = room;
    $('location').replaceChildren(el('option', '', 'Not set'));
    $('location').firstChild.value = '';
    for (const area of home.rooms) { const option = el('option', '', area.name); option.value = area.id; $('location').append(option); }
    if (home.rooms.some(r => r.id === savedLocation)) $('location').value = savedLocation;
    else if (savedLocation) { savedLocation = ''; invalidate(); }
  }
  updateIdentityHint();
  $('home-status').textContent = connected ? `Live · refreshed ${new Date(next.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Disconnected · showing last read';
  $('home-status').classList.toggle('disconnected', !connected);
  if (signature !== homeSignature || roomsChanged) { homeSignature = signature; renderHome(); }
  if (!busy) $('send').disabled = !connected;
}
function renderHome(changed = []) {
  const search = $('search').value.trim().toLocaleLowerCase(); const kind = $('kind-filter').value; const area = $('room-filter').value;
  const devices = home.devices.filter(d => (!area || d.room === area) && (kind === 'all' || (kind === 'controls' ? d.kind !== 'sensor' : d.kind === kind)) && (!search || `${d.name} ${d.roomName} ${d.entity_id}`.toLocaleLowerCase().includes(search)));
  const focused = document.activeElement?.dataset?.entity;
  $('rooms').replaceChildren();
  for (const room of home.rooms) {
    const members = devices.filter(d => d.room === room.id); if (!members.length) continue;
    const section = el('section', 'room'); section.append(el('h3', '', `${room.name} · ${members.length}`));
    const grid = el('div', 'device-grid');
    for (const d of members) {
      const button = el('button', `device ${liveActive(d) ? 'active' : 'off'}${d.available ? '' : ' unavailable'}${changed.includes(d.entity_id) ? ' changed' : ''}`);
      button.type = 'button'; button.dataset.entity = d.entity_id;
      button.setAttribute('aria-label', `${d.roomName} ${d.name}: ${liveLabel(d)}. Open details`);
      const icon = el('span', 'device-icon', liveIcons[d.kind]); icon.setAttribute('aria-hidden', 'true');
      const copy = el('span', 'device-copy'); copy.append(el('span', 'device-name', d.name), el('span', 'device-state', liveLabel(d)));
      if (d.readOnly) copy.append(el('span', 'device-meta', 'Read only'));
      if (d.override && d.override.state !== 'auto') copy.append(el('span', 'device-meta', `Manual override · ${Math.ceil(d.override.remainingMinutes || 0)} min`));
      const dot = el('span', 'state-dot'); dot.setAttribute('aria-hidden', 'true'); button.append(icon, copy, dot);
      button.addEventListener('click', () => openDevice(d.entity_id)); grid.append(button);
    }
    section.append(grid); $('rooms').append(section);
  }
  if (!devices.length) $('rooms').append(el('p', 'empty-state', 'No devices match these filters.'));
  $('device-count').textContent = `${devices.length} shown · ${home.devices.length} total · ${home.devices.filter(d => !d.available).length} unavailable or unknown`;
  if (focused) [...$('rooms').querySelectorAll('[data-entity]')].find(n => n.dataset.entity === focused)?.focus({ preventScroll: true });
}
function showResult(result) {
  current = result; updateHome(result);
  $('request-label').hidden = false; $('request-label').textContent = `“${result.command}”`;
  $('timing').hidden = !result.stages.length; timing(result, $('timing'));
  $('trace').replaceChildren(renderStages(result));
  renderHome(result.changed);
  invalidate();
  if (result.planId) {
    pending = result;
    const card = el('section', 'preview-card'); card.append(el('h3', '', 'Review these changes'), el('p', '', 'Nothing has changed yet. Apply sends these actions to your real devices.'));
    card.append(el('p', 'preview-targets', `Target: ${[...new Set(result.actions.map(action => action.roomName))].join(' · ')}`));
    if (result.skipped?.length) card.append(el('p', '', `Skipped unavailable devices: ${result.skipped.map(d => `${d.name} (${d.roomName})`).join(', ')}.`));
    const list = el('ol');
    for (const action of result.actions) { const li = el('li', '', action.label); li.append(el('span', 'preview-before', `Current: ${action.before}`)); list.append(li); }
    const actions = el('div', 'preview-actions'); const apply = el('button', 'send', `Apply ${result.actions.length} ${result.actions.length === 1 ? 'action' : 'actions'}`); apply.id = 'apply-plan'; apply.addEventListener('click', applyPending);
    const cancel = el('button', 'quiet', 'Discard'); cancel.addEventListener('click', () => { invalidate(); announce('Preview discarded. No changes sent.'); });
    actions.append(apply, cancel); card.append(list, actions, el('p', 'device-meta', 'Preview expires after 2 minutes. Changed device states require a new preview.'));
    $('action-preview').append(card); $('action-preview').hidden = false;
  }
  $('history').replaceChildren();
  for (const record of records.slice(-5).reverse()) {
    if (record === current) continue;
    const detail = el('details', 'history-row'); detail.append(el('summary', '', record.command));
    detail.addEventListener('toggle', () => { if (detail.open && detail.childElementCount === 1) detail.append(renderStages(record)); }); $('history').append(detail);
  }
  $('trace-scroll').scrollTop = 0; announce(result.outcome);
}
async function preview(command, manual) {
  if (busy || !connected || !command.trim()) return;
  error(''); invalidate(); setBusy(true); $('command').value = command;
  $('trace').replaceChildren(el('p', 'empty-state pending', manual ? 'Preparing the device change…' : 'Evaluating your request against live devices…'));
  try {
    const result = await api('/api/live/preview', { command, manual, identity: $('identity').value, location: $('location').value, room: $('room-filter').value, context: $('context').checked ? 'devices' : 'none' });
    records.push(result); records = records.slice(-6); showResult(result);
  } catch (e) { error(e.message); $('trace').replaceChildren(el('p', 'empty-state', 'No actions were sent. Edit the request and preview again.')); announce(e.message); }
  finally { setBusy(false); }
}
async function applyPending() {
  if (!pending || busy) return;
  const id = pending.planId; invalidate(); error(''); setBusy(true);
  try {
    const result = await api('/api/live/apply', { planId: id });
    records.push(result); records = records.slice(-6); showResult(result); if (result.error) error(result.error);
  } catch (e) { error(e.message); announce(e.message); await refreshHome(false); }
  finally { setBusy(false); }
}
async function refreshHome(manual = true) {
  if (refreshing) return; refreshing = true;
  try {
    updateHome(await api('/api/live/home'));
    if (connectionError && $('error').textContent === connectionError) error('');
    connectionError = '';
    if (manual) { error(''); announce('Home states refreshed.'); }
  }
  catch (e) {
    connected = false; $('send').disabled = true; invalidate(); $('home-status').textContent = 'Disconnected · showing last read'; $('home-status').classList.add('disconnected');
    if (manual || !home.devices.length) { connectionError = e.message; error(e.message); }
    if (!home.devices.length) { $('device-count').textContent = 'No live state available'; $('rooms').replaceChildren(el('p', 'empty-state', 'Could not load your home. Check the connection and click Refresh.')); }
  } finally { refreshing = false; }
}
function manualPreview(d, service, extra = {}) {
  if (busy) return;
  const call = { domain: d.domain, service, data: { entity_id: d.entity_id, ...extra } };
  $('device-dialog').close(); preview(serviceLabel(call, d), call);
}
function openDevice(id) {
  const d = home.devices.find(d => d.entity_id === id); if (!d) return; selected = id;
  $('device-title').textContent = d.name; $('device-entity').textContent = d.entity_id;
  $('device-status').textContent = `${d.roomName} · ${liveLabel(d)}${d.override && d.override.state !== 'auto' ? ' · Manual lighting override active' : ''}`;
  $('device-json').textContent = JSON.stringify(d, null, 2);
  const controls = $('device-controls'); controls.replaceChildren();
  const actions = connected ? availableActions(d) : [];
  if (!actions.length) controls.append(el('p', 'dialog-note', !connected ? 'Refresh the connection to control this device.' : !d.available ? 'This device has no usable live state. Refresh after it reconnects.' : d.readOnlyReason || 'No supported controls.'));
  const row = el('div', 'control-row');
  const names = { turn_on: 'Turn on', turn_off: 'Turn off', open_cover: 'Open', close_cover: 'Close', stop_cover: 'Stop', media_play: 'Resume', media_pause: 'Pause' };
  for (const action of actions.filter(a => names[a])) { const button = el('button', '', names[action]); button.disabled = busy; button.addEventListener('click', () => manualPreview(d, action)); row.append(button); }
  if (row.childElementCount) controls.append(row);
  function valueControl(title, input, service, data) {
    const label = el('label', '', title); const wrap = el('div', 'value-control'); const button = el('button', '', 'Preview'); button.disabled = busy;
    input.setAttribute('aria-label', title); button.addEventListener('click', () => { if (input.reportValidity()) manualPreview(d, service, data(input.value)); });
    wrap.append(input, button); label.append(wrap); controls.append(label);
  }
  if (actions.includes('set_hvac_mode')) {
    const select = el('select'); for (const mode of d.attributes.hvac_modes) { const option = el('option', '', mode.replaceAll('_', ' ')); option.value = mode; select.append(option); } select.value = d.state;
    valueControl('HVAC mode', select, 'set_hvac_mode', value => ({ hvac_mode: value }));
  }
  if (actions.includes('set_temperature')) {
    const input = el('input'); input.type = 'number'; input.required = true; input.min = d.attributes.min_temp; input.max = d.attributes.max_temp; input.step = d.attributes.target_temp_step || 0.5; input.value = d.attributes.temperature ?? d.attributes.current_temperature ?? d.attributes.min_temp;
    valueControl(`Target temperature (${d.temperatureUnit})`, input, 'set_temperature', value => ({ temperature: Number(value) }));
  }
  for (const [action, title, service, key, value] of [['brightness', 'Brightness (%)', 'turn_on', 'brightness_pct', Math.round((d.attributes.brightness || 255) / 255 * 100)], ['set_cover_position', 'Open position (%)', 'set_cover_position', 'position', d.attributes.current_position ?? 50]]) {
    if (!actions.includes(action)) continue;
    const input = el('input'); input.type = 'number'; input.required = true; input.min = '0'; input.max = '100'; input.step = '1'; input.value = value;
    valueControl(title, input, service, value => ({ [key]: Number(value) }));
  }
  $('device-dialog').showModal();
}
$('command-form').addEventListener('submit', event => { event.preventDefault(); preview($('command').value); });
$('command').addEventListener('input', invalidate);
$('room-filter').addEventListener('change', () => { invalidate(); renderHome(); });
$('identity').addEventListener('change', () => {
  invalidate(); error(''); updateIdentityHint();
  try { localStorage.setItem(identityStorageKey, $('identity').value); } catch { /* The current selection still works when storage is unavailable. */ }
  announce(`Selected ${$('identity').selectedOptions[0].textContent}. ${$('identity-hint').textContent} Preview again to use this selection.`);
});
$('location').addEventListener('change', () => {
  invalidate(); error(''); savedLocation = $('location').value; updateIdentityHint();
  try { localStorage.setItem(locationStorageKey, savedLocation); } catch { /* The current selection still works when storage is unavailable. */ }
  announce(`Location: ${$('location').selectedOptions[0].textContent}. Preview again to use this selection.`);
});
$('context').addEventListener('change', invalidate);
$('search').addEventListener('input', () => renderHome()); $('kind-filter').addEventListener('change', () => renderHome());
$('refresh').addEventListener('click', () => refreshHome());
$('close-device').addEventListener('click', () => $('device-dialog').close());
$('device-dialog').addEventListener('close', () => [...$('rooms').querySelectorAll('[data-entity]')].find(n => n.dataset.entity === selected)?.focus());
for (const command of ['Turn on the lights', 'Which lights are on?', 'What is the temperature?', 'Close the blinds']) {
  const button = el('button', 'example', command); button.addEventListener('click', () => { $('command').value = command; invalidate(); $('command').focus(); }); $('examples').append(button);
}
api('/api/config').then(config => { $('connection').textContent = config.typesafe ? `TypeSafe · ${config.llm}` : 'TypeSafe key missing · manual controls available'; }).catch(() => { $('connection').textContent = 'API unavailable'; });
updateIdentityHint();
await refreshHome();
setInterval(() => { if (!busy && !document.hidden) refreshHome(false); }, 10000);
setInterval(() => { if (pending && Date.now() >= Date.parse(pending.expiresAt)) { invalidate(); announce('Preview expired. Preview the request again.'); } }, 1000);
