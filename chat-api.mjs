import { createHash } from 'node:crypto';
import { isApproval } from './chat-service.mjs';

export const API_VERSION = 1;
export const CHAT_OPERATIONS = ['bootstrap', 'new', 'open', 'send', 'apply', 'cancel', 'location', 'rename', 'archive'];
const writes = new Set(CHAT_OPERATIONS.filter(op => !['bootstrap', 'open'].includes(op)));
const fields = {
  bootstrap: [], new: ['location', 'model'], open: ['toolDetailsId'],
  send: ['text', 'componentAction', 'selected', 'confirmationId', 'model'],
  apply: ['messageId', 'selected'], cancel: [], location: ['location'],
  rename: ['title'], archive: ['targetThreadId', 'archived'],
};
const common = ['apiVersion', 'op', 'client', 'threadId', 'requestId'];
const recordLimit = 10000;
const retentionMs = 24 * 60 * 60 * 1000;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
const canonical = value => JSON.stringify(value, (_, child) => object(child) ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child);
export class ChatApiError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new ChatApiError(code, message, status); };

export function validateChatRequest(input) {
  if (!object(input) || input.apiVersion !== API_VERSION) fail('unsupported_version', 'Use apiVersion: 1.');
  if (!CHAT_OPERATIONS.includes(input.op)) fail('invalid_request', 'Unknown chat operation.');
  if (Object.keys(input).some(key => ![...common, ...fields[input.op]].includes(key))) fail('invalid_request', 'This operation includes unsupported fields.');
  if (!object(input.client) || !['web', 'voice'].includes(input.client.kind) || Object.keys(input.client).some(key => !['kind', 'deviceId'].includes(key))) fail('invalid_client', 'Choose a web or voice client.');
  if (input.client.kind === 'voice' && !id(input.client.deviceId)) fail('invalid_client', 'Voice requests need a stable deviceId.');
  if (input.client.kind === 'web' && input.client.deviceId !== undefined) fail('invalid_client', 'deviceId is only used for voice clients.');
  if (input.threadId !== undefined && !id(input.threadId)) fail('invalid_request', 'Invalid threadId.');
  if (!['bootstrap', 'new'].includes(input.op) && !input.threadId) fail('thread_required', 'Supply the threadId returned when the conversation was created.');
  if (input.op === 'new' && input.threadId !== undefined) fail('invalid_request', 'A new conversation cannot have an existing threadId.');
  if ((writes.has(input.op) || input.requestId !== undefined) && !id(input.requestId)) fail('request_id_required', 'Mutations need a unique requestId. Reuse it only when recovering the same request.');
  for (const key of ['toolDetailsId', 'messageId', 'targetThreadId', 'confirmationId']) if (input[key] !== undefined && !id(input[key])) fail('invalid_request', `Invalid ${key}.`);
  if (input.location !== undefined && (typeof input.location !== 'string' || input.location.length > 200)) fail('invalid_request', 'location must be an ID returned in rooms.');
  if (input.model !== undefined && (typeof input.model !== 'string' || !input.model || input.model.length > 150)) fail('invalid_request', 'Choose a model ID from the model catalog, auto, or default.');
  if (input.op === 'location' && input.location === undefined) fail('invalid_request', 'Choose a location from rooms.');
  if (input.text !== undefined && typeof input.text !== 'string') fail('invalid_request', 'text must be a string.');
  if (input.op === 'send' && ((input.text !== undefined) === (input.componentAction !== undefined))) fail('invalid_request', 'Supply text or componentAction, but not both.');
  if (input.op === 'send' && input.text !== undefined && (!input.text.trim() || input.text.length > 1500)) fail('invalid_request', 'Write a message between 1 and 1,500 characters.');
  if (input.componentAction !== undefined && (!object(input.componentAction) || Object.keys(input.componentAction).some(key => !['messageId', 'entityId', 'action', 'value'].includes(key)) || !id(input.componentAction.messageId) || !id(input.componentAction.entityId) || !id(input.componentAction.action))) fail('invalid_request', 'Choose an action from a saved device component.');
  if (input.op === 'apply' && (!input.messageId || !Array.isArray(input.selected) || !input.selected.length)) fail('invalid_request', 'Supply the confirmation messageId and selected action indexes.');
  if (input.selected !== undefined && (!Array.isArray(input.selected) || new Set(input.selected).size !== input.selected.length || input.selected.some(value => !Number.isInteger(value) || value < 0))) fail('invalid_request', 'selected must contain distinct nonnegative action indexes.');
  if (input.op === 'rename' && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 80)) fail('invalid_request', 'Use a title between 1 and 80 characters.');
  if (input.archived !== undefined && typeof input.archived !== 'boolean') fail('invalid_request', 'archived must be true or false.');
  return input;
}

export function conversationReply(result, { speak = false } = {}) {
  if (!result.thread) return null;
  const thread = result.thread;
  const latest = [...thread.messages].reverse().find(item => item.role === 'assistant');
  const pending = !thread.archived && [...thread.messages].reverse().find(item => item.form?.kind === 'actions' && item.form.status === 'pending' && Date.parse(item.form.expiresAt) > Date.now());
  let elicitation = null; let speech = latest?.text || ''; let status = latest?.error ? 'error' : 'complete';
  if (thread.archived) { status = 'archived'; speech = ''; }
  else if (pending) {
    status = 'awaiting_confirmation';
    elicitation = { type: 'confirmation', id: pending.id, expiresAt: pending.form.expiresAt,
      actions: pending.form.actions.map((action, index) => ({ index, entityId: action.data.entity_id, name: action.name, location: action.roomName, description: action.label, before: action.before })),
      selected: pending.form.selected || pending.form.actions.map((_, index) => index) };
    speech = `Proposed changes: ${elicitation.actions.map(action => `${action.description}, ${action.name}, ${action.location}`).join('; ')}. Should I apply these changes? Say yes to confirm, no to cancel, or tell me what to change.`;
  } else if (latest?.form?.kind === 'location' && latest.form.status !== 'resolved') {
    status = 'awaiting_location'; elicitation = { type: 'location', options: result.rooms.map(room => ({ id: room.id, name: room.name })) };
    speech = 'Which room or space are you in?';
  } else if (latest?.expectsReply) { status = 'awaiting_reply'; elicitation = { type: 'text' }; }
  return { messageId: latest?.id || null, text: latest?.text || '', speech: speak ? speech : '', status, continueConversation: Boolean(elicitation), elicitation,
    components: latest?.components || [], tools: latest?.tools || [] };
}

// One domain service, one serialized account session, multiple transport clients.
// The bridge owns serialization; request records survive lost responses/restarts.
export class ChatApi {
  constructor(service) { this.service = service; this.store = service.store; }
  envelope(result, input, options = {}) {
    return { ...result, apiVersion: API_VERSION, requestId: input.requestId || null, replayed: Boolean(options.replayed),
      capabilities: { operations: CHAT_OPERATIONS, clients: ['web', 'voice'], componentVersion: 1, requestRetentionHours: 24, requestLimit: recordLimit },
      conversation: result.thread ? { id: result.thread.id, location: result.thread.location, model: result.thread.model, archived: result.thread.archived, source: result.thread.source,
        speaker: result.thread.source?.kind === 'voice' ? { known: false, name: null } : { known: true, name: result.user.name } } : undefined,
      reply: options.replayed ? null : conversationReply(result, { speak: ['send', 'apply', 'cancel', 'location'].includes(input.op) }) };
  }
  checkContext(input, data) {
    const thread = input.threadId && data.threads.find(item => item.id === input.threadId);
    if (input.threadId && !thread) fail('thread_not_found', 'That chat is not available for your Home Assistant account.', 404);
    if (input.client.kind === 'voice' && input.op !== 'bootstrap') {
      for (const targetId of [input.threadId, input.targetThreadId].filter(Boolean)) {
        const target = data.threads.find(item => item.id === targetId);
        if (!target || target.source?.kind !== 'voice' || target.source.deviceId !== input.client.deviceId) fail('conversation_mismatch', 'This voice device must use its own conversation.', 409);
      }
    }
    if (input.op === 'send' && isApproval(input.text)) {
      const pending = this.service.pending(thread);
      if (!input.confirmationId || input.confirmationId !== pending?.id) fail('confirmation_mismatch', 'Confirm the specific pending proposal, or ask for a new preview.', 409);
    }
  }
  async handle(input, signal) {
    validateChatRequest(input);
    if (input.client.kind === 'voice' && input.op === 'bootstrap') {
      const snapshot = await this.service.home.snapshot(signal);
      return this.envelope({ user: { id: this.service.actor.id, name: this.service.actor.name }, rooms: snapshot.rooms, connected: true }, input);
    }
    const actorId = this.service.actor.id;
    let data = await this.store.load(actorId);
    const fingerprint = createHash('sha256').update(canonical({ ...input, requestId: undefined })).digest('hex');
    const prior = (data.requestRecords || []).find(item => item.id === input.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail('request_conflict', 'This requestId was already used for a different request.', 409);
      if (prior.status === 'processing') fail('request_incomplete', 'This request may have completed. Open its conversation and check the result before sending another action.', 409);
      if (prior.status === 'failed') fail(prior.error.code, prior.error.message, prior.error.status);
      const thread = data.threads.find(item => item.id === prior.threadId);
      if (!thread) fail('thread_not_found', 'The saved conversation is unavailable.', 404);
      const result = await this.service.handle({ op: 'open', threadId: thread.id, activate: false }, signal);
      return this.envelope(result, input, { replayed: true });
    }
    this.checkContext(input, data);
    const mutation = writes.has(input.op);
    if (mutation) {
      data.requestRecords = (data.requestRecords || []).filter(item => item.status === 'processing' || Date.now() - Date.parse(item.createdAt) < retentionMs);
      if (data.requestRecords.length >= recordLimit) fail('request_limit', 'This account reached its retained request limit. Try again after older requests expire.', 429);
      data.requestRecords.push({ id: input.requestId, fingerprint, status: 'processing', createdAt: new Date().toISOString(), threadId: input.threadId || null });
      await this.store.save(actorId, data);
    }
    try {
      const result = await this.service.handle({ ...input, activate: input.client.kind !== 'voice' }, signal);
      if (mutation) {
        data = await this.store.load(actorId);
        Object.assign(data.requestRecords.find(item => item.id === input.requestId), { status: 'complete', threadId: result.thread.id });
        await this.store.save(actorId, data);
      }
      return this.envelope(result, input);
    } catch (error) {
      if (mutation) {
        data = await this.store.load(actorId);
        Object.assign(data.requestRecords.find(item => item.id === input.requestId), { status: 'failed', error: { code: error.code || 'operation_failed', message: error.message, status: error.status || 400 } });
        await this.store.save(actorId, data);
      }
      throw error;
    }
  }
}
