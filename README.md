# LocalMind — AI Chat (Offline Compatability)

A ChatGPT-style hybrid online/offline app that runs AI models locally in your browser. Internet access is used for first-time model downloads and application updates; once the app shell and a model are cached, chat, history, and inference continue offline. No cloud inference, API keys, accounts, or tracking. Powered by [Transformers.js](https://huggingface.co/docs/transformers.js) and IndexedDB.

---

## Features

- **Hybrid online/offline access** — open and use LocalMind online or offline after the first successful app/model setup
- **100% local inference** — AI runs on the device via WebAssembly or WebGPU, even while connected
- **Offline-first data** — conversations and settings remain in IndexedDB; no cloud sync is required
- **Reconnect-aware updates** — checks deployment versions and installs app updates when internet returns
- **No account required** — zero sign-ups, rate limits, or subscriptions
- **Persistent chat history** — stored in IndexedDB, survives page refreshes
- **Resilient model setup** — shared downloads, WebGPU→WASM fallback, dtype fallback, and clear progress diagnostics
- **Browser diagnostics** — send `/browser` to inspect storage, WebGPU, WASM, network, and device capabilities
- **Multi-model library** — SmolLM2 135M and 360M, Qwen2.5 0.5B and 1.5B, Phi-3.5 Mini; download, activate, and remove models independently
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

### ADR-001: Hybrid access, local-first inference

**Status:** Accepted

**Context:** LocalMind should remain accessible without internet while still benefiting from online delivery of app updates and first-time model downloads.

**Decision:** Run all inference locally with Transformers.js (ONNX Runtime Web). Use the network only for initial app delivery, model/runtime downloads, and deployment-version checks. Cache the app shell and runtime assets for offline launch; keep conversations and settings in IndexedDB. When the network returns, resume update checks without requiring a user restart. No cloud inference, remote conversation sync, authentication, or account backend is introduced.

**Consequences:**
- Models must be downloaded once while online (~117MB–2.3GB)
- Already downloaded models can generate responses offline
- Generation speed depends on the user's device (WebGPU >> WASM)
- App updates and new model downloads require internet access
- Deployable to Vercel and compatible static hosts; the Vercel version endpoint is optional outside Vercel

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

**Decision:** Static assets → Cache First. HTML → Network First. Transformers.js and ONNX Runtime CDN dependencies → Cache First in a runtime cache that survives app deployments. Model weights are **not** handled by the service worker; Transformers.js caches them itself in `transformers-cache` (caching them twice doubled disk use and buffered the whole download in RAM).

**Why not precache model weights?** They can range from about 117MB to multiple gigabytes. Precaching at SW install time would fail on most devices and block SW activation. Lazy caching on first use is safer.

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

| Model (Hugging Face repo) | Approx. quantized weights | Runtime | Profile |
|-------|------:|-------|---------|
| `onnx-community/SmolLM2-135M-Instruct-ONNX` | 117MB q4f16 / 181MB q4 | WebGPU or WASM | Ultra-light starter |
| `HuggingFaceTB/SmolLM2-360M-Instruct` | 273MB q4f16 / 388MB q4 | WebGPU or WASM | Balanced everyday model |
| `onnx-community/Qwen2.5-0.5B-Instruct` | 483MB q4f16 / 786MB q4 | WebGPU or WASM | Multilingual option |
| `onnx-community/Qwen3-0.6B-ONNX` | 570MB q4f16 / 919MB q4 | WebGPU or WASM | Newer compact multilingual model |
| `onnx-community/TinyLlama-1.1B-Chat-v1.0-ONNX` | 714MB q4f16 / 910MB q4 | WebGPU or WASM | Chat-tuned alternative |
| `onnx-community/Qwen2.5-1.5B-Instruct` | 1.22GB q4f16 / 1.79GB q4 | WebGPU or WASM | Higher quality, higher memory |
| `onnx-community/Phi-3.5-mini-instruct-onnx-web` | ~2.3GB q4f16 | **WebGPU with shader-f16 only** | Advanced / high-memory |

> The official `Qwen/Qwen2.5-0.5B-Instruct` repo has no `onnx/` folder, so it can never load in
> Transformers.js. Old saved settings pointing at it are migrated automatically.

The Transformers.js runtime is pinned in one place (`TRANSFORMERS_VERSION` in `ai.js`, currently 4.3.2); `service-worker.js` keeps a runtime cache named after that version and CI fails if the two drift apart.

The app defaults to SmolLM2 135M to minimize the first download and reduce memory pressure. Settings → Model Library lets users download and keep multiple models, activate one, or remove its cached files. Only one inference pipeline is kept resident at a time. A failed model load stops generation and reports the real error; it never stores a simulated helper message as an AI answer.

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

Open Settings → Application Version to compare the service worker currently controlling the page with the latest deployed commit. LocalMind checks for deployments on startup, when the tab becomes visible, and every five minutes while online. When offline, it keeps the currently installed service worker and cached app shell instead of attempting an online update. On reconnection, it fetches deployment metadata, registers the commit-specific worker, and checks for updates automatically. New workers use isolated caches and trigger one coordinated reload after active generation finishes. Model weights remain cached separately and are preserved across app updates. The connection indicator explicitly distinguishes network availability from local AI availability: online inference still runs on-device, and offline inference requires a model already downloaded.

## Offline Usage

1. Open the app while online — the service worker takes control and caches the app plus the Transformers.js / ONNX Runtime CDN dependencies.
2. Open Settings → Model Library and choose Download for a model (SmolLM2 135M is the smallest starter).
3. Wait for the model badge to show Ready.
4. Confirm your conversations are visible, then disconnect from the internet.
5. Reopen LocalMind from its installed PWA or cached browser tab and continue chatting offline.
6. When internet returns, LocalMind automatically checks for app updates. Model downloads that were not completed must be retried online.

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

**Model never finishes loading / local AI is unavailable**
- Open DevTools → Network and look for a red `404` on `huggingface.co/.../onnx/model_*.onnx`.
  That means the repo/dtype combo in `MODELS` (ai.js) has no such file.
- Allow `cdn.jsdelivr.net`, `huggingface.co` and `*.hf.co` through any ad blocker/proxy.
- Settings → Clear Model Cache, then retry. After updating from an older version, reload twice
  so the new service worker takes over (it also deletes the old duplicate model cache).

**Model download is slow or fails**
- First-time model/runtime downloads require internet. Check your connection or try a different network (some proxies block Hugging Face).
- If a model is already cached, LocalMind can still load and run it offline.
- If a download was interrupted, reconnect and retry; do not clear a valid existing model cache.
- Each completed model caches independently; subsequent loads can work offline when its exact runtime/dtype files are cached.

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
- Temperature `0` means deterministic (greedy) decoding

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
├── scripts/            # verify-model-library.mjs (CI invariants)
├── icons/              # PWA icons (SVG)
└── README.md
```

---

## License

MIT — do whatever you want with it.
