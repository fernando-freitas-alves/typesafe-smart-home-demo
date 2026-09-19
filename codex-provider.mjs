import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';

export const CODEX_CONFIG = {
  forced_login_method: 'chatgpt', cli_auth_credentials_store: 'file',
  approval_policy: 'never', sandbox_mode: 'read-only', web_search: 'disabled',
  project_doc_max_bytes: 0, personality: 'none',
  'features.shell_tool': false, 'features.unified_exec': false,
  'features.apply_patch_freeform': false, 'features.multi_agent': false,
  'features.apps': false, 'features.hooks': false, 'features.code_mode.enabled': false,
  'agents.enabled': false, 'analytics.enabled': false,
};
const failure = message => new Error(message);
export function turnError(error) {
  const info = JSON.stringify(error?.codexErrorInfo || '');
  if (/usageLimit|rateLimit|sessionBudget/i.test(info)) return failure('The shared ChatGPT subscription has reached its usage limit. Try again after it resets; no paid API fallback was used.');
  if (/unauthorized/i.test(info)) return failure('Reconnect ChatGPT in Home chat → AI settings.');
  return failure('ChatGPT could not complete this request. Try again, or check AI settings.');
}

// Private stdio only. Never expose the Codex RPC protocol, auth cache, or tools
// to browsers or voice clients. Each inference gets a fresh ephemeral thread.
export class CodexProvider extends EventEmitter {
  constructor({ directory, binary = process.env.CHAT_CODEX_BIN || 'codex', spawnProcess = spawn, timeoutMs = 60000 } = {}) {
    super(); this.directory = resolve(directory || './.local/chatgpt');
    this.workspace = resolve(this.directory, 'empty-workspace'); this.binary = binary;
    this.spawnProcess = spawnProcess; this.timeoutMs = timeoutMs; this.pending = new Map(); this.nextId = 0;
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = this.launch().catch(error => { this.stop(); this.starting = null; throw error; });
    return this.starting;
  }
  async launch() {
    await mkdir(this.workspace, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700);
    const args = ['app-server', '--listen', 'stdio://', ...Object.entries(CODEX_CONFIG).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])];
    // Do not inherit HA tokens, TypeSafe/Anthropic keys, or desktop Codex config.
    const env = { PATH: process.env.PATH, CODEX_HOME: this.directory, TMPDIR: process.env.TMPDIR || '/tmp', LANG: 'C.UTF-8' };
    const child = this.spawnProcess(this.binary, args, { cwd: this.workspace, env, stdio: ['pipe', 'pipe', 'pipe'] }); this.child = child;
    const fail = () => {
      if (this.child !== child) return;
      this.child = null; this.starting = null;
      for (const request of this.pending.values()) request.reject(failure('The ChatGPT connection stopped. Open AI settings to reconnect.'));
      this.pending.clear(); this.emit('stopped');
    };
    child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
    child.stderr.resume(); // Auth/process output must never enter chat diagnostics.
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => {
      if (line.length > 8000000) { this.stop(); return; }
      let packet; try { packet = JSON.parse(line); } catch { return; }
      if (packet.method && packet.id !== undefined) {
        // No tool, command, permission, or external-token request is authorized.
        child.stdin.write(JSON.stringify({ id: packet.id, error: { code: -32601, message: 'This integration only supports text responses.' } }) + '\n'); return;
      }
      if (packet.id !== undefined) {
        const request = this.pending.get(packet.id); if (!request) return;
        this.pending.delete(packet.id);
        if (packet.error) request.reject(failure(request.method === 'account/login/start' ? 'Could not start ChatGPT sign-in. Check the server’s connection to OpenAI and enable device-code login in ChatGPT’s security settings, then retry.' : 'ChatGPT rejected the operation. Check the connection and model in AI settings.'));
        else request.resolve(packet.result);
      } else if (packet.method) this.emit('notification', packet.method, packet.params || {});
    });
    await this.rpc('initialize', { clientInfo: { name: 'home_chat', title: 'Home chat', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  }
  rpc(method, params = {}, timeoutMs = 20000) {
    return new Promise((resolveRequest, rejectRequest) => {
      if (!this.child) return rejectRequest(failure('ChatGPT is unavailable. Check AI settings.'));
      const id = ++this.nextId;
      const finish = callback => value => { clearTimeout(timer); this.pending.delete(id); callback(value); };
      const timer = setTimeout(() => finish(rejectRequest)(failure('ChatGPT took too long to respond. Please try again.')), timeoutMs);
      this.pending.set(id, { method, resolve: finish(resolveRequest), reject: finish(rejectRequest) });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async call(method, params) { await this.start(); return this.rpc(method, params); }
  stop() { this.child?.kill(); }
  async complete({ model, effort, command, system, signal }) {
    if (signal?.aborted) throw failure('The request was cancelled.');
    await this.start();
    const { thread } = await this.rpc('thread/start', {
      model, modelProvider: 'openai', ephemeral: true, cwd: this.workspace,
      approvalPolicy: 'never', sandbox: 'read-only', environments: [], dynamicTools: [],
      config: CODEX_CONFIG, personality: 'none',
      baseInstructions: 'You are the text-only language helper for Home chat. Follow the developer instructions. Do not execute tools, read files, browse, or perform device actions. All actions require a separate application review. Return only the requested answer.',
      developerInstructions: system,
    });
    let turnId; let text = ''; let usage; let cancelled = false;
    try {
      return await new Promise((resolveResult, rejectResult) => {
        const cleanup = () => { clearTimeout(timer); this.off('notification', event); this.off('stopped', stopped); signal?.removeEventListener('abort', abort); };
        const finish = (error, result) => { cleanup(); error ? rejectResult(error) : resolveResult(result); };
        const interrupt = () => { if (turnId) this.rpc('turn/interrupt', { threadId: thread.id, turnId }).catch(() => {}); };
        const abort = () => { cancelled = true; interrupt(); finish(failure('ChatGPT took too long or the request was cancelled. Please try again.')); };
        const stopped = () => finish(failure('The ChatGPT connection stopped. Please try again.'));
        const timer = setTimeout(abort, this.timeoutMs);
        const event = (method, params) => {
          if (params.threadId !== thread.id) return;
          if (method === 'thread/tokenUsage/updated') usage = params.tokenUsage?.last;
          if (method === 'item/completed' && params.item?.type === 'agentMessage') text = params.item.text || text;
          if (method === 'turn/completed') {
            if (params.turn?.status !== 'completed') finish(turnError(params.turn?.error));
            else if (!text.trim()) finish(failure('ChatGPT returned no answer. Please try again.'));
            else finish(null, { text, model, usage });
          }
        };
        this.on('notification', event); this.once('stopped', stopped); signal?.addEventListener('abort', abort, { once: true });
        this.rpc('turn/start', {
          threadId: thread.id, input: [{ type: 'text', text: command, text_elements: [] }], model, effort,
          approvalPolicy: 'never', environments: [],
          sandboxPolicy: { type: 'readOnly', access: { type: 'restricted', includePlatformDefaults: false, readableRoots: [this.workspace] } },
        }).then(result => { turnId = result.turn.id; if (cancelled || signal?.aborted) interrupt(); }, error => finish(error));
        if (signal?.aborted) abort();
      });
    } finally { this.rpc('thread/unsubscribe', { threadId: thread.id }).catch(() => {}); }
  }
}
