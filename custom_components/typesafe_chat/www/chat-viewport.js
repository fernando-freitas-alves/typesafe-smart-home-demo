// A fixed frame must use the host's unscrolled position. Following its moving
// bounding rect during iOS rubber-banding moves the chat along with the page.
export function chatViewportFrame({ height, offsetTop = 0, anchorTop = 0 }) {
  const top = Math.max(anchorTop, offsetTop);
  return {
    top,
    height: Math.max(0, Math.floor(height + offsetTop - top)),
  };
}

export function chatViewportAnchor(host) {
  const rect = host.getBoundingClientRect();
  let top = rect.top;
  let left = rect.left;
  // Include HA's shadow/slot ancestors as well as the document scroller.
  for (let node = host; node; node = node.assignedSlot || node.parentElement || node.getRootNode().host) {
    if (getComputedStyle(node).position === 'fixed') break;
    if (node === document.scrollingElement) {
      top += window.scrollY;
      left += window.scrollX;
    } else if (node !== host) {
      top += node.scrollTop;
      left += node.scrollLeft;
    }
  }
  return { top: Math.max(0, top), left, width: rect.width };
}

// Finger movement has the opposite sign from scrollTop/scrollLeft changes.
export function canScrollInDirection({ position, size, contentSize }, delta) {
  const maximum = contentSize - size;
  return maximum > 1 && (delta > 0 ? position > 1 : delta < 0 && position < maximum - 1);
}

// WebKit can scroll the page with the keyboard open even with overflow hidden.
// Contain one-finger drags locally; preserve native scrolling, pinch zoom, range
// controls and selects. The composer uses controlled scrolling because WebKit
// can pan the visual viewport when a native swipe starts inside a text field.
export function containChatScroll(root) {
  let previous;
  let composer;
  const start = event => {
    previous = event.touches.length === 1 ? event.touches[0] : null;
    const input = event.composedPath().find(node => node.nodeType === 1 && node.matches('textarea#message'));
    composer = previous && input ? {
      input, origin: previous, startedAt: event.timeStamp, dragging: false,
      scroller: input.scrollHeight > input.clientHeight + 1 ? input : root.querySelector?.('.scroll-area') || input,
      editing: input.selectionStart !== input.selectionEnd,
    } : null;
  };
  const end = () => { previous = null; composer = null; };
  const move = event => {
    if (!previous || event.touches.length !== 1 || (window.visualViewport?.scale || 1) > 1) {
      end();
      return;
    }
    const touch = event.touches[0];
    const dx = touch.clientX - previous.clientX;
    const dy = touch.clientY - previous.clientY;
    previous = touch;
    if (!dx && !dy) return;
    if (composer) {
      const { scroller, origin } = composer;
      if (!composer.dragging) {
        const distanceX = touch.clientX - origin.clientX;
        const distanceY = touch.clientY - origin.clientY;
        // Leave taps, long-press selection and horizontal caret gestures native.
        composer.editing ||= event.timeStamp - composer.startedAt >= 450;
        if (composer.editing || Math.max(Math.abs(distanceX), Math.abs(distanceY)) < 6) return;
        if (Math.abs(distanceX) > Math.abs(distanceY)) { composer.editing = true; return; }
        composer.dragging = true;
      }
      if (composer.editing || !event.cancelable) return;
      event.preventDefault();
      // Keep the scroll target for the whole gesture. A short draft lets you
      // swipe through messages; a long draft scrolls within the text field.
      // Never hand either gesture back to WebKit's page/viewport scroller.
      scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop - dy));
      return;
    }
    const horizontal = Math.abs(dx) > Math.abs(dy);
    for (const node of event.composedPath()) {
      if (node === root) break;
      if (node.nodeType !== 1) continue;
      if (node.matches('select, input[type="range"]')) return;
      const style = getComputedStyle(node);
      if (!/^(auto|scroll)$/.test(horizontal ? style.overflowX : style.overflowY)) continue;
      if (canScrollInDirection({
        position: horizontal ? node.scrollLeft : node.scrollTop,
        size: horizontal ? node.clientWidth : node.clientHeight,
        contentSize: horizontal ? node.scrollWidth : node.scrollHeight,
      }, horizontal ? dx : dy)) return;
    }
    if (event.cancelable) event.preventDefault();
  };
  root.addEventListener('touchstart', start, { passive: true });
  root.addEventListener('touchmove', move, { passive: false, capture: true });
  root.addEventListener('touchend', end, { passive: true });
  root.addEventListener('touchcancel', end, { passive: true });
  return () => {
    root.removeEventListener('touchstart', start);
    root.removeEventListener('touchmove', move, { capture: true });
    root.removeEventListener('touchend', end);
    root.removeEventListener('touchcancel', end);
    end();
  };
}
