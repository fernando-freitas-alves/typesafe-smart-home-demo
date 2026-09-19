import { renderDeviceCollections, renderReviewAction, bindDeviceControls } from './chat-components.js?v=1';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = '') => `<ha-icon class="${cls}" icon="mdi:${name}" aria-hidden="true"></ha-icon>`;
const statuses = { applied: 'Sent to Home Assistant', revised: 'Replaced by your next request', cancelled: 'Cancelled', expired: 'Preview expired · ask again to refresh', applying: 'Applying…', unconfirmed: 'Check device state before retrying' };

export class HomeChatPanel extends HTMLElement {
  constructor() {
    super(); this.attachShadow({ mode: 'open' });
    const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = new URL('./panel.css?v=5', import.meta.url); stylesheet.onload = () => this.scrollBottom();
    this.view = document.createElement('div'); this.view.style.display = 'contents'; this.shadowRoot.append(stylesheet, this.view);
    this.sidebar = false; this.busy = false; this.data = null; this.draft = ''; this.error = ''; this.started = false; this.selections = new Map(); this.toolDetails = new Map(); this.componentValues = new Map();
    this.onResize = () => this.style.setProperty('--chat-viewport', `${window.visualViewport?.height || window.innerHeight}px`);
  }
  set hass(value) {
    const changedUser = this._hass?.user?.id && this._hass.user.id !== value?.user?.id;
    this._hass = value; this.style.colorScheme = value?.themes?.darkMode ? 'dark' : 'light';
    if (changedUser) { this.data = null; this.started = false; this.draft = ''; this.sidebar = false; this.selections.clear(); this.toolDetails.clear(); this.componentValues.clear(); }
    if (this.isConnected && value && !this.started) this.start();
  }
  set narrow(value) { this._narrow = value; this.toggleAttribute('narrow', Boolean(value)); }
  connectedCallback() {
    this.render(); this.onResize(); window.visualViewport?.addEventListener('resize', this.onResize);
    if (this._hass && !this.started) this.start();
    this.expiryTimer = setInterval(() => this.expireForms(), 1000);
  }
  disconnectedCallback() { clearInterval(this.expiryTimer); window.visualViewport?.removeEventListener('resize', this.onResize); }
  async start() { this.started = true; await this.request('bootstrap', {}, false); }
  async request(op, extra = {}, focus = true) {
    if (this.busy) return;
    const previousDraft = this.draft;
    if (op === 'send' && !extra.componentAction) { this.pendingText = extra.text; this.draft = ''; }
    this.busy = true; this.operation = op; this.error = ''; this.render(); this.scrollBottom();
    try {
      const payload = { op, ...(this.data ? { threadId: this.data.thread.id } : {}), requestId: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`, ...extra };
      const result = await this._hass.callApi('POST', 'typesafe_chat', payload);
      if (result.error) throw new Error(result.error);
      this.data = result;
      if (['new', 'open', 'archive'].includes(op)) this.draft = '';
      if (['new', 'open'].includes(op) && matchMedia('(max-width: 700px)').matches) this.sidebar = false;
    } catch (error) {
      this.error = error.body?.message || error.body?.error || error.message || 'Could not reach Home chat. Reopen the chat to check its latest result.';
      if (op === 'send') this.draft ||= previousDraft;
    } finally { this.busy = false; this.pendingText = ''; this.render(); this.scrollBottom(); if (focus && !matchMedia('(pointer: coarse)').matches) this.shadowRoot.querySelector('textarea')?.focus(); }
  }
  expireForms() {
    for (const item of this.data?.thread.messages || []) {
      if (item.form?.status !== 'pending' || Date.now() < Date.parse(item.form.expiresAt)) continue;
      item.form.status = 'expired';
      const form = this.shadowRoot.querySelector(`[data-approval="${item.id}"]`);
      if (form) { form.querySelector('fieldset').disabled = true; const footer = form.querySelector('.approval-footer'); if (footer) { footer.className = 'approval-status'; footer.textContent = statuses.expired; } }
    }
  }
  locationSelect(className = '', inline = false) {
    return `<label class="location ${className}">${icon('map-marker-outline')}<span class="sr-only">Where I am${inline ? ' for this request' : ''}</span><select name="location" aria-label="Where I am${inline ? ' for this request' : ''}" data-location ${this.busy ? 'disabled' : ''}><option value="">Choose your location</option>${(this.data?.rooms || []).map(room => `<option value="${escape(room.id)}" ${this.data?.thread.location === room.id ? 'selected' : ''}>${escape(room.name)}</option>`).join('')}</select>${icon('chevron-down')}</label>`;
  }
  tools(items) {
    if (!items?.length) return '';
    return `<details class="tools"><summary>${icon('chevron-right', 'disclosure')}${icon('tools')}<span>Used ${items.length} ${items.length === 1 ? 'tool' : 'tools'}</span></summary><ol>${items.map(item => `<li><div class="tool-heading">${icon(item.status === 'complete' ? 'check' : 'alert-circle-outline')}<strong>${escape(item.name)}</strong>${item.durationMs !== undefined ? `<span>${(item.durationMs / 1000).toFixed(1)}s</span>` : ''}</div><p>${escape(item.detail)}</p>${item.provider ? `<small>${escape(item.provider)}</small>` : ''}<details class="tool-inspector" data-tool-details="${escape(item.detailsId || '')}"><summary>${icon('chevron-right', 'disclosure')}${icon('code-json')}<span>Request &amp; response</span></summary><div class="tool-inspector-body">${item.detailsId ? '<p role="status">Open to load saved details.</p>' : `<p>${escape(item.detailsNote || 'Full payloads were not recorded for this older message. Send a new message to capture them.')}</p>`}</div></details></li>`).join('')}</ol></details>`;
  }
  async loadToolDetails(disclosure) {
    const id = disclosure.dataset.toolDetails;
    if (!disclosure.open || !id || disclosure.dataset.loading || disclosure.dataset.loaded) return;
    const body = disclosure.querySelector('.tool-inspector-body'); const account = this.data.user.id;
    disclosure.dataset.loading = 'true';
    body.innerHTML = '<p role="status">Loading saved request and response…</p>';
    try {
      let details = this.toolDetails.get(id);
      if (!details) {
        const result = await this._hass.callApi('POST', 'typesafe_chat', { op: 'open', threadId: this.data.thread.id, toolDetailsId: id });
        if (result.error) throw new Error(result.error);
        details = result.details;
        if (this.data?.user.id !== account) return;
        this.toolDetails.set(id, details);
      }
      if (!disclosure.isConnected) return;
      this.renderToolDetails(body, details); disclosure.dataset.loaded = 'true';
    } catch (error) {
      if (!disclosure.isConnected) return;
      body.innerHTML = `<p role="alert">${escape(error.body?.error || error.message || 'Could not load saved details.')}</p><button class="text-button" data-retry-details>Retry</button>`;
      body.querySelector('[data-retry-details]').onclick = () => this.loadToolDetails(disclosure);
    } finally { delete disclosure.dataset.loading; }
  }
  renderToolDetails(body, details) {
    const metadata = [
      ['Source', details.provider || details.source], ['Model', details.response?.body?.model],
      ['HTTP status', details.response?.status], ['Duration', details.durationMs === undefined ? undefined : `${details.durationMs} ms`],
      ['Request ID', details.response?.requestId], ['Recorded', details.startedAt ? new Date(details.startedAt).toLocaleString() : undefined],
    ].filter(([, value]) => value !== undefined);
    const sections = [['Request', details.request], ['Response', details.response], ['Usage', details.response?.body?.usage], ['Attempts', details.attempts], ['Used questions', details.usedQuestions]].filter(([, value]) => value !== undefined);
    body.innerHTML = `${details.note ? `<p class="trace-note">${escape(details.note)}</p>` : ''}${details.error ? `<p class="message-error">${escape(details.error)}</p>` : ''}<dl class="trace-meta">${metadata.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>${sections.map(([label], index) => `<details class="trace-payload" data-payload="${index}"><summary>${icon('chevron-right', 'disclosure')}<span>${escape(label)}</span><span class="json-label">JSON</span></summary><div class="payload-body"></div></details>`).join('')}<p class="trace-note">Saved at execution time. Credentials are excluded. Inspecting details does not repeat the action.</p>`;
    body.querySelectorAll('[data-payload]').forEach(section => section.addEventListener('toggle', () => {
      if (!section.open || section.dataset.loaded) return;
      const [label, value] = sections[Number(section.dataset.payload)]; const json = JSON.stringify(value, null, 2);
      const panel = section.querySelector('.payload-body');
      panel.innerHTML = `<div class="payload-toolbar"><span>${escape(label)} payload</span><button type="button" class="copy-json" aria-label="Copy ${escape(label.toLowerCase())} JSON">${icon('content-copy')}<span>Copy JSON</span></button></div><pre tabindex="0" aria-label="${escape(label)} JSON"><code>${escape(json)}</code></pre><span class="copy-status sr-only" role="status"></span>`;
      panel.querySelector('button').onclick = async () => {
        const status = panel.querySelector('.copy-status');
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(json);
          else {
            const field = document.createElement('textarea'); field.value = json; field.className = 'sr-only'; this.shadowRoot.append(field); field.select();
            let copied; try { copied = document.execCommand('copy'); } finally { field.remove(); }
            if (!copied) throw new Error('Copy unavailable');
          }
          panel.querySelector('button span').textContent = 'Copied'; status.textContent = `${label} JSON copied.`;
        } catch { status.classList.remove('sr-only'); status.textContent = 'Copy is unavailable. Select the JSON text to copy it manually.'; }
      };
      section.dataset.loaded = 'true';
    }));
  }
  actionForm(item) {
    const form = item.form; if (!form) return '';
    if (form.kind === 'location' && form.status === 'resolved') return '';
    if (form.kind === 'location') return `<div class="location-question">${this.locationSelect('inline-location', true)}</div>`;
    const active = form.status === 'pending' && Date.now() < Date.parse(form.expiresAt);
    return `<form class="approval" data-approval="${escape(item.id)}"><div class="approval-heading">${icon('tune-variant')}<strong>Review changes</strong><span>${form.actions.length} ${form.actions.length === 1 ? 'action' : 'actions'}</span></div><fieldset ${!active || this.busy ? 'disabled' : ''}><legend class="sr-only">Select the actions to apply</legend>${form.actions.map((action, index) => renderReviewAction(action, index, (form.selected || this.selections.get(item.id) || form.actions.map((_, i) => i)).includes(index))).join('')}</fieldset>${active ? `<div class="approval-footer"><span>Apply your selection here, or reply “yes”.</span><div><button type="button" class="text-button" data-cancel ${this.busy ? 'disabled' : ''}>Cancel</button><button class="primary" type="submit" ${this.busy || this.selections.get(item.id)?.length === 0 ? 'disabled' : ''}>Apply selected</button></div></div>` : `<div class="approval-status">${icon(form.status === 'applied' ? 'check-circle-outline' : 'information-outline')}${escape(statuses[form.status] || statuses.expired)}</div>`}</form>`;
  }
  renderMessage(item) {
    if (item.role === 'context') return `<div class="context-message">${icon('map-marker-outline')}${escape(item.text)}</div>`;
    const components = item.role === 'assistant' ? renderDeviceCollections(item.components, item.id, { busy: this.busy, values: this.componentValues }) : '';
    return `<article class="message ${item.role}" aria-label="${item.role === 'user' ? 'You' : 'Home chat'}"><div class="message-content">${item.role === 'assistant' ? this.tools(item.tools) : ''}<p class="message-text ${item.error ? 'message-error' : ''}">${escape(components && item.summary ? item.summary : item.text)}</p>${components}${this.actionForm(item)}</div></article>`;
  }
  render() {
    const messages = this.data?.thread.messages || [];
    const name = this.data?.user.name || this._hass?.user?.name || 'Home Assistant';
    const hasMessages = messages.length > 0 || Boolean(this.pendingText);
    this.view.innerHTML = `<div class="layout ${this.sidebar ? 'sidebar-open' : ''}">
      ${this.sidebar ? `<button class="scrim" aria-label="Close chat history" data-close></button>` : ''}
      <aside class="sidebar" aria-label="Chat history" ${!this.sidebar ? 'inert' : ''}>
        <div class="sidebar-top"><strong>Your chats</strong><button class="icon-button" title="Close chat history" aria-label="Close chat history" data-close>${icon('dock-left')}</button></div>
        <button class="new-chat" data-new ${this.busy ? 'disabled' : ''}>${icon('plus')}New chat</button>
        <nav aria-label="Conversations">${(this.data?.threads || []).map(thread => `<button class="thread ${thread.id === this.data.thread.id ? 'active' : ''}" data-thread="${escape(thread.id)}" ${thread.id === this.data.thread.id ? 'aria-current="page"' : ''} ${this.busy ? 'disabled' : ''}><span>${escape(thread.title)}</span></button>`).join('')}</nav>
        <div class="account">${icon('account-circle-outline')}<div><strong>${escape(name)}</strong><small>Home Assistant account</small></div></div>
      </aside>
      <main ${this.sidebar && matchMedia('(max-width: 700px)').matches ? 'inert' : ''}><header><div class="header-left"><ha-menu-button class="ha-menu" title="Home Assistant menu"></ha-menu-button><button class="icon-button" aria-label="${this.sidebar ? 'Close' : 'Open'} chat history" aria-expanded="${this.sidebar}" title="Chat history" data-sidebar>${icon('dock-left')}</button><button class="icon-button" title="New chat" aria-label="New chat" data-new ${this.busy ? 'disabled' : ''}>${icon('square-edit-outline')}</button><span class="brand">Home chat<span class="brand-dot" aria-hidden="true"></span></span></div><div class="header-right"><span class="user-name">${escape(name)}</span>${hasMessages ? `<details class="chat-menu"><summary class="icon-button" aria-label="Chat options" title="Chat options">${icon('dots-horizontal')}</summary><div><button data-rename ${this.busy ? 'disabled' : ''}>Rename chat</button><button data-archive ${this.busy ? 'disabled' : ''}>Archive chat</button></div></details>` : ''}</div></header>
      <div class="scroll-area"><div class="conversation ${!hasMessages ? 'empty' : ''}">${hasMessages ? messages.map(item => this.renderMessage(item)).join('') : `<section class="welcome"><div class="welcome-icon">${icon('home-outline')}</div><h1>What can I help with${name !== 'Home Assistant' ? `, ${escape(name.split(' ')[0])}` : ''}?</h1><p>Your home, one conversation.</p><div class="suggestions"><button data-prompt="Turn on the lights">${icon('lightbulb-outline')}Turn on the lights</button><button data-prompt="Which lights are on here?">${icon('home-search-outline')}What’s on here?</button><button data-prompt="What’s the temperature here?">${icon('thermometer')}Check the temperature</button></div></section>`}${this.pendingText ? this.renderMessage({ role: 'user', text: this.pendingText }) : ''}${this.busy ? `<div class="working" role="status"><span class="working-dot"></span>${this.operation === 'apply' ? 'Applying your selected changes…' : this.operation === 'bootstrap' ? 'Connecting to your home…' : this.operation === 'send' ? 'Working on your request…' : 'Updating your chat…'}</div>` : ''}</div></div>
      <div class="composer-area"><div class="composer-inner">${this.error ? `<div class="error" role="alert">${icon('alert-circle-outline')}<span>${escape(this.error)}</span><button class="text-button" data-recover>Reopen chat</button></div>` : ''}<div class="presence-row">${this.locationSelect()}<span>Selected manually</span></div><form class="composer"><label class="sr-only" for="message">Message Home chat</label><textarea id="message" name="message" autocomplete="off" rows="1" maxlength="1500" placeholder="Ask about your home…" ${!this.data ? 'disabled' : ''}>${escape(this.draft)}</textarea><div class="composer-bottom"><span>${icon('home-assistant')}${this.data ? 'Connected to Home Assistant' : 'Connecting to Home Assistant'}</span><button class="send" type="submit" aria-label="Send message" title="Send message" ${this.busy || !this.draft.trim() || !this.data ? 'disabled' : ''}>${icon('arrow-up')}</button></div></form><p class="composer-note">You review changes before they happen. Location is specific to this chat.</p></div></div>
      <div class="sr-only" role="status" aria-live="polite">${this.error ? 'Chat needs attention.' : !this.busy && hasMessages ? 'Response ready.' : ''}</div>
      </main></div>`;
    const root = this.shadowRoot;
    bindDeviceControls(root, { values: this.componentValues, submit: componentAction => this.request('send', { componentAction }, false) });
    root.querySelectorAll('[data-tool-details]').forEach(disclosure => disclosure.addEventListener('toggle', () => this.loadToolDetails(disclosure)));
    const menu = root.querySelector('ha-menu-button'); if (menu) { menu.hass = this._hass; menu.narrow = this._narrow; }
    root.querySelector('[data-sidebar]').onclick = () => { this.sidebar = !this.sidebar; this.render(); if (this.sidebar) root.querySelector('.sidebar [data-close]').focus(); };
    root.querySelectorAll('[data-close]').forEach(button => button.onclick = () => { this.sidebar = false; this.render(); root.querySelector('[data-sidebar]').focus(); });
    root.querySelectorAll('[data-new]').forEach(button => button.onclick = () => this.request('new'));
    root.querySelectorAll('[data-thread]').forEach(button => button.onclick = () => this.request('open', { threadId: button.dataset.thread }));
    root.querySelectorAll('[data-location]').forEach(select => select.onchange = () => this.request('location', { location: select.value }));
    root.querySelectorAll('[data-prompt]').forEach(button => button.onclick = () => { this.draft = button.dataset.prompt; this.render(); root.querySelector('textarea').focus(); });
    root.querySelectorAll('[data-approval]').forEach(form => form.onsubmit = event => { event.preventDefault(); const selected = [...new FormData(form).getAll('selected')].map(Number); if (selected.length) this.request('apply', { messageId: form.dataset.approval, selected }); });
    root.querySelectorAll('[data-approval] input').forEach(input => input.onchange = () => { const form = input.closest('form'); this.selections.set(form.dataset.approval, [...new FormData(form).getAll('selected')].map(Number)); const submit = form.querySelector('[type="submit"]'); if (submit) submit.disabled = !form.querySelector('input:checked'); });
    root.querySelectorAll('[data-cancel]').forEach(button => button.onclick = () => this.request('cancel'));
    root.querySelector('[data-recover]')?.addEventListener('click', () => this.request('open'));
    root.querySelector('[data-archive]')?.addEventListener('click', () => this.archive());
    root.querySelector('[data-rename]')?.addEventListener('click', () => this.rename());
    const textarea = root.querySelector('textarea');
    const resize = () => { textarea.style.height = 'auto'; textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px'; };
    textarea.oninput = () => { this.draft = textarea.value; root.querySelector('.send').disabled = this.busy || !this.draft.trim(); resize(); };
    textarea.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) { event.preventDefault(); this.send(); } };
    root.querySelector('.composer').onsubmit = event => { event.preventDefault(); this.send(); };
    root.onkeydown = event => { if (event.key === 'Escape' && this.sidebar) { this.sidebar = false; this.render(); root.querySelector('[data-sidebar]').focus(); } };
    requestAnimationFrame(resize);
  }
  send() {
    if (this.busy || !this.draft.trim()) return;
    const pending = [...(this.data?.thread.messages || [])].reverse().find(item => item.form?.status === 'pending');
    this.request('send', { text: this.draft.trim(), ...(pending && this.selections.has(pending.id) ? { selected: this.selections.get(pending.id) } : {}) });
  }
  archive() {
    const dialog = document.createElement('dialog'); dialog.className = 'rename-dialog';
    dialog.innerHTML = '<form><h2>Archive this chat?</h2><p>This hides the conversation from your sidebar. Its saved history stays on the HA server.</p><div><button type="button" class="text-button">Keep chat</button><button type="submit" class="primary">Archive chat</button></div></form>';
    this.shadowRoot.append(dialog); dialog.querySelector('[type="button"]').onclick = () => dialog.close(); dialog.onclose = () => dialog.remove();
    dialog.querySelector('form').onsubmit = event => { event.preventDefault(); dialog.close(); this.request('archive'); }; dialog.showModal();
  }
  rename() {
    const dialog = document.createElement('dialog'); dialog.className = 'rename-dialog';
    dialog.innerHTML = `<form><h2>Rename chat</h2><label for="chat-title">Chat title</label><input id="chat-title" name="title" autocomplete="off" maxlength="80" required value="${escape(this.data.thread.title)}"><div><button type="button" class="text-button">Cancel</button><button class="primary" type="submit">Save</button></div></form>`;
    this.shadowRoot.append(dialog); dialog.querySelector('[type="button"]').onclick = () => dialog.close(); dialog.onclose = () => dialog.remove();
    dialog.querySelector('form').onsubmit = event => { event.preventDefault(); const title = new FormData(event.target).get('title'); dialog.close(); this.request('rename', { title }); };
    dialog.showModal(); dialog.querySelector('input').select();
  }
  scrollBottom() { requestAnimationFrame(() => { const scroll = this.shadowRoot.querySelector('.scroll-area'); if (scroll) scroll.scrollTop = scroll.scrollHeight; }); }
}
if (!customElements.get('typesafe-chat-panel')) customElements.define('typesafe-chat-panel', HomeChatPanel);
