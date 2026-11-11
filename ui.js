/**
 * ui.js
 * DOM rendering helpers — messages, sidebar, modals, toasts, progress.
 * No state held here; everything is pure render/utility.
 */

// ---- markdown ----
//
// Code (fenced and inline) and links are lifted out into a stash BEFORE any other
// rule runs, then restored at the end. Otherwise the emphasis/heading/list rules
// rewrite the inside of code blocks (`**kwargs`, `__init__`, `# comment`, `- item`)
// and the italic rule corrupts the encoded `data-code` attribute of the Copy button.

const BLOCK_MARK = '\u0001';
const INLINE_MARK = '\u0000';

export function md(text) {
  const stash = [];
  const keep = (html, mark) => `${mark}${stash.push(html) - 1}${mark}`;

  let src = String(text ?? '').replace(/[\u0000\u0001]/g, '');

  // Closed fenced blocks, then one unterminated fence (a response that is still streaming).
  src = src.replace(/```([\w+#.-]*)[^\S\n]*\n?([\s\S]*?)```/g,
    (_, lang, code) => `\n${keep(codeBlock(lang, code), BLOCK_MARK)}\n`);
  src = src.replace(/```([\w+#.-]*)[^\S\n]*\n?([\s\S]*)$/,
    (_, lang, code) => `\n${keep(codeBlock(lang, code), BLOCK_MARK)}\n`);

  src = src.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${esc(code)}</code>`, INLINE_MARK));

  const lines = esc(src).split('\n');
  const out = [];
  let para = [];
  let list = null;

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(l => inline(l, stash, keep)).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.type}>${list.items.map(i => `<li>${inline(i, stash, keep)}</li>`).join('')}</${list.type}>`);
    }
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); flushList(); continue; }

    let m;
    if (new RegExp(`^${BLOCK_MARK}\\d+${BLOCK_MARK}$`).test(line.trim())) {
      flushPara(); flushList(); out.push(line.trim());
    } else if ((m = line.match(/^(#{1,6}) +(.+)$/))) {
      flushPara(); flushList();
      out.push(`<h${m[1].length}>${inline(m[2], stash, keep)}</h${m[1].length}>`);
    } else if (/^ {0,3}([-*_])( *\1){2,}$/.test(line)) {
      flushPara(); flushList(); out.push('<hr>');
    } else if ((m = line.match(/^&gt; ?(.*)$/))) {
      flushPara(); flushList();
      out.push(`<blockquote>${inline(m[1], stash, keep)}</blockquote>`);
    } else if ((m = line.match(/^\s*[-*+] +(.+)$/))) {
      flushPara();
      if (list && list.type !== 'ul') flushList();
      (list ||= { type: 'ul', items: [] }).items.push(m[1]);
    } else if ((m = line.match(/^\s*\d+[.)] +(.+)$/))) {
      flushPara();
      if (list && list.type !== 'ol') flushList();
      (list ||= { type: 'ol', items: [] }).items.push(m[1]);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();

  // Restore stashed HTML; links can contain inline-code placeholders, so loop.
  let html = out.join('');
  const marker = /[\u0000\u0001](\d+)[\u0000\u0001]/g;
  for (let pass = 0; pass < 4 && marker.test(html); pass += 1) {
    marker.lastIndex = 0;
    html = html.replace(marker, (_, i) => stash[Number(i)] ?? '');
  }
  return html;
}

function inline(s, stash, keep) {
  // Links first, so `_`/`*` inside a URL can never be treated as emphasis.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, rawHref) => {
    const href = safeMarkdownHref(unesc(rawHref.trim()));
    const text = emphasis(label);
    return keep(href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow">${text}</a>`
      : text, INLINE_MARK);
  });
  return emphasis(s);
}

function emphasis(s) {
  return s
    .replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=[^*\s])([^*\n]*?[^*\s])\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^_\s])([^_\n]*?[^_\s])_(?!\w)/g, '$1<em>$2</em>');
}

function codeBlock(lang, code) {
  const label = lang || 'text';
  const raw = code.replace(/\n$/, '');
  return `<div class="code-block-wrap">
      <div class="code-block-header">
        <span class="code-lang">${esc(label)}</span>
        <button class="code-copy" data-code="${esc(encodeURIComponent(raw))}">Copy</button>
      </div>
      <pre><code>${highlight(raw, label.toLowerCase())}</code></pre>
    </div>`;
}

function safeMarkdownHref(value) {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (value.startsWith('//')) return null;

  try {
    const parsed = new URL(value, document.baseURI);
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return null;
    if (parsed.protocol === 'mailto:' && !/^mailto:[^\s@]+@[^\s@]+$/i.test(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function esc(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function unesc(t) {
  return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// Highlighting runs on the RAW code in a single tokenizing pass and escapes every
// piece itself. (The old version highlighted already-escaped text, so the `#` in
// `&#39;` turned the rest of any line containing an apostrophe into a "comment".)
const KEYWORDS = 'const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|new|this|true|false|null|undefined|def|print|in|not|and|or|is|pass|break|continue|yield|try|catch|throw|typeof|instanceof|None|True|False|elif|except|with|as|lambda|self|echo|fi|then|do|done';
const LANGS = {
  js: 'c', javascript: 'c', ts: 'c', typescript: 'c',
  python: 'hash', py: 'hash', bash: 'hash', sh: 'hash',
  html: 'plain', css: 'plain', json: 'plain',
};
const TOKENS = {
  c: new RegExp(`(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'|\`(?:\\\\.|[^\`\\\\])*\`)|\\b(${KEYWORDS})\\b|\\b(\\d+(?:\\.\\d+)?)\\b`, 'g'),
  hash: new RegExp(`(#[^\\n]*)|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*')|\\b(${KEYWORDS})\\b|\\b(\\d+(?:\\.\\d+)?)\\b`, 'g'),
  plain: new RegExp(`(\\/\\*[\\s\\S]*?\\*\\/)|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*')|\\b(true|false|null)\\b|\\b(\\d+(?:\\.\\d+)?)\\b`, 'g'),
};
const COLORS = ['#8b949e', '#a5d6ff', '#ff7b72', '#79c0ff'];

function highlight(code, lang) {
  const kind = LANGS[lang];
  if (!kind) return esc(code);

  const re = TOKENS[kind];
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  for (const m of code.matchAll(re)) {
    out += esc(code.slice(last, m.index));
    const group = m.findIndex((v, i) => i > 0 && v !== undefined) - 1;
    out += `<span style="color:${COLORS[group]}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
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
  let frame = 0;
  let finished = false;
  copyBtn.addEventListener('click', () => copyText(buf, copyBtn));

  // Re-parsing the whole reply on every token is quadratic; paint at most once per frame.
  const paint = () => {
    frame = 0;
    bubble.innerHTML = md(buf) + '<span class="cursor" aria-hidden="true">▋</span>';
    bindCodeCopy(bubble);
  };

  return {
    el: row,
    push(chunk) {
      buf += chunk;
      if (!frame && !finished) frame = requestAnimationFrame(paint);
    },
    done(full) {
      finished = true;
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      buf = full;
      bubble.innerHTML = md(full);
      bindCodeCopy(bubble);
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
  if (btn.dataset.origHtml === undefined) btn.dataset.origHtml = btn.innerHTML;
  btn.textContent = label;
  btn.classList.add('copied');
  clearTimeout(Number(btn.dataset.copyTimer));
  btn.dataset.copyTimer = String(setTimeout(() => {
    btn.innerHTML = btn.dataset.origHtml;
    btn.classList.remove('copied');
  }, 2000));
}

function copyIcon() {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

// ---- conversations list ----

export function renderConvList(convs, activeId, handlers, query = '') {
  const el = document.getElementById('conversations-list');
  if (!el) return;

  // The controller already searches titles and message bodies; do not filter twice here.
  const filtered = [...convs].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (!filtered.length) {
    el.innerHTML = `<div class="conversations-empty">${
      query ? 'No matches.' : 'No conversations yet.<br/>Click New Chat to start.'
    }</div>`;
    return;
  }

  const pinned = filtered.filter(conv => conv.pinned);
  const recent = filtered.filter(conv => !conv.pinned);
  el.innerHTML = '';
  if (pinned.length) {
    const group = document.createElement('div');
    group.innerHTML = '<div class="conv-group-label">Pinned</div>';
    for (const conv of pinned) group.appendChild(convItem(conv, conv.id === activeId, handlers));
    el.appendChild(group);
  }
  const now = Date.now();
  const DAY = 86400000;
  const groups = { Today: [], Yesterday: [], 'This Week': [], Older: [] };
  for (const c of recent) {
    const age = now - c.updatedAt;
    if (age < DAY) groups.Today.push(c);
    else if (age < 2 * DAY) groups.Yesterday.push(c);
    else if (age < 7 * DAY) groups['This Week'].push(c);
    else groups.Older.push(c);
  }
  for (const [label, items] of Object.entries(groups)) {
    if (!items.length) continue;
    const group = document.createElement('div');
    group.innerHTML = `<div class="conv-group-label">${label}</div>`;
    for (const c of items) group.appendChild(convItem(c, c.id === activeId, handlers));
    el.appendChild(group);
  }
}

function convItem(conv, active, { onSelect, onRename, onDelete, onTogglePin = () => {} }) {
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
      <button class="conv-item-btn pin-btn${conv.pinned ? ' pinned' : ''}" title="${conv.pinned ? 'Unpin' : 'Pin'}" aria-label="${conv.pinned ? 'Unpin conversation' : 'Pin conversation'}" aria-pressed="${Boolean(conv.pinned)}">★</button>
      <button class="conv-item-btn rename-btn" title="Rename" aria-label="Rename">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button class="conv-item-btn delete-btn" title="Delete" aria-label="Delete">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>`;

  item.addEventListener('click', e => { if (!e.target.closest('.conv-item-btn')) onSelect(conv.id); });
  item.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.target.closest('.conv-item-btn')) onSelect(conv.id); });
  item.querySelector('.pin-btn').addEventListener('click', e => { e.stopPropagation(); onTogglePin(conv.id); });
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

// Pending dialog promises, keyed by modal id. Hiding a dialog by any route (Escape,
// backdrop, close button) cancels it, so its listeners never linger and later fire
// a stale confirm (which could delete a conversation the user had backed out of).
const dialogCancel = new Map();

export function hideModal(id) {
  const cancel = dialogCancel.get(id);
  if (cancel) { dialogCancel.delete(id); cancel(); }
  document.getElementById(id)?.classList.add('hidden');
}

export function promptRename(current) {
  return new Promise(res => {
    const input = document.getElementById('rename-input');
    const ok = document.getElementById('rename-confirm-btn');
    const cancel = document.getElementById('rename-cancel-btn');
    const close = document.getElementById('rename-close-btn');

    dialogCancel.get('rename-modal')?.();
    input.value = current;
    showModal('rename-modal');
    input.select();

    const backdrop = document.getElementById('rename-backdrop');
    const cleanup = () => {
      dialogCancel.delete('rename-modal');
      hideModal('rename-modal');
      backdrop?.removeEventListener('click', dismiss);
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
    backdrop?.addEventListener('click', dismiss);
    input.addEventListener('keydown', keydown);
    dialogCancel.set('rename-modal', dismiss);
  });
}

export function confirmDlg(title, msg, okLabel = 'Delete') {
  return new Promise(res => {
    dialogCancel.get('confirm-modal')?.();
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = msg;
    document.getElementById('confirm-ok-btn').textContent = okLabel;
    showModal('confirm-modal');

    const ok = document.getElementById('confirm-ok-btn');
    const cancel = document.getElementById('confirm-cancel-btn');
    const backdrop = document.getElementById('confirm-backdrop');

    const cleanup = () => {
      dialogCancel.delete('confirm-modal');
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
    dialogCancel.set('confirm-modal', no);
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
