import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStore } from '../chat-store.mjs';
import { ChatService } from '../chat-service.mjs';
import { groupThreads, renderHistoryList } from '../custom_components/typesafe_chat/www/chat-history.js';

const thread = (id, extra = {}) => ({ id, title: `Chat ${id}`, messages: [], location: '', receipts: [], waitingCommand: null, updatedAt: '2026-09-01T12:00:00Z', ...extra });
async function setup(t, threads = [thread('current'), thread('other')]) {
  const dir = await mkdtemp(join(tmpdir(), 'chat-history-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ChatStore(dir); const actor = { id: 'owner', name: 'Home owner' };
  await store.save(actor.id, { version: 1, threads, activeThreadId: threads[0].id });
  const home = { pending: new Map(), async snapshot() { return { rooms: [], devices: [] }; }, async apply() { assert.fail('Archiving must never actuate devices'); } };
  const service = new ChatService({ home, store, actor });
  return { store, home, service, actor };
}

test('archive another thread keeps the current chat and gives a restorable preview', async t => {
  const saved = { id: 'message', role: 'assistant', text: 'Light is off.\nNo changes made.', components: [{ type: 'deviceCollection' }] };
  const { service, store, home, actor } = await setup(t, [thread('current'), thread('other', { messages: [saved] })]);
  const result = await service.handle({ op: 'archive', threadId: 'current', targetThreadId: 'other' });
  assert.equal(result.thread.id, 'current'); assert.equal(result.thread.archived, false);
  assert.deepEqual(result.threads.map(item => item.id), ['current']);
  assert.equal(result.archivedThreads[0].preview, 'Light is off. No changes made.');
  assert.ok(result.archivedThreads[0].archivedAt);
  const restarted = new ChatService({ home, store, actor });
  const opened = await restarted.handle({ op: 'open', threadId: 'other' });
  assert.equal(opened.thread.archived, true); assert.deepEqual(opened.thread.messages, [saved]);
  const restored = await restarted.handle({ op: 'archive', threadId: 'other', targetThreadId: 'other', archived: false });
  assert.equal(restored.thread.id, 'other'); assert.equal(restored.thread.archived, false);
  assert.deepEqual(restored.thread.messages, [saved]); assert.equal(restored.archivedThreads.length, 0);
  assert.equal((await store.load(actor.id)).threads.find(item => item.id === 'other').archivedAt, undefined);
});

test('archive cancels approvals and waiting commands; restore never revives them', async t => {
  const approval = { id: 'approval', role: 'assistant', text: 'Review', form: { kind: 'actions', status: 'pending', planId: 'plan', expiresAt: new Date(Date.now() + 120000).toISOString(), actions: [] } };
  const { service, home, store, actor } = await setup(t, [thread('current'), thread('other', { messages: [approval], waitingCommand: 'Turn on lights' })]);
  home.pending.set('plan', {});
  await service.handle({ op: 'archive', threadId: 'current', targetThreadId: 'other' });
  assert.equal(home.pending.has('plan'), false);
  const stored = (await store.load(actor.id)).threads.find(item => item.id === 'other');
  assert.equal(stored.waitingCommand, null); assert.equal(stored.messages[0].form.status, 'cancelled');
  const restored = await service.handle({ op: 'archive', threadId: 'other', archived: false });
  assert.equal(restored.thread.messages[0].form.status, 'cancelled');
  await assert.rejects(service.handle({ op: 'apply', threadId: 'other', messageId: 'approval', selected: [0] }), /no longer active/);
});

test('archived conversations reject writes but their own saved tool details remain readable', async t => {
  const { service, store, actor } = await setup(t);
  const details = { request: { operation: 'inventory' }, response: { count: 3 } };
  const detailsId = await store.saveDetails(actor.id, details);
  const data = await store.load(actor.id); data.threads[1].messages.push({ id: 'm', role: 'assistant', text: 'Three devices', tools: [{ detailsId }] }); await store.save(actor.id, data);
  await service.handle({ op: 'archive', threadId: 'other' });
  for (const op of ['send', 'apply', 'cancel', 'location', 'rename']) await assert.rejects(service.handle({ op, threadId: 'other', text: 'yes', componentAction: {} }), /Restore this archived chat/);
  assert.deepEqual(await service.handle({ op: 'open', threadId: 'other', toolDetailsId: detailsId }), { details });
  await assert.rejects(service.handle({ op: 'open', threadId: 'current', toolDetailsId: detailsId }), /do not belong/);
  await assert.rejects(service.handle({ op: 'archive', threadId: 'current', targetThreadId: 'foreign', archived: false }), /not available/);
  await assert.rejects(service.handle({ op: 'archive', threadId: 'current', archived: 'false' }), /Choose whether/);
  const foreign = new ChatService({ home: service.home, store, actor: { id: 'another-account' } });
  await assert.rejects(foreign.handle({ op: 'open', threadId: 'other' }), /not available/);
  await assert.rejects(foreign.handle({ op: 'archive', targetThreadId: 'other', archived: false }), /not available/);
});

test('archiving the last chat creates one usable replacement, including repeated requests', async t => {
  const { service } = await setup(t, [thread('only')]);
  const archived = await service.handle({ op: 'archive', threadId: 'only', requestId: 'request-1' });
  assert.notEqual(archived.thread.id, 'only'); assert.equal(archived.threads.length, 1);
  assert.equal(archived.archivedThreads.length, 1); assert.equal(archived.thread.archived, false);
  const repeated = await service.handle({ op: 'archive', threadId: 'only', requestId: 'request-1' });
  assert.equal(repeated.thread.id, archived.thread.id); assert.equal(repeated.threads.length, 1);
  assert.equal(repeated.archivedThreads[0].archivedAt, archived.archivedThreads[0].archivedAt);
  const restored = await service.handle({ op: 'archive', threadId: archived.thread.id, targetThreadId: 'only', archived: false });
  assert.equal(restored.thread.id, archived.thread.id); assert.equal(restored.threads.length, 2);
});

test('reading history preserves recency and restoring respects the 100 active chat limit', async t => {
  const { service, store, actor } = await setup(t, Array.from({ length: 100 }, (_, i) => thread(`chat-${i}`)).concat(thread('archived', { archived: true })));
  await service.handle({ op: 'open', threadId: 'chat-30' });
  await service.handle({ op: 'bootstrap' });
  assert.equal((await store.load(actor.id)).threads.find(item => item.id === 'chat-30').updatedAt, '2026-09-01T12:00:00Z');
  await assert.rejects(service.handle({ op: 'archive', threadId: 'chat-30', targetThreadId: 'archived', archived: false }), /100 chats/);
  await service.handle({ op: 'archive', threadId: 'chat-30', targetThreadId: 'chat-99' });
  const restored = await service.handle({ op: 'archive', threadId: 'chat-30', targetThreadId: 'archived', archived: false });
  assert.equal(restored.threads.length, 100); assert.equal(restored.archivedThreads.length, 1);
});

test('history groups by local dates, sorts by activity or archive time, and searches previews', () => {
  const now = new Date(2026, 8, 18, 12);
  const threads = [thread('old'), thread('week', { updatedAt: new Date(2026, 8, 14, 10).toISOString() }), thread('today', { updatedAt: new Date(2026, 8, 18, 9).toISOString(), title: 'Café lights', preview: 'Brightness 36%' }), thread('yesterday', { updatedAt: new Date(2026, 8, 17, 10).toISOString() })];
  assert.deepEqual(groupThreads(threads, { now }).map(g => [g.label, g.items[0].id]), [['Today', 'today'], ['Yesterday', 'yesterday'], ['Previous 7 days', 'week'], ['Older', 'old']]);
  assert.equal(groupThreads(threads, { now, query: 'cafe' })[0].items[0].id, 'today');
  assert.equal(groupThreads(threads, { now, query: '36%' })[0].items[0].id, 'today');
  assert.deepEqual(groupThreads(threads, { now, query: 'missing' }), []);
  assert.equal(groupThreads([thread('old', { archivedAt: now.toISOString() })], { now, mode: 'archived' })[0].label, 'Today');
  assert.equal(threads[0].id, 'old', 'rendering does not reorder source data');
});

test('history renders separate accessible row actions, escapes content, and handles empty views', () => {
  const item = thread('a', { title: '<script> "Title"', preview: '<img onerror="alert(1)">' });
  const data = { thread: item, threads: [item], archivedThreads: [item] };
  const html = renderHistoryList(data);
  assert.match(html, /aria-current="page"/); assert.match(html, /data-row-archive="a"/);
  assert.match(html, /aria-label="Archive &lt;script&gt; &quot;Title&quot;"/);
  assert.match(html, /&lt;img onerror=/); assert.doesNotMatch(html, /<script>|<img /);
  assert.equal((html.match(/<button /g) || []).length, 2); assert.match(html, /<\/button>\s*<button class="thread-action"/);
  const archived = renderHistoryList(data, { mode: 'archived', busy: true });
  assert.match(archived, /data-restore="a"/); assert.doesNotMatch(archived, /data-row-archive/); assert.equal((archived.match(/ disabled/g) || []).length, 2);
  assert.match(renderHistoryList({ threads: [], archivedThreads: [] }, { mode: 'archived' }), /No archived chats/);
  assert.match(renderHistoryList(data, { query: 'no match' }), /No matching chats/);
});
