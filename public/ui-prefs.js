// Per-device interface preferences: reduced motion, feedback sound and a sticky top bar.
// Loaded synchronously in <head> so <html data-motion> is set before first paint.
// Storage can be unavailable (private window, blocked site data); every access is guarded
// and the defaults (full motion, sound on) apply.
(() => {
  const MOTION_KEY = 'defter-motion';
  const SOUND_KEY = 'defter-sound';
  const TOPBAR_KEY = 'defter-topbar';
  const listeners = new Set();
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const systemReduced = () => {
    try { return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
  };

  function getMotion() { return read(MOTION_KEY) === 'reduced' ? 'reduced' : 'full'; }
  function applyMotion(mode) {
    const root = document.documentElement;
    if (mode === 'reduced') root.dataset.motion = 'reduced';
    else delete root.dataset.motion;
  }
  function setMotion(mode) {
    const selected = mode === 'reduced' ? 'reduced' : 'full';
    write(MOTION_KEY, selected);
    applyMotion(selected);
    notify();
    return selected;
  }
  // True when either the app switch or the operating system asks for less motion.
  function motionReduced() { return getMotion() === 'reduced' || systemReduced(); }

  function getSound() { return read(SOUND_KEY) !== 'off'; }
  function setSound(enabled) {
    write(SOUND_KEY, enabled ? 'on' : 'off');
    notify();
    return Boolean(enabled);
  }

  // Sticky top bar (wide screens). Default on; "static" lets the bar scroll away with the page.
  function getTopbarSticky() { return read(TOPBAR_KEY) !== 'static'; }
  function applyTopbar(sticky) {
    const root = document.documentElement;
    if (sticky) delete root.dataset.topbar;
    else root.dataset.topbar = 'static';
  }
  function setTopbarSticky(sticky) {
    write(TOPBAR_KEY, sticky ? 'sticky' : 'static');
    applyTopbar(Boolean(sticky));
    notify();
    return Boolean(sticky);
  }

  function notify() {
    const snapshot = { motion: getMotion(), motionReduced: motionReduced(), sound: getSound(), topbarSticky: getTopbarSticky() };
    for (const listener of listeners) { try { listener(snapshot); } catch {} }
  }
  function onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  applyMotion(getMotion());
  applyTopbar(getTopbarSticky());
  try {
    window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', notify);
  } catch {}
  window.addEventListener('storage', event => {
    if (event.key === MOTION_KEY) applyMotion(getMotion());
    if (event.key === TOPBAR_KEY) applyTopbar(getTopbarSticky());
    if (event.key === MOTION_KEY || event.key === SOUND_KEY || event.key === TOPBAR_KEY) notify();
  });

  window.DefterPrefs = Object.freeze({ getMotion, setMotion, motionReduced, getSound, setSound, getTopbarSticky, setTopbarSticky, onChange });
})();
