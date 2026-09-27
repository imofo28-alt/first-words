/* Screen switching, the two-finger parent gate, and boot. */

window.FWApp = (function () {
  const GATE_HOLD_MS = 2000;     // two fingers, held still this long, opens the parent area
  const GATE_MAX_MOVE_PX = 30;

  const screenIds = { start: 'screen-start', session: 'screen-session', end: 'screen-end', parent: 'screen-parent' };

  function show(name) {
    Object.entries(screenIds).forEach(([key, id]) => {
      document.getElementById(id).hidden = key !== name;
    });
    document.body.dataset.screen = name;
    if (name === 'start') refreshStart();
  }

  async function refreshStart() {
    const { topic, words: ready } = await FWDB.sessionWords();
    const btn = document.getElementById('btn-start');
    const msg = document.getElementById('start-msg');
    const topicLine = document.getElementById('start-topic');
    topicLine.textContent = topic ? 'Topic: ' + topic : '';
    topicLine.hidden = !topic;
    if (ready.length < 2) {
      btn.disabled = true;
      msg.textContent = topic
        ? 'Put at least two words with a photo and your voice in rotation under “' + topic + '”, or choose another topic (hold two fingers on the screen).'
        : 'Add at least two words in the parent area first (hold two fingers on the screen).';
      msg.hidden = false;
    } else {
      btn.disabled = false;
      msg.hidden = true;
    }
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
    document.getElementById('btn-start').addEventListener('click', () => FWSession.begin());

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* http on LAN: fine, just no offline */ });
    }

    const words = await FWDB.allWords();
    if (words.length === 0) {
      FWParent.open('welcome');
    } else {
      show('start');
    }
  }

  document.addEventListener('DOMContentLoaded', boot);

  return { show };
})();
