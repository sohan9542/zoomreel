// ZoomReel desktop — Electron main process.
// Owns: window management, screen-source picking, global cursor/click
// tracking (for camera.js's auto-zoom), and recording storage on disk.
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, Menu, session } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const { pathToFileURL } = require("url");

// Chromium's newer Windows Graphics Capture (WGC) backend fails repeatedly
// on some Windows/GPU-driver combinations — "ProcessFrame failed, using
// existing frame" / "CreateForWindow failed" / "Source is not capturable"
// spammed from wgc_capture_*.cc, observed the instant
// desktopCapturer.getSources() runs (even just for thumbnails). Falling back
// to the older capture backend avoids it. Must be set before app is ready.
//
// --disable-features is a single-valued switch: appending it blindly drops
// whatever Electron/Chromium already put there (and vice versa). Merge.
const DISABLED_FEATURES = ["AllowWgcScreenCapturer", "AllowWgcWindowCapturer"];
app.commandLine.appendSwitch(
  "disable-features",
  [app.commandLine.getSwitchValue("disable-features"), ...DISABLED_FEATURES].filter(Boolean).join(",")
);

let uIOhook = null;
try {
  ({ uIOhook } = require("uiohook-napi"));
} catch (e) {
  // Optional — cursor movement tracking still works without it, just no
  // click/keypress-triggered zoom bursts.
}

// One instance, ever. Without this, "close the recorder, run it again"
// leaves the first instance alive whenever an editor window is still open
// (Windows only quits on window-ALL-closed) — and that old instance's
// editor keeps playing the previous take, which system-audio loopback then
// records straight into the new instance's recording.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    createMainWindow();
  }
});

const recordingsDir = () => path.join(app.getPath("userData"), "recordings");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

let mainWindow = null;

const appIcon = path.join(__dirname, "build", "icon.png");

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 760,
    minWidth: 360,
    minHeight: 500,
    title: "ZoomReel",
    icon: appIcon,
    autoHideMenuBar: true,
    show: false, // paired with maximize() below — avoids a visible small-then-big jump
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.once("ready-to-show", () => {
    mainWindow.maximize();
    mainWindow.show();
  });
  mainWindow.loadFile("index.html");
  // Closing the recorder closes the whole app, editors included. Otherwise
  // "I closed the software" can silently leave editor windows (and their
  // audio playback) running in the background.
  mainWindow.on("closed", () => {
    mainWindow = null;
    app.quit();
  });
}

// The legacy chromeMediaSource:'desktop' getUserMedia path always bakes the
// real OS cursor into captured frames with no way to turn it off — it then
// visually fights with the cursor camera.js already draws from tracked
// events. Routing capture through getDisplayMedia instead lets us pass
// `cursor: "never"`, so the only cursor that ever appears is the one we draw.
let pendingCapture = null;

ipcMain.handle("zr:set-capture-source", (event, { sourceId, wantSystemAudio }) => {
  pendingCapture = { sourceId, wantSystemAudio };
  return { ok: true };
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // no File/Edit/View/Window/Help — this app doesn't use any of it
  ensureDir(recordingsDir());

  // Video only — system audio deliberately does NOT use Electron's
  // "loopback" plumbing. Its capture session can outlive the stream and leak
  // buffered between-takes audio into the next recording (audio from a
  // previous take appearing in a new one, which is exactly what happened).
  // Audio comes from the classic chromeMediaSource:"desktop" getUserMedia
  // path in the renderer instead.
  //
  // thumbnailSize 0: we only need the id match here. The default size makes
  // getSources() do a real capture of EVERY open window before it returns —
  // seconds of delay, during which the already-open desktop-audio loopback
  // keeps buffering. That buffered pre-roll is what leads the recording.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
    const match = sources.find((s) => s.id === pendingCapture?.sourceId) || sources[0];
    callback({ video: match });
  }, { useSystemPicker: false });

  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  try { if (uIOhook) uIOhook.stop(); } catch (e) {}
});

/* ---------- screen source picking ---------- */

ipcMain.handle("zr:get-sources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 480, height: 270 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    display_id: s.display_id || null,
  }));
});

/* ---------- cursor / click / key tracking (drives camera.js auto-zoom) ---------- */
// Electron gives us the captured display's bounds directly (via display_id),
// so cursor coordinates can be normalized to [0,1] with simple arithmetic —
// no need for the extension's multi-surface coordinate-guessing heuristics.

let trackingInterval = null;
let trackingTarget = null;
let trackingBounds = null;
let uiohookHandlersBound = false;

function boundsForSource(displayId) {
  const displays = screen.getAllDisplays();
  if (displayId) {
    const match = displays.find((d) => String(d.id) === String(displayId));
    if (match) return match.bounds;
  }
  // Window source (or unmatched screen) — fall back to the full virtual
  // desktop bounds. Not pixel-perfect for a specific window, but a simple,
  // honest approximation that still drives reasonable auto-zoom behavior.
  const minX = Math.min(...displays.map((d) => d.bounds.x));
  const minY = Math.min(...displays.map((d) => d.bounds.y));
  const maxX = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function sendInputEvent(ev) {
  if (trackingTarget && !trackingTarget.isDestroyed()) {
    trackingTarget.send("zr:input-event", ev);
  }
}

ipcMain.on("zr:start-tracking", (event, { displayId }) => {
  trackingTarget = event.sender;
  trackingBounds = boundsForSource(displayId);

  if (trackingInterval) clearInterval(trackingInterval);
  trackingInterval = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    const x = clamp01((p.x - trackingBounds.x) / (trackingBounds.width || 1));
    const y = clamp01((p.y - trackingBounds.y) / (trackingBounds.height || 1));
    sendInputEvent({ t: Date.now(), x, y, k: "m" });
  }, 16);

  if (uIOhook && !uiohookHandlersBound) {
    uIOhook.on("mousedown", () => {
      if (!trackingBounds) return;
      const p = screen.getCursorScreenPoint();
      const x = clamp01((p.x - trackingBounds.x) / (trackingBounds.width || 1));
      const y = clamp01((p.y - trackingBounds.y) / (trackingBounds.height || 1));
      sendInputEvent({ t: Date.now(), x, y, k: "c" });
    });
    uIOhook.on("keydown", () => {
      sendInputEvent({ t: Date.now(), x: NaN, y: NaN, k: "k" });
    });
    // Scroll = zoom-out signal while the auto-camera is zoomed in.
    uIOhook.on("wheel", () => {
      sendInputEvent({ t: Date.now(), x: NaN, y: NaN, k: "s" });
    });
    uIOhook.start();
    uiohookHandlersBound = true;
  }
});

function silenceForRecording() {
  // System-audio loopback records EVERYTHING the PC plays — including any
  // still-open editor window playing back an earlier take. Mute first (takes
  // effect immediately, even on a busy renderer), then tear the editors down.
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    // NOT the recorder window: it plays no audio to begin with, but it does
    // host the AudioContext that mixes mic + system audio for the recording.
    // Muting a window switches its audio render pipeline to a silent sink,
    // which is a different clock — and the mixer drifts against the capture
    // devices for the whole take.
    if (w !== mainWindow) w.webContents.setAudioMuted(true);
    w.webContents.send("zr:global-pause");
  }
  closeEditorWindows();
}

function unsilenceWindows() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.setAudioMuted(false);
  }
}

function closeEditorWindows(except = null) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w === except || w.isDestroyed()) continue;
    try {
      if (!w.webContents.getURL().includes("editor.html")) continue;
      // destroy(), not close(): close() is a request the renderer can sit on
      // for seconds while it's busy decoding, and an editor that keeps playing
      // that long is exactly what loopback bakes into the next take.
      w.destroy();
    } catch (e) {}
  }
}

ipcMain.on("zr:stop-tracking", () => {
  if (trackingInterval) { clearInterval(trackingInterval); trackingInterval = null; }
  trackingTarget = null;
  trackingBounds = null;
  // Do NOT unsilence here — stopTracking runs at the start of stopRecording,
  // while MediaRecorder is still flushing. Unmuting then lets a previous
  // editor bleed into the final chunks via system-audio loopback.
});

// Must run BEFORE desktop/system-audio getUserMedia — otherwise loopback
// buffers whatever editors were still playing during mic/cam setup.
ipcMain.handle("zr:silence-for-recording", async () => {
  silenceForRecording();
  // Let windows die + OS mixer / capture ring-buffer drain before loopback opens.
  await new Promise((r) => setTimeout(r, 400));
  return { ok: true };
});

ipcMain.handle("zr:unsilence", async () => {
  unsilenceWindows();
  return { ok: true };
});

/* ---------- recording storage (real filesystem, no quota to hit) ---------- */
// Chunks stream straight to disk as MediaRecorder produces them, so a long
// recording never sits fully buffered in memory anywhere.

const openStreams = new Map(); // id -> { screen: fs.WriteStream, cam: fs.WriteStream|null }

ipcMain.handle("zr:recording-start", async (event, { id, hasCam, hasMic }) => {
  silenceForRecording(); // idempotent — already done early; keep as safety net
  const key = String(id);
  const dir = path.join(recordingsDir(), key);
  ensureDir(dir);
  const streams = {
    screen: fs.createWriteStream(path.join(dir, "screen.webm")),
    cam: hasCam ? fs.createWriteStream(path.join(dir, "cam.webm")) : null,
    // Raw mic, unmixed — see the note in index.js.
    mic: hasMic ? fs.createWriteStream(path.join(dir, "mic.webm")) : null,
  };
  openStreams.set(key, streams);
  return { ok: true };
});

ipcMain.on("zr:recording-chunk", (event, { id, kind, chunk }) => {
  const streams = openStreams.get(String(id));
  if (!streams) return;
  const s = streams[kind] || streams.screen;
  if (s) s.write(Buffer.from(chunk));
});

ipcMain.handle("zr:recording-finish", async (event, { id, meta }) => {
  const key = String(id);
  const streams = openStreams.get(key);
  if (streams) {
    await Promise.all([
      streams.screen && new Promise((res) => streams.screen.end(res)),
      streams.cam && new Promise((res) => streams.cam.end(res)),
      streams.mic && new Promise((res) => streams.mic.end(res)),
    ]);
    openStreams.delete(key);
  }
  const dir = path.join(recordingsDir(), key);
  ensureDir(dir);
  await fsp.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
  // Audio-track identity/state, kept in its own small file: meta.json is one
  // huge line of cursor events, which makes it useless to eyeball.
  if (meta && meta.audioDiag) {
    await fsp.writeFile(path.join(dir, "audio-diag.json"), JSON.stringify(meta.audioDiag, null, 2));
  }
  unsilenceWindows();
  return { ok: true };
});

ipcMain.handle("zr:list-sessions", async () => {
  const dir = recordingsDir();
  if (!fs.existsSync(dir)) return [];
  const ids = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isDirectory());
  const sessions = [];
  for (const id of ids) {
    const metaPath = path.join(dir, id, "meta.json");
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      sessions.push({ id, startEpoch: meta.startEpoch || Number(id), hasWebcam: !!meta.hasWebcam });
    } catch (e) {}
  }
  return sessions.sort((a, b) => b.startEpoch - a.startEpoch);
});

ipcMain.handle("zr:load-session", async (event, id) => {
  const dir = path.join(recordingsDir(), String(id));
  const metaPath = path.join(dir, "meta.json");
  if (!fs.existsSync(metaPath)) return { ok: false, error: "Recording not found." };
  const meta = JSON.parse(await fsp.readFile(metaPath, "utf-8"));
  const screenPath = path.join(dir, "screen.webm");
  const camPath = path.join(dir, "cam.webm");
  // Cache-bust: Chromium can reuse a demuxed audio track from a previous
  // file:// load when opening a new take in a fresh editor window.
  const bust = `?t=${Date.now()}`;
  return {
    ok: true,
    meta,
    screenUrl: pathToFileURL(screenPath).href + bust,
    camUrl: fs.existsSync(camPath) ? pathToFileURL(camPath).href + bust : null,
  };
});

ipcMain.handle("zr:delete-session", async (event, id) => {
  const dir = path.join(recordingsDir(), String(id));
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// Close the calling editor window and bring the recorder back up front.
ipcMain.on("zr:record-again", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    createMainWindow();
  }
  if (win && !win.isDestroyed()) win.close();
});

/* ---------- editor window ---------- */

ipcMain.on("zr:open-editor", (event, id) => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "ZoomReel Editor",
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // One editor at a time — an old take left playing is exactly what system
  // audio loopback used to bake into the next recording.
  closeEditorWindows(win);
  win.loadFile("editor.html", { query: { id: String(id) } });
});

/* ---------- export save ---------- */

ipcMain.handle("zr:save-export", async (event, { defaultName, buffer }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: defaultName });
  if (canceled || !filePath) return { ok: false };
  await fsp.writeFile(filePath, Buffer.from(buffer));
  return { ok: true, filePath };
});
