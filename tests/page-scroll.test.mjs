import test from 'node:test';
import assert from 'node:assert/strict';
import { lockChatPageScroll } from '../custom_components/typesafe_chat/www/chat-page-scroll.js';

function page() {
  const style = () => {
    const values = new Map();
    return {
      getPropertyValue: key => values.get(key)?.value || '',
      getPropertyPriority: key => values.get(key)?.priority || '',
      setProperty: (key, value, priority = '') => values.set(key, { value, priority }),
      removeProperty: key => values.delete(key),
    };
  };
  const restored = [];
  return { body: { style: style() }, documentElement: { style: style() }, defaultView: { scrollX: 0, scrollY: 64, scrollTo: position => restored.push(position) }, restored };
}

test('chat prevents outer page scrolling before a gesture and restores HA on exit', () => {
  const doc = page();
  doc.body.style.setProperty('width', '98%', 'important');
  doc.documentElement.style.setProperty('overflow-x', 'clip');
  const release = lockChatPageScroll(doc);
  assert.equal(doc.body.style.getPropertyValue('position'), 'fixed');
  assert.equal(doc.body.style.getPropertyValue('top'), '0px');
  assert.equal(doc.documentElement.style.getPropertyValue('overflow-y'), 'hidden');
  assert.equal(doc.documentElement.style.getPropertyValue('overscroll-behavior-y'), 'none');
  release();
  assert.equal(doc.body.style.getPropertyValue('position'), '');
  assert.equal(doc.body.style.getPropertyValue('width'), '98%');
  assert.equal(doc.body.style.getPropertyPriority('width'), 'important');
  assert.equal(doc.documentElement.style.getPropertyValue('overflow-x'), 'clip');
  assert.equal(doc.documentElement.style.getPropertyValue('overflow-y'), '');
  assert.deepEqual(doc.restored, [{ left: 0, top: 64, behavior: 'instant' }]);
  release();
  assert.equal(doc.restored.length, 1, 'cleanup is safe to call twice');
});

test('remounts and multiple cards cannot prematurely unlock HA or leave it locked', () => {
  const doc = page();
  const first = lockChatPageScroll(doc);
  const second = lockChatPageScroll(doc);
  first();
  assert.equal(doc.body.style.getPropertyValue('position'), 'fixed');
  assert.equal(doc.restored.length, 0);
  second();
  assert.equal(doc.body.style.getPropertyValue('position'), '');
  const again = lockChatPageScroll(doc);
  assert.equal(doc.body.style.getPropertyValue('position'), 'fixed');
  again();
  assert.equal(doc.body.style.getPropertyValue('position'), '');
  assert.equal(doc.restored.length, 2);
});

test('leaving chat preserves subsequent style changes by other HA components', () => {
  const doc = page();
  const release = lockChatPageScroll(doc);
  doc.body.style.setProperty('width', '95%');
  doc.documentElement.style.setProperty('overflow-y', 'hidden', 'important');
  release();
  assert.equal(doc.body.style.getPropertyValue('width'), '95%');
  assert.equal(doc.documentElement.style.getPropertyPriority('overflow-y'), 'important');
  assert.equal(doc.body.style.getPropertyValue('position'), '');
});
