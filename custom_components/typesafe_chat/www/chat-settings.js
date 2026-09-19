const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = name => `<ha-icon icon="mdi:${name}" aria-hidden="true"></ha-icon>`;

// Keep settings outside the conversation render cycle, preserving unsent drafts.
export function openAiSettings(panel) {
  const root = panel.shadowRoot;
  if (root.querySelector('.ai-settings')) return;
  const dialog = document.createElement('dialog'); dialog.className = 'ai-settings'; dialog.setAttribute('aria-labelledby', 'ai-settings-title');
  root.append(dialog); let state; let busy = false; let error = ''; let poll; let closed = false;
  const close = () => { closed = true; clearTimeout(poll); dialog.remove(); root.querySelector('[data-ai-settings]')?.focus(); };
  dialog.addEventListener('close', close); dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
  const render = () => {
    const active = root.activeElement;
    const focusSelector = active?.id === 'shared-model' ? '#shared-model' : [...(active?.attributes || [])].find(attribute => attribute.name.startsWith('data-settings-'))?.name;
    dialog.innerHTML = `<div class="settings-heading"><div><h2 id="ai-settings-title">AI settings</h2><p>One connection for your home</p></div><button class="icon-button" aria-label="Close AI settings" data-settings-close>${icon('close')}</button></div>
      ${error ? `<p class="settings-error" role="alert">${escape(error)}</p>` : ''}
      ${state ? `<section class="settings-provider"><div class="settings-provider-heading">${icon('creation')}<div><strong>ChatGPT subscription</strong><span>${state.connected ? 'Connected' : state.login ? 'Waiting for sign-in' : 'Not connected'}</span></div><span class="settings-dot ${state.connected ? 'connected' : ''}" aria-hidden="true"></span></div>
        <p>Replies, follow-ups, and command splitting share this subscription across all HA users. Usage counts toward its limits.</p>
        ${state.account ? `<div class="settings-account"><strong>${escape(state.account.email || 'ChatGPT account')}</strong><span>${escape(state.account.plan || '')}</span></div>` : ''}
        ${state.login ? `<div class="settings-login"><p>Open ChatGPT, sign in, and enter this code:</p><strong class="login-code">${escape(state.login.userCode)}</strong><a class="primary" href="${escape(state.login.verificationUrl)}" target="_blank" rel="noopener noreferrer">Continue to ChatGPT ${icon('open-in-new')}</a><p>Keep this window open. The connection updates automatically. If asked, enable device-code sign-in in ChatGPT’s security settings.</p><button class="text-button" data-settings-cancel ${busy ? 'disabled' : ''}>Cancel sign-in</button></div>` : ''}
        ${state.canManage && !state.login ? `<button class="${state.connected ? 'text-button' : 'primary'}" data-settings-${state.connected ? 'disconnect' : 'connect'} ${busy ? 'disabled' : ''}>${state.connected ? 'Disconnect ChatGPT' : 'Connect ChatGPT'}</button>` : ''}
        ${state.error ? `<p class="settings-error" role="alert">${escape(state.error)}</p>` : ''}
      </section>
      <section class="settings-model"><label for="shared-model">Model for everyone</label><select id="shared-model" ${!state.canManage || !state.connected || busy ? 'disabled' : ''}><option value="auto" ${state.model === 'auto' ? 'selected' : ''}>Auto · fastest preset</option>${(state.models || []).map(model => `<option value="${escape(model.id)}" ${state.model === model.id ? 'selected' : ''}>${escape(model.name)}</option>`).join('')}${state.model !== 'auto' && !(state.models || []).some(model => model.id === state.model) ? `<option selected value="${escape(state.model)}">${escape(state.model)}</option>` : ''}</select><p>${state.connected ? state.modelUnavailable ? 'This model is unavailable. Choose Auto or another model.' : `Using ${escape(state.modelName || state.resolvedModel)} · ${escape(state.effort)} reasoning.` : 'Connect ChatGPT to load your available models.'} Auto prefers a fast model with light reasoning.</p></section>
      ${!state.canManage ? '<p class="settings-note">An HA administrator manages this shared connection and model.</p>' : ''}
      <p class="settings-note">The sign-in stays on your HA server. No LLM API key or paid fallback. Jev still needs its separate TypeSafe key.</p>` : '<p class="settings-loading" role="status">Loading AI settings…</p>'}
      <div class="settings-footer"><span role="status">${busy ? 'Updating…' : ''}</span><button class="text-button" data-settings-refresh ${busy ? 'disabled' : ''}>Refresh</button></div>`;
    dialog.querySelector('[data-settings-close]').onclick = () => dialog.close();
    for (const op of ['connect', 'cancel', 'disconnect']) dialog.querySelector(`[data-settings-${op}]`)?.addEventListener('click', () => request(op));
    dialog.querySelector('[data-settings-refresh]').onclick = () => request('status');
    dialog.querySelector('select')?.addEventListener('change', event => request('model', { model: event.target.value }));
    if (dialog.open) (dialog.querySelector(focusSelector?.startsWith('#') ? focusSelector : `[${focusSelector || 'data-settings-close'}]`) || dialog.querySelector('[data-settings-close]')).focus();
  };
  const request = async (op, extra = {}, background = false) => {
    if (busy || closed) return;
    clearTimeout(poll); busy = true; error = ''; if (!background) render();
    const previous = JSON.stringify(state);
    try {
      const result = await panel._hass.callApi('POST', 'typesafe_chat/llm', { apiVersion: 1, op, ...extra });
      if (result.error && !('connected' in result)) throw new Error(result.error);
      state = result;
    } catch (reason) { error = reason.body?.error || reason.message || 'Could not reach AI settings.'; }
    finally {
      busy = false;
      if (!closed) {
        if (!background || error || JSON.stringify(state) !== previous) render();
        if (state?.login) poll = setTimeout(() => request('status', {}, true), 3000);
      }
    }
  };
  render(); dialog.showModal(); request('status');
}
