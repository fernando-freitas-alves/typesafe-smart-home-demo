// HA's document is not a chat scroll container. Lock it before a gesture can
// start, instead of repositioning the chat after Safari has already moved it.
// Restore HA's styles on exit, including when more than one card is mounted.
const locks = new WeakMap();

export function lockChatPageScroll(doc) {
  let lock = locks.get(doc);
  if (!lock) {
    const win = doc.defaultView;
    const { scrollX, scrollY } = win;
    const saved = [];
    const apply = (element, properties) => {
      for (const [property, value] of Object.entries(properties)) {
        const style = element.style;
        const previous = style.getPropertyValue(property);
        const priority = style.getPropertyPriority(property);
        style.setProperty(property, value);
        saved.push({ style, property, previous, priority, applied: style.getPropertyValue(property) });
      }
    };
    apply(doc.documentElement, { 'overflow-x': 'hidden', 'overflow-y': 'hidden', 'overscroll-behavior-x': 'none', 'overscroll-behavior-y': 'none' });
    apply(doc.body, { position: 'fixed', top: '0px', left: '0px', width: '100%', height: '100%', 'overflow-x': 'hidden', 'overflow-y': 'hidden' });
    lock = { count: 0, restore: () => {
      for (const { style, property, previous, priority, applied } of saved.reverse()) {
        // Do not overwrite a setting another HA component changed in the meantime.
        if (style.getPropertyValue(property) !== applied || style.getPropertyPriority(property)) continue;
        if (previous) style.setProperty(property, previous, priority);
        else style.removeProperty(property);
      }
      win.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
    } };
    locks.set(doc, lock);
  }
  lock.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--lock.count) return;
    lock.restore();
    locks.delete(doc);
  };
}
