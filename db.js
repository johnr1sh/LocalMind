/**
 * db.js
 * IndexedDB layer. Three stores: conversations, messages, settings.
 * All ops return promises. No ORM, just plain IDB wrapped nicely.
 */

const DB_NAME = 'localmind';
const DB_VER = 1;

const S = {
  CONVS: 'conversations',
  MSGS: 'messages',
  SETTINGS: 'settings',
};

let db = null;

export function open() {
  if (db) return Promise.resolve(db);

  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = e => {
      const d = e.target.result;

      if (!d.objectStoreNames.contains(S.CONVS)) {
        const s = d.createObjectStore(S.CONVS, { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }

      if (!d.objectStoreNames.contains(S.MSGS)) {
        const s = d.createObjectStore(S.MSGS, { keyPath: 'id' });
        s.createIndex('convId', 'convId');
        s.createIndex('createdAt', 'createdAt');
      }

      if (!d.objectStoreNames.contains(S.SETTINGS)) {
        d.createObjectStore(S.SETTINGS, { keyPath: 'key' });
      }
    };

    req.onsuccess = e => { db = e.target.result; res(db); };
    req.onerror = e => rej(e.target.error);
  });
}

function wrap(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// --- conversations ---

export async function createConv(data = {}) {
  const d = await open();
  const now = Date.now();
  const conv = {
    id: uid('conv'),
    title: 'New Conversation',
    createdAt: now,
    updatedAt: now,
    model: 'HuggingFaceTB/SmolLM2-360M-Instruct',
    ...data,
  };
  const tx = d.transaction(S.CONVS, 'readwrite');
  await wrap(tx.objectStore(S.CONVS).put(conv));
  return conv;
}

export async function getConvs() {
  const d = await open();
  const tx = d.transaction(S.CONVS, 'readonly');
  const all = await wrap(tx.objectStore(S.CONVS).getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConv(id) {
  const d = await open();
  const tx = d.transaction(S.CONVS, 'readonly');
  return wrap(tx.objectStore(S.CONVS).get(id));
}

export async function updateConv(id, patch = {}) {
  const d = await open();
  const tx = d.transaction(S.CONVS, 'readwrite');
  const store = tx.objectStore(S.CONVS);
  const existing = await wrap(store.get(id));
  if (!existing) return null;
  const updated = { ...existing, ...patch, updatedAt: Date.now() };
  await wrap(store.put(updated));
  return updated;
}

export async function deleteConv(id) {
  const d = await open();

  // delete messages first
  const mtx = d.transaction(S.MSGS, 'readwrite');
  const mstore = mtx.objectStore(S.MSGS);
  const msgs = await wrap(mstore.index('convId').getAll(id));
  for (const m of msgs) await wrap(mstore.delete(m.id));

  const ctx = d.transaction(S.CONVS, 'readwrite');
  await wrap(ctx.objectStore(S.CONVS).delete(id));
}

// --- messages ---

export async function addMsg(convId, role, content) {
  const d = await open();
  const now = Date.now();
  const msg = {
    id: uid('msg'),
    convId,
    role,
    content,
    createdAt: now,
  };
  const tx = d.transaction(S.MSGS, 'readwrite');
  await wrap(tx.objectStore(S.MSGS).put(msg));
  await updateConv(convId, { updatedAt: now });
  return msg;
}

export async function getMsgs(convId) {
  const d = await open();
  const tx = d.transaction(S.MSGS, 'readonly');
  const msgs = await wrap(tx.objectStore(S.MSGS).index('convId').getAll(convId));
  return msgs.sort((a, b) => a.createdAt - b.createdAt);
}

export async function updateMsg(id, content) {
  const d = await open();
  const tx = d.transaction(S.MSGS, 'readwrite');
  const store = tx.objectStore(S.MSGS);
  const m = await wrap(store.get(id));
  if (!m) return null;
  const updated = { ...m, content };
  await wrap(store.put(updated));
  return updated;
}

export async function deleteMsg(id) {
  const d = await open();
  const tx = d.transaction(S.MSGS, 'readwrite');
  await wrap(tx.objectStore(S.MSGS).delete(id));
}

export async function clearMsgs(convId) {
  const d = await open();
  const tx = d.transaction(S.MSGS, 'readwrite');
  const store = tx.objectStore(S.MSGS);
  const msgs = await wrap(store.index('convId').getAll(convId));
  for (const m of msgs) await wrap(store.delete(m.id));
}

// --- settings ---

export async function setSetting(key, val) {
  const d = await open();
  const tx = d.transaction(S.SETTINGS, 'readwrite');
  await wrap(tx.objectStore(S.SETTINGS).put({ key, value: val }));
}

export async function getSetting(key, fallback = null) {
  const d = await open();
  const tx = d.transaction(S.SETTINGS, 'readonly');
  const r = await wrap(tx.objectStore(S.SETTINGS).get(key));
  return r ? r.value : fallback;
}

export async function getAllSettings() {
  const d = await open();
  const tx = d.transaction(S.SETTINGS, 'readonly');
  const all = await wrap(tx.objectStore(S.SETTINGS).getAll());
  return Object.fromEntries(all.map(s => [s.key, s.value]));
}

// --- export / import ---

export async function exportData() {
  const convs = await getConvs();
  const msgs = {};
  for (const c of convs) msgs[c.id] = await getMsgs(c.id);
  const settings = await getAllSettings();
  return { version: 1, exportedAt: new Date().toISOString(), convs, msgs, settings };
}

export async function importData(data) {
  if (!data || data.version !== 1) throw new Error('Incompatible export file (expected version 1).');

  const d = await open();

  if (data.convs) {
    const tx = d.transaction(S.CONVS, 'readwrite');
    const store = tx.objectStore(S.CONVS);
    for (const c of data.convs) await wrap(store.put(c));
  }

  if (data.msgs) {
    const tx = d.transaction(S.MSGS, 'readwrite');
    const store = tx.objectStore(S.MSGS);
    for (const list of Object.values(data.msgs)) {
      for (const m of list) await wrap(store.put(m));
    }
  }

  if (data.settings) {
    for (const [k, v] of Object.entries(data.settings)) await setSetting(k, v);
  }
}

export async function clearAll() {
  const d = await open();
  const ctxC = d.transaction(S.CONVS, 'readwrite');
  await wrap(ctxC.objectStore(S.CONVS).clear());
  const ctxM = d.transaction(S.MSGS, 'readwrite');
  await wrap(ctxM.objectStore(S.MSGS).clear());
}
