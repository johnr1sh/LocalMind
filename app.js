/**
 * app.js
 * Main controller — wires DB, AI, and UI together.
 * ADR: Single-page, module-based, no framework. State lives here only.
 */

import * as DB from './db.js';
import * as AI from './ai.js';
import * as UI from './ui.js';

// ---- app state ----
// kept flat and minimal — no proxy/signal magic needed at this scale
const app = {
  convs: [],
  activeId: null,
  msgs: [],
  settings: {},
  generating: false,
  query: '',
  lastHealth: null,
};

// ---- boot ----

async function init() {
  if (!supported()) {
    document.getElementById('unsupported-overlay').classList.remove('hidden');
    return;
  }

  registerSW();

  app.settings = await DB.getAllSettings();
  setTheme(app.settings.theme || 'dark');

  app.convs = await DB.getConvs();

  bindAll();

  const lastId = app.settings.lastConvId;
  if (lastId && app.convs.find(c => c.id === lastId)) {
    await openConv(lastId);
  } else {
    showWelcome();
  }

  renderSidebar();
  syncSettingsUI();
  refreshModelBadge();
  await refreshSystemHealth();

  // Warm cached models only. Avoid blocking first-run users behind a large download overlay.
  const modelId = app.settings.model || AI.DEFAULT_MODEL;
  if (await AI.isCached(modelId)) {
    loadModel(modelId, { showPanel: false }).catch(() => refreshModelBadge('error', modelId));
  } else {
    refreshModelBadge('', modelId);
  }
}

function supported() {
  return typeof indexedDB !== 'undefined'
    && typeof fetch !== 'undefined'
    && typeof WebAssembly !== 'undefined'
    && typeof CSS !== 'undefined'
    && CSS.supports('display', 'grid');
}

// ---- service worker ----

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./service-worker.js', { scope: './' })
    .then(reg => {
      reg.addEventListener('updatefound', () => {
        reg.installing?.addEventListener('statechange', e => {
          if (e.target.state === 'installed' && navigator.serviceWorker.controller) {
            document.getElementById('update-toast').classList.remove('hidden');
          }
        });
      });
    })
    .catch(err => console.warn('SW register failed:', err));
}

// ---- theme ----

function setTheme(t) {
  const prefer = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', t === 'system' ? (prefer ? 'dark' : 'light') : t);
}

// ---- sidebar ----

function renderSidebar() {
  UI.renderConvList(app.convs, app.activeId, {
    onSelect: openConv,
    onRename: renameConv,
    onDelete: deleteConv,
  }, app.query);
}

// ---- conversations ----

async function openConv(id) {
  app.activeId = id;
  app.msgs = await DB.getMsgs(id);

  const conv = app.convs.find(c => c.id === id);
  showChat();
  document.getElementById('chat-title').textContent = conv?.title || 'Conversation';

  renderMsgs();
  UI.scrollBottom(false);
  renderSidebar();

  document.getElementById('regenerate-btn').classList.toggle('hidden', app.msgs.length === 0);

  await DB.setSetting('lastConvId', id);
  closeSidebar();
}

async function newConv() {
  const conv = await DB.createConv({ model: app.settings.model || AI.DEFAULT_MODEL });
  app.convs.unshift(conv);
  await openConv(conv.id);
  focusInput();
  return conv;
}

async function renameConv(id, current) {
  const name = await UI.promptRename(current);
  if (!name || name === current) return;
  await DB.updateConv(id, { title: name });
  const c = app.convs.find(c => c.id === id);
  if (c) c.title = name;
  if (app.activeId === id) document.getElementById('chat-title').textContent = name;
  renderSidebar();
  UI.showOk('Renamed.');
}

async function deleteConv(id, title) {
  const ok = await UI.confirmDlg('Delete Conversation', `Delete "${title}"? This can't be undone.`);
  if (!ok) return;

  await DB.deleteConv(id);
  app.convs = app.convs.filter(c => c.id !== id);

  if (app.activeId === id) {
    app.activeId = null;
    app.msgs = [];
    if (app.convs.length) {
      await openConv(app.convs[0].id);
    } else {
      showWelcome();
    }
  }

  renderSidebar();
  UI.showOk('Deleted.');
}

// ---- messages ----

function renderMsgs() {
  const el = document.getElementById('messages-container');
  if (!el) return;
  el.innerHTML = '';
  for (const m of app.msgs) {
    if (m.role === 'system') continue;
    el.appendChild(UI.msgEl(m));
  }
}

async function send(text) {
  if (!text.trim() || app.generating) return;

  if (!app.activeId) await newConv();

  const id = app.activeId;
  const conv = app.convs.find(c => c.id === id);

  // auto-title on first message
  if (conv?.title === 'New Conversation') {
    const title = text.trim().slice(0, 50) + (text.length > 50 ? '…' : '');
    await DB.updateConv(id, { title });
    conv.title = title;
    document.getElementById('chat-title').textContent = title;
    renderSidebar();
  }

  const userMsg = await DB.addMsg(id, 'user', text.trim());
  app.msgs.push(userMsg);

  document.getElementById('messages-container').appendChild(UI.msgEl(userMsg));
  UI.scrollBottom();
  document.getElementById('regenerate-btn').classList.remove('hidden');

  if (text.trim().toLowerCase() === '/browser') {
    const diagnostic = `Browser diagnostics from LocalMind:\n\n${await AI.browserDiagnostics()}\n\nTip: Send a normal message to load the local model, or ask about model download/storage problems for guided help.`;
    const browserMsg = await DB.addMsg(id, 'assistant', diagnostic);
    app.msgs.push(browserMsg);
    document.getElementById('messages-container').appendChild(UI.msgEl(browserMsg));
    UI.scrollBottom();
    return;
  }

  await runGeneration(id);
}

async function runGeneration(convId) {
  if (!AI.isLoaded()) {
    const modelId = app.settings.model || AI.DEFAULT_MODEL;
    try {
      await loadModel(modelId);
    } catch (err) {
      UI.setProgress({ status: 'fallback' });
      UI.showErr(`Model load failed. Browser Helper mode is active. ${err.message}`, 9000);
      refreshModelBadge('fallback', modelId);
    }
  }

  app.generating = true;
  setInputEnabled(false);
  document.getElementById('typing-indicator').classList.remove('hidden');
  UI.scrollBottom();

  const sys = app.settings.systemPrompt || AI.DEFAULT_SYSTEM;
  const history = app.msgs
    .filter(m => m.role !== 'system')
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content }));

  const msgs = AI.withSystem(history, sys);

  const opts = safeGenerationOptions(modelIdForGeneration(), {
    temperature: parseFloat(app.settings.temperature ?? 0.7),
    max_new_tokens: parseInt(app.settings.maxTokens ?? 512),
    top_p: parseFloat(app.settings.topP ?? 0.9),
  });

  const tmpId = `stream_${Date.now()}`;
  const { el, push, done } = UI.streamingEl(tmpId);

  document.getElementById('typing-indicator').classList.add('hidden');
  const container = document.getElementById('messages-container');
  container.appendChild(el);

  let autoScroll = true;
  const scrollInterval = setInterval(() => { if (autoScroll && UI.nearBottom()) UI.scrollBottom(false); }, 100);

  try {
    const full = await AI.generate(msgs, opts, push, done);
    if (AI.isFallback()) refreshModelBadge('fallback', modelIdForGeneration());

    const aiMsg = await DB.addMsg(convId, 'assistant', full);
    el.dataset.msgId = aiMsg.id;
    app.msgs.push(aiMsg);

    const conv = app.convs.find(c => c.id === convId);
    if (conv) conv.updatedAt = Date.now();
    renderSidebar();
  } catch (err) {
    document.getElementById('typing-indicator').classList.add('hidden');
    el.remove();
    if (AI.isLikelyMemoryError(err)) AI.resetModel();
    UI.showErr(`Generation failed: ${err.message}`);
    console.error(err);
  } finally {
    clearInterval(scrollInterval);
    autoScroll = false;
    app.generating = false;
    setInputEnabled(true);
    document.getElementById('typing-indicator').classList.add('hidden');
    UI.scrollBottom();
  }
}

async function regenerate() {
  if (app.generating || !app.activeId) return;

  // remove last assistant message
  const idx = [...app.msgs].reverse().findIndex(m => m.role === 'assistant');
  if (idx === -1) return;

  const real = app.msgs.length - 1 - idx;
  const last = app.msgs[real];

  await DB.deleteMsg(last.id);
  app.msgs.splice(real, 1);
  document.querySelector(`[data-msg-id="${last.id}"]`)?.remove();

  await runGeneration(app.activeId);
}

async function clearChat() {
  if (!app.activeId) return;
  const ok = await UI.confirmDlg('Clear Chat', 'Remove all messages in this conversation?', 'Clear');
  if (!ok) return;
  await DB.clearMsgs(app.activeId);
  app.msgs = [];
  document.getElementById('messages-container').innerHTML = '';
  document.getElementById('regenerate-btn').classList.add('hidden');
  UI.showOk('Chat cleared.');
}

// ---- model loading ----

function modelIdForGeneration() {
  return AI.getModelId() || app.settings.model || AI.DEFAULT_MODEL;
}

function safeGenerationOptions(modelId, opts) {
  const model = AI.MODELS[modelId] || AI.MODELS[AI.DEFAULT_MODEL];
  const memoryGB = Number.isFinite(navigator.deviceMemory) ? navigator.deviceMemory : null;
  let maxTokens = Number.isFinite(opts.max_new_tokens) ? opts.max_new_tokens : 512;

  if (memoryGB !== null && memoryGB <= 4) maxTokens = Math.min(maxTokens, 256);
  if (memoryGB !== null && memoryGB <= 6 && model.runtimeMB >= 1600) maxTokens = Math.min(maxTokens, 256);
  if (model.runtimeMB >= 3000) maxTokens = Math.min(maxTokens, memoryGB !== null && memoryGB < 16 ? 256 : 512);

  return {
    ...opts,
    max_new_tokens: Math.max(64, Math.min(1024, maxTokens)),
  };
}

async function loadModel(id, { showPanel = true } = {}) {
  const health = await ensureModelSafeToLoad(id);
  refreshModelBadge('loading', id);
  if (showPanel) UI.setProgress({ status: 'initiate', modelName: health.modelName, downloadMB: health.downloadMB, health });
  await AI.loadModel(id, progress => {
    const withHealth = { ...progress, modelName: health.modelName, downloadMB: health.downloadMB, health };
    if (showPanel) UI.setProgress(withHealth);
    if (progress.status === 'ready') {
      refreshModelBadge('ready', id);
      refreshSystemHealth(id);
    }
  });
}


function refreshModelBadge(status = 'loading', id = null) {
  const dot = document.getElementById('model-badge-dot');
  const name = document.getElementById('model-badge-name');
  if (!dot || !name) return;

  const mid = id || app.settings.model || AI.DEFAULT_MODEL;
  const info = AI.MODELS[mid];

  dot.className = `model-badge-dot ${status}`;
  if (status === 'fallback') {
    name.textContent = 'Browser Helper Mode';
  } else {
    name.textContent = info ? info.name : mid.split('/')[1];
  }
}

// ---- input state ----

function setInputEnabled(on) {
  const input = document.getElementById('message-input');
  const send = document.getElementById('send-btn');
  const stop = document.getElementById('stop-btn');

  input.disabled = !on;
  send.classList.toggle('hidden', !on);
  stop.classList.toggle('hidden', on);

  if (on) updateSendBtn();
}

function updateSendBtn() {
  const input = document.getElementById('message-input');
  const btn = document.getElementById('send-btn');
  btn.disabled = !input?.value.trim() || app.generating;
}

function focusInput() {
  document.getElementById('message-input')?.focus();
}

// ---- view switching ----

function showWelcome() {
  document.getElementById('welcome-screen').classList.remove('hidden');
  document.getElementById('chat-area').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
}

function showChat() {
  document.getElementById('welcome-screen').classList.add('hidden');
  document.getElementById('chat-area').classList.remove('hidden');
  document.getElementById('input-area').classList.remove('hidden');
  focusInput();
}

// ---- mobile sidebar ----

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-toggle').setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-toggle').setAttribute('aria-expanded', 'false');
}

// ---- settings ----

function syncSettingsUI() {
  const s = app.settings;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };

  set('model-select', s.model || AI.DEFAULT_MODEL);
  set('temperature-input', s.temperature ?? 0.7);
  set('max-tokens-input', s.maxTokens ?? 512);
  set('top-p-input', s.topP ?? 0.9);
  set('system-prompt-input', s.systemPrompt || AI.DEFAULT_SYSTEM);
  set('theme-select', s.theme || 'dark');

  const tempVal = document.getElementById('temperature-value');
  const maxVal = document.getElementById('max-tokens-value');
  const topVal = document.getElementById('top-p-value');
  if (tempVal) tempVal.textContent = parseFloat(s.temperature ?? 0.7).toFixed(2);
  if (maxVal) maxVal.textContent = s.maxTokens ?? 512;
  if (topVal) topVal.textContent = parseFloat(s.topP ?? 0.9).toFixed(2);

  refreshCacheChips();
  refreshSystemHealth(s.model || AI.DEFAULT_MODEL);
}

async function saveSettings() {
  const get = id => document.getElementById(id);

  const next = {
    model: get('model-select')?.value || AI.DEFAULT_MODEL,
    temperature: parseFloat(get('temperature-input')?.value ?? 0.7),
    maxTokens: parseInt(get('max-tokens-input')?.value ?? 512),
    topP: parseFloat(get('top-p-input')?.value ?? 0.9),
    systemPrompt: get('system-prompt-input')?.value || AI.DEFAULT_SYSTEM,
    theme: get('theme-select')?.value || 'dark',
  };

  for (const [k, v] of Object.entries(next)) await DB.setSetting(k, v);
  Object.assign(app.settings, next);

  setTheme(next.theme);
  refreshModelBadge();
  await refreshSystemHealth(next.model);

  UI.hideModal('settings-modal');

  if (next.model !== AI.getModelId()) {
    UI.showOk('Settings saved. Safety check will run before downloading the new model.');
  } else {
    UI.showOk('Settings saved.');
  }
}

async function refreshCacheChips() {
  const el = document.getElementById('model-cache-status');
  if (!el) return;
  el.innerHTML = '';

  for (const [id, info] of Object.entries(AI.MODELS)) {
    const cached = await AI.isCached(id);
    const chip = document.createElement('div');
    chip.className = 'model-cache-chip';
    chip.innerHTML = `
      <span class="model-cache-chip-name">${info.name} (${info.size})</span>
      <span class="model-cache-chip-status ${cached ? 'cached' : 'not-cached'}">${cached ? 'Cached' : 'Not downloaded'}</span>`;
    el.appendChild(chip);
  }
}


async function refreshSystemHealth(modelId = app.settings.model || AI.DEFAULT_MODEL) {
  const health = await AI.systemHealth(modelId);
  app.lastHealth = health;

  const welcome = document.getElementById('welcome-system-health');
  const settings = document.getElementById('settings-system-health');
  if (welcome) UI.renderSystemHealth(welcome, health);
  if (settings) UI.renderSystemHealth(settings, health);

  const hint = document.getElementById('model-hint');
  if (hint) {
    hint.textContent = health.safe
      ? `${health.modelName}: ${AI.formatMB(health.downloadMB)} first download, needs about ${AI.formatMB(health.storageMB)} free browser storage. ${health.recommended ? 'Recommended for this device.' : 'Usable with caution; see health notes below.'}`
      : `${health.modelName} is blocked for device safety. Choose a smaller model or free storage first.`;
  }

  return health;
}

async function ensureModelSafeToLoad(modelId) {
  const health = await refreshSystemHealth(modelId);
  if (!health.safe) {
    throw new Error(`Download blocked for device safety. ${health.issues.join(' ')}`);
  }

  if (!health.recommended) {
    const notes = health.warnings.length ? `\n\nCaution:\n- ${health.warnings.join('\n- ')}` : '';
    const ok = await UI.confirmDlg(
      'Device Safety Check',
      `${health.modelName} is usable, but not ideal for this device.\n\nDownload: ${AI.formatMB(health.downloadMB)}\nStorage needed: ${AI.formatMB(health.storageMB)}\nFree browser storage: ${health.freeMB === null ? 'Not reported' : AI.formatMB(health.freeMB)}\nDevice memory: ${health.deviceMemoryGB === null ? 'Not reported' : `${health.deviceMemoryGB}GB`}${notes}\n\nContinue only if you are okay with slower performance.`,
      'Continue Download'
    );
    if (!ok) throw new Error('Download cancelled after device safety warning.');
  }

  return health;
}

// ---- import / export ----

async function exportChats() {
  try {
    const data = await DB.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `localmind-${new Date().toISOString().slice(0, 10)}.json`,
    });
    a.click();
    URL.revokeObjectURL(url);
    UI.showOk('Exported.');
  } catch (err) {
    UI.showErr(`Export failed: ${err.message}`);
  }
}

async function importChats(file) {
  try {
    const raw = await file.text();
    await DB.importData(JSON.parse(raw));
    app.convs = await DB.getConvs();
    renderSidebar();
    UI.showOk('Imported.');
  } catch (err) {
    UI.showErr(`Import failed: ${err.message}`);
  }
}

// ---- char counter ----

function updateCounter(val) {
  const el = document.getElementById('char-counter');
  if (!el) return;
  const n = val.length;
  el.textContent = n;
  el.className = 'char-counter' + (n > 3000 ? ' danger' : n > 2000 ? ' warn' : '');
}

// ---- bind all events ----

function bindAll() {
  const $ = id => document.getElementById(id);

  $('new-chat-btn').addEventListener('click', newConv);
  $('start-chat-btn').addEventListener('click', () => { newConv(); focusInput(); });

  $('sidebar-toggle').addEventListener('click', () => {
    $('sidebar').classList.contains('open') ? closeSidebar() : openSidebar();
  });

  $('mobile-back-btn').addEventListener('click', openSidebar);

  document.addEventListener('click', e => {
    const sidebar = $('sidebar');
    const toggle = $('sidebar-toggle');
    if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && !toggle.contains(e.target)) {
      closeSidebar();
    }
  });

  $('send-btn').addEventListener('click', () => {
    const input = $('message-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    UI.resize(input);
    updateSendBtn();
    updateCounter('');
    send(text);
  });

  $('stop-btn').addEventListener('click', AI.stop);

  const input = $('message-input');
  input.addEventListener('input', () => {
    UI.resize(input);
    updateSendBtn();
    updateCounter(input.value);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('send-btn').click(); }
  });

  $('regenerate-btn').addEventListener('click', regenerate);
  $('clear-chat-btn').addEventListener('click', clearChat);

  $('settings-btn').addEventListener('click', () => { syncSettingsUI(); UI.showModal('settings-modal'); });
  $('settings-close-btn').addEventListener('click', () => UI.hideModal('settings-modal'));
  $('settings-backdrop').addEventListener('click', () => UI.hideModal('settings-modal'));
  $('settings-save-btn').addEventListener('click', saveSettings);

  $('model-select').addEventListener('change', e => refreshSystemHealth(e.target.value));

  // live range preview
  $('temperature-input').addEventListener('input', e => { $('temperature-value').textContent = parseFloat(e.target.value).toFixed(2); });
  $('max-tokens-input').addEventListener('input', e => { $('max-tokens-value').textContent = e.target.value; });
  $('top-p-input').addEventListener('input', e => { $('top-p-value').textContent = parseFloat(e.target.value).toFixed(2); });

  $('clear-all-btn').addEventListener('click', async () => {
    const ok = await UI.confirmDlg('Clear All', 'Delete ALL conversations? This cannot be undone.', 'Delete All');
    if (!ok) return;
    await DB.clearAll();
    app.convs = [];
    app.activeId = null;
    app.msgs = [];
    renderSidebar();
    showWelcome();
    UI.hideModal('settings-modal');
    UI.showOk('All conversations deleted.');
  });

  $('clear-cache-btn').addEventListener('click', async () => {
    const ok = await UI.confirmDlg('Clear Cache', 'Remove all downloaded model files?', 'Clear Cache');
    if (!ok) return;
    try {
      await AI.clearCache();
      refreshCacheChips();
      refreshModelBadge('loading');
      UI.showOk('Cache cleared.');
    } catch (e) {
      UI.showErr(e.message);
    }
  });

  $('export-btn').addEventListener('click', exportChats);

  $('import-file').addEventListener('change', e => {
    const f = e.target.files?.[0];
    if (f) importChats(f);
    e.target.value = '';
  });

  $('search-conversations').addEventListener('input', e => {
    app.query = e.target.value;
    renderSidebar();
  });

  $('update-reload-btn').addEventListener('click', () => location.reload());
  $('update-dismiss-btn').addEventListener('click', () => $('update-toast').classList.add('hidden'));
  $('error-toast-close').addEventListener('click', () => $('error-toast').classList.add('hidden'));
  $('cancel-load-btn').addEventListener('click', () => UI.setProgress({ status: 'ready' }));

  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); $('search-conversations').focus(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); newConv(); }
    if (e.key === 'Escape') {
      ['settings-modal', 'rename-modal', 'confirm-modal'].forEach(id => {
        if (!$(id).classList.contains('hidden')) UI.hideModal(id);
      });
    }
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (app.settings.theme === 'system') setTheme('system');
  });
}

// kick off
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
