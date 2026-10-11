# ZoomReel

**ZoomReel** is an Electron desktop app that records your screen (and optional webcam / mic / system audio), then applies Screen Studio–style cinematic auto-zoom in a built-in editor. Zooms follow clicks and typing, ease out on scroll or inactivity, and can be overridden with manual zoom regions. Export to WebM, MP4, or GIF.

There is no hosted web app or Chrome Web Store listing for this repository — it is a local desktop application you run or package yourself.

> Electron port of an earlier ZoomReel browser-extension prototype. This repo is the desktop app only.

## Features

- Screen or window capture via Electron `desktopCapturer` / `getDisplayMedia`
- Optional webcam bubble, microphone, and system-audio capture
- Global cursor / click / key / scroll tracking to drive auto-zoom
- Offline camera simulation (`camera.js`) — scrubbing and export share the same track
- Editor: framing, padding, backgrounds, trim/cut timeline, manual zoom regions
- Recordings streamed to disk under the app userData folder (no IndexedDB quota limits)
- Windows NSIS installer via `electron-builder`

## Tech stack

| Layer          | Choice                                                         |
| -------------- | -------------------------------------------------------------- |
| Runtime        | Electron 32                                                    |
| Main / preload | Node.js (CommonJS)                                             |
| Renderer       | Vanilla HTML / CSS / JS                                        |
| Input hooks    | `uiohook-napi` (optional; falls back to cursor-move tracking)  |
| GIF export     | Bundled [gif.js](https://github.com/jnordberg/gif.js)          |
| Packaging      | electron-builder (NSIS)                                        |
| Quality        | ESLint, Prettier, Node.js built-in test runner, GitHub Actions |

## Architecture

```
Recorder window (index.html) ──IPC──► Main process (main.js)
        │                                  │
        │  cursor / click / key events     │ desktopCapturer, file I/O,
        │  MediaRecorder chunks ──────────►│ window lifecycle, uIOhook
        │                                  │
        └── openEditor(id) ───────────────► Editor window (editor.html)
                                              │
                                              ├─ camera.js  (pure zoom math)
                                              └─ vendor/gif.js (export)
```

- **`src/main.js`** — single app instance, source picking, input tracking, recording storage, editor windows.
- **`src/preload.js`** — `contextBridge` API exposed as `window.zr` (context isolation on, Node integration off).
- **`src/index.html` / `index.js`** — recorder UI and capture pipeline.
- **`src/editor.html` / `editor.js`** — preview, trim, styling, export.
- **`src/camera.js`** — pure cinematic camera algorithm (also unit-tested under Node).

Recordings live at `app.getPath('userData')/recordings/<id>/` (`screen.webm`, optional `cam.webm` / `mic.webm`, `meta.json`).

## Requirements

- Node.js 18+ (CI uses Node 20)
- npm
- Platform support targets **Windows** for the packaged installer; development can run wherever Electron runs (native `uiohook-napi` may be unavailable on some setups — the app still starts)

## Local development

```bash
npm install
npm start
```

That launches the Electron recorder window. Pick a screen or window, optionally enable camera / mic / system audio, then start recording. When you stop, the editor opens on that take.

## Scripts

| Script                 | Purpose                                       |
| ---------------------- | --------------------------------------------- |
| `npm start`            | Run the app in development                    |
| `npm run build`        | Package a Windows NSIS installer into `dist/` |
| `npm test`             | Unit tests for the camera algorithm           |
| `npm run lint`         | ESLint                                        |
| `npm run format`       | Prettier write                                |
| `npm run format:check` | Prettier check (CI)                           |
| `npm run ci`           | lint + format check + test                    |

## Project structure

```
zoomreel/
├── src/
│   ├── main.js          # Electron main process
│   ├── preload.js       # Secure IPC bridge → window.zr
│   ├── camera.js        # Auto-zoom algorithm
│   ├── index.html/.js   # Recorder UI
│   ├── editor.html/.js  # Editor UI
│   ├── logo.svg
│   └── vendor/          # Bundled gif.js + worker
├── build/
│   └── icon.png         # App / installer icon
├── tests/
│   └── camera.test.js
├── .github/workflows/ci.yml
├── package.json
└── README.md
```

## Packaging

```bash
npm run build
```

Produces an NSIS installer under `dist/` (`com.zoomreel.app`).

## Known limitations (v1)

- **No capture-window exclusion.** Recording “Entire screen” includes ZoomReel windows.
- **`uiohook-napi` is optional.** If it fails to load, auto-zoom still follows cursor movement but not click/key bursts.
- **Export uses real-time canvas capture** (`MediaRecorder` + `canvas.captureStream()`), so cut points pause briefly rather than frame-perfect splicing.

## License

Private / unlicensed (`UNLICENSED` in `package.json`). All rights reserved by the author unless otherwise stated.
