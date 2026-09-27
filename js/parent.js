/* The parent area, built around the parent's three jobs:
     1. pick a topic (tabs)
     2. get its words ready — pictures plus the parent's own voice
     3. start
   One topic shows at a time. Every word is a card with one clear state:
     Practising (in the session) · Needs your voice · Resting · He says it.
   A word that gets a voice joins the practice set by itself while there is room (the
   research cap is six per topic); tapping a card's picture rests or resumes it.
   "Record voices" walks through the words that still need a voice, one at a time.
   Opens only via the two-finger long-press (see app.js). */

window.FWParent = (function () {
  const MAX_ACTIVE = 6; // the research cap on the active set, per topic
  const AUDIO_EXT = { m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg', caf: 'audio/x-caf' };
  const IMAGE_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', gif: 'image/gif' };

  const $ = id => document.getElementById(id);
  const topicOf = w => FWDB.topicOf(w);

  let words = [];         // fresh after every change
  let topic = '';         // the selected tab
  let view = 'topic';     // 'topic' | 'add'
  let objectUrls = [];
  let packs = null;       // packs/index.json, once fetched
  let packsError = false;
  const previewAudio = new Audio();

  // add/edit form
  let editingId = null;
  let photoBlob = null;
  let recBlob = null;

  // guided recording
  let recQueue = [];
  let recCurrent = null;
  let recTaken = null;

  const recorder = makeRecorder();
  let timer = null;

  /* ---------- small helpers ---------- */

  function revokeAll() { objectUrls.forEach(u => URL.revokeObjectURL(u)); objectUrls = []; }
  function track(url) { objectUrls.push(url); return url; }
  function say(id, text) { const e = $(id); e.textContent = text || ''; e.hidden = !text; }
  function note(text) { say('parent-note', text); }
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function stateOf(w) {
    if (w.saysIt) return 'says';
    if (!w.audio) return 'needs-voice';
    return w.active ? 'practising' : 'resting';
  }
  const STATE_LABEL = { says: 'He says it', 'needs-voice': 'Needs your voice', practising: 'Practising', resting: 'Resting' };

  function inTopic(t) { return words.filter(w => topicOf(w) === t); }
  function practisingCount(t) { return inTopic(t).filter(w => w.active && !w.saysIt).length; }
  function topics() { return Array.from(new Set(words.map(topicOf))).sort((a, b) => a.localeCompare(b)); }

  // A word with a voice joins the practice set while there is room.
  function activateIfRoom(w) {
    if (w.saysIt || !w.audio || w.active) return;
    if (practisingCount(topicOf(w)) < MAX_ACTIVE) w.active = true;
  }

  async function refresh() { words = await FWDB.allWords(); }

  function startTimer(elId) {
    const started = Date.now();
    stopTimer();
    $(elId).textContent = '0.0 s';
    timer = setInterval(() => { $(elId).textContent = ((Date.now() - started) / 1000).toFixed(1) + ' s'; }, 100);
  }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  function play(blob) {
    previewAudio.src = track(URL.createObjectURL(blob));
    previewAudio.play().catch(() => {});
  }

  /* ---------- the recorder ---------- */

  function makeRecorder() {
    let mr = null, chunks = [], stream = null, waiting = null;
    return {
      available() { return !!(navigator.mediaDevices && window.MediaRecorder); },
      get recording() { return !!(mr && mr.state === 'recording'); },
      async start() {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
        mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        chunks = [];
        mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        mr.onstop = () => {
          const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
          stream.getTracks().forEach(t => t.stop());
          const done = waiting; waiting = null;
          if (done) done(blob);
        };
        mr.start();
      },
      // Resolves with the recording once the browser has handed it over.
      stop() {
        if (!(mr && mr.state === 'recording')) return Promise.resolve(null);
        return new Promise(resolve => {
          waiting = resolve;
          mr.stop();
          setTimeout(() => { if (waiting === resolve) { waiting = null; resolve(new Blob(chunks, { type: mr.mimeType || 'audio/webm' })); } }, 3000);
        });
      }
    };
  }

  /* ---------- open / render ---------- */

  async function open(reason) {
    FWSession.abort();
    await refresh();
    const stored = ((await FWDB.getSetting('currentTopic', '')) || '').trim();
    const names = topics();
    topic = names.includes(stored) ? stored : (names[0] || '');
    if (topic !== stored) await FWDB.setSetting('currentTopic', topic);
    view = words.length ? 'topic' : 'add';
    await closeFlow(true);
    hideForm();
    render();
    FWApp.show('parent');
    if (reason === 'need-words') note('Two words with your voice are enough to start. Tap “Record voices”.');
    else if (reason === 'welcome') note('Welcome. Add a pack, then record your voice for a few of its words.');
    else note('');
    const taps = await FWDB.getSetting('tapsPerSession', 0);
    $('f-taps').value = String(taps);
    const mode = (await FWDB.getSetting('sessionMode', 'swipe')) === 'pair' ? 'pair' : 'swipe';
    const radio = document.querySelector('input[name="session-mode"][value="' + mode + '"]');
    if (radio) radio.checked = true;
    if (packs === null) loadPacks();
  }

  function render() {
    revokeAll();
    renderTabs();
    $('topic-view').hidden = view !== 'topic';
    $('add-view').hidden = view !== 'add';
    if (view === 'topic') renderTopic(); else renderAdd();
    renderStartButton();
    renderDatalist();
  }

  function renderTabs() {
    const bar = $('topic-tabs');
    bar.textContent = '';
    topics().forEach(t => {
      const b = el('button', 'tab' + (view === 'topic' && t === topic ? ' on' : ''), t);
      b.type = 'button';
      b.addEventListener('click', async () => {
        topic = t; view = 'topic';
        await FWDB.setSetting('currentTopic', t);
        await closeFlow(true); hideForm(); note('');
        render();
      });
      bar.appendChild(b);
    });
    const add = el('button', 'tab add' + (view === 'add' ? ' on' : ''), '+ Add');
    add.type = 'button';
    add.addEventListener('click', async () => { view = 'add'; await closeFlow(true); hideForm(); note(''); render(); });
    bar.appendChild(add);
  }

  function renderDatalist() {
    const dl = $('topic-list');
    dl.textContent = '';
    topics().forEach(n => { const o = document.createElement('option'); o.value = n; dl.appendChild(o); });
  }

  function renderStartButton() {
    const btn = $('btn-to-start');
    const ready = inTopic(topic).filter(FWDB.isReady).length;
    btn.textContent = topic ? 'Start · ' + topic : 'Start';
    btn.disabled = ready < 2;
    btn.title = ready < 2 ? 'Record your voice for two words first' : '';
  }

  /* ---------- the topic view ---------- */

  function renderTopic() {
    const ws = inTopic(topic);
    const practising = ws.filter(w => w.active && !w.saysIt).length;
    const needVoice = ws.filter(w => !w.audio && !w.saysIt);
    const says = ws.filter(w => w.saysIt).length;

    const bits = [practising + ' practising' + (practising ? ' of up to ' + MAX_ACTIVE : '')];
    if (needVoice.length) bits.push(needVoice.length + ' need' + (needVoice.length === 1 ? 's' : '') + ' your voice');
    if (says) bits.push(says + ' he says');
    $('topic-summary').textContent = bits.join(' · ');

    const ready = ws.filter(FWDB.isReady).length;
    say('topic-hint', ready >= 2 ? '' : (ready === 0 ? 'Record your voice for two words and he can start.' : 'One more voice and he can start.'));

    const recBtn = $('btn-record-all');
    recBtn.hidden = needVoice.length === 0;
    recBtn.textContent = '● Record voices (' + needVoice.length + ')';

    const grid = $('word-grid');
    grid.textContent = '';
    ws.forEach(w => grid.appendChild(cardFor(w)));
    const flowOpen = !$('rec-panel').hidden;
    grid.hidden = flowOpen;
    $('grid-legend').hidden = flowOpen;
  }

  function cardFor(w) {
    const st = stateOf(w);
    const li = el('li', 'wcard ' + st);

    const pic = el('button', 'wphoto');
    pic.type = 'button';
    pic.setAttribute('aria-label', (st === 'practising' ? 'Rest ' : 'Practise ') + w.label);
    const img = el('img');
    img.alt = '';
    if (w.photo) img.src = track(URL.createObjectURL(w.photo));
    pic.appendChild(img);
    pic.appendChild(el('span', 'wmark', st === 'practising' ? '✓' : (st === 'says' ? '★' : '')));
    pic.addEventListener('click', () => togglePractising(w));
    li.appendChild(pic);

    const body = el('div', 'wbody');
    body.appendChild(el('div', 'wname', w.label));
    body.appendChild(el('span', 'chip ' + st, STATE_LABEL[st]));
    li.appendChild(body);

    const acts = el('div', 'wacts');
    if (!w.audio) {
      const rec = el('button', 'btn small primary', '● Record');
      rec.type = 'button';
      rec.addEventListener('click', () => startFlow([w.id]));
      acts.appendChild(rec);
    } else {
      const listen = el('button', 'btn small', '▶');
      listen.type = 'button';
      listen.setAttribute('aria-label', 'Listen to ' + w.label);
      listen.addEventListener('click', () => play(w.audio));
      acts.appendChild(listen);
    }
    const saysBtn = el('button', 'btn small' + (w.saysIt ? ' on' : ''), w.saysIt ? 'Says it ✓' : 'Says it');
    saysBtn.type = 'button';
    saysBtn.addEventListener('click', async () => {
      w.saysIt = !w.saysIt;
      w.saysItAt = w.saysIt ? Date.now() : null;
      if (w.saysIt) w.active = false;
      await FWDB.putWord(w);
      await refresh(); render();
    });
    acts.appendChild(saysBtn);
    const edit = el('button', 'btn small quiet', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', () => openForm(w));
    acts.appendChild(edit);
    li.appendChild(acts);
    return li;
  }

  async function togglePractising(w) {
    if (w.saysIt) { note('He says this one already. Untick “Says it” to practise it again.'); return; }
    if (!w.audio) { startFlow([w.id]); return; }
    if (w.active) {
      w.active = false;
    } else if (practisingCount(topicOf(w)) >= MAX_ACTIVE) {
      note('Six words is plenty for one topic. Rest one first by tapping its picture.');
      return;
    } else {
      w.active = true;
    }
    note('');
    await FWDB.putWord(w);
    await refresh(); render();
  }

  /* ---------- guided recording: one word at a time ---------- */

  function startFlow(ids) {
    if (!recorder.available()) {
      note('Recording needs the secure (https) address on the iPad.');
      return;
    }
    recQueue = ids.slice();
    hideForm();
    note('');
    $('rec-panel').hidden = false;
    $('word-grid').hidden = true;
    $('grid-legend').hidden = true;
    nextInFlow();
    $('rec-panel').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function nextInFlow() {
    recTaken = null;
    while (recQueue.length && !words.find(w => w.id === recQueue[0])) recQueue.shift();
    if (!recQueue.length) { closeFlow(false); return; }
    recCurrent = words.find(w => w.id === recQueue[0]);
    $('rec-progress').textContent = recQueue.length > 1 ? recQueue.length + ' to go' : 'Last one';
    $('rec-word').textContent = recCurrent.label;
    $('rec-photo').src = recCurrent.photo ? track(URL.createObjectURL(recCurrent.photo)) : '';
    $('rec-toggle').textContent = '● Record';
    $('rec-time').textContent = '';
    $('rec-listen').hidden = true;
    $('rec-save').hidden = true;
    say('rec-msg', '');
  }

  async function toggleFlowRecord() {
    if (recorder.recording) {
      $('rec-toggle').disabled = true;
      recTaken = await recorder.stop();
      stopTimer();
      $('rec-toggle').disabled = false;
      $('rec-toggle').textContent = '● Record again';
      $('rec-listen').hidden = !recTaken;
      $('rec-save').hidden = !recTaken;
      return;
    }
    try {
      await recorder.start();
      $('rec-toggle').textContent = '■ Stop';
      $('rec-listen').hidden = true;
      $('rec-save').hidden = true;
      startTimer('rec-time');
      say('rec-msg', '');
    } catch (err) {
      say('rec-msg', 'Couldn’t open the microphone. Allow microphone access and try again.');
    }
  }

  async function saveInFlow() {
    if (!recCurrent || !recTaken) return;
    const w = recCurrent;
    w.audio = recTaken;
    activateIfRoom(w);
    await FWDB.putWord(w);
    await refresh();
    recQueue.shift();
    nextInFlow();
  }

  function skipInFlow() { recQueue.shift(); nextInFlow(); }

  async function closeFlow(silent) {
    stopTimer();
    if (recorder.recording) await recorder.stop();
    const wasOpen = !$('rec-panel').hidden;
    $('rec-panel').hidden = true;
    $('word-grid').hidden = false;
    $('grid-legend').hidden = false;
    recQueue = []; recCurrent = null; recTaken = null;
    if (wasOpen && !silent) {
      await refresh();
      const left = inTopic(topic).filter(w => !w.audio && !w.saysIt).length;
      render();
      note(left ? 'Saved. ' + left + ' still need' + (left === 1 ? 's' : '') + ' your voice.' : 'All recorded. ' + practisingCount(topic) + ' words are practising.');
    }
  }

  /* ---------- the add view: packs, one word, files ---------- */

  async function loadPacks() {
    try {
      const res = await fetch('packs/index.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      packs = (data && data.packs) || [];
      packsError = false;
    } catch (e) {
      packs = [];
      packsError = true;
    }
    if (view === 'add') renderAdd();
    if (!packsError) repairMissingPhotos();
  }

  // A word whose picture went missing (an earlier version could lose it when a
  // recording was saved) gets it back from the pack it came from, quietly.
  async function repairMissingPhotos() {
    let restored = 0;
    for (const p of packs) {
      const missing = inTopic(String(p.name)).filter(w => !w.photo);
      if (!missing.length) continue;
      try {
        const res = await fetch('packs/' + p.id + '/pack.json', { cache: 'no-store' });
        if (!res.ok) continue;
        const pack = await res.json();
        for (const w of missing) {
          const entry = (pack.words || []).find(x => x.label.toLowerCase() === w.label.toLowerCase());
          if (!entry || !entry.photo) continue;
          w.photo = await fetchBlob('packs/' + p.id + '/' + entry.photo);
          await FWDB.putWord(w);
          restored += 1;
        }
      } catch (e) { /* offline or a missing pack: try again next time */ }
    }
    if (restored) {
      await refresh();
      render();
      note(restored + ' picture' + (restored === 1 ? '' : 's') + ' restored from the pack.');
    }
  }

  function renderAdd() {
    const list = $('packs-list');
    list.textContent = '';
    const have = topics().map(t => t.toLowerCase());
    if (packs === null) { say('packs-msg', 'Looking for packs…'); return; }
    if (packsError) { say('packs-msg', 'Packs need an internet connection. Connect and reopen the parent area.'); return; }
    const todo = packs.filter(p => !have.includes(String(p.name).toLowerCase()));
    if (!todo.length) { say('packs-msg', packs.length ? 'Every pack is already in his words.' : 'No packs published yet.'); return; }
    say('packs-msg', '');
    todo.forEach(p => {
      const li = el('li', 'pack-row');
      const main = el('div', 'w-main');
      main.appendChild(el('strong', null, p.name));
      main.appendChild(el('span', 'w-meta', p.words + ' pictures'));
      li.appendChild(main);
      const btn = el('button', 'btn primary', 'Add');
      btn.type = 'button';
      btn.addEventListener('click', () => addPack(p, btn));
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  async function fetchBlob(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    return res.blob();
  }

  async function addPack(p, btn) {
    btn.disabled = true;
    try {
      const res = await fetch('packs/' + p.id + '/pack.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('http ' + res.status);
      const pack = await res.json();
      const name = ((pack.name || p.name || p.id) + '').trim();
      const list = pack.words || [];
      const items = [];
      for (let i = 0; i < list.length; i++) {
        const w = list[i];
        say('packs-msg', 'Adding ' + name + '… ' + (i + 1) + ' of ' + list.length);
        items.push({
          label: w.label,
          photo: w.photo ? await fetchBlob('packs/' + p.id + '/' + w.photo) : null,
          audio: w.audio ? await fetchBlob('packs/' + p.id + '/' + w.audio) : null
        });
      }
      const r = await mergeWords(name, items, false);
      await refresh();
      topic = name; view = 'topic';
      await FWDB.setSetting('currentTopic', name);
      render();
      note(r.added + ' pictures added. Now record your voice for a few of them.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      say('packs-msg', 'Couldn’t add that pack. Check the internet connection and try again.');
      btn.disabled = false;
    }
  }

  // items: [{ label, photo, audio }] → new words, or fill in what an existing word in the
  // topic is missing. Words with a voice join the practice set while there is room.
  async function mergeWords(name, items, shrinkPhotos) {
    const r = { added: 0, updated: 0, skipped: 0 };
    let n = 0;
    for (const it of items) {
      const label = (it.label || '').trim();
      if (!label) { r.skipped += 1; continue; }
      const existing = inTopic(name).find(w => w.label.toLowerCase() === label.toLowerCase());
      if (existing) {
        let changed = false;
        if (it.photo && !existing.photo) { existing.photo = shrinkPhotos ? await processPhoto(it.photo) : it.photo; changed = true; }
        if (it.audio && !existing.audio) { existing.audio = it.audio; activateIfRoom(existing); changed = true; }
        if (changed) { await FWDB.putWord(existing); r.updated += 1; } else { r.skipped += 1; }
        continue;
      }
      if (!it.photo) { r.skipped += 1; continue; }
      const w = {
        label, topic: name,
        photo: shrinkPhotos ? await processPhoto(it.photo) : it.photo,
        audio: it.audio || null,
        active: false, saysIt: false, timesNamed: 0,
        createdAt: Date.now() + n
      };
      n += 1;
      activateIfRoom(w);
      await FWDB.putWord(w);
      words.push(w);
      r.added += 1;
    }
    return r;
  }

  function kindOf(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if ((file.type || '').startsWith('image/') || IMAGE_EXT[ext]) return 'image';
    if ((file.type || '').startsWith('audio/') || AUDIO_EXT[ext]) return 'audio';
    return null;
  }

  function labelFromName(name) {
    return name.replace(/\.[^.]+$/, '').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  async function importFiles() {
    const files = Array.from($('f-import-files').files || []);
    const name = $('f-import-topic').value.trim();
    if (!name) { say('import-msg', 'Type the topic these belong to.'); return; }
    if (!files.length) { say('import-msg', 'Choose the photos and recordings first.'); return; }
    const byLabel = new Map();
    for (const f of files) {
      const kind = kindOf(f);
      const label = labelFromName(f.name);
      if (!kind || !label) continue;
      if (!byLabel.has(label)) byLabel.set(label, { label, photo: null, audio: null });
      const it = byLabel.get(label);
      if (kind === 'image' && !it.photo) it.photo = f;
      if (kind === 'audio' && !it.audio) {
        const ext = (f.name.split('.').pop() || '').toLowerCase();
        it.audio = f.type ? f : new Blob([f], { type: AUDIO_EXT[ext] || 'audio/mp4' });
      }
    }
    say('import-msg', 'Importing…');
    const r = await mergeWords(name, Array.from(byLabel.values()), true);
    $('f-import-files').value = '';
    await refresh();
    if (r.added || r.updated) {
      topic = name; view = 'topic';
      await FWDB.setSetting('currentTopic', name);
      render();
      note((r.added ? r.added + ' added' : '') + (r.added && r.updated ? ', ' : '') + (r.updated ? r.updated + ' filled in' : '') + '.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      say('import-msg', 'Nothing new there. A word needs a photo file, like apple.jpg.');
    }
  }

  /* ---------- the add/edit form (one word) ---------- */

  async function openForm(w) {
    await closeFlow(true);
    editingId = w ? w.id : null;
    photoBlob = null;
    recBlob = null;
    $('f-photo').value = '';
    $('f-word').value = w ? w.label : '';
    $('f-topic').value = w ? (w.topic || '') : (view === 'topic' ? topic : '');
    $('photo-preview').textContent = '';
    $('photo-preview').hidden = true;
    if (w && w.photo) setPreview(w.photo);
    $('btn-rec').textContent = '● Record';
    $('f-rec-time').textContent = '';
    $('btn-rec-play').hidden = !(w && w.audio);
    $('btn-form-delete').hidden = !w;
    $('form-title').textContent = w ? 'Edit “' + w.label + '”' : 'Add a word';
    say('form-msg', '');
    $('word-form').hidden = false;
    $('word-form').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function hideForm() {
    stopTimer();
    if (recorder.recording) recorder.stop();
    $('word-form').hidden = true;
    editingId = null; photoBlob = null; recBlob = null;
  }

  function setPreview(blob) {
    const holder = $('photo-preview');
    holder.textContent = '';
    const img = el('img');
    img.alt = 'Chosen photo';
    img.src = track(URL.createObjectURL(blob));
    holder.appendChild(img);
    holder.hidden = false;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  async function processPhoto(file) {
    // Downscale to keep the library small; photos never leave the device.
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const max = 1200;
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * s));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * s));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
      return blob || file;
    } catch (e) {
      return file;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function toggleFormRecord() {
    if (recorder.recording) {
      $('btn-rec').disabled = true;
      recBlob = await recorder.stop();
      stopTimer();
      $('btn-rec').disabled = false;
      $('btn-rec').textContent = '● Record again';
      $('btn-rec-play').hidden = !recBlob;
      return;
    }
    if (!recorder.available()) { say('form-msg', 'Recording needs the secure (https) address on the iPad.'); return; }
    try {
      await recorder.start();
      $('btn-rec').textContent = '■ Stop';
      startTimer('f-rec-time');
      say('form-msg', '');
    } catch (err) {
      say('form-msg', 'Couldn’t open the microphone. Allow microphone access and try again.');
    }
  }

  function playFormRecording() {
    let blob = recBlob;
    if (!blob && editingId != null) { const w = words.find(x => x.id === editingId); blob = w && w.audio; }
    if (blob) play(blob);
  }

  async function saveForm(e) {
    e.preventDefault();
    if (recorder.recording) { recBlob = await recorder.stop(); stopTimer(); }
    const label = $('f-word').value.trim();
    if (!label) { say('form-msg', 'Type the word.'); return; }
    const name = $('f-topic').value.trim() || FWDB.DEFAULT_TOPIC;
    const existing = editingId != null ? words.find(x => x.id === editingId) : null;
    const photo = photoBlob || (existing && existing.photo) || null;
    if (!photo) { say('form-msg', 'Add a photo of the real thing.'); return; }
    const w = existing || { createdAt: Date.now(), active: false, timesNamed: 0, saysIt: false };
    w.label = label;
    w.topic = name;
    w.photo = photo;
    if (recBlob) w.audio = recBlob;
    activateIfRoom(w);
    await FWDB.putWord(w);
    await refresh();
    hideForm();
    topic = name; view = 'topic';
    await FWDB.setSetting('currentTopic', name);
    render();
    note(existing ? 'Saved.' : (w.audio ? 'Added and practising.' : 'Added. Record your voice when you’re ready.'));
  }

  async function deleteFromForm() {
    if (editingId == null) return;
    const w = words.find(x => x.id === editingId);
    if (!w) return;
    if (!confirm('Delete “' + w.label + '”? This removes its picture and your recording.')) return;
    await FWDB.deleteWord(w.id);
    await refresh();
    hideForm();
    const names = topics();
    if (!names.includes(topic)) {
      topic = names[0] || '';
      await FWDB.setSetting('currentTopic', topic);
      view = topic ? 'topic' : 'add';
    }
    render();
    note('Deleted.');
  }

  /* ---------- wiring ---------- */

  function wire() {
    $('btn-record-all').addEventListener('click', () => {
      startFlow(inTopic(topic).filter(w => !w.audio && !w.saysIt).map(w => w.id));
    });
    $('rec-toggle').addEventListener('click', toggleFlowRecord);
    $('rec-listen').addEventListener('click', () => { if (recTaken) play(recTaken); });
    $('rec-save').addEventListener('click', saveInFlow);
    $('rec-skip').addEventListener('click', skipInFlow);
    $('rec-close').addEventListener('click', () => closeFlow(false));

    $('btn-add-word').addEventListener('click', () => openForm(null));
    $('btn-form-cancel').addEventListener('click', hideForm);
    $('btn-form-delete').addEventListener('click', deleteFromForm);
    $('word-form').addEventListener('submit', saveForm);
    $('btn-rec').addEventListener('click', toggleFormRecord);
    $('btn-rec-play').addEventListener('click', playFormRecording);
    $('f-photo').addEventListener('change', async () => {
      const file = $('f-photo').files[0];
      if (!file) return;
      photoBlob = await processPhoto(file);
      setPreview(photoBlob);
    });
    $('btn-import').addEventListener('click', importFiles);

    $('f-taps').addEventListener('change', () => {
      FWDB.setSetting('tapsPerSession', parseInt($('f-taps').value, 10) || 0);
    });
    document.querySelectorAll('input[name="session-mode"]').forEach(r => {
      r.addEventListener('change', () => { if (r.checked) FWDB.setSetting('sessionMode', r.value); });
    });
    $('btn-to-start').addEventListener('click', async () => {
      await closeFlow(true);
      hideForm();
      FWApp.show('start');
    });
  }

  document.addEventListener('DOMContentLoaded', wire);

  return { open };
})();
