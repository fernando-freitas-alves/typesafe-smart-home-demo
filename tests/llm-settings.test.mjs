import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmSettings, chooseFastModel, lightestEffort } from '../llm-settings.mjs';
import { CodexProvider, turnError } from '../codex-provider.mjs';
import { createChatBridge } from '../ha-chat-server.mjs';
const models = [
  { model: 'gpt-5.6-sol', displayName: 'Sol', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'low' }] },
  { model: 'gpt-5.6-luna', displayName: 'Luna', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'low' }] },
];
class FakeProvider extends EventEmitter {
  calls = []; generations = []; account = { type: 'chatgpt', email: 'owner@example.com', planType: 'plus', accessToken: 'must-not-leak' };
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: this.account };
    if (method === 'model/list') return { data: models, nextCursor: null };
    if (method === 'account/login/start') return { type: 'chatgptDeviceCode', loginId: 'login-id-secret', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234', accessToken: 'must-not-leak' };
    if (method === 'account/logout') this.account = null;
    return {};
  }
  async complete(input) { this.generations.push(input); return { model: input.model, text: 'Hello', usage: { inputTokens: 3 } }; }
}
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'home-chat-llm-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = new FakeProvider(); return { directory, provider, llm: new LlmSettings({ directory, provider }) };
}
test('automatic model prefers the fast model and lightest supported effort', () => {
  assert.equal(chooseFastModel(models).model, 'gpt-5.6-luna'); assert.equal(lightestEffort(models[1]), 'low');
  assert.equal(chooseFastModel([models[0]]).model, 'gpt-5.6-sol'); assert.equal(chooseFastModel([]), undefined);
});
test('shared model persists privately and applies to every account', async t => {
  const { llm, directory, provider } = await setup(t);
  await llm.handle({ apiVersion: 1, op: 'model', model: models[0].model }, { id: 'admin', isAdmin: true });
  const reader = new LlmSettings({ directory, provider }); const state = await reader.status(false);
  assert.equal(state.model, models[0].model); assert.equal(state.canManage, false); assert.equal(state.account, undefined); assert.equal(state.models, undefined);
  assert.equal((await stat(llm.path)).mode & 0o777, 0o600); assert.deepEqual(JSON.parse(await readFile(llm.path, 'utf8')), { model: models[0].model });
  await reader.complete('Hello', 'Be brief'); assert.equal(provider.generations[0].model, models[0].model);
});
test('non-admin cannot connect, disconnect, change models, or cancel sign-in', async t => {
  const { llm, provider } = await setup(t);
  for (const op of ['connect', 'cancel', 'disconnect', 'model']) await assert.rejects(llm.handle({ apiVersion: 1, op, ...(op === 'model' ? { model: 'auto' } : {}) }, { id: 'guest' }), error => error.status === 403);
  assert.equal(provider.calls.length, 0);
  await assert.rejects(llm.handle({ apiVersion: 1, op: 'status', isAdmin: true }, { id: 'guest' }), /valid AI/);
});
test('login returns only display data to admins and never tokens or internal login IDs', async t => {
  const { llm, provider } = await setup(t); provider.account = null;
  const owner = await llm.handle({ apiVersion: 1, op: 'connect' }, { id: 'owner', isAdmin: true });
  assert.equal(owner.login.userCode, 'ABCD-1234');
  assert.equal(JSON.stringify(owner).includes('must-not-leak'), false); assert.equal(JSON.stringify(owner).includes('login-id-secret'), false);
  const guest = await llm.status(); assert.equal(guest.login, undefined); assert.equal(guest.account, undefined);
  provider.account = { type: 'chatgpt', planType: 'plus' };
  provider.emit('notification', 'account/login/completed', { loginId: 'login-id-secret', success: true });
  assert.equal((await llm.status(true)).connected, true); assert.equal(llm.login, null);
});
test('only available models are saved and unavailable saved selections fail closed', async t => {
  const { llm, directory, provider } = await setup(t);
  await assert.rejects(llm.handle({ apiVersion: 1, op: 'model', model: 'unknown' }, { isAdmin: true }), /unavailable/);
  await llm.handle({ apiVersion: 1, op: 'model', model: models[0].model }, { isAdmin: true });
  const restored = new LlmSettings({ directory, provider }); restored.catalog = [models[1]]; restored.catalogTime = Date.now();
  await assert.rejects(restored.complete('Hello', 'Be brief'), /no longer available/); assert.equal(provider.generations.length, 0);
});
test('missing or API-key auth never generates or silently falls back', async t => {
  const { llm, provider } = await setup(t);
  for (const account of [null, { type: 'apiKey' }]) { provider.account = account; await assert.rejects(llm.complete('Hello', 'Be brief'), /Connect ChatGPT/); }
  assert.equal(provider.generations.length, 0);
  assert.match(turnError({ codexErrorInfo: 'usageLimitExceeded' }).message, /no paid API fallback/);
});
test('login can be cancelled and disconnect clears the shared connection', async t => {
  const { llm, provider } = await setup(t);
  await llm.handle({ apiVersion: 1, op: 'connect' }, { isAdmin: true });
  await llm.handle({ apiVersion: 1, op: 'cancel' }, { isAdmin: true }); assert.equal(llm.login, null);
  const result = await llm.handle({ apiVersion: 1, op: 'disconnect' }, { isAdmin: true }); assert.equal(result.connected, false);
  assert.ok(provider.calls.some(call => call.method === 'account/login/cancel'));
});
test('private settings bridge enforces authentication and trusted HA admin role', async t => {
  const { llm, directory } = await setup(t); const secret = 'secret-'.repeat(8);
  const server = createChatBridge({ secret, directory, llm }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/llm`;
  const post = (token, actor, input) => fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ actor, input }) });
  assert.equal((await post('wrong', { id: 'x', isAdmin: true }, { apiVersion: 1, op: 'status' })).status, 401);
  const denied = await post(secret, { id: 'guest' }, { apiVersion: 1, op: 'model', model: 'auto' }); assert.equal(denied.status, 403);
  const status = await (await post(secret, { id: 'guest' }, { apiVersion: 1, op: 'status' })).json(); assert.equal(status.connected, true); assert.equal(status.account, undefined);
});
test('Codex uses isolated ephemeral threads, sanitized environment, and no execution environments', async t => {
  const { directory } = await setup(t); const packets = []; let spawnOptions; let spawnArgs; let child;
  const spawnProcess = (_binary, args, options) => {
    spawnArgs = args; spawnOptions = options; child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit('exit', 0);
    const emit = packet => child.stdout.write(JSON.stringify(packet) + '\n');
    child.stdin = new Writable({ write(data, _encoding, done) {
      const packet = JSON.parse(data); packets.push(packet);
      if (packet.id !== undefined && packet.method) {
        let result = {};
        if (packet.method === 'thread/start') result = { thread: { id: `thread-${packet.id}` } };
        if (packet.method === 'turn/start') result = { turn: { id: 'turn-1' } };
        emit({ id: packet.id, result });
        if (packet.method === 'turn/start') queueMicrotask(() => {
          emit({ method: 'item/completed', params: { threadId: packet.params.threadId, item: { type: 'agentMessage', text: 'Answer only' } } });
          emit({ method: 'turn/completed', params: { threadId: packet.params.threadId, turn: { id: 'turn-1', status: 'completed' } } });
        });
      }
      done();
    } }); return child;
  };
  const p = new CodexProvider({ directory, spawnProcess }); t.after(() => p.stop());
  assert.equal((await p.complete({ model: 'gpt-5.6-luna', effort: 'low', command: 'test', system: 'Be brief' })).text, 'Answer only');
  await p.complete({ model: 'gpt-5.6-luna', effort: 'low', command: 'unrelated', system: 'Be brief' });
  assert.equal(spawnOptions.env.ANTHROPIC_API_KEY, undefined); assert.equal(spawnOptions.env.CHAT_BRIDGE_TOKEN, undefined); assert.equal(spawnOptions.env.HA_TOKEN, undefined);
  assert.ok(spawnArgs.includes('permissions.home-chat-text.filesystem={ ":root" = "deny", ":workspace_roots" = { "." = "read" } }'));
  const starts = packets.filter(x => x.method === 'thread/start'); assert.equal(starts.length, 2); assert.ok(starts.every(x => x.params.ephemeral));
  assert.deepEqual(starts[0].params.environments, []); assert.equal(starts[0].params.config['features.shell_tool'], false);
  assert.equal(starts[0].params.permissions, 'home-chat-text'); assert.equal(starts[0].params.sandbox, undefined);
  assert.equal(starts[0].params.config.sandbox_mode, undefined);
  assert.deepEqual(starts[0].params.config['permissions.home-chat-text.filesystem'], { ':root': 'deny', ':workspace_roots': { '.': 'read' } });
  assert.equal(starts[0].params.config['permissions.home-chat-text.network.enabled'], false);
  const turn = packets.find(x => x.method === 'turn/start'); assert.equal(turn.params.permissions, 'home-chat-text'); assert.equal(turn.params.sandboxPolicy, undefined); assert.deepEqual(turn.params.environments, []);
});
test('a turn accepted after the response deadline is still interrupted', async t => {
  const { directory } = await setup(t); const calls = [];
  const provider = new CodexProvider({ directory, timeoutMs: 5 }); provider.start = async () => {};
  provider.rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'late-thread' } };
    if (method === 'turn/start') { await new Promise(resolve => setTimeout(resolve, 25)); return { turn: { id: 'late-turn' } }; }
    return {};
  };
  await assert.rejects(provider.complete({ command: 'Hi', system: 'Answer', model: 'gpt-5.6-luna', effort: 'low' }), /too long/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(calls.some(call => call.method === 'turn/interrupt' && call.params.turnId === 'late-turn'));
  assert.equal(provider.listenerCount('notification'), 0);
});
