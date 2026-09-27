/* Local storage for words and settings. Everything lives on the device (IndexedDB);
   nothing is ever uploaded. Word shape:
   { id, label, photo (Blob), audio (Blob), active, saysIt, saysItAt,
     timesNamed, lastPracticedAt, createdAt } */

window.FWDB = (function () {
  const DB_NAME = 'firstwords';
  const DB_VERSION = 1;
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

  async function allWords() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('words', 'readonly').objectStore('words').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function getWord(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('words', 'readonly').objectStore('words').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function putWord(word) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('words', 'readwrite').objectStore('words').put(word);
      req.onsuccess = () => resolve(req.result); // id
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

  return { allWords, getWord, putWord, deleteWord, getSetting, setSetting };
})();
