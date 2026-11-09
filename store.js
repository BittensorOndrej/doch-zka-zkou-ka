// Everything the app saves stays on this device: a copy in localStorage and a copy in IndexedDB.
(() => {
  const KEY = 'dochazka-data-v1';
  const BACKUP_KEY = 'dochazka-last-backup';
  const DB_NAME = 'dochazka';
  const STORE = 'data';
  const META = { fromCache: false, hasPendingWrites: false };
  const $ = id => document.getElementById(id);

  let docs = new Map();
  let rev = 0;
  let queue = Promise.resolve();
  const subs = new Set();

  const openIdb = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function idbGet() {
    const idb = await openIdb();
    try {
      return await new Promise((resolve, reject) => {
        const r = idb.transaction(STORE).objectStore(STORE).get('all');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } finally {
      idb.close();
    }
  }

  async function idbPut(blob) {
    const idb = await openIdb();
    try {
      await new Promise((resolve, reject) => {
        const tx = idb.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(blob, 'all');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      idb.close();
    }
  }

  function parse(blob) {
    if (!blob) return null;
    try {
      const data = JSON.parse(blob);
      return data && typeof data.rev === 'number' && data.docs && typeof data.docs === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  async function load() {
    let local = null;
    let idb = null;
    let readable = false;
    try {
      local = parse(localStorage.getItem(KEY));
      readable = true;
    } catch { /* the other copy may still work */ }
    try {
      idb = parse(await idbGet());
      readable = true;
    } catch { /* the other copy may still work */ }
    const best = [local, idb].filter(Boolean).sort((a, b) => b.rev - a.rev)[0];
    if (best) {
      rev = best.rev;
      docs = new Map(Object.entries(best.docs));
    }
    return readable;
  }

  function persist() {
    rev += 1;
    const blob = JSON.stringify({ rev, docs: Object.fromEntries(docs) });
    const write = queue.then(async () => {
      let saved = false;
      let full = false;
      try {
        localStorage.setItem(KEY, blob);
        saved = true;
      } catch (e) {
        full = e?.name === 'QuotaExceededError';
      }
      try {
        await idbPut(blob);
        saved = true;
      } catch { /* the localStorage copy is enough */ }
      if (!saved) throw { code: full ? 'quota_exceeded' : 'unavailable' };
    });
    queue = write.catch(() => {});
    return write;
  }

  const fire = () => { for (const f of [...subs]) f(); };
  const listen = f => {
    subs.add(f);
    setTimeout(() => { if (subs.has(f)) f(); }, 0);
    return () => subs.delete(f);
  };
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(36).padStart(2, '0')).join('');
  const clone = v => JSON.parse(JSON.stringify(v));
  const snapDoc = path => ({
    id: path.split('/').pop(),
    exists: docs.has(path),
    data: () => docs.get(path),
    metadata: META,
  });

  function merge(target, source) {
    for (const [k, v] of Object.entries(source)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (!target[k] || typeof target[k] !== 'object') target[k] = {};
        merge(target[k], v);
      } else {
        target[k] = v;
      }
    }
  }

  function read(path) {
    const depth = path.split('/').length + 1;
    const list = [...docs.keys()]
      .filter(k => k.startsWith(`${path}/`) && k.split('/').length === depth)
      .sort()
      .map(snapDoc);
    return { docs: list, size: list.length, empty: !list.length, metadata: META };
  }

  const doc = path => ({
    id: path.split('/').pop(),
    path,
    get: async () => snapDoc(path),
    async set(data) {
      docs.set(path, clone(data));
      fire();
      await persist();
    },
    async update(data) {
      if (!docs.has(path)) throw { code: 'invalid_argument' };
      merge(docs.get(path), clone(data));
      fire();
      await persist();
    },
    async delete() {
      docs.delete(path);
      fire();
      await persist();
    },
    onSnapshot: next => listen(() => next(snapDoc(path))),
    collection: name => collection(`${path}/${name}`),
  });

  const collection = path => ({
    path,
    doc: id => doc(`${path}/${id || newId()}`),
    get: async () => read(path),
    onSnapshot: next => listen(() => next(read(path))),
  });

  async function saveFile(filename, data) {
    const type = filename.endsWith('.csv') ? 'text/csv' : 'text/plain';
    const file = new File([data], filename, { type });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return { status: 'saved' };
      } catch (e) {
        if (e?.name === 'AbortError') throw { code: 'declined' };
      }
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { status: 'saved' };
  }

  const ready = load();
  const api = { doc, collection };
  window.claude = {
    use: async name => {
      if (name === 'db') return (await ready) ? api : null;
      if (name === 'downloads') return { save: saveFile };
      return null;
    },
  };

  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  $('install').hidden = standalone;

  const stamp = d => `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`;

  function renderBackup() {
    let last = 0;
    try { last = Number(localStorage.getItem(BACKUP_KEY)) || 0; } catch { /* no date to show */ }
    const line = $('backup-last');
    line.textContent = last ? `Poslední záloha: ${stamp(new Date(last))}` : 'Zatím žádná záloha.';
    line.className = docs.size && (!last || Date.now() - last > 30 * 864e5) ? 'warn' : 'fine';
  }

  async function renderSafety() {
    const granted = await navigator.storage?.persisted?.().catch(() => false);
    $('backup-safe').textContent = granted
      ? 'Telefon potvrdil trvalé uložení. Zálohy i tak dělej.'
      : 'Telefon trvalé uložení zatím nepotvrdil, takže dělej zálohy.';
  }

  function backupMessage(text) {
    const box = $('backup-message');
    box.textContent = text;
    box.hidden = !text;
  }

  $('backup-save').addEventListener('click', async () => {
    backupMessage('');
    const d = new Date();
    const name = `dochazka-zaloha-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}.txt`;
    const data = JSON.stringify({ app: 'dochazka', version: 1, savedAt: d.toISOString(), docs: Object.fromEntries(docs) });
    try {
      await saveFile(name, data);
      localStorage.setItem(BACKUP_KEY, String(Date.now()));
      renderBackup();
    } catch (e) {
      if (e?.code !== 'declined') backupMessage('Zálohu se nepodařilo uložit.');
    }
  });

  let pending = null;
  $('backup-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    backupMessage('');
    let data = null;
    try {
      data = JSON.parse(await file.text());
    } catch { /* handled below */ }
    const valid = data?.app === 'dochazka' && data.docs && typeof data.docs === 'object'
      && Object.keys(data.docs).every(k => k.startsWith('groups/'));
    if (!valid) {
      backupMessage('Tento soubor není záloha docházky.');
      return;
    }
    pending = data;
    const when = new Date(data.savedAt);
    $('restore-text').textContent = `Obnovit zálohu${Number.isNaN(when.getTime()) ? '' : ` z ${stamp(when)}`}? Nahradí všechna data v aplikaci.`;
    $('restore-confirm').hidden = false;
  });

  $('restore-no').addEventListener('click', () => {
    pending = null;
    $('restore-confirm').hidden = true;
  });

  $('restore-yes').addEventListener('click', async () => {
    if (!pending) return;
    docs = new Map(Object.entries(pending.docs));
    try {
      await persist();
      location.reload();
    } catch {
      backupMessage('Zálohu se nepodařilo obnovit.');
    }
  });

  ready.then(renderBackup);
  renderSafety();
  navigator.storage?.persist?.().then(renderSafety).catch(() => {});

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
})();
