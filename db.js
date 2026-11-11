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
let opening = null;

export function open() {
  if (db) return Promise.resolve(db);
  if (opening) return opening;

  opening = new Promise((res, rej) => {
    let settled = false;
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

    req.onsuccess = e => {
      db = e.target.result;
      db.onversionchange = () => {
        db.close();
        db = null;
      };
      settled = true;
      res(db);
    };
    req.onerror = e => {
      if (!settled) rej(e.target.error || new Error('Could not open LocalMind storage.'));
    };
    req.onblocked = () => {
      if (!settled) rej(new Error('LocalMind storage is blocked by another open tab. Close other LocalMind tabs and retry.'));
    };
  }).finally(() => { opening = null; });

  return opening;
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('Storage transaction was aborted.'));
    tx.onerror = () => reject(tx.error || new Error('Storage transaction failed.'));
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

// `touch: false` is for metadata-only edits (rename, pin) that must not move an
// old conversation to the top of the sidebar as if it had new activity.
export async function updateConv(id, patch = {}, { touch = true } = {}) {
  const d = await open();
  const tx = d.transaction(S.CONVS, 'readwrite');
  const store = tx.objectStore(S.CONVS);
  const existing = await wrap(store.get(id));
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  if (touch) updated.updatedAt = Date.now();
  await wrap(store.put(updated));
  return updated;
}

export async function deleteConv(id) {
  const d = await open();

  // One transaction: a conversation and its messages are removed together or not at all.
  const tx = d.transaction([S.MSGS, S.CONVS], 'readwrite');
  const done = transactionDone(tx);
  const mstore = tx.objectStore(S.MSGS);
  const msgs = await wrap(mstore.index('convId').getAll(id));
  for (const m of msgs) mstore.delete(m.id);
  tx.objectStore(S.CONVS).delete(id);
  await done;
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
  const done = transactionDone(tx);
  const store = tx.objectStore(S.MSGS);
  const msgs = await wrap(store.index('convId').getAll(convId));
  for (const m of msgs) store.delete(m.id);
  await done;
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
  if (!data || data.version !== 1) {
    throw new Error('Incompatible export file (expected version 1).');
  }
  if (!Array.isArray(data.convs) || !data.msgs || typeof data.msgs !== 'object' || Array.isArray(data.msgs)) {
    throw new Error('Invalid backup: conversations and message records are required.');
  }
  if (data.settings !== undefined && (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings))) {
    throw new Error('Invalid backup: settings must be an object.');
  }

  // Validate the complete backup before opening a write transaction. A malformed
  // file must never leave the user's existing history half-imported.
  const convIds = new Set();
  for (const conv of data.convs) {
    if (!conv || typeof conv.id !== 'string' || !conv.id || typeof conv.title !== 'string'
      || !Number.isFinite(conv.createdAt) || !Number.isFinite(conv.updatedAt)) {
      throw new Error('Invalid backup: a conversation record is malformed.');
    }
    if (convIds.has(conv.id)) throw new Error('Invalid backup: duplicate conversation IDs were found.');
    convIds.add(conv.id);
  }

  const messages = [];
  for (const [convId, list] of Object.entries(data.msgs)) {
    if (!convIds.has(convId) || !Array.isArray(list)) {
      throw new Error('Invalid backup: messages reference an unknown conversation.');
    }
    for (const msg of list) {
      if (!msg || typeof msg.id !== 'string' || !msg.id || msg.convId !== convId
        || !['user', 'assistant', 'system'].includes(msg.role)
        || typeof msg.content !== 'string' || msg.content.length > 2_000_000
        || !Number.isFinite(msg.createdAt)) {
        throw new Error('Invalid backup: a message record is malformed or too large.');
      }
      messages.push(msg);
    }
  }

  const settings = Object.entries(data.settings || {});
  if (settings.some(([key]) => !key || key.length > 200)) {
    throw new Error('Invalid backup: a setting key is invalid.');
  }

  const d = await open();
  const tx = d.transaction([S.CONVS, S.MSGS, S.SETTINGS], 'readwrite');
  const done = transactionDone(tx);

  try {
    const convStore = tx.objectStore(S.CONVS);
    const msgStore = tx.objectStore(S.MSGS);
    const settingStore = tx.objectStore(S.SETTINGS);

    for (const conv of data.convs) convStore.put(conv);
    for (const msg of messages) msgStore.put(msg);
    for (const [key, value] of settings) settingStore.put({ key, value });

    await done;
  } catch (err) {
    try { tx.abort(); } catch { /* transaction may already be complete */ }
    throw err;
  }
}

export async function clearAll() {
  const d = await open();
  const tx = d.transaction([S.CONVS, S.MSGS], 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(S.CONVS).clear();
  tx.objectStore(S.MSGS).clear();
  await done;
}
