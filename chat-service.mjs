import { randomUUID } from 'node:crypto';
import { contextualizeChat, config } from './providers.mjs';
import { redactDiagnostics } from './trace-utils.mjs';
import { deviceCollection, deviceComponent, resolveComponentAction } from './chat-components.mjs';
import { sharedLlm } from './llm-settings.mjs';

const approval = /^(?:yes(?: please)?|apply(?: all)?|confirm|go ahead|do it|ok(?:ay)?|sim|pode aplicar|confirmar)[.!\s]*$/i;
export const isApproval = text => typeof text === 'string' && approval.test(text);
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
  return { name: 'Interpret follow-up', provider: context.provider || 'Anthropic', detail: command, durationMs: context.durationMs, model: context.model, usage: context.usage, diagnostics: context.diagnostics, status: 'complete' };
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
  constructor({ home, store, actor, resolve = contextualizeChat, llm = sharedLlm() }) { this.home = home; this.store = store; this.actor = actor; this.resolve = resolve; this.llm = llm; }
  invalidate(thread, status = 'revised') {
    for (const item of thread.messages) if (item.form?.status === 'pending') { this.home.pending.delete(item.form.planId); item.form.status = status; }
  }
  pending(thread) { return [...thread.messages].reverse().find(item => item.form?.status === 'pending'); }
  async handle(input, signal) {
    const data = await this.store.load(this.actor.id);
    if (!data.threads.length && input.op !== 'new') data.threads.push(newThread());
    let thread = input.threadId ? data.threads.find(item => item.id === input.threadId) : data.threads.find(item => item.id === data.activeThreadId) || data.threads.find(item => !item.archived) || data.threads[0];
    if (!thread && input.op !== 'new') throw new Error('That chat is not available for your Home Assistant account.');
    if (thread?.archived && !['bootstrap', 'open', 'new', 'archive'].includes(input.op)) throw new Error('Restore this archived chat before continuing it.');
    if (input.op === 'open' && input.toolDetailsId) {
      const tool = thread.messages.flatMap(item => item.tools || []).find(item => item.detailsId === input.toolDetailsId);
      if (!tool) throw new Error('These tool details do not belong to this chat.');
      return { details: await this.store.loadDetails(this.actor.id, tool.detailsId) };
    }
    if (input.op === 'new') {
      if (data.threads.filter(item => !item.archived).length >= 100) throw new Error('You have 100 chats. Archive a chat before starting another.');
      thread = newThread();
      if (input.apiVersion === 1) thread.source = { ...input.client };
      data.threads.unshift(thread);
    }
    if (input.model !== undefined) {
      if (!['new', 'send'].includes(input.op)) throw new Error('Model selection belongs to a new chat or message.');
      // Approvals/cancellations and card controls must still work if ChatGPT is offline.
      if (input.op === 'new' || (typeof input.text === 'string' && !approval.test(input.text.trim()) && !rejection.test(input.text.trim()))) {
        await this.llm.validateModel(input.model);
        thread.model = input.model;
      }
    }
    const snapshot = await this.home.snapshot(signal);
    if (input.op === 'new' && input.location !== undefined) {
      if (input.location && !snapshot.rooms.some(room => room.id === input.location)) throw new Error('Choose a location from this home.');
      thread.location = input.location;
    }
    if (!thread.archived && thread.location && !snapshot.rooms.some(room => room.id === thread.location)) { thread.location = ''; this.invalidate(thread, 'expired'); }
    for (const item of thread.messages) if (item.form?.status === 'pending' && (!this.home.pending.has(item.form.planId) || Date.now() >= Date.parse(item.form.expiresAt))) item.form.status = 'expired';
    for (const item of [...thread.messages]) if (item.form?.status === 'applying') {
      item.form.status = 'unconfirmed';
      thread.messages.push(message('assistant', 'The previous action was interrupted. It may have executed. Check the device state before making a new request.', { error: true }));
    }
    const requestId = input.requestId;
    if (requestId && thread.receipts.includes(requestId)) return this.response(data, thread, snapshot);
    if (input.op === 'send' && input.componentAction) {
      // A card click creates a new preview, never a physical write. Resolve its
      // exact entity and capability again against this account's fresh inventory.
      const action = resolveComponentAction(input.componentAction, thread, snapshot);
      this.invalidate(thread); thread.waitingCommand = null;
      thread.messages.push(message('user', action.text));
      await this.preview(thread, action.text, signal, {}, action.call);
    } else if (input.op === 'send') {
      if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 1500) throw new Error('Write a message between 1 and 1,500 characters.');
      const text = input.text.trim(); const pending = this.pending(thread);
      if (approval.test(text) && input.confirmationId && pending?.id !== input.confirmationId) throw new Error('This approval is no longer active. Ask for a new preview.');
      const history = thread.messages.slice(-10).map(item => ({ role: item.role, text: item.text, ...(item.form?.actions ? { proposedActions: item.form.actions.map(action => ({ name: action.name, room: action.roomName, action: action.label })) } : {}) }));
      thread.messages.push(message('user', text));
      if (thread.title === 'New chat') thread.title = text.slice(0, 65);
      if (pending && approval.test(text)) await this.apply(data, thread, pending, input.selected, signal);
      else if (pending && rejection.test(text)) { this.invalidate(thread, 'cancelled'); thread.waitingCommand = null; thread.messages.push(message('assistant', 'Cancelled. No changes were sent.')); }
      else if (approval.test(text)) thread.messages.push(message('assistant', 'There is no active change to confirm. Tell me what you would like to do.'));
      else {
        this.invalidate(thread); thread.waitingCommand = null;
        try {
          const resolved = await this.resolve(text, history, signal, thread.model || 'default');
          if (resolved.clarification) thread.messages.push(message('assistant', resolved.clarification, { expectsReply: true, tools: resolved.diagnostics ? [contextTool(resolved, text)] : [] }));
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
      if (input.archived !== undefined && typeof input.archived !== 'boolean') throw new Error('Choose whether to archive or restore the chat.');
      const target = input.targetThreadId ? data.threads.find(item => item.id === input.targetThreadId) : thread;
      if (!target) throw new Error('That chat is not available for your Home Assistant account.');
      const archived = input.archived !== false;
      if (!archived && target.archived && data.threads.filter(item => !item.archived).length >= 100) throw new Error('You have 100 chats. Archive a chat before restoring another.');
      if (Boolean(target.archived) !== archived) {
        this.invalidate(target, 'cancelled'); target.waitingCommand = null;
        target.archived = archived;
        if (archived) target.archivedAt = new Date().toISOString();
        else { delete target.archivedAt; target.updatedAt = new Date().toISOString(); }
      }
      if (archived && target.id === thread.id && input.activate !== false) {
        thread = data.threads.find(item => item.id === data.activeThreadId && !item.archived) || data.threads.filter(item => !item.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] || newThread();
        if (!data.threads.some(item => item.id === thread.id)) data.threads.unshift(thread);
      }
    } else if (!['bootstrap', 'open', 'new'].includes(input.op)) throw new Error('Unknown chat operation.');
    if (requestId) thread.receipts = [...thread.receipts, requestId].slice(-50);
    if (input.activate !== false) data.activeThreadId = thread.id;
    if (!['bootstrap', 'open', 'archive'].includes(input.op)) thread.updatedAt = new Date().toISOString();
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
    const summary = item => ({ id: item.id, title: item.title, updatedAt: item.updatedAt, archivedAt: item.archivedAt,
      preview: [...item.messages].reverse().find(message => ['user', 'assistant'].includes(message.role))?.text.replace(/\s+/g, ' ').slice(0, 160) || 'Start a conversation with your home.' });
    return { user: { id: this.actor.id, name: this.actor.name }, rooms: snapshot.rooms,
      threads: data.threads.filter(item => !item.archived).map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      archivedThreads: data.threads.filter(item => item.archived).map(summary).sort((a, b) => (b.archivedAt || b.updatedAt).localeCompare(a.archivedAt || a.updatedAt)),
      thread: { id: thread.id, title: thread.title, location: thread.location, model: thread.model || 'default', messages: thread.messages, archived: Boolean(thread.archived), source: thread.source || { kind: 'web' } }, connected: true };
  }
  async preview(thread, command, signal, context = {}, manual) {
    try {
      const result = await this.home.preview({ command, location: thread.location, model: thread.model || 'default', anonymous: thread.source?.kind === 'voice', context: 'devices', ...(manual ? { manual } : {}) }, signal);
      const tools = summarizeTools(result);
      if (context.durationMs !== undefined) tools.unshift(contextTool(context, command));
      if (result.planId) {
        for (const item of thread.messages) if (item.form?.kind === 'location') item.form.status = 'resolved';
        const rooms = [...new Set(result.actions.map(action => action.roomName))].join(', ');
        thread.messages.push(message('assistant', `Ready to make ${result.actions.length} ${result.actions.length === 1 ? 'change' : 'changes'} in ${rooms}. Review the actions, or tell me what to adjust.`, {
          tools, command, components: deviceCollection(result.queried, { capturedAt: result.updatedAt }),
          form: { kind: 'actions', planId: result.planId, expiresAt: result.expiresAt, actions: result.actions.map(action => ({ ...action, component: deviceComponent(result.devices.find(device => device.entity_id === action.data.entity_id), { controls: false }) })), status: 'pending' },
        }));
      } else {
        const text = result.stages.filter(stage => ['response', 'result'].includes(stage.kind)).map(stage => stage.text).join('\n\n') || result.outcome;
        const components = deviceCollection(result.queried, { capturedAt: result.updatedAt });
        const summary = components.length ? `Here ${result.queried.length === 1 ? 'is the device you asked about' : 'are the devices you asked about'}.` : undefined;
        thread.messages.push(message('assistant', text, { tools, command, components, summary }));
      }
    } catch (error) {
      if (thread.source?.kind === 'voice' && /To use “my office”/.test(error.message)) {
        thread.messages.push(message('assistant', 'Which person’s office do you mean? Please name the room.', { expectsReply: true }));
        return;
      }
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
      thread.messages.push(message('assistant', resultText.join('\n'), { summary: result.outcome, components: deviceCollection(result.devices.filter(device => result.calls.some(call => call.data.entity_id === device.entity_id)), { capturedAt: result.updatedAt, controls: false, calls: result.calls }), tools: [{ name: 'Call Home Assistant', provider: 'Home Assistant', detail: result.calls.map(call => `${call.domain}.${call.service} → ${call.data.entity_id}`).join('\n'), status: result.error ? 'unconfirmed' : 'complete', diagnostics: { note: 'Service requests and returned entity states. Returned attributes are filtered; HTTP acceptance is not device-state confirmation.', request: result.calls.map(call => ({ method: 'POST', path: `/api/services/${call.domain}/${call.service}`, body: call.data })), response: result.calls.map(call => ({ entity_id: call.data.entity_id, status: call.status, body: call.response ?? null, error: call.error ?? null })) } }, { name: 'Check device states', provider: 'Home Assistant', detail: result.outcome, status: result.calls.every(call => call.observed) ? 'complete' : 'unconfirmed', diagnostics: { source: 'Application inventory adapter', request: { operation: 'inventory after service calls', entities: result.calls.map(call => call.data.entity_id) }, response: { outcome: result.outcome, devices: result.devices.filter(device => result.calls.some(call => call.data.entity_id === device.entity_id)), observed: result.calls.map(call => ({ entity_id: call.data.entity_id, observed: call.observed, state: call.after })) } } }], error: Boolean(result.error) }));
    } catch (error) { pending.form.status = 'expired'; thread.messages.push(message('assistant', error.message, { error: true, tools: failedTool(error) })); }
  }
}
