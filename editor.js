// ZoomReel editor (desktop): renders the recording with cinematic auto-zoom, framing, and export.
// Ported from the extension — same rendering/trim/export logic, with storage
// swapped from chrome.storage.local + IndexedDB to the main process's
// filesystem-backed session store (see main.js / preload.js).

const params = new URLSearchParams(location.search);
const SID = Number(params.get("id"));

const BACKGROUNDS = {
  aurora:   ["#6d28d9", "#4f46e5"],
  sunset:   ["#f97316", "#db2777"],
  ocean:    ["#0ea5e9", "#4f46e5"],
  mint:     ["#10b981", "#0891b2"],
  graphite: ["#1f2937", "#0b0f19"],
};

const S = {
  zoomMode: "auto", // "auto" | "manual" — manual = user-drawn zoom regions, see manualZooms
  zoom: 1.7,
  smooth: 0.06,
  pad: 0.06,
  radius: 16,
  bg: "aurora",
  showCursor: false,
  muted: false,
  camEnabled: true,
  camCorner: "br",
  camSize: 0.18,
  segments: [], // [{start,end,deleted}] ms — the whole clip split into pieces
  manualZooms: [], // [{start,end,cx,cy,zoom}] ms/normalized — user-drawn zoom regions
};

let meta, prepared;
let video, canvas, ctx;
// The take's real length in seconds. video.duration can't be trusted: these
// files carry no duration in their header, so it reads Infinity, and the one
// way to discover the true value (see init) forces a reload that resets it to
// Infinity all over again. Everything downstream uses this instead.
let durationSec = 0;
let camVideo = null;
let screenUrl = null;
let exporting = false;
let selectedSegment = null;
let selectedZoomIdx = null;
let dragBox = null; // { startX, startY, curX, curY } in canvas-wrap CSS pixels, while drawing a manual zoom

init();

async function init() {
  const result = await window.zr.loadSession(SID);
  if (!result.ok) {
    document.getElementById("empty").textContent = "Recording not found. Try recording again.";
    return;
  }
  meta = result.meta;
  screenUrl = result.screenUrl;

  video = document.createElement("video");
  video.src = screenUrl;
  video.playsInline = true;
  video.muted = S.muted;
  await new Promise((r) => { video.onloadedmetadata = r; });
  if (!isFinite(video.duration)) {
    // MediaRecorder writes no duration into the WebM header, so the only way to
    // learn a take's length is to seek past the end and see where it lands.
    // That leaves the element pinned at the end with ended=true, and from there
    // EVERY seek is silently ignored — currentTime=0, fastSeek, seeking twice,
    // all of it. play() then fails with "interrupted by end of playback" and
    // the editor opens on a video that simply will not start.
    // load() is the only thing that clears that state, and the duration just
    // discovered survives the reload.
    await new Promise((r) => { video.onseeked = r; video.currentTime = 1e6; });
    video.onseeked = null;
    durationSec = video.duration; // capture before load() throws it away
    video.load();
    await new Promise((r) => { video.onloadedmetadata = r; });
  }
  if (!durationSec || !isFinite(durationSec)) durationSec = isFinite(video.duration) ? video.duration : 0;

  S.segments = [{ start: 0, end: durationSec * 1000, deleted: false }];
  selectedSegment = 0;

  if (result.camUrl) {
    camVideo = document.createElement("video");
    camVideo.src = result.camUrl;
    camVideo.playsInline = true;
    camVideo.muted = true;
    await new Promise((r) => { camVideo.onloadedmetadata = r; });
  }

  rebuildCamera();

  setupCanvas();
  buildControls();

  document.getElementById("empty").style.display = "none";
  document.getElementById("app").style.display = "grid";
  document.getElementById("camGroup").style.display = camVideo ? "" : "none";
  renderSegments();
  updateDeleteBtnLabel();
  generateThumbnails();

  const diagLines = [];
  if (meta.camError) diagLines.push("Camera: " + meta.camError);
  if (meta.micError) diagLines.push("Microphone: " + meta.micError);
  if (diagLines.length) {
    const diag = document.getElementById("camDiag");
    diag.textContent = diagLines.join(" · ");
    diag.style.display = "block";
  }

  // A window you played and then navigated away from keeps playing
  // (audio included) indefinitely — pause the moment it's not the one
  // you're looking at.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && exporting === false) {
      if (!video.paused) video.pause();
      if (camVideo && !camVideo.paused) camVideo.pause();
    }
  });

  // A new recording just started somewhere — stop playing immediately, even
  // if this window is visible (e.g. on a second monitor). System-audio
  // loopback would otherwise record this window's playback into the new take.
  window.zr.onGlobalPause(() => {
    if (exporting) return;
    if (!video.paused) video.pause();
    if (camVideo && !camVideo.paused) camVideo.pause();
  });

  video.addEventListener("ended", () => {
    if (camVideo && !camVideo.paused) camVideo.pause();
  });

  requestAnimationFrame(loop);
}

// Cursor/click/key events already arrive pre-normalized to [0,1] relative to
// whatever screen/window was actually captured (main.js does that using
// Electron's real display bounds) — unlike the extension, which had to guess
// at surface geometry after the fact. No remapping needed here.
function rebuildCamera() {
  const raw = (meta.events || [])
    .map((e) => ({ ...e, t: e.t - meta.startEpoch }))
    .filter((e) => Number.isFinite(e.t));
  const totalMs = durationSec * 1000;
  prepared = ZR_CAMERA.prepare(raw, totalMs, S);
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function setupCanvas() {
  canvas = document.getElementById("c");
  ctx = canvas.getContext("2d");
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 800;
  const outW = Math.min(1600, vw);
  canvas.width = Math.round(outW);
  canvas.height = Math.round(outW * (vh / vw));
  // Zooming magnifies a 1080p capture, so every zoomed frame is an upscale.
  // Default resampling is the cheap one; this is the good one, and it's the
  // difference between readable and mushy text when zoomed in.
  ctx.imageSmoothingQuality = "high";
}

/* ---------- render loop ---------- */

function loop() {
  let t = video.currentTime * 1000;
  if (!video.paused && !exporting) {
    const skipTo = cutEndAt(t);
    if (skipTo !== null) {
      const durMs = durationSec * 1000;
      const newT = Math.min(skipTo, durMs);
      video.currentTime = newT / 1000;
      if (camVideo) {
        const camT = Math.min(newT / 1000, Number.isFinite(camVideo.duration) ? camVideo.duration : newT / 1000);
        camVideo.currentTime = camT;
      }
      t = newT;
    }
  }
  render(t);
  if (!exporting) updateTransport(t);
  requestAnimationFrame(loop);
}

function render(t) {
  // Cam and screen MediaRecorders stop a few hundred ms apart. Seeking the
  // cam past its own duration every frame makes readyState flap (<2) and the
  // bubble flicker hide/show forever after the main video ends.
  if (camVideo && !camVideo.seeking && camVideo.readyState >= 1) {
    const target = Math.min(
      video.currentTime,
      Number.isFinite(camVideo.duration) ? camVideo.duration : video.currentTime
    );
    if (Math.abs(camVideo.currentTime - target) > 0.15) camVideo.currentTime = target;
  }
  const frame = ZR_CAMERA.evaluate(t, prepared, S);
  lastFrame.cx = frame.cx; lastFrame.cy = frame.cy; lastFrame.zoom = frame.zoom;
  draw(frame.cx, frame.cy, frame.zoom, t);
}

// Center/zoom currently on screen — the manual zoom-region drag needs this to
// map a mouse position back to a normalized video coordinate, since the
// canvas is already showing a cropped/zoomed view, not the raw frame.
let lastFrame = { cx: 0.5, cy: 0.5, zoom: 1 };

function getViewport() {
  const W = canvas.width, H = canvas.height;
  const padH = W * S.pad, padV = H * S.pad;
  return { W, H, ix: padH, iy: padV, iw: W - padH * 2, ih: H - padV * 2 };
}

function draw(cx, cy, zoom, t) {
  const W = canvas.width, H = canvas.height;
  const { ix, iy, iw, ih } = getViewport();
  const r = S.radius;

  paintBackdrop(W, H, ix, iy, iw, ih, r);

  ctx.save();
  roundRect(ctx, ix, iy, iw, ih, r);
  ctx.clip();

  const vw = video.videoWidth, vh = video.videoHeight;
  const cw = vw / zoom, ch = vh / zoom;
  const sx = cx * vw - cw / 2, sy = cy * vh - ch / 2;
  if (video.readyState >= 2) ctx.drawImage(video, sx, sy, cw, ch, ix, iy, iw, ih);

  if (S.showCursor) {
    // The recording's raw footage always has the real Windows cursor baked
    // in — nothing at the JS level can suppress it (that requires the modern
    // Windows Graphics Capture backend, which is disabled elsewhere in this
    // app to work around a separate WGC crash). Drawing our own pointer on
    // top of that unavoidable real one was two cursors overlapping/
    // flickering. Click/keypress ripples don't have that conflict — they're
    // an added highlight, not a second pointer — so only those remain.
    const visL = cx - 0.5 / zoom, visT = cy - 0.5 / zoom;
    const invW = 1 / zoom;
    const toScreen = (nx, ny) => ({
      x: ix + ((nx - visL) / invW) * iw,
      y: iy + ((ny - visT) / invW) * ih,
    });

    const triggers = prepared.triggers || [];
    for (const c of triggers) {
      if (c.k === "h") continue;
      const dtc = t - c.t;
      if (dtc >= 0 && dtc < 520) {
        const p = toScreen(c.x, c.y);
        const prog = dtc / 520;
        const rad = (10 + prog * 34) * (iw / 900);
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        const hue = c.k === "k" ? "59,130,246" : "139,92,246";
        ctx.strokeStyle = `rgba(${hue},${(1 - prog) * 0.85})`;
        ctx.lineWidth = 3 * (iw / 900);
        ctx.stroke();
      }
    }
  }
  ctx.restore();

  drawWebcamBubble(W, H);
}

function drawWebcamBubble(W, H) {
  if (!S.camEnabled || !camVideo || camVideo.readyState < 2) return;

  const size = Math.min(W, H) * S.camSize;
  const margin = Math.min(W, H) * 0.035;
  const r = size / 2;
  let bx, by;
  switch (S.camCorner) {
    case "tl": bx = margin + r; by = margin + r; break;
    case "tr": bx = W - margin - r; by = margin + r; break;
    case "bl": bx = margin + r; by = H - margin - r; break;
    default:   bx = W - margin - r; by = H - margin - r; break; // br
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(bx, by, r, 0, Math.PI * 2);
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(bx, by, r, 0, Math.PI * 2);
  ctx.clip();
  const vw = camVideo.videoWidth, vh = camVideo.videoHeight;
  const scale = Math.max(size / vw, size / vh);
  const dw = vw * scale, dh = vh * scale;
  ctx.drawImage(camVideo, bx - dw / 2, by - dh / 2, dw, dh);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(bx, by, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, size * 0.02);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.stroke();
  ctx.restore();
}

// Gradient background + the drop-shadowed frame behind the video. None of it
// changes between frames, but it was being rebuilt on every one — two fresh
// gradient objects and a 42px blur per frame. Rendered once into an offscreen
// canvas and blitted instead; the cache rebuilds only when something it
// depends on actually changes. Export captures this same canvas in real time,
// so the cost came straight out of the exported frame rate too.
let bgCache = null, bgKey = "";

function paintBackdrop(W, H, ix, iy, iw, ih, r) {
  const key = [W, H, S.bg, ix, iy, iw, ih, r].join("|");
  if (!bgCache || bgKey !== key) {
    bgCache = document.createElement("canvas");
    bgCache.width = W;
    bgCache.height = H;
    const b = bgCache.getContext("2d");

    const [c1, c2] = BACKGROUNDS[S.bg] || BACKGROUNDS.aurora;
    const g = b.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);
    b.fillStyle = g;
    b.fillRect(0, 0, W, H);
    const rg = b.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.2, W / 2, H / 2, Math.max(W, H) * 0.75);
    rg.addColorStop(0, "rgba(0,0,0,0)");
    rg.addColorStop(1, "rgba(0,0,0,0.28)");
    b.fillStyle = rg;
    b.fillRect(0, 0, W, H);

    b.shadowColor = "rgba(0,0,0,0.45)";
    b.shadowBlur = 42;
    b.shadowOffsetY = 22;
    roundRect(b, ix, iy, iw, ih, r);
    b.fillStyle = "#000";
    b.fill();

    bgKey = key;
  }
  ctx.drawImage(bgCache, 0, 0);
}

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/* ---------- trim / cuts (CapCut-style: split a clip, select a piece, delete it) ---------- */

function segmentIndexAt(tMs) {
  for (let i = 0; i < S.segments.length; i++) {
    const s = S.segments[i];
    if (tMs >= s.start && tMs < s.end) return i;
  }
  return S.segments.length - 1;
}

// Active (non-deleted) segment covering tMs, or null if it's inside a deleted one.
function cutEndAt(tMs) {
  const seg = S.segments[segmentIndexAt(tMs)];
  return seg && seg.deleted ? seg.end : null;
}

function computeKeptSegments() {
  const out = [];
  for (const seg of S.segments) {
    if (seg.deleted) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.end - seg.start) < 1) last.end = seg.end;
    else out.push({ start: seg.start, end: seg.end });
  }
  return out.filter((s) => s.end - s.start > 50);
}

function splitAtPlayhead() {
  const tMs = video.currentTime * 1000;
  const idx = segmentIndexAt(tMs);
  const seg = S.segments[idx];
  if (!seg || tMs - seg.start < 50 || seg.end - tMs < 50) return;
  const a = { start: seg.start, end: tMs, deleted: seg.deleted };
  const b = { start: tMs, end: seg.end, deleted: seg.deleted };
  S.segments.splice(idx, 1, a, b);
  selectedSegment = idx + 1;
  renderSegments();
  updateDeleteBtnLabel();
}

function toggleDeleteSelected() {
  if (selectedSegment === null || !S.segments[selectedSegment]) return;
  const seg = S.segments[selectedSegment];
  seg.deleted = !seg.deleted;
  renderSegments();
  updateDeleteBtnLabel();

  if (seg.deleted) {
    const tMs = video.currentTime * 1000;
    if (tMs >= seg.start && tMs < seg.end) {
      const durMs = durationSec * 1000;
      const newT = Math.min(seg.end, durMs) / 1000;
      video.currentTime = newT;
      if (camVideo) camVideo.currentTime = newT;
    }
  }
}

function updateDeleteBtnLabel() {
  const btn = document.getElementById("deleteBtn");
  if (!btn) return;
  const seg = selectedSegment !== null ? S.segments[selectedSegment] : null;
  if (!seg) { btn.disabled = true; btn.textContent = "Delete clip"; return; }
  btn.disabled = false;
  btn.textContent = seg.deleted ? "Restore clip" : "Delete clip";
}

function renderSegments() {
  const overlay = document.getElementById("segmentsOverlay");
  if (!overlay) return;
  const durMs = durationSec * 1000 || 1;
  overlay.innerHTML = "";
  S.segments.forEach((seg, i) => {
    const div = document.createElement("div");
    div.className = "seg-block" + (seg.deleted ? " deleted" : "") + (i === selectedSegment ? " selected" : "");
    div.style.left = (seg.start / durMs) * 100 + "%";
    div.style.width = Math.max(0.2, ((seg.end - seg.start) / durMs) * 100) + "%";
    overlay.appendChild(div);
  });
}

function setupTimelineDrag() {
  const wrap = document.getElementById("timelineWrap");
  if (!wrap) return;

  function timeSecFromEvent(e) {
    const rect = wrap.getBoundingClientRect();
    const frac = clamp01((e.clientX - rect.left) / rect.width);
    return frac * durationSec;
  }

  function seekAndSelect(e) {
    const t = timeSecFromEvent(e);
    video.currentTime = t;
    if (camVideo) camVideo.currentTime = t;
    selectedSegment = segmentIndexAt(t * 1000);
    renderSegments();
    updateDeleteBtnLabel();
  }

  wrap.addEventListener("mousedown", (e) => {
    seekAndSelect(e);
    const onMove = (ev) => seekAndSelect(ev);
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/* ---------- manual zoom: drag a region on the video, get a zoom keyframe ---------- */

function setZoomMode(mode) {
  S.zoomMode = mode;
  document.getElementById("modeAuto").classList.toggle("sel", mode === "auto");
  document.getElementById("modeManual").classList.toggle("sel", mode === "manual");
  document.getElementById("zoomLevelGroup").style.display = mode === "manual" ? "none" : "";
  document.getElementById("zoomTrackWrap").style.display = mode === "manual" ? "" : "none";
  canvas.classList.toggle("manual-mode", mode === "manual");
  document.getElementById("modeHint").textContent = mode === "manual"
    ? "Click and drag on the video to pick what to zoom into. Drag the blocks below to move or resize them, Delete to remove."
    : "Zooms in on clicks and typing, eases out when you move or go idle.";
  rebuildCamera();
  if (mode === "manual") renderZoomTrack();
}

// Maps a point on the CANVAS (in its own internal pixel space) back to a
// normalized [0,1] video coordinate, accounting for whatever zoom/pan is
// currently on screen — the canvas is already showing a cropped view, not
// the raw frame, so a straight percentage of canvas size would be wrong
// whenever a manual zoom is already active near the playhead.
function canvasPxToNorm(px, py, cx, cy, zoom) {
  const { ix, iy, iw, ih } = getViewport();
  const invW = 1 / zoom;
  const visL = cx - 0.5 * invW, visT = cy - 0.5 * invW;
  return {
    x: clamp01(visL + ((px - ix) / iw) * invW),
    y: clamp01(visT + ((py - iy) / ih) * invW),
  };
}

function setupZoomSelection() {
  const wrap = canvas.parentElement; // .canvas-wrap
  const box = document.getElementById("zoomSelectBox");
  let drag = null; // { startX, startY, curX, curY } in canvas-wrap CSS pixels

  function toWrapPx(clientX, clientY) {
    const r = wrap.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  function updateBoxStyle() {
    const x1 = Math.min(drag.startX, drag.curX), y1 = Math.min(drag.startY, drag.curY);
    box.style.left = x1 + "px";
    box.style.top = y1 + "px";
    box.style.width = Math.abs(drag.curX - drag.startX) + "px";
    box.style.height = Math.abs(drag.curY - drag.startY) + "px";
  }

  canvas.addEventListener("mousedown", (e) => {
    if (S.zoomMode !== "manual" || exporting) return;
    e.preventDefault();
    video.pause();
    if (camVideo) camVideo.pause();
    const p = toWrapPx(e.clientX, e.clientY);
    drag = { startX: p.x, startY: p.y, curX: p.x, curY: p.y };
    box.style.display = "block";
    updateBoxStyle();

    const onMove = (ev) => {
      const mp = toWrapPx(ev.clientX, ev.clientY);
      drag.curX = mp.x; drag.curY = mp.y;
      updateBoxStyle();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      box.style.display = "none";
      finishZoomSelection(drag);
      drag = null;
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function finishZoomSelection(drag) {
  const wPx = Math.abs(drag.curX - drag.startX), hPx = Math.abs(drag.curY - drag.startY);
  if (wPx < 12 || hPx < 12) return; // too small to be a deliberate drag — ignore stray clicks

  const canvasRect = canvas.getBoundingClientRect();
  const wrapRect = canvas.parentElement.getBoundingClientRect();
  const offX = canvasRect.left - wrapRect.left, offY = canvasRect.top - wrapRect.top;
  const scaleX = canvas.width / canvasRect.width, scaleY = canvas.height / canvasRect.height;
  const toCanvasPx = (wx, wy) => ({ x: (wx - offX) * scaleX, y: (wy - offY) * scaleY });

  const c1 = toCanvasPx(drag.startX, drag.startY);
  const c2 = toCanvasPx(drag.curX, drag.curY);
  const { cx: curCx, cy: curCy, zoom: curZoom } = lastFrame;
  const n1 = canvasPxToNorm(c1.x, c1.y, curCx, curCy, curZoom);
  const n2 = canvasPxToNorm(c2.x, c2.y, curCx, curCy, curZoom);

  const cx = (n1.x + n2.x) / 2, cy = (n1.y + n2.y) / 2;
  const dx = Math.max(0.02, Math.abs(n2.x - n1.x)), dy = Math.max(0.02, Math.abs(n2.y - n1.y));
  const zoom = clamp(Math.min(1 / dx, 1 / dy), 1.1, 4);

  const totalMs = durationSec * 1000;
  const startMs = video.currentTime * 1000;
  const endMs = Math.min(startMs + 2500, totalMs);
  if (endMs - startMs < 300) return; // no room left before the clip ends

  S.manualZooms.push({ start: startMs, end: endMs, cx, cy, zoom });
  selectedZoomIdx = S.manualZooms.length - 1;
  rebuildCamera();
  renderZoomTrack();
}

function renderZoomTrack() {
  const trackEl = document.getElementById("zoomTrack");
  if (!trackEl) return;
  const durMs = durationSec * 1000 || 1;
  trackEl.innerHTML = "";

  S.manualZooms.forEach((z, i) => {
    const div = document.createElement("div");
    div.className = "zoom-block" + (i === selectedZoomIdx ? " selected" : "");
    div.style.left = (z.start / durMs) * 100 + "%";
    div.style.width = Math.max(0.5, ((z.end - z.start) / durMs) * 100) + "%";
    div.textContent = z.zoom.toFixed(1) + "×";
    div.innerHTML += `<div class="handle left"></div><div class="handle right"></div>`;
    trackEl.appendChild(div);

    div.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      selectedZoomIdx = i;
      renderZoomTrack();

      const isLeft = e.target.classList.contains("left");
      const isRight = e.target.classList.contains("right");
      const startClientX = e.clientX;
      const origStart = z.start, origEnd = z.end;
      const trackRect = trackEl.getBoundingClientRect();

      const onMove = (ev) => {
        const dMs = ((ev.clientX - startClientX) / trackRect.width) * durMs;
        if (isLeft) {
          z.start = clamp(origStart + dMs, 0, z.end - 300);
        } else if (isRight) {
          z.end = clamp(origEnd + dMs, z.start + 300, durMs);
        } else {
          const dur = origEnd - origStart;
          z.start = clamp(origStart + dMs, 0, durMs - dur);
          z.end = z.start + dur;
        }
        renderZoomTrack();
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        rebuildCamera();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  });
}

// Builds the filmstrip from a second, independent <video> pointed at the same
// file so seeking through it for thumbnails never disturbs the main
// preview's playback position.
async function generateThumbnails() {
  const container = document.getElementById("filmstrip");
  if (!container || !screenUrl) return;
  const count = 20;

  container.innerHTML = "";
  const placeholders = [];
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = "thumb";
    container.appendChild(el);
    placeholders.push(el);
  }

  const tVideo = document.createElement("video");
  tVideo.muted = true;
  tVideo.src = screenUrl;
  await new Promise((res) => { tVideo.onloadedmetadata = res; });

  const tw = 96;
  const th = Math.max(1, Math.round(tw * (tVideo.videoHeight / tVideo.videoWidth || 0.6)));
  const tcanvas = document.createElement("canvas");
  tcanvas.width = tw;
  tcanvas.height = th;
  const tctx = tcanvas.getContext("2d");

  // tVideo.duration is unreliable here — MediaRecorder-produced WebM often
  // reports Infinity until forced to compute it (same issue `video` already
  // had fixed in init()). Reuse that already-correct duration instead.
  const dur = durationSec;
  for (let i = 0; i < count; i++) {
    const t = (dur * (i + 0.5)) / count;
    await new Promise((res) => { tVideo.onseeked = res; tVideo.currentTime = t; });
    tctx.drawImage(tVideo, 0, 0, tw, th);
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = tcanvas.toDataURL("image/jpeg", 0.6);
    placeholders[i].replaceWith(img);
    placeholders[i] = img;
  }
}

/* ---------- transport + controls ---------- */

function fmt(sec) {
  sec = Math.max(0, sec | 0);
  const m = (sec / 60) | 0, s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}

function updateTransport(tMs) {
  const dur = durationSec;
  const playhead = document.getElementById("playhead");
  if (playhead) playhead.style.left = (dur ? (video.currentTime / dur) * 100 : 0) + "%";
  document.getElementById("time").textContent = fmt(video.currentTime) + " / " + fmt(dur);
  document.getElementById("play").textContent = video.paused ? "▶" : "❚❚";
}

function smoothLabel(v) {
  return v < 0.08 ? "Silky" : v < 0.16 ? "Balanced" : "Snappy";
}

function buildControls() {
  const $ = (id) => document.getElementById(id);

  S.showCursor = $("cursor").checked;
  S.zoom = +$("zoom").value;
  S.smooth = +$("smooth").value;
  $("zoomV").textContent = S.zoom.toFixed(1) + "×";
  $("smoothV").textContent = smoothLabel(S.smooth);

  $("play").onclick = () => {
    if (video.paused) {
      // Surface a refused play instead of leaving a button that does nothing.
      video.play().catch((e) => { $("expNote").textContent = "Can't play this recording: " + e.name + " — " + e.message; });
      camVideo && camVideo.play().catch(() => {});
    } else { video.pause(); camVideo && camVideo.pause(); }
  };
  $("mute").onclick = () => {
    S.muted = !S.muted; video.muted = S.muted;
    $("mute").textContent = S.muted ? "🔇" : "🔈";
  };
  setupTimelineDrag();
  setupZoomSelection();

  $("modeAuto").onclick = () => setZoomMode("auto");
  $("modeManual").onclick = () => setZoomMode("manual");
  $("zoom").oninput = (e) => {
    S.zoom = +e.target.value;
    $("zoomV").textContent = S.zoom.toFixed(1) + "×";
    rebuildCamera();
  };
  $("smooth").oninput = (e) => {
    S.smooth = +e.target.value;
    $("smoothV").textContent = smoothLabel(S.smooth);
    rebuildCamera();
  };
  $("pad").oninput = (e) => { S.pad = +e.target.value; $("padV").textContent = Math.round(S.pad * 100) + "%"; };
  $("rad").oninput = (e) => { S.radius = +e.target.value; $("radV").textContent = String(S.radius); };
  $("cursor").onchange = (e) => { S.showCursor = e.target.checked; };

  const bgs = $("bgs");
  Object.keys(BACKGROUNDS).forEach((name) => {
    const [a, b] = BACKGROUNDS[name];
    const btn = document.createElement("button");
    btn.style.background = `linear-gradient(135deg,${a},${b})`;
    if (name === S.bg) btn.classList.add("sel");
    btn.onclick = () => {
      S.bg = name;
      [...bgs.children].forEach((c) => c.classList.remove("sel"));
      btn.classList.add("sel");
    };
    bgs.appendChild(btn);
  });

  $("exportWebm").onclick = () => exportVideo("webm");
  $("exportMp4").onclick = () => exportVideo("mp4");
  $("exportGif").onclick = exportGif;

  if (!pickVideoMime("mp4", true) && !pickVideoMime("mp4", false)) {
    const b = $("exportMp4");
    b.disabled = true;
    b.dataset.unsupported = "1";
    b.title = "MP4 recording isn't supported in this build";
  }

  $("camToggle").checked = S.camEnabled;
  $("camToggle").onchange = (e) => { S.camEnabled = e.target.checked; };
  $("camSizeCtl").value = S.camSize;
  $("camSizeCtl").oninput = (e) => { S.camSize = +e.target.value; };
  [...document.querySelectorAll("#camCorners button")].forEach((b) => {
    if (b.dataset.corner === S.camCorner) b.classList.add("sel");
    b.onclick = () => {
      S.camCorner = b.dataset.corner;
      [...document.querySelectorAll("#camCorners button")].forEach((c) => c.classList.remove("sel"));
      b.classList.add("sel");
    };
  });

  $("splitBtn").onclick = splitAtPlayhead;
  $("deleteBtn").onclick = toggleDeleteSelected;

  $("recordAgainBtn").onclick = () => {
    video.pause();
    if (camVideo) camVideo.pause();
    window.zr.recordAgain(); // keeps this take on disk; closes editor, focuses recorder
  };
  $("discardBtn").onclick = async () => {
    if (!confirm("Delete this recording permanently? This can't be undone.")) return;
    video.pause();
    if (camVideo) camVideo.pause();
    // Release the file handles first — the <video> elements keep the .webm
    // files open, and Windows won't let the main process delete open files.
    video.removeAttribute("src"); video.load();
    if (camVideo) { camVideo.removeAttribute("src"); camVideo.load(); }
    await window.zr.deleteSession(SID);
    window.zr.recordAgain();
  };

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "s" || e.key === "S") splitAtPlayhead();
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (S.zoomMode === "manual" && selectedZoomIdx !== null) {
        S.manualZooms.splice(selectedZoomIdx, 1);
        selectedZoomIdx = null;
        rebuildCamera();
        renderZoomTrack();
      } else {
        toggleDeleteSelected();
      }
    }
  });
}

/* ---------- export (real-time capture of the canvas) ---------- */

function seekTo(el, tSec) {
  return new Promise((res) => {
    el.onseeked = res;
    el.currentTime = tSec;
  });
}

function setExportButtonsDisabled(disabled) {
  ["exportWebm", "exportMp4", "exportGif"].forEach((id) => {
    const b = document.getElementById(id);
    if (b && !b.dataset.unsupported) b.disabled = disabled;
  });
}

// withAudio must reflect whether the stream ACTUALLY carries an audio track.
// Naming an audio codec writes that track into the container header, and if no
// audio ever arrives the file stalls forever on playback — the same defect the
// recorder had for screen-only takes.
function pickVideoMime(format, withAudio) {
  if (format === "mp4") {
    const candidates = withAudio
      ? ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1.42E01E", "video/mp4"]
      : ["video/mp4;codecs=avc1.42E01E", "video/mp4"];
    return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || null;
  }
  if (!withAudio) {
    return MediaRecorder.isTypeSupported("video/webm;codecs=vp8") ? "video/webm;codecs=vp8" : "video/webm";
  }
  // VP8, not VP9. Export captures this canvas in real time, so an encoder that
  // can't sustain 30fps doesn't just take longer — it drops frames, and the
  // export itself comes out stuttering. VP9 software encode at this size is
  // well beyond a laptop CPU; VP8 keeps up, and the bitrate below buys back
  // the per-frame quality difference.
  return MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
}

async function saveBlobAs(blob, defaultName) {
  const buffer = await blob.arrayBuffer();
  return window.zr.saveExport(defaultName, buffer);
}

async function exportVideo(format) {
  if (exporting) return;
  const note = document.getElementById("expNote");

  exporting = true;
  setExportButtonsDisabled(true);

  const fps = 30;
  const cstream = canvas.captureStream(fps);

  let audioTracks = [];
  try {
    video.muted = false;
    const vs = video.captureStream ? video.captureStream() : (video.mozCaptureStream && video.mozCaptureStream());
    if (vs) audioTracks = vs.getAudioTracks();
  } catch (e) {}

  // Picked only now that we know whether there is real audio to declare.
  const mime = pickVideoMime(format, audioTracks.length > 0);
  if (!mime) {
    note.textContent = "MP4 recording isn't supported in this build — try WebM instead.";
    cstream.getTracks().forEach((t) => t.stop());
    video.muted = S.muted;
    exporting = false;
    setExportButtonsDisabled(false);
    return;
  }

  const out = new MediaStream([...cstream.getVideoTracks(), ...audioTracks]);
  const rec = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: 20_000_000 });
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  const done = new Promise((res) => { rec.onstop = res; });

  // Play through the WHOLE recording in one continuous, uninterrupted pass —
  // never pausing — and jump forward past cut regions while still playing.
  video.pause();
  if (camVideo) camVideo.pause();
  await seekTo(video, 0);
  if (camVideo) await seekTo(camVideo, 0);

  rec.start();
  await video.play();
  if (camVideo) camVideo.play().catch(() => {});

  await new Promise((res) => {
    const tick = () => {
      let curMs = video.currentTime * 1000;
      const skipTo = cutEndAt(curMs);
      if (skipTo !== null) {
        const durMs = durationSec * 1000;
        const newT = Math.min(skipTo, durMs);
        video.currentTime = newT / 1000;
        if (camVideo) camVideo.currentTime = newT / 1000;
        curMs = newT;
      }
      const totalMs = durationSec * 1000;
      note.textContent = "Exporting… " + Math.min(100, Math.round((curMs / (totalMs || 1)) * 100)) + "%";
      if (video.ended || curMs >= totalMs - 5) { res(); return; }
      requestAnimationFrame(tick);
    };
    video.addEventListener("ended", res, { once: true });
    requestAnimationFrame(tick);
  });

  video.pause();
  if (camVideo) camVideo.pause();
  rec.stop();
  await done;

  const ext = format === "mp4" ? "mp4" : "webm";
  const outBlob = new Blob(parts, { type: mime.split(";")[0] });
  const saveResult = await saveBlobAs(outBlob, "zoomreel-" + SID + "." + ext);

  video.muted = S.muted;
  exporting = false;
  setExportButtonsDisabled(false);
  note.textContent = saveResult.ok ? "Saved to " + saveResult.filePath : "Export ready, but save was cancelled.";
}

/* ---------- export as GIF (frame capture, no audio) ---------- */

async function exportGif() {
  if (exporting) return;
  exporting = true;
  const note = document.getElementById("expNote");
  setExportButtonsDisabled(true);

  const segments = computeKeptSegments();
  const totalKeptMs = segments.reduce((s, seg) => s + (seg.end - seg.start), 0) || 1;

  const gifFps = 14;
  const maxW = 900;
  const scale = Math.min(1, maxW / canvas.width);
  const gw = Math.round(canvas.width * scale);
  const gh = Math.round(canvas.height * scale);

  const gif = new GIF({
    workers: 4,
    quality: 1,
    dither: "FloydSteinberg",
    width: gw,
    height: gh,
    workerScript: "gif.worker.js",
  });

  const frameCanvas = document.createElement("canvas");
  frameCanvas.width = gw;
  frameCanvas.height = gh;
  const fctx = frameCanvas.getContext("2d");

  video.pause();
  if (camVideo) camVideo.pause();

  const frameIntervalMs = 1000 / gifFps;
  let playedMs = 0;
  for (const seg of segments) {
    await seekTo(video, seg.start / 1000);
    if (camVideo) await seekTo(camVideo, seg.start / 1000);

    await video.play();
    if (camVideo) camVideo.play().catch(() => {});

    const segStartMs = seg.start;
    let lastCapturedMs = -Infinity;
    let lastCaptureClock = null;
    await new Promise((res) => {
      const tick = () => {
        const curMs = video.currentTime * 1000;
        if (video.ended || curMs >= seg.end - 5) { res(); return; }
        if (curMs - lastCapturedMs >= frameIntervalMs) {
          const now = performance.now();
          const delay = lastCaptureClock === null ? frameIntervalMs : now - lastCaptureClock;
          fctx.drawImage(canvas, 0, 0, gw, gh);
          gif.addFrame(fctx, { copy: true, delay });
          lastCapturedMs = curMs;
          lastCaptureClock = now;
          const overall = playedMs + Math.max(0, curMs - segStartMs);
          note.textContent = "Capturing frames… " + Math.min(100, Math.round((overall / totalKeptMs) * 100)) + "%";
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    video.pause();
    if (camVideo) camVideo.pause();
    playedMs += seg.end - seg.start;
  }

  note.textContent = "Encoding GIF…";
  const outBlob = await new Promise((res) => {
    gif.on("progress", (p) => { note.textContent = "Encoding GIF… " + Math.round(p * 100) + "%"; });
    gif.on("finished", (blob) => res(blob));
    gif.render();
  });

  const saveResult = await saveBlobAs(outBlob, "zoomreel-" + SID + ".gif");

  video.muted = S.muted;
  exporting = false;
  setExportButtonsDisabled(false);
  note.textContent = saveResult.ok
    ? "Saved to " + saveResult.filePath + " (capped at " + gifFps + " fps / " + maxW + "px wide)"
    : "GIF ready, but save was cancelled.";
}
