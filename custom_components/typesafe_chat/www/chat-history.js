const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<ha-icon icon="mdi:${name}" aria-hidden="true"></ha-icon>`;
const searchable = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

export function groupThreads(threads, { mode = 'chats', query = '', now = new Date() } = {}) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(today); week.setDate(week.getDate() - 7);
  const groups = new Map(['Today', 'Yesterday', 'Previous 7 days', 'Older'].map(label => [label, []]));
  const needle = searchable(query.trim());
  const date = thread => Date.parse((mode === 'archived' && thread.archivedAt) || thread.updatedAt) || 0;
  for (const thread of threads.filter(item => searchable(`${item.title} ${item.preview || ''}`).includes(needle)).sort((a, b) => date(b) - date(a))) {
    const time = date(thread);
    const label = time >= today ? 'Today' : time >= yesterday ? 'Yesterday' : time >= week ? 'Previous 7 days' : 'Older';
    groups.get(label).push(thread);
  }
  return [...groups].filter(([, items]) => items.length).map(([label, items]) => ({ label, items }));
}

export function renderHistoryList(data, { mode = 'chats', query = '', busy = false, now } = {}) {
  const archived = mode === 'archived';
  const groups = groupThreads((archived ? data?.archivedThreads : data?.threads) || [], { mode, query, now });
  if (!groups.length) return `<div class="history-empty">${icon(query.trim() ? 'magnify' : archived ? 'archive-outline' : 'chat-outline')}<strong>${query.trim() ? 'No matching chats' : archived ? 'No archived chats' : 'Your chats will appear here'}</strong><p>${query.trim() ? 'Try another title or message.' : archived ? 'Chats you archive stay saved here.' : 'Start a conversation with your home.'}</p></div>`;
  return groups.map(({ label, items }) => `<section class="history-group"><h3>${label}</h3>${items.map(thread => `<div class="thread-row ${thread.id === data?.thread.id ? 'active' : ''}">
    <button class="thread-open" data-thread="${escape(thread.id)}" title="${escape(thread.title)}" ${thread.id === data?.thread.id ? 'aria-current="page"' : ''} ${busy ? 'disabled' : ''}>${icon(archived ? 'archive-outline' : 'chat-outline')}<span class="thread-copy"><span class="thread-title">${escape(thread.title)}</span><span class="thread-preview">${escape(thread.preview || 'Start a conversation with your home.')}</span></span></button>
    <button class="thread-action" ${archived ? 'data-restore' : 'data-row-archive'}="${escape(thread.id)}" aria-label="${archived ? 'Restore' : 'Archive'} ${escape(thread.title)}" title="${archived ? 'Restore' : 'Archive'} chat" ${busy ? 'disabled' : ''}>${icon(archived ? 'archive-arrow-up-outline' : 'archive-outline')}</button>
  </div>`).join('')}</section>`).join('');
}
