import { initialDevices, normalizeDevices, rooms, deviceIcons, examples, isActive, stateLabel, MockHomeAssistant } from '/home.mjs';

const $ = id => document.getElementById(id);
const storageKey = 'typesafe-smart-home-demo-v1';
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
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

function duration(ms) { return `${number.format(ms)}ms`; }
function timing(result, target) {
  const steps = [];
  let parallelAdded = false;
  for (const stage of result.stages) {
    if (stage.kind === 'result') continue;
    if (stage.parallel) {
      if (parallelAdded) continue;
      parallelAdded = true;
      steps.push({ ...stage, provider: `${result.stages.filter(s => s.parallel).length}× TypeSafe`, durationMs: stage.parallelDurationMs });
    } else steps.push(stage);
  }
  target.replaceChildren();
  for (const [index, step] of steps.entries()) {
    if (index) target.append(el('span', 'timing-arrow', '→'));
    const text = el('span', step.kind === 'typesafe' ? 'provider-typesafe' : 'provider-llm', `${step.provider} `);
    text.append(el('b', '', duration(step.durationMs)));
    target.append(text);
  }
}

function renderQuestion(id, question, answer, used) {
  const row = el('div', `question${used ? '' : ' unused'}`);
  const badge = el('span', `badge ${question.type}`, `${question.type === 'noul' ? '⊕' : '✦'} ${question.type}`);
  const main = el('div', 'question-main');
  const details = el('details');
  const summary = el('summary');
  // Keep the concise headings visible in the recording; full rubrics are expandable.
  const title = el('div', 'question-title', question.instructions.split('?')[0] + '?');
  const probabilities = el('div', 'probabilities');
  if (answer.type === 'noul') {
    probabilities.append(el('span', 'probability', `${(answer.noul * 100).toFixed(1)}% probability`));
  } else {
    const sorted = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
    for (const [option, value] of sorted) probabilities.append(el('span', `probability${option === answer.choice ? ` winner${value < .8 ? ' low' : ''}` : ''}`, `${option} ${value.toFixed(2)}`));
  }
  summary.append(title, probabilities);
  summary.title = used ? 'Used in this decision. Expand to inspect the prompt.' : 'Speculative answer, not used in this decision. Expand to inspect the prompt.';
  const prompt = el('div', 'prompt-details');
  prompt.append(el('p', '', used ? 'Used in this decision' : 'Not used in this decision'), el('pre', '', JSON.stringify({ question, answer }, null, 2)));
  details.append(summary, prompt);
  main.append(details);
  const value = answer.type === 'noul' ? answer.noul : answer.confidence;
  const confidence = el('span', `confidence${value < .5 ? ' low' : value < .8 ? ' medium' : ''}`, value.toFixed(2));
  confidence.title = answer.type === 'noul' ? 'Probability of yes' : 'Model confidence';
  row.dataset.question = id;
  row.dataset.used = String(used);
  row.append(badge, main, confidence);
  return row;
}

function renderStages(result) {
  const fragment = document.createDocumentFragment();
  for (const stage of result.stages) {
    const card = el('article', 'trace-card');
    if (stage.kind === 'typesafe') {
      if (stage.parallel) card.append(el('div', 'stage-heading', `Sub-command: “${stage.command}”`));
      for (const [id, question] of Object.entries(stage.questions)) card.append(renderQuestion(id, question, stage.answers[id], stage.used.includes(id)));
      card.append(el('div', 'stage-footer', `TypeSafe · ${Object.keys(stage.questions).length} prompts · ${duration(stage.durationMs)}`));
    } else {
      const content = el('div', 'response-card');
      const title = el('div', 'response-title');
      const badge = el('span', `badge ${stage.kind === 'result' ? '' : 'llm'}`, stage.kind === 'result' ? '⌂ home' : stage.mocked ? '◇ local' : '◆ llm');
      title.append(badge, document.createTextNode(stage.kind === 'split' ? (stage.mocked ? 'Local split → sub-commands' : 'LLM split → sub-commands') : stage.kind === 'result' ? 'Home response' : stage.mocked ? 'Local fallback response' : 'LLM response'));
      content.append(title);
      if (stage.commands) {
        const list = el('ol');
        for (const command of stage.commands) list.append(el('li', '', command));
        content.append(list);
      }
      if (stage.text) content.append(el('p', 'response-text', stage.text));
      if (stage.mocked) content.append(el('p', 'response-note', stage.note || 'Limited rule-based fallback. Add ANTHROPIC_API_KEY to use the LLM shown in the video.'));
      card.append(content);
      if (stage.durationMs !== undefined) card.append(el('div', 'stage-footer', `${stage.provider} · ${duration(stage.durationMs)}`));
    }
    fragment.append(card);
  }
  if (result.calls.length) {
    const log = el('details', 'service-log');
    log.append(el('summary', '', `Mock HA service calls (${result.calls.length})`), el('pre', '', JSON.stringify(result.calls, null, 2)));
    fragment.append(log);
  }
  const raw = el('details', 'service-log');
  raw.append(el('summary', '', 'Request details and raw API answers'), el('pre', '', JSON.stringify({ command: result.command, context: result.context, durationMs: result.durationMs, stages: result.stages }, null, 2)));
  fragment.append(raw);
  return fragment;
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
