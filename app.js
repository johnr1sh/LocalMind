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
  searchMatches: null,
  searchSeq: 0,
};

// ---- boot ----

async function init() {
  if (!supported()) {
    document.getElementById('unsupported-overlay').classList.remove('hidden');
    return;
  }

  await registerSW();
  // Wait until the newly installed worker actually controls this document before
  // importing the CDN-hosted inference runtime or checking model caches.
  if ('serviceWorker' in navigator) {
    try {
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise(resolve => setTimeout(resolve, 2500)),
      ]);
      if (!navigator.serviceWorker.controller) {
        await new Promise(resolve => {
          const done = () => { clearTimeout(timeout); resolve(); };
          const timeout = setTimeout(done, 3000);
          navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
        });
      }
    } catch (err) {
      console.warn('[SW] control wait failed; online inference can still proceed:', err);
    }
  }

  app.settings = await DB.getAllSettings();
  // Older builds saved a model id that has no ONNX weights; map it to a working repo.
  if (app.settings.model) {
    const fixed = AI.normalizeModelId(app.settings.model);
    if (fixed !== app.settings.model) {
      app.settings.model = fixed;
      await DB.setSetting('model', fixed);
    }
  }
  setTheme(app.settings.theme || 'dark');

  app.convs = await DB.getConvs();

  bindAll();

  // Preserve an unsent draft if an update reload happens while the user is typing.
  try {
    const draft = sessionStorage.getItem('localmind-pending-draft');
    const input = document.getElementById('message-input');
    if (draft && input) {
      input.value = draft;
      sessionStorage.removeItem('localmind-pending-draft');
      updateSendBtn();
    }
  } catch { /* session storage may be unavailable in restricted browsing modes */ }

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
  const modelId = AI.normalizeModelId(app.settings.model || AI.DEFAULT_MODEL);
  if (await AI.isCached(modelId)) {
    loadModel(modelId, { showPanel: false, skipConfirm: true }).catch(() => refreshModelBadge('error', modelId));
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

// ---- deployment version + service worker updates ----

let swRegistration = null;
let hadServiceWorkerController = Boolean(navigator.serviceWorker?.controller);
let isReloadingForUpdate = false;
let pendingUpdateReload = false;
let versionPollTimer = null;

async function fetchDeploymentVersion() {
  if (!navigator.onLine) return null;
  try {
    const response = await fetch(new URL('./api/version', document.baseURI), {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Version endpoint returned HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    console.warn('[Version] latest deployment check failed:', err);
    return null;
  }
}

function getWorkerVersion(worker = navigator.serviceWorker?.controller) {
  if (!worker) return Promise.resolve(null);
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, 1800);
    channel.port1.onmessage = event => {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(event.data?.version || null);
    };
    try {
      worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    } catch {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(null);
    }
  });
}

function renderVersionStatus(running, latest, detail = '') {
  const currentEl = document.getElementById('app-version-current');
  const latestEl = document.getElementById('app-version-latest');
  const stateEl = document.getElementById('app-version-state');
  if (!currentEl || !latestEl || !stateEl) return;

  currentEl.textContent = running ? running.slice(0, 12) : 'Not yet controlled';
  latestEl.textContent = latest?.commit ? latest.commit.slice(0, 12) : 'Unavailable';
  const currentCommit = running?.toLowerCase();
  const latestCommit = latest?.commit?.toLowerCase();
  const outdated = Boolean(currentCommit && latestCommit && currentCommit !== latestCommit);

  stateEl.className = `version-status-state ${outdated ? 'is-outdated' : latestCommit ? 'is-current' : 'is-unknown'}`;
  stateEl.textContent = outdated
    ? 'Update available — applying'
    : latestCommit && currentCommit
      ? 'Running latest deployment'
      : latestCommit
        ? 'Waiting for service worker'
        : 'Cannot verify while offline';
  const meta = document.getElementById('app-version-meta');
  if (meta) {
    const details = [
      latest?.environment || 'unknown environment',
      latest?.branch || null,
      latest?.deploymentId ? `deployment ${latest.deploymentId.slice(0, 10)}` : null,
      detail || null,
    ].filter(Boolean);
    meta.textContent = details.join(' · ');
  }
  return outdated;
}

function updateConnectivityUI() {
  const online = navigator.onLine;
  const message = online
    ? 'Online · Local inference · Downloads and updates available'
    : 'Offline · Saved chats available · Cached models can run';
  for (const id of ['connection-status', 'settings-connection-status']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = message;
    el.className = `connection-status ${online ? 'is-online' : 'is-offline'}`;
  }
}

async function registerWorkerForVersion(commit = null) {
  if (!('serviceWorker' in navigator)) return null;
  const workerUrl = commit
    ? `./service-worker.js?v=${encodeURIComponent(commit)}`
    : './service-worker.js';
  const registration = await navigator.serviceWorker.register(workerUrl, {
    scope: './',
    updateViaCache: 'none',
  });
  swRegistration = registration;
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        document.getElementById('update-toast')?.classList.remove('hidden');
        checkForUpdates();
      }
    });
  });
  return registration;
}

async function checkForUpdates() {
  updateConnectivityUI();
  const [latest, running] = await Promise.all([
    fetchDeploymentVersion(),
    getWorkerVersion(),
  ]);
  const outdated = renderVersionStatus(running, latest);
  if (!navigator.onLine) {
    const state = document.getElementById('app-version-state');
    if (state) state.textContent = running
      ? 'Offline mode · Running cached application'
      : 'Offline mode · Waiting for cached application control';
  } else if (outdated) {
    document.getElementById('update-toast')?.classList.remove('hidden');
    swRegistration?.update().catch(err => console.warn('[SW] update check failed:', err));
  }
  return { latest, running, outdated };
}

async function handleConnectionRestored() {
  updateConnectivityUI();
  const latest = await fetchDeploymentVersion();
  try {
    if (latest?.commit) {
      await registerWorkerForVersion(latest.commit);
    } else {
      swRegistration?.update().catch(err => console.warn('[SW] update check failed:', err));
    }
  } catch (err) {
    console.warn('[SW] online update registration failed:', err);
  }
  await checkForUpdates();
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) {
    updateConnectivityUI();
    renderVersionStatus(null, null, 'Service workers are not supported');
    return;
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadServiceWorkerController && !isReloadingForUpdate) {
      pendingUpdateReload = true;
      const message = document.getElementById('update-toast-message');
      if (message) {
        message.textContent = app.generating
          ? 'Update ready. It will apply after the current response finishes.'
          : 'Update installed. Reloading LocalMind…';
      }
      reloadForUpdateWhenSafe();
      return;
    }
    hadServiceWorkerController = true;
    checkForUpdates();
  });

  window.addEventListener('online', handleConnectionRestored);
  window.addEventListener('offline', () => {
    updateConnectivityUI();
    checkForUpdates();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && navigator.onLine) checkForUpdates();
  });

  updateConnectivityUI();
  try {
    // Do not attempt to replace/register a worker while offline. Keep the existing
    // controller and its cached shell; retry versioned registration on reconnect.
    swRegistration = await navigator.serviceWorker.getRegistration() || null;
    if (navigator.onLine) {
      const latest = await fetchDeploymentVersion();
      if (latest?.commit) {
        await registerWorkerForVersion(latest.commit);
      } else if (!swRegistration) {
        // First install on a static host or while Vercel metadata is unavailable.
        await registerWorkerForVersion(null);
      }
      // Never replace a known-good versioned worker with an unversioned fallback.
      await swRegistration?.update().catch(err => console.warn('[SW] update check failed:', err));
    }
    await checkForUpdates();

    if (versionPollTimer) clearInterval(versionPollTimer);
    versionPollTimer = setInterval(() => {
      if (!document.hidden && navigator.onLine) checkForUpdates();
    }, 5 * 60 * 1000);
  } catch (err) {
    console.warn('[SW] registration check failed:', err);
    renderVersionStatus(await getWorkerVersion(), null, 'Keeping the installed offline version');
  }
}

function reloadForUpdateWhenSafe() {
  if (!pendingUpdateReload || isReloadingForUpdate || app.generating) return;
  const input = document.getElementById('message-input');
  try {
    if (input?.value) sessionStorage.setItem('localmind-pending-draft', input.value);
  } catch { /* continue with the update even when session storage is unavailable */ }
  isReloadingForUpdate = true;
  location.reload();
}

async function activateAvailableUpdate() {
  if (swRegistration?.waiting) {
    swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
    return;
  }
  const button = document.getElementById('check-updates-btn');
  if (button) {
    button.disabled = true;
    button.textContent = 'Checking…';
  }
  try {
    const result = await checkForUpdates();
    if (!result.outdated) {
      const state = document.getElementById('app-version-state');
      if (state) state.textContent = result.latest ? 'Already up to date' : 'Could not reach deployment';
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Check for updates';
    }
  }
}

// ---- theme ----

function setTheme(t) {
  const prefer = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', t === 'system' ? (prefer ? 'dark' : 'light') : t);
}

// ---- sidebar ----

function renderSidebar() {
  UI.renderConvList(app.searchMatches || app.convs, app.activeId, {
    onSelect: openConv, onRename: renameConv, onDelete: deleteConv,
    onTogglePin: togglePinConv,
  }, app.query);
}

async function togglePinConv(id) {
  const conv = app.convs.find(item => item.id === id);
  if (!conv) return;
  const pinned = !conv.pinned;
  await DB.updateConv(id, { pinned });
  conv.pinned = pinned;
  renderSidebar();
  UI.showOk(conv.pinned ? 'Conversation pinned.' : 'Conversation unpinned.');
}

async function searchConversations(query) {
  const token = ++app.searchSeq;
  const term = query.trim().toLocaleLowerCase();
  if (!term) { app.searchMatches = null; renderSidebar(); return; }
  const results = [];
  // Scan one conversation at a time to keep peak memory low on large histories.
  for (const conv of app.convs) {
    if ((conv.title || '').toLocaleLowerCase().includes(term)) {
      results.push(conv);
      continue;
    }
    const messages = await DB.getMsgs(conv.id);
    if (messages.some(message => message.content.toLocaleLowerCase().includes(term))) {
      results.push(conv);
    }
    if (token !== app.searchSeq) return;
  }
  if (token !== app.searchSeq) return;
  app.searchMatches = results;
  renderSidebar();
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
  if (app.generating) return;
  // Lock immediately, including while a first-run model download is in progress.
  // Otherwise rapid sends can start parallel generations against one pipeline.
  app.generating = true;

  const wanted = AI.normalizeModelId(app.settings.model || AI.DEFAULT_MODEL);
  if (!AI.isLoaded() || AI.getModelId() !== wanted) {
    const modelId = wanted;
    try {
      await loadModel(modelId);
    } catch (err) {
      // Never generate or save a simulated "Browser Helper" answer as if it were AI.
      // Keep the user's message in history and stop this generation cleanly.
      UI.setProgress({ status: 'ready' });
      UI.showErr(`Local model could not start. No AI response was generated. ${err.message}`, 12000);
      refreshModelBadge('error', modelId);
      document.getElementById('typing-indicator').classList.add('hidden');
      app.generating = false;
      setInputEnabled(true);
      await refreshCacheChips();
      return;
    }
  }

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
    if (!full || !full.trim()) {
      el.remove();
      return;
    }

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
    refreshModelBadge('error', modelIdForGeneration());
    UI.showErr(`Generation failed. No simulated response was saved. ${err.message}`);
    console.error(err);
  } finally {
    clearInterval(scrollInterval);
    autoScroll = false;
    app.generating = false;
    setInputEnabled(true);
    document.getElementById('typing-indicator').classList.add('hidden');
    UI.scrollBottom();
    reloadForUpdateWhenSafe();
  }
}

async function regenerate() {
  if (app.generating || !app.activeId || !app.msgs.length) return;

  // Retry the latest unanswered user message without deleting an older answer.
  const last = app.msgs[app.msgs.length - 1];
  if (last.role === 'assistant') {
    await DB.deleteMsg(last.id);
    app.msgs.pop();
    document.querySelector(`[data-msg-id="${last.id}"]`)?.remove();
  } else if (last.role !== 'user') {
    return;
  }

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

async function loadModel(id, { showPanel = true, skipConfirm = false } = {}) {
  const health = await ensureModelSafeToLoad(id, { skipConfirm });
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

    const name = document.createElement('span');
    name.className = 'model-cache-chip-name';
    name.textContent = `${info.name} · ${info.size}`;

    const status = document.createElement('span');
    status.className = `model-cache-chip-status ${cached ? 'cached' : 'not-cached'}`;
    status.textContent = cached ? 'Downloaded' : 'Not downloaded';

    const actions = document.createElement('div');
    actions.className = 'model-cache-chip-actions';

    const useButton = document.createElement('button');
    useButton.type = 'button';
    useButton.className = 'btn btn-ghost btn-sm';
    useButton.textContent = cached ? 'Use' : 'Download';
    useButton.disabled = app.generating;
    useButton.addEventListener('click', async () => {
      if (app.generating) return;
      useButton.disabled = true;
      useButton.textContent = cached ? 'Loading…' : 'Downloading…';
      try {
        await loadModel(id, { showPanel: true });
        app.settings.model = id;
        await DB.setSetting('model', id);
        const select = document.getElementById('model-select');
        if (select) select.value = id;
        refreshModelBadge('ready', id);
        UI.showOk(`${info.name} is ready for local inference.`);
      } catch (err) {
        refreshModelBadge('error', id);
        UI.showErr(`Could not prepare ${info.name}. ${err.message}`, 12000);
      } finally {
        await refreshCacheChips();
      }
    });
    actions.appendChild(useButton);

    if (cached) {
      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'btn btn-ghost btn-sm';
      removeButton.textContent = 'Remove';
      removeButton.disabled = app.generating;
      removeButton.addEventListener('click', async () => {
        if (app.generating) return;
        const ok = await UI.confirmDlg('Remove model', `Delete the downloaded files for ${info.name}? Your conversations will remain.`, 'Remove');
        if (!ok) return;
        try {
          await AI.clearModelCache(id);
          await refreshCacheChips();
          UI.showOk(`${info.name} download removed.`);
        } catch (err) {
          UI.showErr(`Could not remove model files. ${err.message}`);
        }
      });
      actions.appendChild(removeButton);
    }

    chip.append(name, status, actions);
    el.appendChild(chip);
  }
}

async function refreshSystemHealth(modelId = app.settings.model || AI.DEFAULT_MODEL) {
  const health = await AI.systemHealth(AI.normalizeModelId(modelId));
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

async function ensureModelSafeToLoad(modelId, { skipConfirm = false } = {}) {
  const health = await refreshSystemHealth(modelId);
  if (!health.safe) {
    throw new Error(`Download blocked for device safety. ${health.issues.join(' ')}`);
  }

  // Only interrupt the user for a genuinely big first download; every non-8GB or
  // non-WebGPU device used to get a scary dialog before even the 300MB model.
  const needsConfirm = !health.cached && !skipConfirm && health.downloadMB >= 1000 && !health.recommended;
  if (needsConfirm) {
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

async function exportCurrentChat() {
  if (!app.activeId) return UI.showErr('Open a conversation before exporting it.');
  try {
    const conv = app.convs.find(item => item.id === app.activeId);
    const messages = await DB.getMsgs(app.activeId);
    const title = conv?.title || 'Conversation';
    const body = messages.filter(m => m.role !== 'system').map(m =>
      `## ${m.role === 'assistant' ? 'LocalMind' : 'You'}\n\n${m.content}`
    ).join('\n\n');
    const markdown = `# ${title}\n\nExported from LocalMind on ${new Date().toLocaleString()}.\n\n${body}\n`;
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const safe = title.normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'conversation';
    const link = Object.assign(document.createElement('a'), { href: url, download: `localmind-${safe}.md` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    UI.showOk('Conversation exported as Markdown.');
  } catch (err) { UI.showErr(`Conversation export failed: ${err.message}`); }
}

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
  $('export-current-chat-btn').addEventListener('click', exportCurrentChat);
  document.querySelectorAll('[data-prompt]').forEach(button => {
    button.addEventListener('click', async () => {
      if (!button.dataset.prompt || app.generating) return;
      await newConv();
      await send(button.dataset.prompt);
    });
  });
  $('clear-chat-btn').addEventListener('click', clearChat);

  $('settings-btn').addEventListener('click', () => { syncSettingsUI(); UI.showModal('settings-modal'); });
  $('settings-close-btn').addEventListener('click', () => UI.hideModal('settings-modal'));
  $('settings-backdrop').addEventListener('click', () => UI.hideModal('settings-modal'));
  $('settings-save-btn').addEventListener('click', saveSettings);

  $('model-select').addEventListener('change', e => refreshSystemHealth(e.target.value));

  $('retry-model-btn').addEventListener('click', async () => {
    const button = $('retry-model-btn');
    if (app.generating || button.disabled) return;
    const modelId = AI.normalizeModelId($('model-select')?.value || app.settings.model || AI.DEFAULT_MODEL);
    button.disabled = true;
    button.textContent = 'Retrying…';
    try {
      AI.resetModel();
      await loadModel(modelId, { showPanel: true, skipConfirm: false });
      UI.showOk(`${AI.MODELS[modelId]?.name || 'Model'} loaded successfully.`);
      await refreshCacheChips();
    } catch (err) {
      refreshModelBadge('fallback', modelId);
      UI.showErr(`Model retry failed. No AI response was generated. ${err.message}`, 12000);
    } finally {
      button.disabled = false;
      button.textContent = 'Retry Model Load';
    }
  });

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

  let searchTimer;
  $('search-conversations').addEventListener('input', e => {
    app.query = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => searchConversations(app.query), 120);
  });

  $('update-reload-btn').addEventListener('click', activateAvailableUpdate);
  $('check-updates-btn').addEventListener('click', activateAvailableUpdate);
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
