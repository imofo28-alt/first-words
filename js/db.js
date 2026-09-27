/* Local storage for words and settings. Everything lives on the device (IndexedDB);
   nothing is ever uploaded. Word shape:
   { id, label, topic, photo (Blob), audio (Blob), active, saysIt, saysItAt,
     timesNamed, lastPracticedAt, createdAt }
   Settings: tapsPerSession, sessionMode ('swipe' | 'pair'), currentTopic. */

window.FWDB = (function () {
  const DB_NAME = 'firstwords';
  const DB_VERSION = 1;
  const DEFAULT_TOPIC = 'General'; // words saved before topics existed live here
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('words')) {
          db.createObjectStore('words', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  /* ---------- media storage ----------
     Safari can hand back a Blob from IndexedDB that turns empty when it is written
     again — e.g. saving a recording for a word re-saves "the same" photo, and the photo
     is gone. So photos and recordings are stored as raw bytes + type, and turned back
     into a fresh Blob on the way out. Records written before this change (plain Blobs)
     still read fine and are converted the next time they are saved. */

  function isBlob(v) { return typeof Blob !== 'undefined' && v instanceof Blob; }

  function readBytes(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsArrayBuffer(blob);
    });
  }

  async function toStored(v) {
    if (!v) return null;
    if (isBlob(v)) {
      if (!v.size) return null;
      return { type: v.type || '', buf: await readBytes(v) };
    }
    if (v.buf && v.buf.byteLength) return v; // already in stored form
    return null;
  }

  function fromStored(v) {
    if (!v) return null;
    if (isBlob(v)) return v.size ? v : null;
    if (v.buf && v.buf.byteLength) return new Blob([v.buf], { type: v.type || '' });
    return null;
  }

  function unpack(w) {
    if (w) {
      w.photo = fromStored(w.photo);
      w.audio = fromStored(w.audio);
    }
    return w;
  }

  async function pack(w) {
    const copy = Object.assign({}, w);
    copy.photo = await toStored(w.photo);
    copy.audio = await toStored(w.audio);
    return copy;
  }

  async function allWords() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('words', 'readonly').objectStore('words').getAll();
      req.onsuccess = () => resolve((req.result || []).map(unpack));
      req.onerror = () => reject(req.error);
    });
  }

  async function getWord(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('words', 'readonly').objectStore('words').get(id);
      req.onsuccess = () => resolve(unpack(req.result || null));
      req.onerror = () => reject(req.error);
    });
  }

  async function putWord(word) {
    const stored = await pack(word); // bytes are read before the transaction opens
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('words', 'readwrite').objectStore('words').put(stored);
      req.onsuccess = () => {
        if (word.id == null) word.id = req.result; // a new word learns its id
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteWord(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('words', 'readwrite').objectStore('words').delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function getSetting(key, fallback) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('settings', 'readonly').objectStore('settings').get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
      req.onerror = () => reject(req.error);
    });
  }

  async function setSetting(key, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('settings', 'readwrite').objectStore('settings').put({ key, value });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /* ---------- topics and what a session may use ---------- */

  function topicOf(w) { return ((w && w.topic) || '').trim() || DEFAULT_TOPIC; }

  // In rotation, has a photo and the parent's voice, and he doesn't say it yet.
  function isReady(w) { return !!(w && w.active && w.photo && w.audio && !w.saysIt); }

  async function topics() {
    const words = await allWords();
    return Array.from(new Set(words.map(topicOf))).sort((a, b) => a.localeCompare(b));
  }

  // The words a session draws from: the ready words inside the chosen topic.
  // No topic chosen → ready words from any topic.
  async function sessionWords() {
    const words = await allWords();
    const topic = ((await getSetting('currentTopic', '')) || '').trim();
    const ready = words.filter(isReady);
    return { topic, words: topic ? ready.filter(w => topicOf(w) === topic) : ready };
  }

  return { allWords, getWord, putWord, deleteWord, getSetting, setSetting,
           DEFAULT_TOPIC, topicOf, isReady, topics, sessionWords };
})();
