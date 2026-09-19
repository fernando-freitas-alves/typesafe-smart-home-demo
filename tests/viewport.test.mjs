import test from 'node:test';
import assert from 'node:assert/strict';
import { chatViewportFrame } from '../custom_components/typesafe_chat/www/chat-viewport.js';

test('chat remains below the HA tabs and meets the visible bottom before and after the keyboard', () => {
  for (const height of [844, 390, 844]) {
    const frame = chatViewportFrame({ height, hostTop: 56 });
    assert.equal(frame.shift, 0);
    assert.equal(56 + frame.height, height);
  }
});

test('keyboard focus panning cannot leave a gap below the composer', () => {
  for (const { height, offsetTop, hostTop } of [
    { height: 390, offsetTop: 260, hostTop: 56 },
    { height: 390, offsetTop: 0, hostTop: -260 },
    { height: 310, offsetTop: 80, hostTop: -120 },
    { height: 390, offsetTop: 36, hostTop: 56 },
    { height: 390, offsetTop: 260, hostTop: 0 },
  ]) {
    const frame = chatViewportFrame({ height, offsetTop, hostTop });
    assert.ok(hostTop + frame.shift >= offsetTop, 'chat starts inside the visible viewport');
    assert.equal(hostTop + frame.shift + frame.height, offsetTop + height, 'chat bottom meets the keyboard edge');
  }
});

test('a view temporarily below the viewport never gets a negative height', () => {
  assert.deepEqual(chatViewportFrame({ height: 300, hostTop: 400 }), { height: 0, shift: 0 });
});
