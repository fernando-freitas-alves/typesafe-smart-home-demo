import { config } from './providers.mjs';

export class HomeAssistantClient {
  constructor({ settings = config, fetchImpl = fetch, WebSocketImpl = WebSocket } = {}) {
    this.settings = settings; this.fetch = fetchImpl; this.WebSocket = WebSocketImpl;
    this.registryCache = null;
  }
  connection() {
    const { haUrl, haToken } = this.settings();
    if (!haUrl || !haToken) throw new Error('Add HA_URL and HA_TOKEN to the local .env file to connect your home.');
    const url = new URL(haUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('HA_URL must be an HTTP or HTTPS address without credentials or query parameters.');
    return { base: haUrl.replace(/\/+$/, ''), token: haToken };
  }
  async request(path, { body, signal } = {}) {
    const { base, token } = this.connection();
    let response;
    try {
      response = await this.fetch(base + '/api/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      });
    } catch { throw new Error(body === undefined ? 'Home Assistant could not be reached. Refresh to reconnect.' : 'Home Assistant did not confirm the request. It may have executed; check the device before trying again.'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error([401, 403].includes(response.status) ? 'Home Assistant rejected the token or its permissions. Check HA_TOKEN.' : `Home Assistant returned HTTP ${response.status}. Refresh the device state before retrying.`);
    }
    return response.json();
  }
  async registry(signal) {
    const { base, token } = this.connection();
    if (this.registryCache?.base === base && this.registryCache?.token === token && Date.now() - this.registryCache.time < 60000) return this.registryCache.value;
    const url = new URL(base + '/api/websocket'); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const value = await new Promise((resolve, reject) => {
      const socket = new this.WebSocket(url);
      const results = {}; let settled = false;
      const types = ['config/area_registry/list', 'config/device_registry/list', 'config/entity_registry/list', 'config/label_registry/list'];
      const finish = (error, data) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        socket.close(); error ? reject(error) : resolve(data);
      };
      const abort = () => finish(new Error('Home discovery was cancelled.'));
      const timer = setTimeout(() => finish(new Error('Home Assistant room discovery timed out. Refresh to retry.')), 15000);
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      socket.addEventListener('error', () => finish(new Error('Home Assistant room discovery failed. Check the connection.')));
      socket.addEventListener('close', () => { if (!settled) finish(new Error('Home Assistant closed the discovery connection.')); });
      socket.addEventListener('message', event => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: token }));
          else if (message.type === 'auth_invalid') finish(new Error('Home Assistant rejected HA_TOKEN.'));
          else if (message.type === 'auth_ok') types.forEach((type, i) => socket.send(JSON.stringify({ id: i + 1, type })));
          else if (message.type === 'result') {
            if (!message.success) return finish(new Error('Home Assistant could not list rooms and devices. Check token permissions.'));
            results[message.id] = message.result;
            if (Object.keys(results).length === types.length) finish(null, { areas: results[1], devices: results[2], entities: results[3], labels: results[4] });
          }
        } catch { finish(new Error('Home Assistant returned invalid discovery data.')); }
      });
    });
    this.registryCache = { base, token, time: Date.now(), value };
    return value;
  }
  async inventory(signal) {
    const [registry, states, settings] = await Promise.all([this.registry(signal), this.request('states', { signal }), this.request('config', { signal })]);
    return { ...registry, states, temperatureUnit: settings.unit_system?.temperature || '°C' };
  }
  callService(domain, service, data, signal) {
    // Physical commands are deliberately never retried automatically.
    return this.request(`services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, { body: data, signal });
  }
}
