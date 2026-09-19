import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexProvider } from './codex-provider.mjs';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function chooseFastModel(models) {
  return models.find(model => /spark/i.test(model.model)) || models.find(model => model.model === 'gpt-5.6-luna') || models.find(model => /mini|nano/i.test(model.model)) || models.find(model => /fast/i.test(model.description)) || models.find(model => model.isDefault) || models[0];
}
export function lightestEffort(model) {
  const supported = model.supportedReasoningEfforts?.map(item => item.reasoningEffort) || [];
  return ['none', 'minimal', 'low', 'medium', 'high'].find(effort => supported.includes(effort)) || model.defaultReasoningEffort || 'low';
}
export class LlmSettings {
  constructor({ directory = process.env.CHAT_DATA_DIR || './.local/chats', provider } = {}) {
    this.directory = resolve(directory); this.path = resolve(this.directory, 'llm-settings.json');
    this.provider = provider || new CodexProvider({ directory: resolve(this.directory, 'chatgpt') });
    this.provider.on('notification', (method, params) => {
      if (method === 'account/login/completed' && params.loginId === this.login?.id) {
        this.login = null; this.loginError = params.success ? null : 'Sign-in did not finish. Try connecting again.'; this.catalog = null;
      }
      if (method === 'account/updated') this.catalog = null;
    });
    this.provider.on('stopped', () => { this.login = null; this.catalog = null; });
    this.queue = Promise.resolve(); this.active = 0;
  }
  async saved() {
    try { return JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { model: 'auto' }; throw error; }
  }
  async models() {
    if (this.catalog && Date.now() - this.catalogTime < 60000) return this.catalog;
    let cursor; const models = [];
    do {
      const page = await this.provider.call('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      models.push(...page.data.filter(model => !model.hidden && (!model.inputModalities || model.inputModalities.includes('text')))); cursor = page.nextCursor;
    } while (cursor && models.length < 500);
    this.catalog = models; this.catalogTime = Date.now(); return models;
  }
  async status(admin = false) {
    const { account } = await this.provider.call('account/read', { refreshToken: false });
    const connected = account?.type === 'chatgpt';
    const saved = await this.saved(); const models = connected ? await this.models() : [];
    const selected = saved.model === 'auto' ? chooseFastModel(models) : models.find(model => model.model === saved.model);
    if (this.login && Date.now() >= this.login.expiresAt) { await this.cancelLogin(); this.loginError = 'The sign-in code expired. Connect again for a new code.'; }
    return { apiVersion: 1, provider: 'chatgpt', connected, canManage: admin, shared: true,
      model: saved.model, resolvedModel: selected?.model || null, modelName: selected?.displayName || null,
      effort: selected ? lightestEffort(selected) : null,
      modelUnavailable: connected && !selected,
      ...(admin ? { account: connected ? { email: account.email, plan: account.planType } : null,
        models: models.map(model => ({ id: model.model, name: model.displayName, description: model.description })),
        login: this.login ? { verificationUrl: this.login.verificationUrl, userCode: this.login.userCode, expiresAt: this.login.expiresAt } : null,
        error: this.loginError || null } : {}),
    };
  }
  async cancelLogin() { if (this.login) { const loginId = this.login.id; this.login = null; await this.provider.call('account/login/cancel', { loginId }); } }
  async handle(input, actor) {
    if (!input || input.apiVersion !== 1 || !['status', 'connect', 'cancel', 'disconnect', 'model'].includes(input.op) || Object.keys(input).some(key => !['apiVersion', 'op', ...(input.op === 'model' ? ['model'] : [])].includes(key))) fail('Use a valid AI settings request.');
    if (input.op !== 'status' && actor.isAdmin !== true) fail('Only a Home Assistant administrator can change the shared AI settings.', 403);
    if (input.op === 'status') return this.status(actor.isAdmin === true);
    const work = async () => {
      if (input.op === 'connect') {
        if (!this.login || Date.now() >= this.login.expiresAt) {
          await this.cancelLogin();
          const result = await this.provider.call('account/login/start', { type: 'chatgptDeviceCode' });
          const url = new URL(result.verificationUrl);
          if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com', 'auth0.openai.com'].includes(url.hostname)) fail('ChatGPT returned an unexpected sign-in address.');
          this.login = { id: result.loginId, verificationUrl: url.href, userCode: result.userCode, expiresAt: Date.now() + 15 * 60000 }; this.loginError = null;
        }
      } else if (input.op === 'cancel') { await this.cancelLogin(); this.loginError = null; }
      else if (input.op === 'disconnect') {
        if (this.active) fail('Wait for the current chat response before disconnecting.', 409);
        await this.cancelLogin(); await this.provider.call('account/logout'); this.catalog = null; this.loginError = null;
      } else if (input.op === 'model') {
        if (typeof input.model !== 'string' || input.model.length > 150) fail('Choose an available model.');
        if (input.model !== 'auto' && !(await this.models()).some(model => model.model === input.model)) fail('That model is unavailable. Refresh the model list.');
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const temp = `${this.path}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify({ model: input.model }), { mode: 0o600 }); await rename(temp, this.path);
      }
      return this.status(true);
    };
    const result = this.queue.then(work, work); this.queue = result.catch(() => {}); return result;
  }
  async complete(command, system, signal) {
    const started = performance.now();
    const state = await this.status();
    if (!state.connected) fail('Connect ChatGPT once in Home chat → AI settings. An HA administrator can share the connection with this home.');
    if (state.modelUnavailable) fail('The selected model is no longer available. Choose Auto or another model in AI settings.');
    this.active++;
    try {
      const result = await this.provider.complete({ model: state.resolvedModel, effort: state.effort, command, system, signal });
      const durationMs = Math.round(performance.now() - started);
      return { ...result, provider: 'ChatGPT subscription', durationMs,
        diagnostics: { provider: 'ChatGPT subscription', durationMs, startedAt: new Date(Date.now() - durationMs).toISOString(),
          note: 'Text response via Codex App Server using the shared ChatGPT subscription. Tokens and authentication messages are never recorded. No device tools are exposed to this model.',
          request: { operation: 'text response', model: result.model, effort: state.effort, system, input: command }, response: { body: { model: result.model, text: result.text }, usage: result.usage } } };
    } finally { this.active--; }
  }
}
let shared;
export const sharedLlm = () => shared ||= new LlmSettings();
