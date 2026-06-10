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
- **Import / export** — back up and restore conversations as JSON
- **Dark and light themes** — with system preference detection
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

**Decision:** Static assets → Cache First. HTML → Network First. Model weights → Cache First (own bucket). Transformers.js CDN → Cache First.

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

| Model | Size | Speed | Quality |
|-------|------|-------|---------|
| SmolLM2 360M Instruct | ~360MB | Fast | Good |
| Qwen2.5 0.5B Instruct | ~500MB | Medium | Better |
| Phi-3.5 Mini Instruct | ~2.3GB | Slow | Best |

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

The included `vercel.json` adds security headers and proper MIME types.

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

**Model download is slow or fails**
- Check your internet connection
- Try a different network (some corporate proxies block HuggingFace)
- The model caches after the first download — subsequent loads are instant

**"Out of memory" error**
- Try a smaller model (SmolLM2 360M is the most memory-efficient)
- Close other browser tabs to free RAM
- On mobile, 4GB+ RAM is recommended for the 0.5B model

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
├── icons/              # PWA icons (PNG + SVG)
└── README.md
```

---

## License

MIT — do whatever you want with it.
