# ZoomReel (desktop)

Auto-zoom screen recorder — Electron port of the ZoomReel browser extension.

## Run in development

```
npm install
npm start
```

## Build a Windows installer

```
npm run build
```

Produces an NSIS installer in `dist/`.

## How it's organized

- `main.js` — Electron main process: screen-source picking (`desktopCapturer`), global cursor/click/key tracking (drives the auto-zoom camera), and recording storage on disk (`app.getPath('userData')/recordings/<id>/`).
- `preload.js` — the only bridge between renderer windows and Node/Electron APIs (`contextBridge`), exposed to renderers as `window.zr`.
- `index.html` / `index.js` — the recorder window: pick a screen/window + camera/mic, start/stop recording.
- `editor.html` / `editor.js` — the editor window: cinematic auto-zoom preview, webcam bubble, trim/cut timeline, export to WebM/MP4/GIF. Ported near-unchanged from the extension.
- `camera.js` — the auto-zoom algorithm itself (pure JS, untouched from the extension).
- `gif.js` / `gif.worker.js` — bundled GIF encoder (same library the extension used).

## What's different from the extension

Nearly everything that was awkward in the Chrome extension is just gone here:
- No more offscreen-document-can't-get-camera-permission workaround — one normal window, `getUserMedia` just works.
- No more service-worker-killed-mid-recording state loss — `main.js` runs as one persistent process for the app's whole lifetime.
- No more IndexedDB/`chrome.storage.local` quota dance — recordings stream straight to disk.
- Cursor tracking is more accurate: Electron gives real display bounds, so events are already normalized correctly at the source (no more surface-guessing heuristics).

## Known v1 simplifications

- **No capture-window exclusion.** If you record "Entire screen," any ZoomReel window will appear in the recording, same as the extension. Fixing this needs real per-OS compositor work and is a deliberate v2 item.
- **Click/keypress detection uses `uiohook-napi`.** If it fails to load on your platform, the app still runs — auto-zoom just falls back to cursor-movement tracking only (no click-triggered zoom bursts).
- **Export is still real-time canvas capture** (`MediaRecorder` + `canvas.captureStream()`), same as the extension — there's a brief pause at cut points rather than a frame-perfect splice. Swapping this for bundled `ffmpeg` muxing would fix that; deferred as a v2 polish item since the current approach already works.
