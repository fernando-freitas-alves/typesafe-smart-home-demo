// Shared browser / Node client. Transports provide authentication; never store
// HA tokens in a request payload or retry a physical action automatically.
const writes = new Set(['new', 'send', 'apply', 'cancel', 'location', 'rename', 'archive']);
export function createChatRequest(op, fields = {}, client = { kind: 'web' }) {
  const request = { ...fields, apiVersion: 1, op, client: { ...client } };
  if (writes.has(op) && !request.requestId) request.requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return request;
}
export class ChatClientError extends Error {
  constructor(message, { code = 'transport_error', status } = {}) { super(message); this.code = code; this.status = status; }
}
export function createChatClient({ transport, client = { kind: 'web' } }) {
  if (typeof transport !== 'function') throw new TypeError('Supply an authenticated transport.');
  const prepare = (op, fields) => createChatRequest(op, fields, client);
  const execute = async (request, options = {}) => {
    const result = await transport(request, options);
    if (result.error) throw new ChatClientError(result.error, { code: result.code });
    if (result.apiVersion !== 1) throw new ChatClientError('Unsupported Home chat API version.', { code: 'unsupported_version' });
    return result;
  };
  return { prepare, execute, call: (op, fields, options) => execute(prepare(op, fields), options) };
}
export function createHttpTransport({ baseUrl, token, fetchImpl = globalThis.fetch }) {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new TypeError('Use your HA base URL without credentials or a path.');
  return async (request, { signal } = {}) => {
    const accessToken = typeof token === 'function' ? await token() : token;
    if (typeof accessToken !== 'string' || !accessToken) throw new ChatClientError('An HA access token is required.', { code: 'unauthorized' });
    const response = await fetchImpl(new URL('/api/typesafe_chat', url), { method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    let result;
    try { result = await response.json(); } catch { throw new ChatClientError('Home chat returned an unreadable response. Reopen the conversation before retrying an action.', { status: response.status }); }
    if (!response.ok) throw new ChatClientError(result.error || result.message || 'Home chat request failed.', { code: result.code, status: response.status });
    return result;
  };
}
