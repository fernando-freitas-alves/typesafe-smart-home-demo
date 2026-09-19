const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = name => `<ha-icon icon="mdi:${name}" aria-hidden="true"></ha-icon>`;

export function modelOptions(state, selected = 'default') {
  const options = [{ id: 'default', name: state?.model === 'auto' ? 'Auto · fastest' : 'Home default', description: state?.modelName ? `Uses ${state.modelName}. Follows your home's default.` : 'Follows your home’s default model.' }];
  if (state?.model !== 'auto' || selected === 'auto') options.push({ id: 'auto', name: 'Auto · fastest', description: 'Automatically choose the fast preset.' });
  options.push(...(state?.models || []));
  if (!options.some(option => option.id === selected)) options.push({ id: selected, name: selected, description: 'Unavailable. Choose another model.', unavailable: true });
  return options;
}

export function renderModelPicker(state, selected, { busy = false, error = '', loading = false } = {}) {
  const options = modelOptions(state, selected);
  const choice = options.find(option => option.id === selected);
  return `<details class="model-picker"><summary aria-label="Choose chat model: ${escape(choice.name)}" aria-disabled="${busy}" title="Choose the model for this chat">${icon('creation')}<span>${escape(choice.name)}</span>${icon('chevron-down')}</summary>
    <div class="model-menu"><div class="model-menu-heading"><strong>Model for this chat</strong><button type="button" class="icon-button" data-refresh-models aria-label="Refresh models" ${loading ? 'disabled' : ''}>${icon('refresh')}</button></div>
      ${error ? `<p class="model-error" role="alert">${escape(error)}</p>` : ''}
      ${loading ? '<p class="model-hint" role="status">Loading models…</p>' : ''}
      ${state && !state.connected ? '<p class="model-hint">An HA administrator can connect ChatGPT in AI settings.</p>' : ''}
      <div class="model-options" role="group" aria-label="Available models">${options.map(option => `<button type="button" class="model-option" data-chat-model="${escape(option.id)}" aria-pressed="${option.id === selected}" ${busy || option.unavailable || (option.id !== 'default' && !state?.connected) ? 'disabled' : ''}><span><strong>${escape(option.name)}</strong><small>${escape(option.description || '')}</small></span>${option.id === selected ? icon('check') : ''}</button>`).join('')}</div>
      <p class="model-hint model-menu-footer">Used for your next message. Saved with this chat when you send.</p>
    </div></details>`;
}

export function bindModelPicker(slot, { select, refresh, busy }) {
  const picker = slot.querySelector('details'); const summary = picker.querySelector('summary');
  const close = () => { picker.open = false; summary.focus({ preventScroll: true }); };
  summary.onclick = event => { if (busy) event.preventDefault(); };
  picker.querySelector('[data-refresh-models]').onclick = refresh;
  picker.querySelectorAll('[data-chat-model]').forEach(button => button.onclick = () => select(button.dataset.chatModel));
  picker.onkeydown = event => {
    if (event.key === 'Escape' && picker.open) { event.preventDefault(); event.stopPropagation(); close(); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !busy) {
      event.preventDefault(); picker.open = true;
      const options = [...picker.querySelectorAll('[data-chat-model]:not(:disabled)')];
      const current = options.indexOf(event.target);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length;
      options[index]?.focus();
    }
  };
}
