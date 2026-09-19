import { openAiSettings } from './chat-settings.js?v=2';
import { renderModelPicker, bindModelPicker } from './chat-model-picker.js?v=1';
import { createChatRequest } from './chat-client.js?v=1';
import { chatViewportFrame, chatViewportAnchor, containChatScroll } from './chat-viewport.js?v=2';
import { lockChatPageScroll } from './chat-page-scroll.js?v=1';
import { renderHistoryList } from './chat-history.js?v=1';
import { renderDeviceCollections, renderReviewAction, bindDeviceControls } from './chat-components.js?v=1';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = '') => `<ha-icon class="${cls}" icon="mdi:${name}" aria-hidden="true"></ha-icon>`;
const statuses = { applied: 'Sent to Home Assistant', revised: 'Replaced by your next request', cancelled: 'Cancelled', expired: 'Preview expired · ask again to refresh', applying: 'Applying…', unconfirmed: 'Check device state before retrying' };

export class HomeChatPanel extends HTMLElement {
  constructor() {
    super(); this.attachShadow({ mode: 'open' });
    const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = new URL('./panel.css?v=15', import.meta.url); stylesheet.onload = () => { this.onResize(); this.scrollBottom(); };
    this.view = document.createElement('div'); this.view.style.display = 'contents'; this.shadowRoot.append(stylesheet, this.view);
    this.sidebar = false; this.historyMode = 'chats'; this.historyQuery = ''; this.historyNotice = null; this.busy = false; this.data = null; this.draft = ''; this.error = ''; this.started = false; this.selections = new Map(); this.toolDetails = new Map(); this.componentValues = new Map();
    this.modelChoices = new Map(); this.modelState = null; this.modelError = ''; this.modelsLoading = false;
    this.onModelOutside = event => { const picker = this.shadowRoot.querySelector('.model-picker'); if (picker?.open && !event.composedPath().includes(picker)) picker.open = false; };
    this.onResize = () => {
      if (this.viewportFrame) return;
      this.viewportFrame = requestAnimationFrame(() => {
        this.viewportFrame = 0;
        if (!this.isConnected) return;
        const viewport = window.visualViewport;
        const anchor = chatViewportAnchor(this);
        const frame = chatViewportFrame({ height: viewport?.height || window.innerHeight, offsetTop: viewport?.offsetTop || 0, anchorTop: anchor.top });
        for (const [key, value] of [['--chat-viewport', frame.height], ['--chat-top', frame.top], ['--chat-left', anchor.left], ['--chat-width', anchor.width], ['--chat-page-top', anchor.top]]) {
          const px = `${value}px`;
          if (this.style.getPropertyValue(key) !== px) this.style.setProperty(key, px);
        }
        const main = this.shadowRoot.querySelector('main');
        if (main) main.inert = this.sidebar && matchMedia('(max-width: 700px)').matches;
      });
    };
  }
  set hass(value) {
    const changedUser = this._hass?.user?.id && this._hass.user.id !== value?.user?.id;
    this._hass = value; this.style.colorScheme = value?.themes?.darkMode ? 'dark' : 'light';
    this.updateAccountBadge();
    if (changedUser) { this.shadowRoot.querySelector('.ai-settings')?.close(); this.data = null; this.started = false; this.draft = ''; this.sidebar = false; this.historyMode = 'chats'; this.historyQuery = ''; this.historyNotice = null; this.selections.clear(); this.toolDetails.clear(); this.componentValues.clear(); this.modelChoices.clear(); this.modelState = null; this.modelError = ''; this.modelsLoading = false; }
    if (this.isConnected && value && !this.started) this.start();
  }
  set narrow(value) { this._narrow = value; this.toggleAttribute('narrow', Boolean(value)); }
  connectedCallback() {
    this.releasePageScroll = lockChatPageScroll(this.ownerDocument);
    this.render(); this.onResize(); window.visualViewport?.addEventListener('resize', this.onResize); window.addEventListener('resize', this.onResize);
    window.visualViewport?.addEventListener('scroll', this.onResize);
    window.visualViewport?.addEventListener('scrollend', this.onResize);
    window.addEventListener('scroll', this.onResize);
    this.shadowRoot.addEventListener('focusin', this.onResize);
    this.shadowRoot.addEventListener('focusout', this.onResize);
    this.releaseScrollContainment = containChatScroll(this.shadowRoot);
    document.addEventListener('pointerdown', this.onModelOutside);
    if (this._hass && !this.started) this.start();
    this.expiryTimer = setInterval(() => this.expireForms(), 1000);
  }
  disconnectedCallback() {
    this.shadowRoot.querySelector('.ai-settings')?.close(); clearInterval(this.expiryTimer);
    cancelAnimationFrame(this.viewportFrame); this.viewportFrame = 0;
    window.visualViewport?.removeEventListener('resize', this.onResize);
    window.visualViewport?.removeEventListener('scroll', this.onResize);
    window.visualViewport?.removeEventListener('scrollend', this.onResize);
    window.removeEventListener('resize', this.onResize); window.removeEventListener('scroll', this.onResize);
    this.shadowRoot.removeEventListener('focusin', this.onResize); this.shadowRoot.removeEventListener('focusout', this.onResize);
    this.releaseScrollContainment?.();
    this.releasePageScroll?.();
    document.removeEventListener('pointerdown', this.onModelOutside);
  }
  updateAccountBadge() {
    const badge = this.shadowRoot.querySelector('ha-user-badge');
    // Reuse HA's photo/initials rendering, including older versions that need hass.
    if (badge) { badge.hass = this._hass; badge.user = this._hass?.user; }
  }
  async start() { this.started = true; await Promise.all([this.request('bootstrap', {}, false), this.refreshModels()]); }
  selectedModel() { return this.modelChoices.get(this.data?.thread.id) || this.data?.thread.model || 'default'; }
  async refreshModels() {
    if (this.modelsLoading) return;
    const account = this._hass?.user?.id;
    this.modelsLoading = true; this.modelError = ''; this.updateModelPicker();
    try {
      const state = await this._hass.callApi('POST', 'typesafe_chat/llm', { apiVersion: 1, op: 'status' });
      if (account !== this._hass?.user?.id) return;
      if (state.error && !('connected' in state)) throw new Error(state.error);
      this.modelState = state;
    } catch (error) { if (account === this._hass?.user?.id) this.modelError = error.body?.error || error.message || 'Could not load models. Try refreshing.'; }
    finally { if (account === this._hass?.user?.id) { this.modelsLoading = false; this.updateModelPicker(); } }
  }
  updateModelPicker() {
    const slot = this.shadowRoot.querySelector('[data-model-picker]'); if (!slot) return;
    const wasOpen = slot.querySelector('details')?.open;
    const hadFocus = slot.contains(this.shadowRoot.activeElement);
    const busy = this.busy || !this.data;
    slot.innerHTML = renderModelPicker(this.modelState, this.selectedModel(), { busy, error: this.modelError, loading: this.modelsLoading });
    slot.querySelector('details').open = Boolean(wasOpen && !busy);
    bindModelPicker(slot, { busy, refresh: () => this.refreshModels(), select: model => {
      this.modelChoices.set(this.data.thread.id, model);
      slot.querySelector('details').open = false; this.updateModelPicker();
      slot.querySelector('summary').focus({ preventScroll: true });
    } });
    if (hadFocus) slot.querySelector('summary').focus({ preventScroll: true });
  }
  setSidebar(open, { focus = true } = {}) {
    const root = this.shadowRoot;
    const sidebar = root.querySelector('.sidebar');
    // Establish the starting position even immediately after a chat render.
    sidebar.getBoundingClientRect();
    this.sidebar = Boolean(open);
    root.querySelector('.layout').classList.toggle('sidebar-open', this.sidebar);
    sidebar.inert = !this.sidebar;
    const scrim = root.querySelector('.scrim');
    scrim.inert = !this.sidebar;
    scrim.setAttribute('aria-hidden', String(!this.sidebar));
    root.querySelector('main').inert = this.sidebar && matchMedia('(max-width: 700px)').matches;
    const toggle = root.querySelector('[data-sidebar]');
    toggle.setAttribute('aria-expanded', String(this.sidebar));
    toggle.setAttribute('aria-label', `${this.sidebar ? 'Close' : 'Open'} chat history`);
    if (focus) (this.sidebar ? sidebar.querySelector('[data-close]') : toggle).focus({ preventScroll: true });
  }
  async request(op, extra = {}, focus = true) {
    if (this.busy) return;
    const previousDraft = this.draft; const previousThreadId = this.data?.thread.id;
    let closeSidebar = false;
    const preserveView = op === 'archive' && extra.targetThreadId !== previousThreadId;
    const scrollTop = this.shadowRoot.querySelector('.scroll-area')?.scrollTop || 0;
    const historyScrollTop = this.shadowRoot.querySelector('.sidebar nav')?.scrollTop || 0;
    const position = () => {
      if (!preserveView) this.scrollBottom();
      else requestAnimationFrame(() => { const scroll = this.shadowRoot.querySelector('.scroll-area'); if (scroll) scroll.scrollTop = scrollTop; });
      requestAnimationFrame(() => { const nav = this.shadowRoot.querySelector('.sidebar nav'); if (nav && op === 'archive') nav.scrollTop = historyScrollTop; });
    };
    if (op === 'send' && !extra.componentAction) { this.pendingText = extra.text; this.draft = ''; }
    this.busy = true; this.operation = op; this.error = ''; this.render(); position();
    try {
      const payload = createChatRequest(op, { ...(this.data && op !== 'new' ? { threadId: this.data.thread.id } : {}), ...extra });
      const result = await this._hass.callApi('POST', 'typesafe_chat', payload);
      if (result.error) throw new Error(result.error);
      this.data = result;
      if (['new', 'open'].includes(op) || (op === 'archive' && result.thread.id !== previousThreadId)) this.draft = '';
      if (op === 'new') { this.historyMode = 'chats'; this.historyQuery = ''; }
      if (op === 'open') this.historyMode = result.thread.archived ? 'archived' : 'chats';
      if (op === 'archive') {
        this.historyNotice = { text: extra.archived === false ? 'Chat restored' : 'Chat archived', undoId: extra.archived === false ? null : extra.targetThreadId || previousThreadId };
        if (extra.archived === false) { this.historyMode = 'chats'; this.historyQuery = ''; }
      }
      closeSidebar = ['new', 'open'].includes(op) && matchMedia('(max-width: 700px)').matches;
      return result;
    } catch (error) {
      this.error = error.body?.message || error.body?.error || error.message || 'Could not reach Home chat. Reopen the chat to check its latest result.';
      if (op === 'send') this.draft ||= previousDraft;
    } finally { this.busy = false; this.pendingText = ''; this.render(); position(); if (closeSidebar) this.setSidebar(false, { focus: false }); if (focus && !matchMedia('(pointer: coarse)').matches) this.shadowRoot.querySelector('textarea')?.focus({ preventScroll: true }); }
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
    return `<label class="location ${className}">${icon('map-marker-outline')}<span class="sr-only">Where I am${inline ? ' for this request' : ''}</span><select name="location" aria-label="Where I am${inline ? ' for this request' : ''}" data-location ${this.busy || this.data?.thread.archived ? 'disabled' : ''}><option value="">Choose your location</option>${(this.data?.rooms || []).map(room => `<option value="${escape(room.id)}" ${this.data?.thread.location === room.id ? 'selected' : ''}>${escape(room.name)}</option>`).join('')}</select>${icon('chevron-down')}</label>`;
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
        const result = await this._hass.callApi('POST', 'typesafe_chat', createChatRequest('open', { threadId: this.data.thread.id, toolDetailsId: id }));
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
    if (form.kind === 'location' && (form.status === 'resolved' || this.data?.thread.archived)) return '';
    if (form.kind === 'location') return `<div class="location-question">${this.locationSelect('inline-location', true)}</div>`;
    const active = !this.data?.thread.archived && form.status === 'pending' && Date.now() < Date.parse(form.expiresAt);
    return `<form class="approval" data-approval="${escape(item.id)}"><div class="approval-heading">${icon('tune-variant')}<strong>Review changes</strong><span>${form.actions.length} ${form.actions.length === 1 ? 'action' : 'actions'}</span></div><fieldset ${!active || this.busy ? 'disabled' : ''}><legend class="sr-only">Select the actions to apply</legend>${form.actions.map((action, index) => renderReviewAction(action, index, (form.selected || this.selections.get(item.id) || form.actions.map((_, i) => i)).includes(index))).join('')}</fieldset>${active ? `<div class="approval-footer"><span>Apply your selection here, or reply “yes”.</span><div><button type="button" class="text-button" data-cancel ${this.busy ? 'disabled' : ''}>Cancel</button><button class="primary" type="submit" ${this.busy || this.selections.get(item.id)?.length === 0 ? 'disabled' : ''}>Apply selected</button></div></div>` : `<div class="approval-status">${icon(form.status === 'applied' ? 'check-circle-outline' : 'information-outline')}${escape(statuses[form.status] || statuses.expired)}</div>`}</form>`;
  }
  renderMessage(item) {
    if (item.role === 'context') return `<div class="context-message">${icon('map-marker-outline')}${escape(item.text)}</div>`;
    const components = item.role === 'assistant' ? renderDeviceCollections(item.components, item.id, { busy: this.busy || this.data?.thread.archived, values: this.componentValues }) : '';
    return `<article class="message ${item.role}" aria-label="${item.role === 'user' ? 'You' : 'Home chat'}"><div class="message-content">${item.role === 'assistant' ? this.tools(item.tools) : ''}<p class="message-text ${item.error ? 'message-error' : ''}">${escape(components && item.summary ? item.summary : item.text)}</p>${components}${this.actionForm(item)}</div></article>`;
  }
  render() {
    const previousScrollTop = this.shadowRoot.querySelector('.scroll-area')?.scrollTop || 0;
    const messages = this.data?.thread.messages || [];
    const name = this.data?.user.name || this._hass?.user?.name || 'Home Assistant';
    const archived = this.data?.thread.archived;
    const hasMessages = messages.length > 0 || Boolean(this.pendingText) || archived;
    this.view.innerHTML = `<div class="layout ${this.sidebar ? 'sidebar-open' : ''}">
      <button type="button" class="scrim" aria-label="Close chat history" aria-hidden="${!this.sidebar}" ${!this.sidebar ? 'inert' : ''} data-close></button>
      <aside class="sidebar" aria-label="Chat history" ${!this.sidebar ? 'inert' : ''}>
        <div class="sidebar-top"><strong>Your chats</strong><div class="sidebar-actions"><button class="icon-button new-chat" title="New chat" aria-label="New chat" data-new ${this.busy ? 'disabled' : ''}>${icon('plus')}</button><button class="icon-button" title="Close chat history" aria-label="Close chat history" data-close>${icon('dock-left')}</button></div></div>
        <label class="history-search">${icon('magnify')}<span class="sr-only">Search chats</span><input type="search" name="chat-search" autocomplete="off" placeholder="Search chats" value="${escape(this.historyQuery)}" data-history-search></label>
        <div class="history-views" role="group" aria-label="Chat history views">${['chats', 'archived'].map(mode => `<button data-history-view="${mode}" aria-pressed="${this.historyMode === mode}">${mode === 'chats' ? icon('chat-outline') + 'Chats' : icon('archive-outline') + 'Archived'}<span>${(mode === 'chats' ? this.data?.threads : this.data?.archivedThreads)?.length || 0}</span></button>`).join('')}</div>
        <nav aria-label="${this.historyMode === 'archived' ? 'Archived conversations' : 'Conversations'}">${renderHistoryList(this.data, { mode: this.historyMode, query: this.historyQuery, busy: this.busy })}</nav>
        ${this.historyNotice ? `<div class="history-notice" role="status">${icon('check-circle-outline')}<span>${this.historyNotice.text}</span>${this.historyNotice.undoId ? `<button class="text-button" data-history-undo ${this.busy ? 'disabled' : ''}>Undo</button>` : ''}</div>` : ''}
        <div class="account"><span class="account-avatar" aria-hidden="true"><ha-user-badge></ha-user-badge>${icon('account-circle-outline')}</span><div><strong>${escape(name)}</strong><small>Home Assistant account</small></div><button class="icon-button" title="AI settings" aria-label="AI settings" data-ai-settings>${icon('cog-outline')}</button></div>
      </aside>
      <main ${this.sidebar && matchMedia('(max-width: 700px)').matches ? 'inert' : ''}><header><div class="header-left"><ha-menu-button class="ha-menu" title="Home Assistant menu"></ha-menu-button><button class="icon-button" aria-label="${this.sidebar ? 'Close' : 'Open'} chat history" aria-expanded="${this.sidebar}" title="Chat history" data-sidebar>${icon('dock-left')}</button><button class="icon-button" title="New chat" aria-label="New chat" data-new ${this.busy ? 'disabled' : ''}>${icon('square-edit-outline')}</button><span class="brand">Home chat</span></div><div class="header-right"><span class="user-name">${escape(name)}</span>${hasMessages ? `<details class="chat-menu"><summary class="icon-button" aria-label="Chat options" title="Chat options">${icon('dots-horizontal')}</summary><div>${archived ? `<button data-restore="${escape(this.data.thread.id)}" ${this.busy ? 'disabled' : ''}>Restore chat</button>` : `<button data-rename ${this.busy ? 'disabled' : ''}>Rename chat</button><button data-archive ${this.busy ? 'disabled' : ''}>Archive chat</button>`}</div></details>` : ''}</div></header>
      <div class="scroll-area"><div class="conversation ${!hasMessages ? 'empty' : ''}">${hasMessages ? messages.map(item => this.renderMessage(item)).join('') || (archived ? '<p class="archived-empty">This archived chat is empty.</p>' : '') : `<section class="welcome"><div class="welcome-icon">${icon('home-outline')}</div><h1>What can I help with${name !== 'Home Assistant' ? `, ${escape(name.split(' ')[0])}` : ''}?</h1><p>Your home, one conversation.</p><div class="suggestions"><button data-prompt="Turn on the lights">${icon('lightbulb-outline')}Turn on the lights</button><button data-prompt="Which lights are on here?">${icon('home-search-outline')}What’s on here?</button><button data-prompt="What’s the temperature here?">${icon('thermometer')}Check the temperature</button></div></section>`}${this.pendingText ? this.renderMessage({ role: 'user', text: this.pendingText }) : ''}${this.busy ? `<div class="working" role="status"><span class="working-dot"></span>${this.operation === 'apply' ? 'Applying your selected changes…' : this.operation === 'bootstrap' ? 'Connecting to your home…' : this.operation === 'send' ? 'Working on your request…' : 'Updating your chat…'}</div>` : ''}</div></div>
      <div class="composer-area"><div class="composer-inner">${this.error ? `<div class="error" role="alert">${icon('alert-circle-outline')}<span>${escape(this.error)}</span><button class="text-button" data-recover>Reopen chat</button></div>` : ''}${archived ? `<div class="archived-chat">${icon('archive-outline')}<div><strong>Archived chat</strong><p>Restore this conversation to send messages or use device controls.</p></div><button class="primary" data-restore="${escape(this.data.thread.id)}" ${this.busy ? 'disabled' : ''}>Restore chat</button></div>` : `<div class="presence-row">${this.locationSelect()}<span>Selected manually</span></div><form class="composer"><label class="sr-only" for="message">Message Home chat</label><textarea id="message" name="message" autocomplete="off" rows="1" maxlength="1500" placeholder="Ask about your home…" ${!this.data ? 'disabled' : ''}>${escape(this.draft)}</textarea><div class="composer-bottom"><div class="composer-model" data-model-picker></div><span class="connection-status" title="${this.data ? 'Connected to Home Assistant' : 'Connecting to Home Assistant'}">${icon('home-assistant')}<span class="sr-only">${this.data ? 'Connected to Home Assistant' : 'Connecting to Home Assistant'}</span></span><button class="send" type="submit" aria-label="Send message" title="Send message" ${this.busy || !this.draft.trim() || !this.data ? 'disabled' : ''}>${icon('arrow-up')}</button></div></form><p class="composer-note">You review changes before they happen. Location is specific to this chat.</p>`}</div></div>
      <div class="sr-only" role="status" aria-live="polite">${this.error ? 'Chat needs attention.' : !this.busy && hasMessages ? 'Response ready.' : ''}</div>
      </main></div>`;
    const root = this.shadowRoot;
    bindDeviceControls(root, { values: this.componentValues, submit: componentAction => this.request('send', { componentAction }, false) });
    root.querySelectorAll('[data-tool-details]').forEach(disclosure => disclosure.addEventListener('toggle', () => this.loadToolDetails(disclosure)));
    const menu = root.querySelector('ha-menu-button'); if (menu) { menu.hass = this._hass; menu.narrow = this._narrow; }
    this.updateAccountBadge();
    this.updateModelPicker();
    root.querySelector('[data-ai-settings]').onclick = () => openAiSettings(this);
    root.querySelector('[data-sidebar]').onclick = () => this.setSidebar(!this.sidebar);
    root.querySelectorAll('[data-close]').forEach(button => button.onclick = () => this.setSidebar(false));
    root.querySelectorAll('[data-new]').forEach(button => button.onclick = () => this.request('new'));
    this.bindHistory(root);
    root.querySelector('[data-history-search]').oninput = event => { this.historyQuery = event.target.value; this.updateHistory(); };
    root.querySelectorAll('[data-history-view]').forEach(button => button.onclick = () => {
      this.historyMode = button.dataset.historyView;
      root.querySelectorAll('[data-history-view]').forEach(view => view.setAttribute('aria-pressed', view === button ? 'true' : 'false'));
      this.updateHistory();
    });
    root.querySelector('[data-history-undo]')?.addEventListener('click', () => this.archiveThread(this.historyNotice.undoId, false));
    root.querySelectorAll('[data-location]').forEach(select => select.onchange = () => this.request('location', { location: select.value }));
    root.querySelectorAll('[data-prompt]').forEach(button => button.onclick = () => { this.draft = button.dataset.prompt; this.render(); root.querySelector('textarea').focus({ preventScroll: true }); });
    root.querySelectorAll('[data-approval]').forEach(form => form.onsubmit = event => { event.preventDefault(); const selected = [...new FormData(form).getAll('selected')].map(Number); if (selected.length) this.request('apply', { messageId: form.dataset.approval, selected }); });
    root.querySelectorAll('[data-approval] input').forEach(input => input.onchange = () => { const form = input.closest('form'); this.selections.set(form.dataset.approval, [...new FormData(form).getAll('selected')].map(Number)); const submit = form.querySelector('[type="submit"]'); if (submit) submit.disabled = !form.querySelector('input:checked'); });
    root.querySelectorAll('[data-cancel]').forEach(button => button.onclick = () => this.request('cancel'));
    root.querySelector('[data-recover]')?.addEventListener('click', () => this.request('open'));
    root.querySelector('[data-archive]')?.addEventListener('click', () => this.archiveThread(this.data.thread.id));
    root.querySelector('[data-rename]')?.addEventListener('click', () => this.rename());
    const textarea = root.querySelector('textarea');
    if (textarea) {
      const resize = () => { textarea.style.height = 'auto'; textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px'; };
      textarea.oninput = () => { this.draft = textarea.value; root.querySelector('.send').disabled = this.busy || !this.draft.trim(); resize(); };
      textarea.onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) { event.preventDefault(); this.send(); } };
      root.querySelector('.composer').onsubmit = event => { event.preventDefault(); this.send(); };
      requestAnimationFrame(resize);
    }
    root.onkeydown = event => { if (event.key === 'Escape' && this.sidebar) this.setSidebar(false); };
    requestAnimationFrame(() => { const scroll = this.shadowRoot.querySelector('.scroll-area'); if (scroll) scroll.scrollTop = previousScrollTop; });
  }
  send() {
    if (this.busy || this.data?.thread.archived || !this.draft.trim()) return;
    const pending = [...(this.data?.thread.messages || [])].reverse().find(item => item.form?.status === 'pending');
    this.request('send', { text: this.draft.trim(), model: this.selectedModel(), ...(pending ? { confirmationId: pending.id } : {}), ...(pending && this.selections.has(pending.id) ? { selected: this.selections.get(pending.id) } : {}) });
  }
  bindHistory(root) {
    root.querySelectorAll('[data-thread]').forEach(button => button.onclick = () => this.request('open', { threadId: button.dataset.thread }));
    root.querySelectorAll('[data-row-archive]').forEach(button => button.onclick = () => this.archiveThread(button.dataset.rowArchive));
    root.querySelectorAll('[data-restore]').forEach(button => button.onclick = () => this.archiveThread(button.dataset.restore, false));
  }
  updateHistory() {
    const nav = this.shadowRoot.querySelector('.sidebar nav');
    nav.setAttribute('aria-label', this.historyMode === 'archived' ? 'Archived conversations' : 'Conversations');
    nav.innerHTML = renderHistoryList(this.data, { mode: this.historyMode, query: this.historyQuery, busy: this.busy });
    nav.scrollTop = 0; this.bindHistory(nav);
  }
  async archiveThread(id, archived = true) {
    if (this.busy) return;
    const result = await this.request('archive', { targetThreadId: id, archived }, false);
    if (result && archived) this.setSidebar(true, { focus: false });
    if (result && (this.sidebar || !matchMedia('(pointer: coarse)').matches)) (this.shadowRoot.querySelector('[data-history-undo]') || (this.sidebar ? this.shadowRoot.querySelector('[data-history-view][aria-pressed="true"]') : this.shadowRoot.querySelector('textarea')))?.focus({ preventScroll: true });
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
