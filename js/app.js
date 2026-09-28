/* Screen switching, the two-finger parent gate, and boot. */

window.FWApp = (function () {
  const APP_VERSION = '14'; // shown on screen so a stale copy can be spotted; bump ?v= in index.html and V in sw.js too
  const GATE_HOLD_MS = 2000;     // two fingers, held still this long, opens the parent area
  const GATE_MAX_MOVE_PX = 30;

  // Two worlds: the parent area (home) and his screen. The end screen only appears
  // when a session has a limit.
  const screenIds = { session: 'screen-session', end: 'screen-end', parent: 'screen-parent' };

  function show(name) {
    Object.entries(screenIds).forEach(([key, id]) => {
      document.getElementById(id).hidden = key !== name;
    });
    document.body.dataset.screen = name;
  }

  /* ---------- the two-finger long-press gate ----------
     Exactly two fingers, held ~2 s without moving, with no third finger:
     deliberate for an adult, out of reach for a one-year-old (multi-finger
     gestures are beyond even two-year-olds in the motor-skills research).
     A palm mash makes 3+ contacts and cancels it. */

  const gatePointers = new Map();
  let gateTimer = null;

  function cancelGate() {
    if (gateTimer) { clearTimeout(gateTimer); gateTimer = null; }
  }

  function maybeArmGate() {
    cancelGate();
    if (gatePointers.size !== 2) return;
    if (document.body.dataset.screen === 'parent') return;
    gateTimer = setTimeout(() => {
      gateTimer = null;
      if (gatePointers.size === 2 && document.body.dataset.screen !== 'parent') {
        FWParent.open();
      }
    }, GATE_HOLD_MS);
  }

  document.addEventListener('pointerdown', e => {
    gatePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    maybeArmGate(); // a third finger lands here too: size becomes 3, gate disarms
  }, true);

  document.addEventListener('pointermove', e => {
    const p = gatePointers.get(e.pointerId);
    if (!p) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > GATE_MAX_MOVE_PX) {
      gatePointers.delete(e.pointerId); // a moving finger is not a hold
      cancelGate();
    }
  }, true);

  ['pointerup', 'pointercancel'].forEach(type => {
    document.addEventListener(type, e => {
      gatePointers.delete(e.pointerId);
      cancelGate();
    }, true);
  });

  /* ---------- boot ---------- */

  async function boot() {
    document.getElementById('btn-end-home').addEventListener('click', () => FWParent.open());

    document.querySelectorAll('.app-version').forEach(e => { e.textContent = 'version ' + APP_VERSION; });

    if ('serviceWorker' in navigator) {
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register('sw.js')
        .then(reg => reg.update().catch(() => {}))
        .catch(() => { /* http on LAN: fine, just no offline */ });
      // A newer version took over: load it now rather than on the open after next.
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded || !hadController) return;
        reloaded = true;
        if (document.body.dataset.screen !== 'session') location.reload();
      });
    }

    const latest = document.getElementById('btn-latest');
    if (latest) latest.addEventListener('click', async () => {
      latest.disabled = true;
      latest.textContent = 'Fetching…';
      try {
        if ('serviceWorker' in navigator) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
        if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
      } catch (e) { /* storage of words is untouched either way */ }
      location.replace(location.pathname + '?v=' + Date.now());
    });

    const words = await FWDB.allWords();
    FWParent.open(words.length === 0 ? 'welcome' : undefined);
  }

  document.addEventListener('DOMContentLoaded', boot);

  return { show };
})();
