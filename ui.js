/**
 * ui.js
 * DOM rendering helpers — messages, sidebar, modals, toasts, progress.
 * No state held here; everything is pure render/utility.
 */

// ---- markdown ----

export function md(text) {
  let h = esc(text);

  // fenced code blocks
  h = h.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const raw = code.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const hi = highlight(raw, lang);
    return `<div class="code-block-wrap">
      <div class="code-block-header">
        <span class="code-lang">${esc(lang || 'text')}</span>
        <button class="code-copy" data-code="${encodeURIComponent(raw)}">Copy</button>
      </div>
      <pre><code>${hi}</code></pre>
    </div>`;
  });

  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  h = h.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  h = h.replace(/_(.+?)_/g, '<em>$1</em>');
  h = h.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // lists
  h = h.replace(/(^[-*] .+\n?)+/gm, block => {
    const items = block.trim().split('\n').filter(Boolean)
      .map(l => `<li>${l.replace(/^[-*] /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });
  h = h.replace(/(^\d+\. .+\n?)+/gm, block => {
    const items = block.trim().split('\n').filter(Boolean)
      .map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // paragraphs
  h = h.split(/\n{2,}/).map(p => {
    if (/^<(h[1-6]|ul|ol|blockquote|div)/.test(p)) return p;
    return `<p>${p.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  return h;
}

function esc(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function highlight(code, lang) {
  const supported = ['js', 'javascript', 'ts', 'typescript', 'python', 'py', 'html', 'css', 'json', 'bash', 'sh'];
  if (!supported.includes(lang)) return esc(code);

  let out = esc(code);
  out = out.replace(/(\/\/.*?$|#.*?$)/gm, '<span style="color:#8b949e">$1</span>');
  out = out.replace(/(&quot;.*?&quot;|&#39;.*?&#39;|`.*?`)/g, '<span style="color:#a5d6ff">$1</span>');
  const kws = 'const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|new|this|true|false|null|undefined|def|print|in|not|and|or|is|pass|break|continue|yield|try|catch|throw|typeof|instanceof';
  out = out.replace(new RegExp(`\\b(${kws})\\b`, 'g'), '<span style="color:#ff7b72">$1</span>');
  out = out.replace(/\b(\d+\.?\d*)\b/g, '<span style="color:#79c0ff">$1</span>');
  return out;
}

function ts(time) {
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ---- message elements ----

export function msgEl(msg) {
  const row = document.createElement('div');
  row.className = `message-row ${msg.role === 'user' ? 'user' : 'ai'}`;
  row.dataset.msgId = msg.id;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.innerHTML = msg.role === 'user'
    ? 'U'
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M8 12h8M12 8v8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

  const wrap = document.createElement('div');
  wrap.className = 'message-content-wrap';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.setAttribute('role', 'article');

  if (msg.role === 'user') {
    bubble.textContent = msg.content;
  } else {
    bubble.innerHTML = md(msg.content);
    bindCodeCopy(bubble);
  }

  const meta = document.createElement('div');
  meta.className = 'message-meta';

  const time = document.createElement('span');
  time.className = 'message-time';
  time.textContent = ts(msg.createdAt || Date.now());
  meta.appendChild(time);

  if (msg.role !== 'user') {
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.setAttribute('aria-label', 'Copy');
    btn.innerHTML = copyIcon() + ' Copy';
    btn.addEventListener('click', () => copyText(msg.content, btn));
    meta.appendChild(btn);
  }

  wrap.appendChild(bubble);
  wrap.appendChild(meta);
  row.appendChild(avatar);
  row.appendChild(wrap);
  return row;
}

// returns handlers to update a streaming placeholder
export function streamingEl(id) {
  const row = document.createElement('div');
  row.className = 'message-row ai';
  row.dataset.msgId = id;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5"/><path d="M8 12h8M12 8v8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

  const wrap = document.createElement('div');
  wrap.className = 'message-content-wrap';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  const time = document.createElement('span');
  time.className = 'message-time';
  time.textContent = ts(Date.now());
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.setAttribute('aria-label', 'Copy');
  copyBtn.innerHTML = copyIcon() + ' Copy';
  meta.appendChild(time);
  meta.appendChild(copyBtn);

  wrap.appendChild(bubble);
  wrap.appendChild(meta);
  row.appendChild(avatar);
  row.appendChild(wrap);

  let buf = '';

  return {
    el: row,
    push(chunk) {
      buf += chunk;
      bubble.innerHTML = md(buf) + '<span class="cursor" aria-hidden="true">▋</span>';
      bindCodeCopy(bubble);
    },
    done(full) {
      buf = full;
      bubble.innerHTML = md(full);
      bindCodeCopy(bubble);
      copyBtn.addEventListener('click', () => copyText(full, copyBtn));
    },
  };
}

function bindCodeCopy(el) {
  el.querySelectorAll('.code-copy').forEach(btn => {
    btn.onclick = () => {
      const code = decodeURIComponent(btn.dataset.code || '');
      copyText(code, btn, 'Copied!');
    };
  });
}

async function copyText(text, btn, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // clipboard API blocked — fallback
    const ta = Object.assign(document.createElement('textarea'), {
      value: text, style: 'position:fixed;opacity:0',
    });
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  const orig = btn.innerHTML;
  btn.textContent = label;
  btn.classList.add('copied');
  setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 2000);
}

function copyIcon() {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

// ---- conversations list ----

export function renderConvList(convs, activeId, handlers, query = '') {
  const el = document.getElementById('conversations-list');
  if (!el) return;

  const filtered = query
    ? convs.filter(c => c.title.toLowerCase().includes(query.toLowerCase()))
    : convs;

  if (!filtered.length) {
    el.innerHTML = `<div class="conversations-empty">${
      query ? 'No matches.' : 'No conversations yet.<br/>Click New Chat to start.'
    }</div>`;
    return;
  }

  const now = Date.now();
  const DAY = 86400000;
  const groups = { Today: [], Yesterday: [], 'This Week': [], Older: [] };
  for (const c of filtered) {
    const age = now - c.updatedAt;
    if (age < DAY) groups['Today'].push(c);
    else if (age < 2 * DAY) groups['Yesterday'].push(c);
    else if (age < 7 * DAY) groups['This Week'].push(c);
    else groups['Older'].push(c);
  }

  el.innerHTML = '';
  for (const [label, items] of Object.entries(groups)) {
    if (!items.length) continue;
    const g = document.createElement('div');
    g.innerHTML = `<div class="conv-group-label">${label}</div>`;
    for (const c of items) g.appendChild(convItem(c, c.id === activeId, handlers));
    el.appendChild(g);
  }
}

function convItem(conv, active, { onSelect, onRename, onDelete }) {
  const item = document.createElement('div');
  item.className = `conv-item${active ? ' active' : ''}`;
  item.dataset.id = conv.id;
  item.setAttribute('role', 'button');
  item.setAttribute('tabindex', '0');
  item.setAttribute('aria-pressed', active);
  item.setAttribute('aria-label', conv.title);

  const name = esc(conv.title);
  item.innerHTML = `
    <span class="conv-item-icon" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </span>
    <span class="conv-item-name">${name}</span>
    <div class="conv-item-actions" role="group">
      <button class="conv-item-btn rename-btn" title="Rename" aria-label="Rename">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="conv-item-btn delete-btn" title="Delete" aria-label="Delete">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>`;

  item.addEventListener('click', e => { if (!e.target.closest('.conv-item-btn')) onSelect(conv.id); });
  item.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.target.closest('.conv-item-btn')) onSelect(conv.id); });
  item.querySelector('.rename-btn').addEventListener('click', e => { e.stopPropagation(); onRename(conv.id, conv.title); });
  item.querySelector('.delete-btn').addEventListener('click', e => { e.stopPropagation(); onDelete(conv.id, conv.title); });

  return item;
}


// ---- toasts ----

let errTimer, okTimer;

export function showErr(msg, ms = 5000) {
  const toast = document.getElementById('error-toast');
  const txt = document.getElementById('error-toast-message');
  if (!toast || !txt) return;
  txt.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(errTimer);
  errTimer = setTimeout(() => toast.classList.add('hidden'), ms);
}

export function showOk(msg, ms = 3000) {
  const toast = document.getElementById('success-toast');
  const txt = document.getElementById('success-toast-message');
  if (!toast || !txt) return;
  txt.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(okTimer);
  okTimer = setTimeout(() => toast.classList.add('hidden'), ms);
}

// ---- modals ----

export function showModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.classList.remove('hidden');
  setTimeout(() => {
    const first = m.querySelector('input, select, textarea, button:not(.modal-close-btn)');
    first?.focus();
  }, 80);
}

export function hideModal(id) {
  document.getElementById(id)?.classList.add('hidden');
}

export function promptRename(current) {
  return new Promise(res => {
    const input = document.getElementById('rename-input');
    const ok = document.getElementById('rename-confirm-btn');
    const cancel = document.getElementById('rename-cancel-btn');
    const close = document.getElementById('rename-close-btn');

    input.value = current;
    showModal('rename-modal');
    input.select();

    const cleanup = () => {
      hideModal('rename-modal');
      ok.removeEventListener('click', confirm);
      cancel.removeEventListener('click', dismiss);
      close.removeEventListener('click', dismiss);
      input.removeEventListener('keydown', keydown);
    };

    const confirm = () => { const v = input.value.trim(); cleanup(); res(v || null); };
    const dismiss = () => { cleanup(); res(null); };
    const keydown = e => { if (e.key === 'Enter') { e.preventDefault(); confirm(); } if (e.key === 'Escape') dismiss(); };

    ok.addEventListener('click', confirm);
    cancel.addEventListener('click', dismiss);
    close.addEventListener('click', dismiss);
    input.addEventListener('keydown', keydown);
  });
}

export function confirmDlg(title, msg, okLabel = 'Delete') {
  return new Promise(res => {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = msg;
    document.getElementById('confirm-ok-btn').textContent = okLabel;
    showModal('confirm-modal');

    const ok = document.getElementById('confirm-ok-btn');
    const cancel = document.getElementById('confirm-cancel-btn');
    const backdrop = document.getElementById('confirm-backdrop');

    const cleanup = () => {
      hideModal('confirm-modal');
      ok.removeEventListener('click', yes);
      cancel.removeEventListener('click', no);
      backdrop.removeEventListener('click', no);
    };

    const yes = () => { cleanup(); res(true); };
    const no = () => { cleanup(); res(false); };

    ok.addEventListener('click', yes);
    cancel.addEventListener('click', no);
    backdrop.addEventListener('click', no);
  });
}

// ---- progress bar ----

export function setProgress({ status, progress, text, file, loaded, total, device, dtype, health, modelName, downloadMB }) {
  const panel = document.getElementById('model-loading-panel');
  const bar = document.getElementById('progress-bar');
  const wrap = document.getElementById('progress-bar-wrap');
  const pct = document.getElementById('progress-percent');
  const txt = document.getElementById('progress-text');
  const title = document.getElementById('model-loading-title');
  const desc = document.getElementById('model-loading-desc');
  const healthEl = document.getElementById('model-loading-health');

  if (!panel) return;

  if (status === 'ready') { panel.classList.add('hidden'); return; }

  if (status === 'fallback') {
    panel.classList.add('hidden');
    return;
  }

  panel.classList.remove('hidden');
  if (healthEl && health) renderSystemHealth(healthEl, health, { compact: true });

  const expectedMB = downloadMB || health?.downloadMB;

  if (status === 'initiate') {
    title.textContent = 'Checking Device Safety';
    desc.textContent = text || 'Verifying storage, memory, and browser capability before downloading.';
    bar.style.width = '0%';
    wrap.removeAttribute('data-indeterminate');
    pct.textContent = '0%';
    txt.textContent = expectedMB ? `No download started yet · expected ${formatSize(expectedMB)} download` : (text || 'Starting…');
    if (device || dtype) desc.textContent = `Starting ${device?.toUpperCase() || 'browser'} (${dtype || 'auto'}). Keep this tab open.`;
    return;
  }

  if (status === 'retry') {
    title.textContent = 'Trying Safer Runtime';
    desc.textContent = text || 'The previous runtime failed. Trying a safer fallback automatically.';
    txt.textContent = `${device || 'Runtime'} ${dtype || ''}`.trim();
    bar.style.width = '12%';
    wrap.removeAttribute('data-indeterminate');
    pct.textContent = '12%';
    return;
  }

  if (status === 'download' || status === 'progress') {
    const hasProgress = Number.isFinite(progress) && progress > 0;
    const p = hasProgress ? Math.max(1, Math.min(100, Math.round(progress))) : 0;
    const fname = file ? file.split('/').pop() : `${modelName || 'Model'} files`;
    const lMB = Number.isFinite(loaded) ? (loaded / 1048576).toFixed(1) : null;
    const tMB = Number.isFinite(total) && total > 0 ? (total / 1048576).toFixed(1) : null;

    wrap.setAttribute('aria-valuenow', p);
    pct.textContent = hasProgress ? `${p}%` : 'Starting';
    if (hasProgress) {
      wrap.removeAttribute('data-indeterminate');
      bar.style.width = `${p}%`;
    } else {
      wrap.setAttribute('data-indeterminate', 'true');
      bar.style.width = '36%';
    }

    if (tMB) {
      txt.textContent = `${fname} — ${lMB || '0.0'}MB / ${tMB}MB`;
    } else if (lMB) {
      txt.textContent = `${fname} — received ${lMB}MB · expected about ${formatSize(expectedMB)}`;
    } else {
      txt.textContent = `${fname} — waiting for browser progress · expected about ${formatSize(expectedMB)}`;
    }
    title.textContent = 'Downloading Private AI Model';
    desc.textContent = device
      ? `Using ${device.toUpperCase()} (${dtype || 'auto'}). Download continues only after the safety check passed.`
      : 'Download continues only after the safety check passed. Keep this tab open.';
  }

  if (status === 'loading') {
    title.textContent = 'Loading Model into Memory';
    txt.textContent = file ? `Loading ${file.split('/').pop()}…` : (text || 'Loading…');
    wrap.removeAttribute('data-indeterminate');
    bar.style.width = '90%';
    pct.textContent = '90%';
  }
}

function formatSize(mb) {
  if (!Number.isFinite(mb)) return 'unknown size';
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${Math.round(mb)}MB`;
}

export function renderSystemHealth(el, health, { compact = false } = {}) {
  if (!el || !health) return;
  const status = health.level === 'good' ? 'Recommended' : health.level === 'warn' ? 'Use with caution' : 'Blocked for safety';
  const details = [
    ['Model download', formatSize(health.downloadMB)],
    ['Free browser storage', health.freeMB === null ? 'Not reported' : formatSize(health.freeMB)],
    ['Storage needed', formatSize(health.storageMB)],
    ['Device memory', health.deviceMemoryGB === null ? 'Not reported' : `${health.deviceMemoryGB}GB`],
    ['WebGPU', health.webgpu ? 'Available' : 'Not available'],
  ];

  el.className = `system-health system-health-${health.level}${compact ? ' compact' : ''}`;
  el.innerHTML = `
    <div class="system-health-head">
      <span class="system-health-dot" aria-hidden="true"></span>
      <div>
        <strong>${esc(status)}</strong>
        <p>${esc(health.cached ? 'Model is already cached on this device.' : health.modelName + ' will run locally after the first download.')}</p>
      </div>
    </div>
    <div class="system-health-grid">
      ${details.map(([k, v]) => `<div><span>${esc(k)}</span><strong>${esc(String(v))}</strong></div>`).join('')}
    </div>
    ${health.issues.length || health.warnings.length ? `<ul class="system-health-notes">
      ${[...health.issues, ...health.warnings].slice(0, compact ? 3 : 6).map(note => `<li>${esc(note)}</li>`).join('')}
    </ul>` : ''}`;
}

// ---- misc helpers ----

export function resize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
}

export function scrollBottom(smooth = true) {
  const c = document.getElementById('messages-container');
  if (c) c.scrollTo({ top: c.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}

export function nearBottom(threshold = 120) {
  const c = document.getElementById('messages-container');
  if (!c) return true;
  return c.scrollHeight - c.scrollTop - c.clientHeight < threshold;
}
