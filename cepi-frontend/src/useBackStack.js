// Minimal History-API back integration for a no-router PWA.
//
// A module-singleton stack of close-handlers + ONE popstate listener. When a
// sub-view opens, bindBackState pushes a sentinel history entry; the device/
// browser Back button pops the top handler (closing that view) and re-arms while
// still nested. At the root the stack is empty, so Back genuinely leaves the app.
import { watch } from 'vue';

const stack = [];            // [{ id, close }]
let nextId = 1;
let listenerInstalled = false;

function ensureListener() {
  if (listenerInstalled || typeof window === 'undefined') return;
  listenerInstalled = true;
  window.addEventListener('popstate', () => {
    if (!stack.length) return;                 // root → let the browser navigate/exit
    const top = stack.pop();
    try { top.close(); } catch { /* */ }
    if (stack.length) history.pushState({ cepiBack: true }, ''); // re-arm while nested
  });
}

export function pushView(close) {
  if (typeof window === 'undefined') return null;
  if (!stack.length) history.pushState({ cepiBack: true }, ''); // 0→1 sentinel
  const id = nextId++;
  stack.push({ id, close });
  ensureListener();
  return id;
}

export function removeView(id) {
  const i = stack.findIndex(e => e.id === id);
  if (i !== -1) stack.splice(i, 1);
}

// One-liner Vue integration: open(getter→true) pushes, close(getter→false) pops.
export function bindBackState(getter, close, opts) {
  let id = null;
  return watch(getter, (open) => {
    if (open && id == null) id = pushView(close);
    else if (!open && id != null) { removeView(id); id = null; }
  }, opts);
}
