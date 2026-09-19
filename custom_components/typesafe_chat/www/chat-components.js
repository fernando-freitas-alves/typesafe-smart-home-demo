const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<ha-icon icon="${escape(name.includes(':') ? name : `mdi:${name}`)}" aria-hidden="true"></ha-icon>`;
const validIcon = value => typeof value === 'string' && /^[a-z0-9_-]+:[a-z0-9_-]+$/i.test(value);
const catalog = new Set(['light', 'thermostat', 'cover', 'sensor', 'fan', 'speaker', 'appliance', 'lock']);
const number = value => typeof value === 'number' ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value) : escape(value);
const reading = (value, unit = '') => `${number(value)}${unit ? `<span class="device-unit">${escape(unit)}</span>` : ''}`;
export const controlKey = (messageId, entityId, action) => `${messageId}/${entityId}/${action}`;

export function deviceIcon(card, hass) {
  // Current HA metadata also supplies icons for older saved cards. Their state
  // readings remain snapshots; only their visual identity is refreshed.
  const custom = [hass?.entities?.[card.entityId]?.icon, hass?.states?.[card.entityId]?.attributes?.icon, card.icon].find(validIcon);
  if (custom) return custom;
  if (card.type === 'sensor') return { temperature: 'thermometer', humidity: 'water-percent', battery: 'battery-outline', illuminance: 'brightness-6', power: 'flash-outline', energy: 'lightning-bolt-outline', occupancy: 'motion-sensor', motion: 'motion-sensor', door: 'door', window: 'window-closed', moisture: 'water-outline', smoke: 'smoke-detector-outline' }[card.deviceClass] || 'gauge';
  return { light: card.active ? 'lightbulb-on-outline' : 'lightbulb-outline', thermostat: 'thermometer', cover: 'blinds-horizontal', fan: 'fan', speaker: 'speaker', appliance: 'power-plug-outline', lock: 'lock-outline' }[card.type] || 'home-outline';
}

function renderControl(control, card, messageId, options) {
  const disabled = options.busy ? 'disabled' : '';
  const key = controlKey(messageId, card.entityId, control.action);
  const value = options.values?.has(key) ? options.values.get(key) : control.value;
  const attrs = `data-component-message="${escape(messageId)}" data-component-entity="${escape(card.entityId)}" data-component-action="${escape(control.action)}"`;
  if (control.type === 'button') return `<button type="button" class="device-button" ${attrs} aria-label="${escape(control.label)} ${escape(card.name)}" ${disabled}>${icon(control.action.startsWith('turn_') ? 'power' : control.action === 'media_play' ? 'play-outline' : control.action === 'media_pause' ? 'pause' : control.action === 'open_cover' ? 'arrow-up' : control.action === 'close_cover' ? 'arrow-down' : 'stop')}${escape(control.label)}</button>`;
  const id = `control-${messageId}-${card.entityId}-${control.action}`;
  let field;
  if (control.type === 'select') field = `<select id="${escape(id)}" name="value" ${disabled}>${control.options.map(option => `<option value="${escape(option.value)}" ${option.value === value ? 'selected' : ''}>${escape(option.label)}</option>`).join('')}</select>`;
  else if (['number', 'range'].includes(control.type)) field = `<input id="${escape(id)}" name="value" type="${control.type}" min="${control.min}" max="${control.max}" step="${control.step}" value="${escape(value)}" ${control.type === 'number' ? 'inputmode="decimal" autocomplete="off"' : `aria-valuetext="${escape(value)}${escape(control.unit)}"`} ${disabled} required>`;
  else return '';
  const actionName = { brightness: 'brightness', set_temperature: 'temperature', set_hvac_mode: 'mode', set_cover_position: 'position' }[control.action];
  return `<form class="device-adjustment ${control.type}" ${attrs}><div class="device-control-label"><label for="${escape(id)}">${escape(control.label)}${control.type === 'number' && control.unit ? ` (${escape(control.unit)})` : ''}</label>${control.type === 'range' ? `<output for="${escape(id)}">${reading(value, control.unit)}</output>` : ''}</div>${field}<button type="submit" class="device-button" aria-label="Review ${actionName} for ${escape(card.name)}" ${disabled}>Review ${actionName}</button></form>`;
}

function renderCard(card, messageId, options) {
  const controls = Array.isArray(card.controls) ? card.controls : [];
  const buttons = controls.filter(control => control.type === 'button'); const fields = controls.filter(control => control.type !== 'button');
  return `<article class="device-card device-${card.type} ${card.active ? 'is-active' : ''} ${!card.available ? 'is-unavailable' : ''}" aria-label="${escape(card.name)}"><div class="device-card-heading"><span class="device-symbol">${icon(deviceIcon(card, options.hass))}</span><div><h3>${escape(card.name)}</h3><p>${escape(card.room)}</p></div></div><div class="device-reading">${reading(card.value, card.unit)}</div>${card.metrics?.length ? `<dl class="device-metrics">${card.metrics.map(metric => `<div><dt>${escape(metric.label)}</dt><dd>${reading(metric.value, metric.unit)}</dd></div>`).join('')}</dl>` : ''}${Number.isFinite(card.progress) ? `<meter class="device-meter" min="0" max="100" value="${card.progress}" aria-label="${card.type === 'cover' ? 'Open position' : 'Brightness'}">${card.progress}%</meter>` : ''}${card.observed !== undefined ? `<p class="device-observed ${card.observed ? '' : 'needs-check'}">${icon(card.observed ? 'check-circle-outline' : 'alert-circle-outline')}${card.observed ? 'Change observed' : 'Change not confirmed'}</p>` : ''}${card.note ? `<p class="device-note">${escape(card.note)}</p>` : ''}${controls.length ? `<div class="device-controls">${buttons.length ? `<div class="device-buttons">${buttons.map(control => renderControl(control, card, messageId, options)).join('')}</div>` : ''}${fields.map(control => renderControl(control, card, messageId, options)).join('')}</div>` : ''}</article>`;
}

export function renderDeviceCollections(components, messageId, options = {}) {
  if (!Array.isArray(components)) return '';
  return components.filter(component => component.version === 1 && component.type === 'device_collection' && Array.isArray(component.cards)).map(component => {
    const cards = component.cards.filter(card => catalog.has(card.type)); if (!cards.length) return '';
    const time = new Date(component.capturedAt); const dated = Number.isFinite(time.getTime());
    return `<section class="device-collection" aria-label="${escape(component.title)} devices"><div class="device-collection-heading"><h2>${escape(component.title)}</h2><span>${cards.length} ${cards.length === 1 ? 'device' : 'devices'}${dated ? ` · Snapshot <time datetime="${escape(component.capturedAt)}" title="${escape(time.toLocaleString())}">${escape(new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(time))}</time>` : ' · Saved snapshot'}</span></div><div class="device-grid">${cards.slice(0, 6).map(card => renderCard(card, messageId, options)).join('')}</div>${cards.length > 6 ? `<details class="more-devices"><summary>Show ${cards.length - 6} more devices</summary><div class="device-grid">${cards.slice(6).map(card => renderCard(card, messageId, options)).join('')}</div></details>` : ''}${cards.some(card => card.controls?.length) ? `<p class="device-collection-note">${icon('gesture-tap-button')}Controls open a review before making changes.</p>` : ''}</section>`;
  }).join('');
}

export function renderReviewAction(action, index, checked, options = {}) {
  const card = action.component;
  return `<label class="action ${card ? 'visual-action' : ''}"><input type="checkbox" name="selected" value="${index}" ${checked ? 'checked' : ''}>${card ? `<span class="device-symbol ${card.active ? 'is-active' : ''}">${icon(deviceIcon(card, options.hass))}</span>` : ''}<span class="action-description"><strong>${escape(action.name)}</strong><small>${escape(action.roomName)}</small><span class="action-transition"><span>${escape(action.before)}</span>${icon('arrow-right')}<span>${escape(action.label.split(' · ')[0])}</span></span></span></label>`;
}

export function bindDeviceControls(root, { values, submit }) {
  const action = (element, value) => submit({ messageId: element.dataset.componentMessage, entityId: element.dataset.componentEntity, action: element.dataset.componentAction, ...(value !== undefined ? { value } : {}) });
  root.querySelectorAll('button[data-component-action]').forEach(button => { button.onclick = () => action(button); });
  root.querySelectorAll('form[data-component-action]').forEach(form => {
    const field = form.elements.value;
    field.oninput = () => {
      const value = field.tagName === 'SELECT' ? field.value : field.valueAsNumber;
      values.set(controlKey(form.dataset.componentMessage, form.dataset.componentEntity, form.dataset.componentAction), value);
      if (field.type === 'range') { form.querySelector('output').textContent = `${new Intl.NumberFormat().format(value)}%`; field.setAttribute('aria-valuetext', `${value}%`); }
    };
    form.onsubmit = event => { event.preventDefault(); if (form.reportValidity()) action(form, field.tagName === 'SELECT' ? field.value : field.valueAsNumber); };
  });
}
