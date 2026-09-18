import { HomeAssistantClient } from './ha-client.mjs';

// The HA integration supplies registry metadata and an authenticated, short-lived
// user token. There is deliberately no fallback to an administrator's HA_TOKEN.
export class BridgeHomeClient extends HomeAssistantClient {
  constructor({ haUrl, fetchImpl } = {}) {
    super({ settings: () => ({ haUrl, haToken: this.token }), ...(fetchImpl ? { fetchImpl } : {}) });
    this.raw = null;
  }
  begin({ inventory, accessToken }) {
    this.raw = inventory; this.token = accessToken; this.firstRead = true;
    this.readable = new Set(inventory.states.map(state => state.entity_id));
    this.controllable = new Set(inventory.controlEntities);
  }
  end() { this.token = null; this.raw = null; this.readable = null; this.controllable = null; }
  async inventory(signal) {
    if (!this.raw || !this.token) throw new Error('Reconnect to Home Assistant to continue.');
    if (this.firstRead) { this.firstRead = false; return this.raw; }
    const states = await this.request('states', { signal });
    return { ...this.raw, states: states.filter(state => this.readable.has(state.entity_id)) };
  }
  callService(domain, service, data, signal) {
    if (!this.controllable?.has(data.entity_id)) throw new Error('Your Home Assistant account cannot control this device.');
    return super.callService(domain, service, data, signal);
  }
}
