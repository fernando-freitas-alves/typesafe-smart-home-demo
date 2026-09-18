import { randomUUID } from 'node:crypto';
import { contextualizeChat, config } from './providers.mjs';
import { redactDiagnostics } from './trace-utils.mjs';

const approval = /^(?:yes(?: please)?|apply(?: all)?|confirm|go ahead|do it|ok(?:ay)?|sim|pode aplicar|confirmar)[.!\s]*$/i;
const rejection = /^(?:no(?: thanks)?|cancel|never mind|nevermind|discard|stop|não|nao|cancelar)[.!\s]*$/i;
const message = (role, text, extra = {}) => ({ id: randomUUID(), role, text, createdAt: new Date().toISOString(), ...extra });
function newThread() { return { id: randomUUID(), title: 'New chat', location: '', messages: [], updatedAt: new Date().toISOString(), waitingCommand: null, receipts: [] }; }
function stageTool(stage) {
  return { name: stage.kind === 'split' ? 'Split the request' : stage.kind === 'response' ? 'Answer the question' : 'Match devices and actions',
    provider: stage.provider, detail: stage.kind === 'split' ? stage.commands.join('\n') : stage.command || 'Generate an answer from the supplied context.',
    durationMs: stage.durationMs, model: stage.model, usage: stage.usage, status: 'complete',
    ...(stage.diagnostics ? { diagnostics: { ...stage.diagnostics, ...(stage.used ? { usedQuestions: stage.used } : {}) } } : {}) };
}
function contextTool(context, command) {
  return { name: 'Interpret follow-up', provider: 'Anthropic', detail: command, durationMs: context.durationMs, model: context.model, usage: context.usage, diagnostics: context.diagnostics, status: 'complete' };
}
function failedTool(error) {
  return error.diagnostics ? [{ name: 'Provider request', provider: error.diagnostics.provider, detail: error.message, durationMs: error.diagnostics.durationMs, status: 'failed', diagnostics: error.diagnostics }] : [];
}
function summarizeTools(result) {
  return [{ name: 'Read Home Assistant', provider: 'Home Assistant', detail: 'Read current devices and locations.', durationMs: result.inventoryDurationMs, status: 'complete', diagnostics: {
    source: 'Application inventory adapter', note: 'This is the permission-filtered, normalized inventory used by the application, not the raw HA registry response.',
    request: { operation: 'inventory', arguments: {} }, response: { devices: result.devices, rooms: result.rooms, counts: result.counts, updatedAt: result.updatedAt },
  } }, ...result.stages.filter(stage => stage.kind !== 'result').map(stageTool)];
}
export class ChatService {
  constructor({ home, store, actor, resolve = contextualizeChat }) { this.home = home; this.store = store; this.actor = actor; this.resolve = resolve; }
  invalidate(thread, status = 'revised') {
    for (const item of thread.messages) if (item.form?.status === 'pending') { this.home.pending.delete(item.form.planId); item.form.status = status; }
  }
  pending(thread) { return [...thread.messages].reverse().find(item => item.form?.status === 'pending'); }
  async handle(input, signal) {
    const data = await this.store.load(this.actor.id);
    if (!data.threads.length) data.threads.push(newThread());
    let thread = input.threadId ? data.threads.find(item => item.id === input.threadId && !item.archived) : data.threads.find(item => item.id === data.activeThreadId && !item.archived) || data.threads.find(item => !item.archived);
    if (!thread) throw new Error('That chat is not available for your Home Assistant account.');
    if (input.op === 'open' && input.toolDetailsId) {
      const tool = thread.messages.flatMap(item => item.tools || []).find(item => item.detailsId === input.toolDetailsId);
      if (!tool) throw new Error('These tool details do not belong to this chat.');
      return { details: await this.store.loadDetails(this.actor.id, tool.detailsId) };
    }
    if (input.op === 'new') {
      if (data.threads.filter(item => !item.archived).length >= 100) throw new Error('You have 100 chats. Archive a chat before starting another.');
      thread = newThread(); data.threads.unshift(thread);
    }
    const snapshot = await this.home.snapshot(signal);
    if (thread.location && !snapshot.rooms.some(room => room.id === thread.location)) { thread.location = ''; this.invalidate(thread, 'expired'); }
    for (const item of thread.messages) if (item.form?.status === 'pending' && (!this.home.pending.has(item.form.planId) || Date.now() >= Date.parse(item.form.expiresAt))) item.form.status = 'expired';
    for (const item of [...thread.messages]) if (item.form?.status === 'applying') {
      item.form.status = 'unconfirmed';
      thread.messages.push(message('assistant', 'The previous action was interrupted. It may have executed. Check the device state before making a new request.', { error: true }));
    }
    const requestId = input.requestId;
    if (requestId && thread.receipts.includes(requestId)) return this.response(data, thread, snapshot);
    if (input.op === 'send') {
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 1500) throw new Error('Write a message between 1 and 1,500 characters.');
      const text = input.text.trim(); const pending = this.pending(thread);
      const history = thread.messages.slice(-10).map(item => ({ role: item.role, text: item.text, ...(item.form?.actions ? { proposedActions: item.form.actions.map(action => ({ name: action.name, room: action.roomName, action: action.label })) } : {}) }));
      thread.messages.push(message('user', text));
      if (thread.title === 'New chat') thread.title = text.slice(0, 65);
      if (pending && approval.test(text)) await this.apply(data, thread, pending, input.selected, signal);
      else if (pending && rejection.test(text)) { this.invalidate(thread, 'cancelled'); thread.waitingCommand = null; thread.messages.push(message('assistant', 'Cancelled. No changes were sent.')); }
      else if (approval.test(text)) thread.messages.push(message('assistant', 'There is no active change to confirm. Tell me what you would like to do.'));
      else {
        this.invalidate(thread); thread.waitingCommand = null;
        try {
          const resolved = await this.resolve(text, history, signal);
          if (resolved.clarification) thread.messages.push(message('assistant', resolved.clarification, { tools: resolved.diagnostics ? [contextTool(resolved, text)] : [] }));
          else await this.preview(thread, resolved.command, signal, resolved);
        } catch (error) { thread.messages.push(message('assistant', error.message, { error: true, tools: failedTool(error) })); }
      }
    } else if (input.op === 'apply') {
      const pending = this.pending(thread);
      if (!pending || pending.id !== input.messageId) throw new Error('This approval is no longer active. Ask for a new preview.');
      if (!Array.isArray(input.selected) || !input.selected.length || new Set(input.selected).size !== input.selected.length || input.selected.some(i => !Number.isInteger(i) || i < 0 || i >= pending.form.actions.length)) throw new Error('Select at least one action from this form.');
      thread.messages.push(message('user', `Apply ${input.selected.length} selected ${input.selected.length === 1 ? 'action' : 'actions'}.`));
      await this.apply(data, thread, pending, input.selected, signal);
    } else if (input.op === 'cancel') {
      this.invalidate(thread, 'cancelled'); thread.waitingCommand = null;
      thread.messages.push(message('assistant', 'Cancelled. No changes were sent.'));
    } else if (input.op === 'location') {
      const location = snapshot.rooms.find(room => room.id === input.location);
      if (input.location !== '' && !location) throw new Error('Choose a location from this home.');
      this.invalidate(thread); thread.location = input.location;
      if (location) for (const item of thread.messages) if (item.form?.kind === 'location') item.form.status = 'resolved';
      thread.messages.push(message('context', location ? `Location: ${location.name}` : 'Location cleared.'));
      const waiting = thread.waitingCommand; thread.waitingCommand = null;
      if (waiting && location) await this.preview(thread, waiting, signal);
    } else if (input.op === 'rename') {
      if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 80) throw new Error('Use a chat title between 1 and 80 characters.');
      thread.title = input.title.trim();
    } else if (input.op === 'archive') {
      this.invalidate(thread, 'cancelled'); thread.archived = true;
      thread = data.threads.find(item => !item.archived) || newThread();
      if (!data.threads.some(item => item.id === thread.id)) data.threads.unshift(thread);
    } else if (!['bootstrap', 'open', 'new'].includes(input.op)) throw new Error('Unknown chat operation.');
    if (requestId) thread.receipts = [...thread.receipts, requestId].slice(-50);
    data.activeThreadId = thread.id;
    thread.updatedAt = new Date().toISOString();
    // Keep a bounded conversation while leaving previously saved chats intact.
    if (thread.messages.length > 300) thread.messages = thread.messages.slice(-300);
    await this.persistDetails(thread);
    await this.store.save(this.actor.id, data);
    return this.response(data, thread, snapshot);
  }
  async persistDetails(thread) {
    const settings = config();
    for (const item of thread.messages) for (const tool of item.tools || []) if (tool.diagnostics) {
      try { tool.detailsId = await this.store.saveDetails(this.actor.id, redactDiagnostics(tool.diagnostics, [settings.typesafeKey, settings.anthropicKey, settings.haToken, process.env.CHAT_BRIDGE_TOKEN])); }
      catch { tool.detailsNote = 'The request completed, but its technical details could not be saved.'; }
      delete tool.diagnostics;
    }
  }
  response(data, thread, snapshot) {
    return { user: { id: this.actor.id, name: this.actor.name }, rooms: snapshot.rooms,
      threads: data.threads.filter(item => !item.archived).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      thread: { id: thread.id, title: thread.title, location: thread.location, messages: thread.messages }, connected: true };
  }
  async preview(thread, command, signal, context = {}) {
    try {
      const result = await this.home.preview({ command, location: thread.location, context: 'devices' }, signal);
      const tools = summarizeTools(result);
      if (context.durationMs !== undefined) tools.unshift(contextTool(context, command));
      if (result.planId) {
        for (const item of thread.messages) if (item.form?.kind === 'location') item.form.status = 'resolved';
        const rooms = [...new Set(result.actions.map(action => action.roomName))].join(', ');
        thread.messages.push(message('assistant', `Ready to make ${result.actions.length} ${result.actions.length === 1 ? 'change' : 'changes'} in ${rooms}. Review the actions, or tell me what to adjust.`, {
          tools, command, form: { kind: 'actions', planId: result.planId, expiresAt: result.expiresAt, actions: result.actions, status: 'pending' },
        }));
      } else {
        const text = result.stages.filter(stage => ['response', 'result'].includes(stage.kind)).map(stage => stage.text).join('\n\n') || result.outcome;
        thread.messages.push(message('assistant', text, { tools, command }));
      }
    } catch (error) {
      const needsLocation = /Where I am|selected location|location is no longer|select.*room/i.test(error.message);
      if (needsLocation) thread.waitingCommand = command;
      thread.messages.push(message('assistant', needsLocation ? 'Which space are you in? Choose a location below, or name the room in your next message.' : error.message,
        { ...(needsLocation ? { form: { kind: 'location' } } : { error: true }), tools: [...(context.diagnostics ? [contextTool(context, command)] : []), ...(error.stages || []).map(stageTool), ...failedTool(error)] }));
    }
  }
  async apply(data, thread, pending, selected, signal) {
    if (selected !== undefined && (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(i => !Number.isInteger(i) || i < 0 || i >= pending.form.actions.length))) throw new Error('Select at least one action from this form.');
    pending.form.status = 'applying';
    pending.form.selected = selected || pending.form.actions.map((_, index) => index);
    // Persist consumption before physical writes. A lost response or process restart
    // must never make a previously approved action available for replay.
    await this.store.save(this.actor.id, data);
    const resultText = [];
    try {
      const result = await this.home.apply(pending.form.planId, signal, selected);
      pending.form.status = result.error || result.calls.some(call => !call.observed) ? 'unconfirmed' : 'applied';
      resultText.push(result.outcome);
      for (const call of result.calls) {
        const action = pending.form.actions.find(action => action.data.entity_id === call.data.entity_id);
        resultText.push(`${action?.name || call.data.entity_id}: ${call.after}${call.observed ? '' : ' (not confirmed)'}`);
      }
      thread.messages.push(message('assistant', resultText.join('\n'), { tools: [{ name: 'Call Home Assistant', provider: 'Home Assistant', detail: result.calls.map(call => `${call.domain}.${call.service} → ${call.data.entity_id}`).join('\n'), status: result.error ? 'unconfirmed' : 'complete', diagnostics: { note: 'Service requests and returned entity states. Returned attributes are filtered; HTTP acceptance is not device-state confirmation.', request: result.calls.map(call => ({ method: 'POST', path: `/api/services/${call.domain}/${call.service}`, body: call.data })), response: result.calls.map(call => ({ entity_id: call.data.entity_id, status: call.status, body: call.response ?? null, error: call.error ?? null })) } }, { name: 'Check device states', provider: 'Home Assistant', detail: result.outcome, status: result.calls.every(call => call.observed) ? 'complete' : 'unconfirmed', diagnostics: { source: 'Application inventory adapter', request: { operation: 'inventory after service calls', entities: result.calls.map(call => call.data.entity_id) }, response: { outcome: result.outcome, devices: result.devices.filter(device => result.calls.some(call => call.data.entity_id === device.entity_id)), observed: result.calls.map(call => ({ entity_id: call.data.entity_id, observed: call.observed, state: call.after })) } } }], error: Boolean(result.error) }));
    } catch (error) { pending.form.status = 'expired'; thread.messages.push(message('assistant', error.message, { error: true, tools: failedTool(error) })); }
  }
}
