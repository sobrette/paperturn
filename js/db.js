// IndexedDB storage. Metadata and file bytes live in separate stores so the
// shelf can be listed without loading every PDF into memory.
const DB_NAME = 'paperturn';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB is not available in this browser.'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Storage is blocked by another open tab.'));
  });
  return dbPromise;
}

function tx(stores, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  }));
}

const req2p = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export function listBooks() {
  return tx(['books'], 'readonly', t => req2p(t.objectStore('books').getAll()));
}

export function getBook(id) {
  return tx(['books'], 'readonly', t => req2p(t.objectStore('books').get(id)));
}

export function getFile(id) {
  return tx(['files'], 'readonly', t => req2p(t.objectStore('files').get(id))).then(r => r && r.data);
}

/** Saves a book and its bytes atomically. */
export function putBook(meta, data) {
  return tx(['books', 'files'], 'readwrite', t => {
    t.objectStore('books').put(meta);
    t.objectStore('files').put({ id: meta.id, data });
  });
}

export function updateBook(id, patch) {
  return tx(['books'], 'readwrite', async t => {
    const store = t.objectStore('books');
    const cur = await req2p(store.get(id));
    if (cur) store.put({ ...cur, ...patch });
  });
}

export function deleteBook(id) {
  return tx(['books', 'files'], 'readwrite', t => {
    t.objectStore('books').delete(id);
    t.objectStore('files').delete(id);
  });
}

/** Content hash used as the book id, so re-adding the same file never duplicates it. */
export async function hashBytes(buffer) {
  if (window.crypto && crypto.subtle) {
    const d = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback (insecure contexts): two independent FNV-1a passes over all bytes.
  const u = new Uint8Array(buffer);
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ u.length;
  for (let i = 0; i < u.length; i++) {
    h1 = Math.imul(h1 ^ u[i], 16777619);
    h2 = Math.imul(h2 ^ u[u.length - 1 - i], 2246822519);
  }
  return 'f' + (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + u.length.toString(16);
}
