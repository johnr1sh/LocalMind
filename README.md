# LocalMind — Fully Offline AI Chat PWA

A ChatGPT-style chat app that runs entirely in your browser. No API keys, no server, no tracking. Powered by [Transformers.js](https://huggingface.co/docs/transformers.js) and IndexedDB.

---

## Features

- **100% local inference** — AI runs in your browser via WebAssembly or WebGPU
- **Offline-capable** — works without internet after the first model download
- **No account required** — zero sign-ups, rate limits, or subscriptions
- **Persistent chat history** — stored in IndexedDB, survives page refreshes
- **Resilient model setup** — shared downloads, WebGPU→WASM fallback, dtype fallback, and clear progress diagnostics
- **Browser Helper mode** — if the model cannot download, LocalMind can still explain browser/storage/WebGPU status and recovery steps
- **Multi-model support** — SmolLM2 360M, Qwen2.5 0.5B, Phi-3.5 Mini
- **Streaming responses** — real-time token output
- **Markdown rendering** — code blocks, lists, bold, italic, links
- **Installable PWA** — works on Android, iOS, and desktop
- **Deployment-aware versioning** — displays the running service-worker commit and latest Vercel deployment
- **Optimistic app updates** — commit-versioned cache namespaces, automatic activation, reload coordination, and periodic update checks
- **Import / export** — back up and restore conversations as JSON
- **Dark and light themes** — with system preference detection
- **Full-text local search** — find conversations by title or message content without sending data anywhere
- **Pinned conversations** — keep important chats at the top of the sidebar
- **Markdown chat export** — save an individual conversation as a portable `.md` file
- **Quick-start prompts** — launch common writing, learning, coding, and brainstorming tasks
- **Keyboard shortcuts** — `Ctrl+N` new chat, `Ctrl+K` search

---

## Architecture Decision Record

### ADR-001: Client-only, no backend

**Status:** Accepted

**Context:** Running LLMs requires either a GPU server (expensive, privacy concerns) or a client-side runtime. The goal is zero server cost and complete data privacy.

**Decision:** Use Transformers.js (ONNX Runtime Web) entirely in the browser. Static files only — no serverless functions, no DB, no auth.

**Consequences:**
- Models must be downloaded to the client (one-time, ~360MB–2.3GB)
- Generation speed depends on the user's device (WebGPU >> WASM)
- No streaming from a server — streaming is real via TextStreamer tokens
- Deployable to any static host (Vercel, Netlify, GitHub Pages, S3)

### ADR-002: Vanilla JS ES Modules, no framework

**Status:** Accepted

**Context:** A framework (React, Vue) would add bundle complexity and require a build step, which conflicts with the goal of zero backend and simple deployment.

**Decision:** Plain ES Modules split across `app.js` (controller), `ai.js` (inference), `db.js` (storage), `ui.js` (rendering). No bundler. Modules loaded directly via `<script type="module">`.

**Consequences:**
- No hot reload (use live-server locally)
- No tree-shaking (not needed — the CDN handles Transformers.js)
- Easy to read and audit — no framework magic

### ADR-003: IndexedDB over localStorage

**Status:** Accepted

**Context:** localStorage has a ~5MB quota, synchronous API, and doesn't handle binary data well. Conversations + long AI responses will exceed this quickly.

**Decision:** IndexedDB via raw IDBRequest promises (no lib). Three stores: `conversations`, `messages`, `settings`.

**Trade-offs:**
- More verbose API vs localStorage (mitigated by `wrap()` helper)
- Async everywhere (fine — all callers are async anyway)
- Survives PWA reinstall, works in private browsing (with limits)

### ADR-004: Service worker cache strategy

**Status:** Accepted

**Decision:** Static assets → Cache First. HTML → Network First. Transformers.js CDN → Cache First. Model weights are **not** handled by the service worker; Transformers.js caches them itself in `transformers-cache` (caching them twice doubled disk use and buffered the whole download in RAM).

**Why not precache model weights?** They're 360MB–2.3GB. Precaching at SW install time would fail on most devices and block SW activation. Lazy caching on first use is safer.

---

## System Design

```
┌─────────────────────────────────────────────────────┐
│                    Browser Tab                       │
│                                                      │
│  ┌──────────┐    ┌──────────┐    ┌────────────────┐ │
│  │  app.js  │───▶│  db.js   │    │  service-      │ │
│  │(control) │    │(IndexedDB│    │  worker.js     │ │
│  └────┬─────┘    │  3 stores│    │(cache manager) │ │
│       │          └──────────┘    └────────────────┘ │
│  ┌────▼─────┐                                        │
│  │  ai.js   │◀── Transformers.js (CDN, cached)       │
│  │ pipeline │                                        │
│  │(WASM/GPU)│◀── Model weights (HF, cached)          │
│  └────┬─────┘                                        │
│       │                                              │
│  ┌────▼─────┐                                        │
│  │  ui.js   │──▶ DOM (index.html + styles.css)       │
│  │(renderer)│                                        │
│  └──────────┘                                        │
└─────────────────────────────────────────────────────┘
```

**Data flow for a chat message:**

1. User types → `send()` in app.js
2. Message saved to IndexedDB (`db.addMsg`)
3. DOM updated immediately (optimistic)
4. `ai.generate()` called with last 20 messages as context
5. TextStreamer tokens stream into `ui.streamingEl()` chunk by chunk
6. On completion, full message saved to IndexedDB
7. Sidebar timestamp updated

---

## Supported Models

| Model (Hugging Face repo) | Download | Runs on | Notes |
|-------|------|-------|---------|
| `HuggingFaceTB/SmolLM2-360M-Instruct` | ~300MB (WebGPU q4f16) / ~420MB (CPU q4) | WebGPU or CPU | Default, safest |
| `onnx-community/Qwen2.5-0.5B-Instruct` | ~485MB (WebGPU q4f16) / ~515MB (CPU q8) | WebGPU or CPU | Better quality |
| `onnx-community/Phi-3.5-mini-instruct-onnx-web` | ~2.3GB (q4f16 only) | **WebGPU with shader-f16 only** | Largest; blocked on devices without it |

> The official `Qwen/Qwen2.5-0.5B-Instruct` repo has no `onnx/` folder, so it can never load in
> Transformers.js. Old saved settings pointing at it are migrated automatically.

The app defaults to SmolLM2 360M — it's the best balance of speed and quality for browser inference. First-run downloads start when the user sends a message, so the welcome screen stays usable instead of blocking behind a large model transfer. If loading fails, Browser Helper mode provides diagnostics and recovery steps.

---

## Browser Support

| Browser | Support |
|---------|---------|
| Chrome 90+ | Full (WebGPU if available) |
| Edge 90+ | Full (WebGPU if available) |
| Brave | Full |
| Firefox | Partial (WASM only, no WebGPU yet) |
| Safari 17+ | Partial (WASM only) |
| Mobile Chrome | Full (WASM) |

**WebGPU** gives 3–5× faster inference. The app auto-detects and falls back to WebAssembly if WebGPU isn't available.

---

## Local Development

No build step required.

```bash
# Clone
git clone https://github.com/your-user/localmind.git
cd localmind

# Serve (any static server works)
npx serve .
# or
python3 -m http.server 3000
# or
npx live-server
```

Open `http://localhost:3000` in Chrome or Edge.

> **Note:** Service workers require HTTPS in production, but `localhost` is exempt.

---

## Vercel Deployment

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project
3. Import your repo
4. No configuration needed — Vercel detects it as a static site
5. Click **Deploy**

Or deploy via CLI:

```bash
npm i -g vercel
vercel --prod
```

The included `vercel.json` adds security headers and disables caching for the version endpoint. The `/api/version` function returns Vercel's deployment commit metadata; it does not handle chat data or model inference.

---

## PWA Installation

### Android (Chrome)
1. Open the app in Chrome
2. Tap the three-dot menu → "Add to Home Screen"
3. Tap "Install"

### Desktop (Chrome / Edge)
1. Open the app
2. Look for the install icon in the address bar (⊕)
3. Click "Install"

### iOS (Safari)
1. Open the app in Safari
2. Tap the share icon
3. Tap "Add to Home Screen"

---

## Deployment Version and Updates

Open Settings → Application Version to compare the service worker currently controlling the page with the latest deployed commit. LocalMind checks for deployments on startup, when the tab becomes visible, and every five minutes while the app is open. New workers use a commit-specific cache, activate immediately, and trigger one coordinated reload. Model weights remain cached separately and are preserved across app updates. If the version endpoint cannot be reached, the app reports that deployment status cannot be verified and keeps the current cached version usable.

## Offline Usage

1. Open the app while online — the service worker caches static files automatically
2. Start a chat — this triggers the model download (~360MB for SmolLM2)
3. Wait for "Ready" badge in the welcome screen
4. You can now close your internet connection and use the app fully offline

The model is stored in the browser's Cache Storage and persists until you:
- Manually clear it via Settings → Clear Model Cache
- Clear browser data
- Uninstall the PWA

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift + Enter` | New line in message |
| `Ctrl/Cmd + N` | New conversation |
| `Ctrl/Cmd + K` | Focus search |
| `Escape` | Close modal |

---

## Import / Export

**Export:** Sidebar → Export Chats → saves `localmind-YYYY-MM-DD.json`

**Import:** Sidebar → Import Chats → select a previously exported `.json` file

The export format is versioned (`"version": 1`) for forward compatibility.

---

## Troubleshooting

**Model never finishes loading / "Browser Helper mode" right away**
- Open DevTools → Network and look for a red `404` on `huggingface.co/.../onnx/model_*.onnx`.
  That means the repo/dtype combo in `MODELS` (ai.js) has no such file.
- Allow `cdn.jsdelivr.net`, `huggingface.co` and `*.hf.co` through any ad blocker/proxy.
- Settings → Clear Model Cache, then retry. After updating from an older version, reload twice
  so the new service worker takes over (it also deletes the old duplicate model cache).

**Model download is slow or fails**
- Check your internet connection
- Try a different network (some corporate proxies block HuggingFace)
- The model caches after the first download — subsequent loads are instant

**"std::bad_alloc", "Can't create a session", or "ERROR_CODE: 6" during model load**
- This is an ONNX Runtime memory-allocation failure, not a browser storage-quota error. Model files may fit in Cache Storage while the runtime still cannot reserve enough working memory.
- Close memory-heavy tabs and applications, fully restart Chrome/Edge, keep SmolLM2 360M selected, then use Settings → Retry Model Load.
- LocalMind uses one WASM thread during initialization to reduce temporary memory pressure. If the browser has a usable WebGPU adapter, enable hardware acceleration and restart the browser so LocalMind can prefer the GPU backend.
- The `/browser` diagnostic now distinguishes WebGPU API presence from a successfully-created adapter. A present API alone does not guarantee that WebGPU inference can start.

**"Out of memory" or "Array buffer allocation failed" error**
- Try a smaller model (SmolLM2 360M is the most memory-efficient)
- Close other browser tabs/apps to free RAM and then reload LocalMind
- Reduce Max Tokens in Settings; LocalMind also auto-caps generation on low-memory devices
- On mobile, 4GB+ RAM is recommended for SmolLM2 and 6GB+ for the 0.5B model

**Responses are very slow**
- WebGPU is not available in your browser — the app is using CPU (WASM)
- Use Chrome or Edge for WebGPU support
- Reduce Max Tokens in Settings to get faster responses

**App doesn't work offline**
- Make sure you opened the app at least once while online
- The model download must complete before offline use works
- Check that your browser allows service workers (not in incognito with SW blocked)

**Chat history is gone after browser update**
- Some browser updates clear IndexedDB — use Export Chats regularly as a backup

---

## Project Structure

```
localmind/
├── index.html          # App shell, all HTML
├── styles.css          # All styles, CSS variables, responsive
├── app.js              # Main controller, state, event binding
├── ai.js               # Transformers.js wrapper, model loading
├── db.js               # IndexedDB layer (convs, messages, settings)
├── ui.js               # DOM rendering helpers, markdown, toasts
├── service-worker.js   # PWA caching strategy
├── manifest.json       # PWA manifest
├── vercel.json         # Deployment config
├── api/version.js      # Vercel deployment metadata endpoint
├── icons/              # PWA icons (PNG + SVG)
└── README.md
```

---

## License

MIT — do whatever you want with it.
