/* The parent area: build the word library (photo + your recorded voice), keep it in
   topics, choose what's in rotation, log "he says it now", set session length and the
   topic sessions draw from, and add many words at once — from packs published with
   the app, or from your own photo + recording files. Opens only via the two-finger
   long-press (see app.js). */

window.FWParent = (function () {
  const MAX_ACTIVE = 6; // the research cap on the active set — per topic; a session uses one topic
  const AUDIO_EXT = { m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg', caf: 'audio/x-caf' };
  const IMAGE_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', gif: 'image/gif' };

  let objectUrls = [];
  let editingId = null;
  let photoBlob = null;   // processed photo for the form
  let recBlob = null;     // recorded audio for the form
  let mediaRecorder = null;
  let recChunks = [];
  let recTimer = null;
  let recStartedAt = 0;
  let lastTopic = '';     // the topic the form defaults to
  const previewAudio = new Audio();

  const $ = id => document.getElementById(id);
  const topicOf = w => FWDB.topicOf(w);

  function revokeAll() {
    objectUrls.forEach(u => URL.revokeObjectURL(u));
    objectUrls = [];
  }
  function track(url) { objectUrls.push(url); return url; }

  function note(text) {
    const el = $('parent-note');
    el.textContent = text || '';
    el.hidden = !text;
  }
  function formMsg(text) {
    const el = $('form-msg');
    el.textContent = text || '';
    el.hidden = !text;
  }
  function say(id, text) {
    const el = $(id);
    el.textContent = text || '';
    el.hidden = !text;
  }

  async function open(reason) {
    FWSession.abort();
    lastTopic = ((await FWDB.getSetting('currentTopic', '')) || '').trim();
    await renderList();
    await renderTopicControls();
    FWApp.show('parent');
    if (reason === 'need-words') {
      note('A session needs at least two words in rotation in the chosen topic, each with a photo and your voice.');
    } else if (reason === 'welcome') {
      note('Welcome! Add his first words below — a photo of the real thing and your voice for each. Two words are enough to start.');
    } else {
      note('');
    }
    const taps = await FWDB.getSetting('tapsPerSession', 0); // 0 = keep going
    $('f-taps').value = String(taps);
    const mode = (await FWDB.getSetting('sessionMode', 'swipe')) === 'pair' ? 'pair' : 'swipe';
    const radio = document.querySelector('input[name="session-mode"][value="' + mode + '"]');
    if (radio) radio.checked = true;
    loadPacks(); // online only; quietly explains itself when offline
  }

  /* ---------- topics ---------- */

  async function renderTopicControls() {
    const names = await FWDB.topics();
    const current = ((await FWDB.getSetting('currentTopic', '')) || '').trim();

    const dl = $('topic-list');
    dl.textContent = '';
    names.forEach(n => {
      const o = document.createElement('option');
      o.value = n;
      dl.appendChild(o);
    });

    const sel = $('f-topic-session');
    sel.textContent = '';
    const any = document.createElement('option');
    any.value = '';
    any.textContent = 'Any topic';
    sel.appendChild(any);
    names.forEach(n => {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = n;
      sel.appendChild(o);
    });
    sel.value = names.includes(current) ? current : '';
    $('session-topic-row').hidden = names.length === 0;
  }

  /* ---------- the word list, grouped by topic ---------- */

  async function renderList() {
    revokeAll();
    const words = await FWDB.allWords();
    words.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    const activeCount = words.filter(w => w.active && !w.saysIt).length;
    const saysCount = words.filter(w => w.saysIt).length;
    $('word-counts').textContent =
      words.length === 0 ? '' :
      '— ' + words.length + ' word' + (words.length === 1 ? '' : 's') +
      ', ' + activeCount + ' in rotation' +
      (saysCount ? ', ' + saysCount + ' he says' : '');

    const list = $('word-list');
    list.textContent = '';

    const groups = new Map();
    for (const w of words) {
      const t = topicOf(w);
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(w);
    }
    const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));
    const showHeads = names.length > 1 || (names.length === 1 && names[0] !== FWDB.DEFAULT_TOPIC);

    for (const t of names) {
      const ws = groups.get(t);
      if (showHeads) {
        const head = document.createElement('li');
        head.className = 'topic-head';
        const strong = document.createElement('strong');
        strong.textContent = t;
        const span = document.createElement('span');
        span.className = 'count';
        const act = ws.filter(w => w.active && !w.saysIt).length;
        span.textContent = act + ' in rotation · ' + ws.length + ' word' + (ws.length === 1 ? '' : 's');
        head.appendChild(strong);
        head.appendChild(span);
        list.appendChild(head);
      }
      for (const w of ws) list.appendChild(rowFor(w));
    }
  }

  function rowFor(w) {
    const li = document.createElement('li');
    li.className = 'word-row';

    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    if (w.photo) img.src = track(URL.createObjectURL(w.photo));
    li.appendChild(img);

    const main = document.createElement('div');
    main.className = 'w-main';
    const strong = document.createElement('strong');
    strong.textContent = w.label;
    const meta = document.createElement('span');
    meta.className = 'w-meta';
    const bits = [];
    if (w.timesNamed) bits.push('named ' + w.timesNamed + '×');
    if (w.saysIt && w.saysItAt) bits.push('he says it since ' + new Date(w.saysItAt).toLocaleDateString());
    if (!w.audio) bits.push('no recording yet');
    meta.textContent = bits.join(' · ');
    main.appendChild(strong);
    main.appendChild(meta);
    li.appendChild(main);

    const activeLbl = document.createElement('label');
    activeLbl.className = 'chk';
    const activeCb = document.createElement('input');
    activeCb.type = 'checkbox';
    activeCb.checked = !!w.active;
    activeCb.addEventListener('change', async () => {
      if (activeCb.checked) {
        const fresh = await FWDB.allWords();
        const n = fresh.filter(x => x.active && !x.saysIt && x.id !== w.id && topicOf(x) === topicOf(w)).length;
        if (n >= MAX_ACTIVE && !w.saysIt) {
          activeCb.checked = false;
          note('Keep it to ' + MAX_ACTIVE + ' words in rotation per topic — a one-year-old’s memory is the bottleneck, not the exposure.');
          return;
        }
      }
      w.active = activeCb.checked;
      await FWDB.putWord(w);
      renderList();
    });
    activeLbl.appendChild(activeCb);
    activeLbl.appendChild(document.createTextNode(' In rotation'));
    li.appendChild(activeLbl);

    const saysLbl = document.createElement('label');
    saysLbl.className = 'chk';
    const saysCb = document.createElement('input');
    saysCb.type = 'checkbox';
    saysCb.checked = !!w.saysIt;
    saysCb.addEventListener('change', async () => {
      w.saysIt = saysCb.checked;
      w.saysItAt = saysCb.checked ? Date.now() : null;
      await FWDB.putWord(w);
      renderList();
    });
    saysLbl.appendChild(saysCb);
    saysLbl.appendChild(document.createTextNode(' He says it'));
    li.appendChild(saysLbl);

    const actions = document.createElement('div');
    actions.className = 'row-actions';

    if (w.audio) {
      const play = document.createElement('button');
      play.className = 'btn';
      play.type = 'button';
      play.textContent = '▶';
      play.setAttribute('aria-label', 'Play the recording for ' + w.label);
      play.addEventListener('click', () => {
        previewAudio.src = track(URL.createObjectURL(w.audio));
        previewAudio.play();
      });
      actions.appendChild(play);
    }

    const edit = document.createElement('button');
    edit.className = 'btn';
    edit.type = 'button';
    edit.textContent = w.audio ? 'Edit' : '● Record'; // the missing step, spelled out
    edit.addEventListener('click', () => startEdit(w));
    actions.appendChild(edit);

    const del = document.createElement('button');
    del.className = 'btn danger';
    del.type = 'button';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (confirm('Delete “' + w.label + '”? This removes its photo and recording.')) {
        await FWDB.deleteWord(w.id);
        renderList();
        renderTopicControls();
      }
    });
    actions.appendChild(del);

    li.appendChild(actions);
    return li;
  }

  /* ---------- the add/edit form ---------- */

  function resetForm() {
    editingId = null;
    photoBlob = null;
    recBlob = null;
    $('f-photo').value = '';
    $('f-word').value = '';
    $('f-topic').value = lastTopic;
    $('photo-preview').textContent = '';
    $('photo-preview').hidden = true;
    $('btn-rec-play').hidden = true;
    $('btn-rec').textContent = '● Record';
    $('rec-time').textContent = '';
    formMsg('');
  }

  function showForm() { $('word-form').hidden = false; $('btn-add-word').hidden = true; }
  function hideForm() { stopRecorderIfNeeded(); $('word-form').hidden = true; $('btn-add-word').hidden = false; resetForm(); }

  function startEdit(w) {
    resetForm();
    showForm();
    editingId = w.id;
    $('f-word').value = w.label;
    $('f-topic').value = w.topic || '';
    if (w.photo) setPreview(w.photo);
    if (w.audio) $('btn-rec-play').hidden = false;
    formMsg('');
    $('word-form').scrollIntoView({ block: 'start' });
  }

  function setPreview(blob) {
    const holder = $('photo-preview');
    holder.textContent = '';
    const img = document.createElement('img');
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
      return file; // format the browser can't draw (rare): keep the original
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /* ---------- recording ---------- */

  let stopWaiters = [];
  let stopPending = false; // stop() was called; the browser hasn't handed over the audio yet

  function requestStop() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopPending = true;
      mediaRecorder.stop(); // the audio arrives a moment later, in onstop
    }
  }

  // Resolves once any recording has been turned into recBlob (or right away).
  function stopRecorderIfNeeded() {
    requestStop();
    if (!stopPending) return Promise.resolve();
    return new Promise(resolve => {
      stopWaiters.push(resolve);
      setTimeout(resolve, 3000); // never leave the form hanging if the browser never fires onstop
    });
  }

  async function toggleRecord() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      requestStop();
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      formMsg('Recording is not available here. On the iPad it needs the secure (HTTPS) address.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
        .find(m => MediaRecorder.isTypeSupported(m)) || '';
      mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recChunks = [];
      mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        recBlob = new Blob(recChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        stream.getTracks().forEach(t => t.stop());
        clearInterval(recTimer);
        $('btn-rec').textContent = '● Record again';
        $('btn-rec-play').hidden = false;
        formMsg('');
        stopPending = false;
        stopWaiters.splice(0).forEach(fn => fn());
      };
      mediaRecorder.start();
      recStartedAt = Date.now();
      $('btn-rec').textContent = '■ Stop';
      $('rec-time').textContent = '0.0 s';
      recTimer = setInterval(() => {
        $('rec-time').textContent = ((Date.now() - recStartedAt) / 1000).toFixed(1) + ' s';
      }, 100);
    } catch (err) {
      formMsg('Couldn’t open the microphone. Allow microphone access and try again.');
    }
  }

  async function playRecording() {
    let blob = recBlob;
    if (!blob && editingId != null) {
      const w = await FWDB.getWord(editingId);
      blob = w && w.audio;
    }
    if (!blob) return;
    previewAudio.src = track(URL.createObjectURL(blob));
    previewAudio.play();
  }

  /* ---------- save one word ---------- */

  async function save(e) {
    e.preventDefault();
    await stopRecorderIfNeeded(); // a tap on Save while still recording keeps the recording
    const label = $('f-word').value.trim();
    if (!label) { formMsg('Type the word.'); return; }
    const topic = $('f-topic').value.trim() || FWDB.DEFAULT_TOPIC;

    let existing = null;
    if (editingId != null) existing = await FWDB.getWord(editingId);

    const photo = photoBlob || (existing && existing.photo) || null;
    const audio = recBlob || (existing && existing.audio) || null;
    if (!photo) { formMsg('Add a photo of the real thing.'); return; }
    if (!audio) { formMsg('Record your voice saying the word.'); return; }

    const word = existing || { createdAt: Date.now(), active: true, timesNamed: 0, saysIt: false };
    word.label = label;
    word.topic = topic;
    word.photo = photo;
    word.audio = audio;

    if (!existing) {
      const words = await FWDB.allWords();
      const activeCount = words.filter(w => w.active && !w.saysIt && topicOf(w) === topic).length;
      if (activeCount >= MAX_ACTIVE) word.active = false; // joins the library, waits its turn
    }

    await FWDB.putWord(word);
    lastTopic = topic;
    hideForm();
    note('');
    renderList();
    renderTopicControls();
  }

  /* ---------- adding many at once ---------- */

  // items: [{ label, photo: Blob|null, audio: Blob|null }]. New labels become words
  // (not in rotation — the parent picks 3–6); an existing label in the topic gets its
  // missing photo or voice filled in. Returns counts for the summary line.
  async function mergeWords(topic, items, shrinkPhotos) {
    const words = await FWDB.allWords();
    const inTopic = words.filter(w => topicOf(w) === topic);
    const r = { added: 0, updated: 0, skipped: 0, needVoice: 0 };
    let n = 0;
    for (const it of items) {
      const label = (it.label || '').trim();
      if (!label) { r.skipped += 1; continue; }
      const existing = inTopic.find(w => w.label.toLowerCase() === label.toLowerCase());
      if (existing) {
        let changed = false;
        if (it.photo && !existing.photo) { existing.photo = shrinkPhotos ? await processPhoto(it.photo) : it.photo; changed = true; }
        if (it.audio && !existing.audio) { existing.audio = it.audio; changed = true; }
        if (changed) { await FWDB.putWord(existing); r.updated += 1; } else { r.skipped += 1; }
        if (!existing.audio) r.needVoice += 1;
        continue;
      }
      if (!it.photo) { r.skipped += 1; continue; } // a recording with nothing to attach to
      const word = {
        label, topic,
        photo: shrinkPhotos ? await processPhoto(it.photo) : it.photo,
        audio: it.audio || null,
        active: false, saysIt: false, timesNamed: 0,
        createdAt: Date.now() + n
      };
      n += 1;
      await FWDB.putWord(word);
      inTopic.push(word);
      r.added += 1;
      if (!word.audio) r.needVoice += 1;
    }
    return r;
  }

  function summary(topic, r) {
    const bits = [];
    if (r.added) bits.push(r.added + ' added');
    if (r.updated) bits.push(r.updated + ' filled in');
    if (r.skipped) bits.push(r.skipped + ' skipped (already there, or a recording with no photo)');
    let s = '“' + topic + '”: ' + (bits.length ? bits.join(', ') : 'nothing new') + '.';
    if (r.added || r.updated) {
      s += ' Now tick “In rotation” on 3–6 of them';
      if (r.needVoice) s += ' and record your voice for the ' + r.needVoice + ' without one';
      s += '.';
    }
    return s;
  }

  async function fetchBlob(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    return res.blob();
  }

  async function loadPacks() {
    const list = $('packs-list');
    list.textContent = '';
    try {
      const res = await fetch('packs/index.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      const packs = (data && data.packs) || [];
      if (!packs.length) { say('packs-msg', 'No packs published yet.'); return; }
      say('packs-msg', '');
      for (const p of packs) {
        const li = document.createElement('li');
        li.className = 'pack-row';
        const main = document.createElement('div');
        main.className = 'w-main';
        const strong = document.createElement('strong');
        strong.textContent = p.name;
        const meta = document.createElement('span');
        meta.className = 'w-meta';
        meta.textContent = p.words + ' words, ' +
          (p.recordings ? p.recordings + ' with recordings' : 'photos only — you record the voice');
        main.appendChild(strong);
        main.appendChild(meta);
        li.appendChild(main);
        const btn = document.createElement('button');
        btn.className = 'btn primary';
        btn.type = 'button';
        btn.textContent = 'Add to his words';
        btn.addEventListener('click', () => addPack(p, btn));
        li.appendChild(btn);
        list.appendChild(li);
      }
    } catch (e) {
      say('packs-msg', 'Packs need an internet connection. Connect, then reopen the parent area.');
    }
  }

  async function addPack(p, btn) {
    btn.disabled = true;
    try {
      const res = await fetch('packs/' + p.id + '/pack.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('http ' + res.status);
      const pack = await res.json();
      const topic = ((pack.name || p.name || p.id) + '').trim();
      const list = pack.words || [];
      const items = [];
      for (let i = 0; i < list.length; i++) {
        const w = list[i];
        say('packs-msg', 'Adding ' + topic + '… ' + (i + 1) + ' of ' + list.length);
        items.push({
          label: w.label,
          photo: w.photo ? await fetchBlob('packs/' + p.id + '/' + w.photo) : null,
          audio: w.audio ? await fetchBlob('packs/' + p.id + '/' + w.audio) : null
        });
      }
      const r = await mergeWords(topic, items, false); // pack photos are already sized
      say('packs-msg', summary(topic, r));
      await renderList();
      await renderTopicControls();
    } catch (e) {
      say('packs-msg', 'Couldn’t add that pack — check the internet connection and try again.');
      btn.disabled = false;
    }
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
    const topic = $('f-import-topic').value.trim();
    if (!topic) { say('import-msg', 'Type the topic these belong to.'); return; }
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
    const r = await mergeWords(topic, Array.from(byLabel.values()), true);
    say('import-msg', summary(topic, r));
    $('f-import-files').value = '';
    lastTopic = topic;
    await renderList();
    await renderTopicControls();
  }

  /* ---------- wiring ---------- */

  function wire() {
    $('btn-add-word').addEventListener('click', () => { resetForm(); showForm(); });
    $('btn-form-cancel').addEventListener('click', hideForm);
    $('word-form').addEventListener('submit', save);
    $('btn-rec').addEventListener('click', toggleRecord);
    $('btn-rec-play').addEventListener('click', playRecording);
    $('f-photo').addEventListener('change', async () => {
      const file = $('f-photo').files[0];
      if (!file) return;
      photoBlob = await processPhoto(file);
      setPreview(photoBlob);
    });
    $('f-taps').addEventListener('change', () => {
      FWDB.setSetting('tapsPerSession', parseInt($('f-taps').value, 10) || 0);
    });
    document.querySelectorAll('input[name="session-mode"]').forEach(r => {
      r.addEventListener('change', () => { if (r.checked) FWDB.setSetting('sessionMode', r.value); });
    });
    $('f-topic-session').addEventListener('change', () => {
      lastTopic = $('f-topic-session').value;
      FWDB.setSetting('currentTopic', lastTopic);
    });
    $('btn-import').addEventListener('click', importFiles);
    $('btn-to-start').addEventListener('click', () => {
      stopRecorderIfNeeded();
      FWApp.show('start');
    });
  }

  document.addEventListener('DOMContentLoaded', wire);

  return { open };
})();
