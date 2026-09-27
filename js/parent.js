/* The parent area: build the word library (photo + your recorded voice), choose
   what's in rotation, log "he says it now", set session length. Opens only via
   the two-finger long-press (see app.js). */

window.FWParent = (function () {
  const MAX_ACTIVE = 6; // the research cap on the active set

  let objectUrls = [];
  let editingId = null;
  let photoBlob = null;   // processed photo for the form
  let recBlob = null;     // recorded audio for the form
  let mediaRecorder = null;
  let recChunks = [];
  let recTimer = null;
  let recStartedAt = 0;
  const previewAudio = new Audio();

  const $ = id => document.getElementById(id);

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

  async function open(reason) {
    FWSession.abort();
    await renderList();
    FWApp.show('parent');
    if (reason === 'need-words') {
      note('A session needs at least two words in rotation, each with a photo and your voice.');
    } else if (reason === 'welcome') {
      note('Welcome! Add his first words below — a photo of the real thing and your voice for each. Two words are enough to start.');
    } else {
      note('');
    }
    const taps = await FWDB.getSetting('tapsPerSession', 6);
    $('f-taps').value = String(taps);
    const mode = (await FWDB.getSetting('sessionMode', 'swipe')) === 'pair' ? 'pair' : 'swipe';
    const radio = document.querySelector('input[name="session-mode"][value="' + mode + '"]');
    if (radio) radio.checked = true;
  }

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

    for (const w of words) {
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
          const n = fresh.filter(x => x.active && !x.saysIt && x.id !== w.id).length;
          if (n >= MAX_ACTIVE && !w.saysIt) {
            activeCb.checked = false;
            note('Keep it to ' + MAX_ACTIVE + ' words in rotation — a one-year-old’s memory is the bottleneck, not the exposure.');
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
      edit.textContent = 'Edit';
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
        }
      });
      actions.appendChild(del);

      li.appendChild(actions);
      list.appendChild(li);
    }
  }

  /* ---------- the add/edit form ---------- */

  function resetForm() {
    editingId = null;
    photoBlob = null;
    recBlob = null;
    $('f-photo').value = '';
    $('f-word').value = '';
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

  function stopRecorderIfNeeded() {
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  }

  async function toggleRecord() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
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

  /* ---------- save ---------- */

  async function save(e) {
    e.preventDefault();
    stopRecorderIfNeeded();
    const label = $('f-word').value.trim();
    if (!label) { formMsg('Type the word.'); return; }

    let existing = null;
    if (editingId != null) existing = await FWDB.getWord(editingId);

    const photo = photoBlob || (existing && existing.photo) || null;
    const audio = recBlob || (existing && existing.audio) || null;
    if (!photo) { formMsg('Add a photo of the real thing.'); return; }
    if (!audio) { formMsg('Record your voice saying the word.'); return; }

    const word = existing || { createdAt: Date.now(), active: true, timesNamed: 0, saysIt: false };
    word.label = label;
    word.photo = photo;
    word.audio = audio;

    if (!existing) {
      const words = await FWDB.allWords();
      const activeCount = words.filter(w => w.active && !w.saysIt).length;
      if (activeCount >= MAX_ACTIVE) word.active = false; // joins the library, waits its turn
    }

    await FWDB.putWord(word);
    hideForm();
    note('');
    renderList();
  }

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
      FWDB.setSetting('tapsPerSession', parseInt($('f-taps').value, 10) || 6);
    });
    document.querySelectorAll('input[name="session-mode"]').forEach(r => {
      r.addEventListener('change', () => { if (r.checked) FWDB.setSetting('sessionMode', r.value); });
    });
    $('btn-to-start').addEventListener('click', () => {
      stopRecorderIfNeeded();
      FWApp.show('start');
    });
  }

  document.addEventListener('DOMContentLoaded', wire);

  return { open };
})();
