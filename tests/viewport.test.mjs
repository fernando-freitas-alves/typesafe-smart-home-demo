import test from 'node:test';
import assert from 'node:assert/strict';
import { chatViewportFrame, chatViewportAnchor, canScrollInDirection, containChatScroll } from '../custom_components/typesafe_chat/www/chat-viewport.js';

function browserGlobals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
}

test('chat remains below the HA tabs and meets the visible bottom before and after the keyboard', () => {
  for (const height of [844, 390, 844]) {
    const frame = chatViewportFrame({ height, anchorTop: 56 });
    assert.equal(frame.top, 56);
    assert.equal(frame.top + frame.height, height);
  }
});

test('keyboard focus panning cannot leave a gap below the composer', () => {
  for (const { height, offsetTop, anchorTop } of [
    { height: 390, offsetTop: 260, anchorTop: 56 },
    { height: 390, offsetTop: 0, anchorTop: 56 },
    { height: 310, offsetTop: 80, anchorTop: 56 },
    { height: 390, offsetTop: 36, anchorTop: 56 },
    { height: 390, offsetTop: 260, anchorTop: 0 },
  ]) {
    const frame = chatViewportFrame({ height, offsetTop, anchorTop });
    assert.ok(frame.top >= offsetTop, 'chat starts inside the visible viewport');
    assert.equal(frame.top + frame.height, offsetTop + height, 'chat bottom meets the keyboard edge');
  }
});

test('a view temporarily below the viewport never gets a negative height', () => {
  assert.deepEqual(chatViewportFrame({ height: 300, anchorTop: 400 }), { height: 0, top: 400 });
});

test('page scroll and iOS rubber-banding cannot move or collapse the chat frame', t => {
  const page = { scrollTop: 0, scrollLeft: 0, getRootNode: () => ({}) };
  const parent = { parentElement: page, scrollTop: 0, scrollLeft: 0 };
  const slot = { parentElement: parent, scrollTop: 0, scrollLeft: 0 };
  let hostTop = 56;
  const host = { assignedSlot: slot, getBoundingClientRect: () => ({ top: hostTop, left: 0, width: 390 }) };
  browserGlobals(t, {
    getComputedStyle: () => ({ position: 'static' }),
    document: { scrollingElement: page },
    window: { scrollX: 0, scrollY: 0 },
  });
  for (const { pageScroll, parentScroll } of [
    { pageScroll: 0, parentScroll: 0 },
    { pageScroll: 260, parentScroll: 0 },
    { pageScroll: -340, parentScroll: 0 },
    { pageScroll: 120, parentScroll: 90 },
    { pageScroll: 0, parentScroll: 0 },
  ]) {
    window.scrollY = pageScroll;
    parent.scrollTop = parentScroll;
    hostTop = 56 - pageScroll - parentScroll;
    const anchor = chatViewportAnchor(host);
    assert.equal(anchor.top, 56, 'anchor stays below HA tabs even when the document bounces');
    assert.deepEqual(chatViewportFrame({ height: 390, anchorTop: anchor.top }), { top: 56, height: 334 });
  }
});

test('scroll boundaries allow reading history and long drafts but stop page chaining', () => {
  const area = { size: 200, contentSize: 800 };
  assert.equal(canScrollInDirection({ ...area, position: 0 }, -20), true);
  assert.equal(canScrollInDirection({ ...area, position: 0 }, 20), false);
  assert.equal(canScrollInDirection({ ...area, position: 300 }, 20), true);
  assert.equal(canScrollInDirection({ ...area, position: 300 }, -20), true);
  assert.equal(canScrollInDirection({ ...area, position: 600 }, -20), false);
  assert.equal(canScrollInDirection({ ...area, position: 600 }, 20), true);
  assert.equal(canScrollInDirection({ ...area, position: -30 }, 20), false);
  assert.equal(canScrollInDirection({ ...area, position: 630 }, -20), false);
  assert.equal(canScrollInDirection({ size: 200, contentSize: 200, position: 0 }, -20), false);
});

test('touch containment preserves nested scrolling and pinch zoom, and cleans up on exit', t => {
  browserGlobals(t, { getComputedStyle: node => node.style, window: { visualViewport: { scale: 1 } } });
  const root = new EventTarget();
  const dispose = containChatScroll(root);
  const area = { nodeType: 1, matches: () => false, style: { overflowY: 'auto', overflowX: 'auto' }, scrollTop: 0, scrollLeft: 0, clientHeight: 200, scrollHeight: 800, clientWidth: 100, scrollWidth: 100 };
  const dispatch = (type, y, path = [area, root], touches = [{ clientX: 20, clientY: y }]) => {
    const event = new Event(type, { cancelable: true });
    event.touches = touches;
    event.composedPath = () => path;
    root.dispatchEvent(event);
    return event.defaultPrevented;
  };
  dispatch('touchstart', 100);
  assert.equal(dispatch('touchmove', 140), true, 'top-edge pull must not move the page');
  assert.equal(dispatch('touchmove', 100), false, 'history still scrolls toward older/later messages');
  area.scrollTop = 600;
  assert.equal(dispatch('touchmove', 60), true, 'bottom-edge push must not move the page');
  assert.equal(dispatch('touchmove', 80, [root]), true, 'dragging the composer frame cannot pan the page');
  const select = { ...area, matches: () => true };
  assert.equal(dispatch('touchmove', 90, [select, root]), false, 'native controls still work');
  assert.equal(dispatch('touchmove', 100, [area, root], [{ clientX: 0, clientY: 0 }, { clientX: 20, clientY: 100 }]), false);
  window.visualViewport.scale = 2;
  dispatch('touchstart', 100);
  assert.equal(dispatch('touchmove', 140), false, 'zoomed pages can be panned for accessibility');
  window.visualViewport.scale = 1;
  dispose();
  dispatch('touchstart', 100);
  assert.equal(dispatch('touchmove', 140, [root]), false, 'leaving the chat removes its scroll handlers');
});
