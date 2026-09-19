import { HomeChatPanel } from './panel.js?v=1';

// The dashboard uses the same authenticated chat component and API as the panel.
export class HomeChatCard extends HomeChatPanel {
  setConfig() { this.setAttribute('dashboard', ''); }
  getCardSize() { return 12; }
  getGridOptions() { return { columns: 'full' }; }
  connectedCallback() {
    super.connectedCallback();
    this.dashboardResize = new ResizeObserver(this.onResize);
    this.dashboardResize.observe(this);
    this.dashboardFrame = requestAnimationFrame(this.onResize);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.dashboardResize?.disconnect();
    cancelAnimationFrame(this.dashboardFrame);
  }
}

if (!customElements.get('typesafe-chat-card')) customElements.define('typesafe-chat-card', HomeChatCard);
window.customCards ||= [];
if (!window.customCards.some(card => card.type === 'typesafe-chat-card')) window.customCards.push({
  type: 'typesafe-chat-card', name: 'Home chat', description: 'Your authenticated home assistant chat. Use in a Panel view.',
});
