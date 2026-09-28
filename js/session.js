/* The child session. Two ways to move between photos, chosen in the parent area:

   swipe (default) — one photo. He swipes in any direction and the NEXT photo
     follows his finger in from the side he pulls from, so "swiping this way moves
     things this way" is something he can feel. Every direction moves forward
     through the ring (2026-09-28: no "back" direction, at the parent's request).
     A tap on the photo says it again.
   pair — two photos. He taps either one; it grows alone and is named. A swipe in any
     direction brings the next two (2026-09-28, at the parent's request).

   In both: the parent's recorded voice names the photo; touch is dead while the
   word plays; a designed 2 s silence follows (the parent's and child's turn);
   then a cool-down. After N naming moments the session simply ends. */

window.FWSession = (function () {
  const SILENCE_AFTER_WORD_MS = 0;    // no designed pause: he may swipe as soon as the word ends (parent's call 2026-09-28)
  const FOCUS_MOTION_MS = 450;        // pair: photo grows / returns
  const EXTRA_COOLDOWN_MS = 150;      // just enough that a swipe already in progress doesn't count twice
  const TAP_MAX_TRAVEL_PX = 80;       // a toddler tap wobbles; more than this is a drag

  // swipe mode
  const RING_SIZE = 6;                // words per swipe session (the per-topic cap); he loops round them
  const AXIS_LOCK_PX = 18;            // travel before we decide sideways vs up-down
  const COMMIT_FRACTION = 0.15;       // drag this far across the screen and the next photo lands...
  const FLICK_PX_PER_MS = 0.45;       // ...or flick it
  const SETTLE_MS = 260;              // the glide that finishes the move after the finger lifts
  const NEXT_GAP = 0.1;               // during the drag the next photo trails this fraction of a photo behind

  const audioEl = new Audio();
  // A silent clip played inside the parent's tap: after that, later words may play on
  // their own (browsers only allow sound that a tap started).
  const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
  let state = null;           // { mode, words, target, locked, moments, order, index }
  let activePointer = null;   // pair mode: the one finger that counts
  let drag = null;            // swipe mode: the one finger that counts
  let cur = null;             // swipe mode: the photo on screen
  let inc = null;             // swipe mode: the photo waiting in the wings
  let stage = null;

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function begin() {
    const ready = (await FWDB.sessionWords()).words; // in rotation, inside the chosen topic
    if (ready.length < 2) {
      FWParent.open('need-words');
      return;
    }
    const mode = (await FWDB.getSetting('sessionMode', 'swipe')) === 'pair' ? 'pair' : 'swipe';
    const target = parseInt(await FWDB.getSetting('tapsPerSession', 0), 10) || 0; // 0 = keep going

    // The least-recently practised words; massed repetition within the session.
    ready.sort((a, b) => (a.lastPracticedAt || 0) - (b.lastPracticedAt || 0));
    const chosen = ready.slice(0, Math.min(RING_SIZE, ready.length));
    chosen.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); // a stable ring, both modes

    state = {
      mode,
      words: chosen.map(w => ({
        id: w.id,
        label: w.label,
        photoUrl: URL.createObjectURL(w.photo),
        audioUrl: URL.createObjectURL(w.audio)
      })),
      order: [0, 1 % chosen.length],  // pair: which word sits on which side
      pairAt: 0,      // pair: where the current pair starts in the ring
      index: 0,       // swipe: where he is in the ring
      moments: 0,
      target,
      locked: false
    };

    const now = Date.now();
    for (const w of chosen) {
      w.lastPracticedAt = now;
      await FWDB.putWord(w);
    }

    document.getElementById('screen-session').dataset.mode = mode;
    if (mode === 'swipe') renderSwipe(); else renderPair();
    FWApp.show('session');

    // The first word speaks as soon as Start is tapped (parent's request 2026-09-28).
    if (mode === 'swipe') speak(state.words[state.index]);
    else namePair(document.getElementById('card-0'));
  }

  function unlockAudio() {
    try {
      audioEl.src = SILENT_WAV;
      const p = audioEl.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* fine: the tap on a photo still plays */ }
  }

  /* ---------- shared ---------- */

  function playAudio(url) {
    return new Promise(resolve => {
      audioEl.src = url;
      audioEl.onended = resolve;
      audioEl.onerror = resolve;
      audioEl.play().catch(resolve);
    });
  }

  // One naming moment is over: log it; true when the session is complete
  // (never, when the limit is 0 — it then ends when the parent opens the parent area).
  function countMoment(w) {
    state.moments += 1;
    FWDB.getWord(w.id).then(fresh => {
      if (fresh) {
        fresh.timesNamed = (fresh.timesNamed || 0) + 1;
        FWDB.putWord(fresh);
      }
    });
    return state.target > 0 && state.moments >= state.target;
  }

  function releaseUrls() {
    if (state) {
      state.words.forEach(w => {
        URL.revokeObjectURL(w.photoUrl);
        URL.revokeObjectURL(w.audioUrl);
      });
    }
  }

  function end() {
    releaseUrls();
    state = null;
    activePointer = null;
    drag = null;
    FWApp.show('end');
  }

  function abort() {
    // Parent gate opened mid-session: clean up quietly.
    if (state) audioEl.pause();
    releaseUrls();
    state = null;
    activePointer = null;
    drag = null;
  }

  function isRunning() { return state !== null; }

  /* ---------- pair mode: two photos, tap one ---------- */

  function renderPair() {
    [0, 1].forEach(i => {
      const card = document.getElementById('card-' + i);
      const w = state.words[state.order[i]];
      card.querySelector('img').src = w.photoUrl;
      card.dataset.wordIndex = String(state.order[i]);
      card.classList.remove('focus', 'away');
      card.style.transform = '';
    });
  }

  function focusCard(card, other) {
    other.classList.add('away');
    card.classList.add('focus');
    const r = card.getBoundingClientRect();
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const scale = Math.max(
      1.15,
      Math.min((window.innerWidth * 0.62) / r.width, (window.innerHeight * 0.78) / r.height)
    );
    const tx = cx - (r.left + r.width / 2);
    const ty = cy - (r.top + r.height / 2);
    card.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + scale + ')';
  }

  function unfocus() {
    [0, 1].forEach(i => {
      const card = document.getElementById('card-' + i);
      card.classList.remove('focus', 'away');
      card.style.transform = '';
    });
  }

  async function namePair(card) {
    state.locked = true;
    const idx = parseInt(card.dataset.wordIndex, 10);
    const w = state.words[idx];
    const other = document.getElementById(card.id === 'card-0' ? 'card-1' : 'card-0');

    focusCard(card, other);
    await wait(FOCUS_MOTION_MS);
    await playAudio(w.audioUrl);
    if (!state) return;
    await wait(SILENCE_AFTER_WORD_MS);
    if (!state) return;
    unfocus();
    await wait(FOCUS_MOTION_MS);
    if (!state) return;

    if (countMoment(w)) {
      end();
      return;
    }
    // Swap sides half the time so a side never comes to mean a word.
    if (Math.random() < 0.5) {
      state.order.reverse();
      renderPair();
    }
    await wait(EXTRA_COOLDOWN_MS);
    if (state) state.locked = false;
  }

  // A swipe anywhere on the pair screen: the next two photos from the ring.
  async function nextPair() {
    const n = state.words.length;
    if (n < 3) return; // only two words: nothing to move on to
    state.locked = true;
    state.pairAt = (state.pairAt + 2) % n;
    state.order = [state.pairAt, (state.pairAt + 1) % n];
    renderPair();
    await wait(EXTRA_COOLDOWN_MS);
    if (state) state.locked = false;
  }

  function wirePair() {
    const screen = document.getElementById('screen-session');
    const cardOf = el => el && el.closest ? el.closest('.card') : null;

    screen.addEventListener('pointerdown', e => {
      if (!state || state.mode !== 'pair' || state.locked) return;
      if (activePointer !== null) return; // first touch wins; extra fingers do nothing
      activePointer = { id: e.pointerId, card: cardOf(e.target), x: e.clientX, y: e.clientY };
    });

    screen.addEventListener('pointerup', e => {
      if (!activePointer || e.pointerId !== activePointer.id) return;
      const a = activePointer;
      activePointer = null;
      if (!state || state.mode !== 'pair' || state.locked) return;
      const travel = Math.hypot(e.clientX - a.x, e.clientY - a.y);
      if (travel > TAP_MAX_TRAVEL_PX) { nextPair(); return; } // a swipe: next two
      const card = cardOf(e.target);
      if (!card || card !== a.card) return; // lifted on dead space or the other photo: not a tap
      namePair(card);
    });

    screen.addEventListener('pointercancel', e => {
      if (activePointer && e.pointerId === activePointer.id) activePointer = null;
    });
  }

  /* ---------- swipe mode: one photo, moved by his finger ---------- */

  function ringIndex(i) {
    const n = state.words.length;
    return ((i % n) + n) % n;
  }

  function setSlide(el, wordIdx) {
    el.querySelector('img').src = state.words[wordIdx].photoUrl;
    el.dataset.wordIndex = String(wordIdx);
  }

  // Move a photo along the swipe axis; animate = glide there rather than jump.
  function place(el, axis, off, animate) {
    el.style.transition = animate ? 'transform ' + SETTLE_MS + 'ms ease-out' : 'none';
    el.style.transform = axis === 'y'
      ? 'translate3d(0, ' + off + 'px, 0)'
      : 'translate3d(' + off + 'px, 0, 0)';
  }

  function renderSwipe() {
    cur = document.getElementById('slide-a');
    inc = document.getElementById('slide-b');
    setSlide(cur, state.index);
    place(cur, 'x', 0, false);
    place(inc, 'x', 0, false);
    cur.hidden = false;
    inc.hidden = true;
  }

  function onSwipeDown(e) {
    if (!state || state.mode !== 'swipe' || state.locked) return;
    if (drag !== null) return; // first touch wins; extra fingers do nothing
    drag = {
      id: e.pointerId,
      x0: e.clientX, y0: e.clientY, t0: performance.now(),
      axis: null, dir: 0, off: 0, size: 0,
      onPhoto: cur.contains(e.target)
    };
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* fine without it */ }
  }

  function onSwipeMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!state || state.locked) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.axis) {
      if (Math.hypot(dx, dy) < AXIS_LOCK_PX) return;
      drag.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      drag.size = drag.axis === 'x' ? window.innerWidth : window.innerHeight;
      const r = cur.getBoundingClientRect();
      drag.span = (drag.axis === 'x' ? r.width : r.height) * (1 + NEXT_GAP);
    }
    const off = drag.axis === 'x' ? dx : dy;
    const dir = off < 0 ? 1 : -1; // only which side the next photo waits on: the side he pulls from
    if (dir !== drag.dir) {
      drag.dir = dir;
      if (inc.hidden) { setSlide(inc, ringIndex(state.index + 1)); inc.hidden = false; } // always the next word
    }
    drag.off = off;
    place(cur, drag.axis, off, false);
    place(inc, drag.axis, off + dir * drag.span, false); // right behind it, on the side he is pulling from
  }

  async function onSwipeUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!state || state.locked) return;
    const travel = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
    if (!d.axis) {
      if (d.onPhoto && travel <= TAP_MAX_TRAVEL_PX) sayAgain();
      return;
    }
    const dt = Math.max(1, performance.now() - d.t0);
    const far = Math.abs(d.off) >= d.size * COMMIT_FRACTION;
    const flick = Math.abs(d.off) / dt >= FLICK_PX_PER_MS;
    if (Math.abs(d.off) > TAP_MAX_TRAVEL_PX && (far || flick)) {
      await land(d);
    } else {
      await settleBack(d);
      if (d.onPhoto && travel <= TAP_MAX_TRAVEL_PX) sayAgain(); // a wobbly tap is still a tap
    }
  }

  function onSwipeCancel(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (d.axis && state && !state.locked) settleBack(d);
  }

  // The next photo finishes its glide in, the old one leaves the way he pushed it, then it is named.
  async function land(d) {
    state.locked = true;
    place(cur, d.axis, -d.dir * d.size, true);
    place(inc, d.axis, 0, true);
    await wait(SETTLE_MS + 40);
    if (!state) return;
    const old = cur;
    cur = inc;
    inc = old;
    inc.hidden = true;
    state.index = ringIndex(state.index + 1); // any direction = forward
    await speak(state.words[state.index]);
  }

  // Not far enough: both photos glide back to where they were.
  async function settleBack(d) {
    state.locked = true;
    place(cur, d.axis, 0, true);
    place(inc, d.axis, d.dir * d.size, true);
    await wait(SETTLE_MS + 40);
    if (!state) return;
    inc.hidden = true;
    state.locked = false;
  }

  async function speak(w) {
    state.locked = true;
    await playAudio(w.audioUrl);
    if (!state) return;
    await wait(SILENCE_AFTER_WORD_MS);
    if (!state) return;
    if (countMoment(w)) {
      end();
      return;
    }
    await wait(EXTRA_COOLDOWN_MS);
    if (state) state.locked = false;
  }

  function sayAgain() {
    if (state && !state.locked) speak(state.words[state.index]);
  }

  function wireSwipe() {
    stage = document.getElementById('stage');
    stage.addEventListener('pointerdown', onSwipeDown);
    stage.addEventListener('pointermove', onSwipeMove);
    stage.addEventListener('pointerup', onSwipeUp);
    stage.addEventListener('pointercancel', onSwipeCancel);
  }

  /* ---------- wiring ---------- */

  function wire() {
    wirePair();
    wireSwipe();

    // No pinch zoom, no long-press menus on the child screens.
    const sessionEl = document.getElementById('screen-session');
    sessionEl.addEventListener('contextmenu', e => e.preventDefault());
    document.addEventListener('gesturestart', e => {
      if (document.body.dataset.screen === 'session' || document.body.dataset.screen === 'end') {
        e.preventDefault();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', wire);

  return { begin, abort, isRunning, unlockAudio };
})();
