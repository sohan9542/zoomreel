// Recorder UI. Unlike the extension (which needed a separate visible tab
// just to get camera/mic permission, since invisible offscreen documents
// couldn't), everything runs directly in this one window — Electron has
// none of that restriction.
const screenSourcesEl = document.getElementById("screenSources");
const windowSourcesEl = document.getElementById("windowSources");
const camToggle = document.getElementById("camToggle");
const camSelect = document.getElementById("camSelect");
const micToggle = document.getElementById("micToggle");
const micSelect = document.getElementById("micSelect");
const sysToggle = document.getElementById("sysToggle");
const camWrap = document.getElementById("camWrap");
const camPreview = document.getElementById("camPreview");
const btn = document.getElementById("btn");
const sub = document.getElementById("sub");
const timerEl = document.getElementById("timer");
const errEl = document.getElementById("err");
const recentListEl = document.getElementById("recentList");

let sources = [];
let selectedSource = null;
let recording = false;
let sessionId = null;
let screenRecorder = null, camRecorder = null, micRecorder = null;
let displayStream = null, sysStream = null, micStream = null, camStream = null, audioCtx = null, audioNodes = [];
let events = [];
let startedAt = 0, timerHandle = null;
let stopInputTracking = null;
// Mic and system audio get mixed into one track, so once a take is recorded
// there's no way to tell which input a given sound came from. These watch each
// input separately while recording and the answer lands in meta.json.
let audioMeters = [], meterCtx = null;

function showErr(m) {
  errEl.textContent = m;
  errEl.style.display = "block";
}

function describeTrack(t) {
  if (!t) return null;
  return {
    id: t.id,
    label: t.label,
    readyState: t.readyState,
    muted: t.muted,
    enabled: t.enabled,
    settings: t.getSettings ? t.getSettings() : null,
  };
}

function fmt(sec) {
  sec = Math.max(0, sec | 0);
  const m = (sec / 60) | 0, s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}

function syncSelectVisibility() {
  camSelect.classList.toggle("show", camToggle.checked);
  micSelect.classList.toggle("show", micToggle.checked);
}

function fillSelect(select, list, fallbackLabel) {
  select.innerHTML = "";
  if (!list.length) {
    const opt = document.createElement("option");
    opt.textContent = `No ${fallbackLabel.toLowerCase()} found`;
    select.appendChild(opt);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  list.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `${fallbackLabel} ${i + 1}`;
    select.appendChild(opt);
  });
}

async function loadSources() {
  const prevSelectedId = selectedSource?.id || null;
  sources = await window.zr.getSources();
  screenSourcesEl.innerHTML = "";
  windowSourcesEl.innerHTML = "";

  // desktopCapturer source ids are "screen:N:0" for a whole monitor and
  // "window:N:0" for a single window — split on that so "entire screen"
  // options are visually separate from individual window thumbnails,
  // instead of one flat grid where it's unclear which is which.
  const allEls = [];
  let matchedPrev = false;
  sources.forEach((s) => {
    const isScreen = s.id.startsWith("screen:");
    const container = isScreen ? screenSourcesEl : windowSourcesEl;
    const el = document.createElement("div");
    el.className = "source";
    el.innerHTML = `<img src="${s.thumbnail}" /><div class="name">${isScreen ? s.name.replace(/^Screen/, "Entire screen") : s.name}</div>`;
    el.onclick = () => {
      selectedSource = s;
      allEls.forEach((c) => c.classList.remove("sel"));
      el.classList.add("sel");
    };
    container.appendChild(el);
    allEls.push(el);
    if (s.id === prevSelectedId) {
      selectedSource = s; // keep selection across refreshes, just with the new thumbnail
      el.classList.add("sel");
      matchedPrev = true;
    } else if (!prevSelectedId && !selectedSource && isScreen) {
      selectedSource = s;
      el.classList.add("sel");
      matchedPrev = true;
    }
  });
  if (!matchedPrev) selectedSource = null; // previously selected source disappeared (e.g. window closed)
}

// Thumbnails from desktopCapturer are single still snapshots, not a live
// stream — poll for fresh ones while the picker is up so they look real-time.
// Streaming actual video per thumbnail would mean one capture per source
// just for the picker, not worth it for a preview grid.
let sourceRefreshTimer = null;
function startSourceRefresh() {
  stopSourceRefresh();
  loadSources();
  // desktopCapturer.getSources() with thumbnails does a real capture of every
  // open window/screen on each call — expensive enough that polling once a
  // second visibly loads the system. 3s keeps thumbnails reasonably fresh
  // without the CPU/GPU spike.
  sourceRefreshTimer = setInterval(loadSources, 3000);
}
function stopSourceRefresh() {
  if (sourceRefreshTimer) { clearInterval(sourceRefreshTimer); sourceRefreshTimer = null; }
}

async function loadDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    fillSelect(camSelect, devices.filter((d) => d.kind === "videoinput"), "Camera");
    fillSelect(micSelect, devices.filter((d) => d.kind === "audioinput"), "Microphone");
  } catch (e) {}
}

function fmtRecordingDate(epoch) {
  const d = new Date(epoch);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? `Today · ${time}` : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${time}`;
}

// Recordings are saved to disk the moment a take finishes (recordingFinish
// in main.js) — closing the recorder or hitting "Record again" without
// exporting never loses that file. This list is just making that already-
// persisted state visible and reopenable.
async function loadRecordings() {
  if (!recentListEl) return;
  const list = await window.zr.listSessions();
  recentListEl.innerHTML = "";
  if (!list.length) {
    recentListEl.innerHTML = `<div class="recent-empty">No recordings yet — they'll show up here after you stop one.</div>`;
    return;
  }
  for (const s of list) {
    const row = document.createElement("div");
    row.className = "recent-item";
    const editSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="M15 5l4 4"/></svg>`;
    const trashSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
    row.innerHTML = `<span class="meta">${s.hasWebcam ? "🎬🎥" : "🎬"} ${fmtRecordingDate(s.startEpoch)}</span><div class="actions"><button class="edit" title="Edit">${editSvg}</button><button class="del" title="Delete">${trashSvg}</button></div>`;
    row.onclick = () => window.zr.openEditor(s.id);
    row.querySelector(".edit").onclick = (e) => {
      e.stopPropagation();
      window.zr.openEditor(s.id);
    };
    row.querySelector(".del").onclick = async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this recording permanently? This can't be undone.")) return;
      await window.zr.deleteSession(s.id);
      loadRecordings();
    };
    recentListEl.appendChild(row);
  }
}
window.addEventListener("focus", loadRecordings);

// A forced 640x640 (square) request pushes some webcam drivers' Media
// Foundation capture pipeline into a mode it can't sustain — shows up as
// continuous "Failed to reserve output capture buffer" errors and a dead feed.
// Ask for a normal resolution instead and let CSS/canvas (object-fit: cover)
// crop it into the circular bubble. The frame-rate cap serves the same error
// from the other side: a 60fps feed gives the encoder twice the frames to keep
// up with.
function camConstraints() {
  const c = { width: { ideal: 640 }, frameRate: { ideal: 30, max: 30 } };
  if (camSelect.value) c.deviceId = { exact: camSelect.value };
  return c;
}

// Self-view goes live the moment the toggle flips, not when recording starts.
// startRecording() then reuses this exact stream, so the device is only ever
// opened once — opening a second capture on the same webcam mid-start is what
// stalls USB cams.
async function openCamPreview() {
  if (recording) return;
  if (!camStream) {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: camConstraints() });
    } catch (e) {
      showErr(`Camera: ${e.name}: ${e.message}`);
      return;
    }
  }
  camPreview.srcObject = camStream;
  camWrap.classList.add("show");
}

function closeCamPreview() {
  try { camStream && camStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  camStream = null;
  camPreview.srcObject = null;
  camWrap.classList.remove("show");
}

camToggle.onchange = () => {
  syncSelectVisibility();
  if (camToggle.checked) openCamPreview();
  else closeCamPreview();
};
micToggle.onchange = syncSelectVisibility;
camSelect.onchange = () => {
  if (recording || !camToggle.checked) return;
  closeCamPreview(); // switching devices means a new capture, not a re-attach
  openCamPreview();
};
syncSelectVisibility();

async function startRecording() {
  if (!selectedSource) { showErr("Pick a screen or window first."); return; }
  errEl.style.display = "none";
  btn.disabled = true;
  stopSourceRefresh();

  sessionId = Date.now();
  events = [];

  // Defensive: guarantee a clean slate even if a previous stop cycle somehow
  // left one of these non-null — otherwise the audio-mixing step below can
  // silently fold a leftover track from the last session into this one.
  // camStream is deliberately spared: it's the live self-view preview, and
  // this take reuses it rather than reopening the device.
  [displayStream, sysStream, micStream].forEach((s) => { try { s && s.getTracks().forEach((t) => t.stop()); } catch (e) {} });
  try { audioCtx && audioCtx.close(); } catch (e) {}
  displayStream = null; sysStream = null; micStream = null; audioCtx = null;

  try {
    const wantSysAudio = sysToggle.checked;
    // Pause + mute editors BEFORE opening desktop loopback — otherwise the
    // new take's audio track is whatever previous editors were still playing.
    await window.zr.silenceForRecording();
    await window.zr.setCaptureSource(selectedSource.id, wantSysAudio);

    // Start cursor/click tracking as early as possible — the capture setup
    // below can take real time, and screenRecorder starts recording actual
    // frames after it. Tracking used to start late, leaving the first stretch
    // of video with zero tracked cursor positions (camera.js just freezes on
    // whatever point comes first, which is often off in the wrong spot).
    stopInputTracking = window.zr.onInputEvent((ev) => events.push(ev));
    window.zr.startTracking(selectedSource.display_id);

    // ORDER MATTERS below: every audio device opened here keeps buffering
    // until MediaRecorder.start() finally consumes it, and that backlog is
    // written as the head of the file — audio from before the take began,
    // pushing everything after it out of sync. So the slow, non-audio setup
    // (camera device negotiation) happens FIRST, and each audio source is
    // opened as late as its own ordering constraint allows.
    let hasCam = false, camError = null;
    if (camToggle.checked) {
      try {
        // Normally already open from the preview — this only runs if the
        // preview failed or was never shown.
        if (!camStream) camStream = await navigator.mediaDevices.getUserMedia({ video: camConstraints() });
        hasCam = true;
      } catch (e) { camError = `${e.name}: ${e.message}`; }
    }

    // System audio: the classic chromeMediaSource:"desktop" path, NOT
    // getDisplayMedia's loopback — see the note in main.js. Chromium only
    // allows desktop audio when desktop video is requested alongside it, so
    // request both and immediately drop the video track. That paired video
    // track ALWAYS bakes in the real OS cursor with no way to suppress it —
    // acquire and fully release it here, BEFORE opening the cursor:"never"
    // video capture below. Doing both at once had two capture sessions live
    // on the same source simultaneously, and the cursor from this one would
    // intermittently bleed into the other — the flickering second cursor.
    // That constraint is why loopback can't be opened any later than this.
    let sysError = null;
    if (wantSysAudio) {
      try {
        sysStream = await navigator.mediaDevices.getUserMedia({
          audio: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: selectedSource.id } },
          video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: selectedSource.id } },
        });
        sysStream.getVideoTracks().forEach((t) => t.stop());
        // Give Chromium a beat to actually tear down that capture session
        // before the next one opens on the same source.
        await new Promise((r) => setTimeout(r, 150));
      } catch (e) { sysError = `${e.name}: ${e.message}`; }
    }

    // Video: getDisplayMedia so we get cursor:"never" (no OS cursor baked in).
    // Cap at 30fps. Chromium will happily hand back 60fps on a 60Hz display,
    // which doubles the encoder's work for nothing — the editor renders and
    // exports at 30 either way.
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: "never", frameRate: { ideal: 30, max: 30 } },
      audio: false,
    });

    // Mic last — nothing forces it earlier, so it gets the shortest pre-roll.
    let micError = null;
    if (micToggle.checked) {
      try {
        // All three OFF deliberately. They exist for voice calls, not screen
        // recording, and both hurt here:
        //  - echoCancellation routes the mic through Chromium's AEC, which is
        //    clocked off the *output* device. A USB mic on its own clock then
        //    drifts against it, and the drift accumulates as growing latency —
        //    audio falling further behind picture the longer a take runs, with
        //    a backlog still flushing after you hit stop.
        //  - with system audio also being recorded, AEC actively subtracts the
        //    speaker output from the mic signal, mangling it on purpose.
        const constraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
        if (micSelect.value) constraints.deviceId = { exact: micSelect.value };
        micStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      } catch (e) { micError = `${e.name}: ${e.message}`; }
    }

    const audioSources = [...(sysStream ? sysStream.getAudioTracks() : []), ...(micStream ? micStream.getAudioTracks() : [])];
    let audioTrack = null;
    if (audioSources.length === 1) {
      audioTrack = audioSources[0];
    } else if (audioSources.length > 1) {
      // Pin the graph to the capture devices' own rate. Left to default, the
      // context runs at the *output* device's rate and every input gets
      // resampled — and Chromium's MediaStreamAudioSourceNode does not
      // compensate for clock drift across that resample, so a rate mismatch
      // accumulates into seconds of lag over a long take.
      const rates = audioSources.map((t) => t.getSettings?.().sampleRate).filter(Boolean);
      audioCtx = new AudioContext(rates.length ? { sampleRate: Math.max(...rates) } : undefined);
      const dest = audioCtx.createMediaStreamDestination();
      // The source nodes MUST stay referenced. Chromium garbage-collects an
      // unreferenced MediaStreamAudioSourceNode even while it's connected and
      // producing sound, and that input silently drops out mid-recording.
      audioNodes = audioSources.map((t) => {
        const src = audioCtx.createMediaStreamSource(new MediaStream([t]));
        src.connect(dest);
        return src;
      });
      audioTrack = dest.stream.getAudioTracks()[0];
    }

    // Tap each input separately, before the mix. AnalyserNodes with nothing
    // connected downstream are still driven by the graph ("automatic pull
    // nodes"), so this needs no output path.
    const labelled = [
      ...(sysStream ? sysStream.getAudioTracks().map((t) => ["System audio", t]) : []),
      ...(micStream ? micStream.getAudioTracks().map((t) => ["Microphone", t]) : []),
    ];
    if (labelled.length) {
      meterCtx = audioCtx || new AudioContext();
      audioMeters = labelled.map(([name, t]) => {
        const analyser = meterCtx.createAnalyser();
        analyser.fftSize = 1024;
        const src = meterCtx.createMediaStreamSource(new MediaStream([t]));
        src.connect(analyser);
        // src kept on the object for the same GC reason as the mixer nodes.
        return { name, src, analyser, buf: new Float32Array(analyser.fftSize), active: 0, samples: 0, peak: 0 };
      });
    }

    const screenTracks = [...displayStream.getVideoTracks()];
    if (audioTrack) screenTracks.push(audioTrack);
    const screenStream = new MediaStream(screenTracks);

    // Which audio Chromium actually handed us. `muted: true` on a live track
    // means the device is delivering no data, and an id/label identical to the
    // previous take's means Chromium reused that take's capture session — the
    // two explanations for "new recording, previous recording's audio".
    window.__zrAudioDiag = {
      sessionId,
      start: {
        sys: describeTrack(sysStream && sysStream.getAudioTracks()[0]),
        mic: describeTrack(micStream && micStream.getAudioTracks()[0]),
        mixed: describeTrack(audioTrack),
        mixedFrom: audioSources.length,
      },
    };

    await window.zr.recordingStart(sessionId, hasCam, !!micStream);

    // Snapshot the id here — sessionId itself gets reassigned the moment the
    // *next* recording starts, and these handlers otherwise keep reading the
    // live (by-reference) variable, so a straggler chunk that arrives after
    // that reassignment would get written into the wrong session's file.
    const sid = sessionId;
    let pendingChunks = 0;
    const waitForChunks = async () => {
      while (pendingChunks > 0) await new Promise((r) => setTimeout(r, 20));
    };
    window.__zrWaitForChunks = waitForChunks;

    // Wait for the capture to actually produce a frame before starting the
    // encoder. This is a CLOCK ANCHOR, not a buffer drain.
    //
    // MediaRecorder's timeline begins at its first frame (T0), but startedAt —
    // which every cursor event is measured against — is stamped just after
    // start(). Any delay before that first frame arrives makes T0 later than
    // startedAt, and every zoom in the take then fires late by exactly that
    // gap: click, a beat, then the camera moves. Warming up first keeps the two
    // clocks anchored together.
    //
    // A fixed sleep used to sit here and did this by accident. Waiting on the
    // real frame is shorter when the pipeline is quick and long enough when it
    // isn't; the timeout stops a source that never repaints from stalling it.
    const warm = document.createElement("video");
    warm.srcObject = new MediaStream(displayStream.getVideoTracks());
    warm.muted = true;
    await warm.play().catch(() => {});
    await new Promise((res) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; res(); } };
      if (warm.requestVideoFrameCallback) warm.requestVideoFrameCallback(done);
      else warm.onloadeddata = done;
      setTimeout(done, 1500);
    });
    warm.pause();
    warm.srcObject = null;

    // VP8, not VP9, for the same reason the camera encoder below uses it: both
    // run as software encoders in this one renderer, and VP9 at 1080p costs
    // several times more CPU than VP8. On a laptop chip it can't sustain real
    // time — the encoder falls behind, frames get dropped, and the audio
    // interleaving stutters with it.
    //
    // Bitrate stays high, though. CPU cost is driven by codec and resolution,
    // not by the bitrate, and VP8 needs MORE bits than VP9 for equal quality.
    // Starving it makes the encoder raise the quantizer exactly when the frame
    // changes most — every mouse move smears the text. 16 Mbps is cheap to
    // encode and keeps screen content sharp through motion.
    // Only claim opus when there is actually an audio track. Naming a codec
    // for a track the stream doesn't have still writes that track into the
    // container header, and the file then declares audio that never arrives —
    // players wait for it forever and never start. With mic, camera and system
    // audio all off there is no audio track at all, which is how this got hit.
    const mime = audioTrack
      ? (MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm")
      : (MediaRecorder.isTypeSupported("video/webm;codecs=vp8") ? "video/webm;codecs=vp8" : "video/webm");
    screenRecorder = new MediaRecorder(screenStream, { mimeType: mime, videoBitsPerSecond: 16_000_000 });
    screenRecorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      pendingChunks++;
      e.data.arrayBuffer().then((buf) => {
        window.zr.recordingChunk(sid, "screen", buf);
        pendingChunks--;
      }).catch(() => { pendingChunks--; });
    };
    screenRecorder.start(250);
    // Stamped HERE, not after the camera/mic recorders are wired up further
    // down. Every cursor event is measured against this, so it has to sit as
    // close to the screen recorder's own t=0 as possible — anything in between
    // becomes a constant offset on every zoom in the take.
    startedAt = Date.now();

    if (camStream) {
      // VP8, not VP9: this encoder runs in the same renderer as the 25 Mbps
      // full-resolution screen encode above. Two software VP9 streams saturate
      // the CPU, the renderer stops releasing captured camera frames, and the
      // camera's capture pool exhausts — Chromium then spams "Failed to
      // reserve output capture buffer" and the feed stalls. VP8 on a 640px
      // circle is visually indistinguishable and far cheaper.
      const camMime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8") ? "video/webm;codecs=vp8" : "video/webm";
      camRecorder = new MediaRecorder(camStream, { mimeType: camMime, videoBitsPerSecond: 2_500_000 });
      camRecorder.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        pendingChunks++;
        e.data.arrayBuffer().then((buf) => {
          window.zr.recordingChunk(sid, "cam", buf);
          pendingChunks--;
        }).catch(() => { pendingChunks--; });
      };
      camRecorder.start(250);
      // Detach the self-view once the encoder owns the stream. A <video> in a
      // window that's behind whatever you're recording still holds captured
      // camera frames without releasing them, and once the device's buffer pool
      // is empty Media Foundation logs "Failed to reserve output capture
      // buffer" per frame and the feed freezes mid-take.
      camPreview.srcObject = null;
      camWrap.classList.remove("show");
    }

    // The mic, on its own, straight from the device — no mixing, no system
    // audio, nothing shared with the take's main audio track. If a recording
    // ever contains sound the mic didn't hear, comparing this against
    // screen.webm says immediately which side of the pipeline put it there.
    if (micStream) {
      micRecorder = new MediaRecorder(new MediaStream(micStream.getAudioTracks()), { mimeType: "audio/webm;codecs=opus" });
      micRecorder.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        pendingChunks++;
        e.data.arrayBuffer().then((buf) => {
          window.zr.recordingChunk(sid, "mic", buf);
          pendingChunks--;
        }).catch(() => { pendingChunks--; });
      };
      micRecorder.start(250);
    }

    const track = displayStream.getVideoTracks()[0];
    const settings = track?.getSettings?.() || {};

    recording = true;
    btn.textContent = "Stop recording";
    btn.classList.add("rec");
    btn.disabled = false;
    sub.textContent = "Recording…";
    timerEl.style.display = "block";
    timerHandle = setInterval(() => {
      timerEl.textContent = fmt((Date.now() - startedAt) / 1000);
      for (const m of audioMeters) {
        m.analyser.getFloatTimeDomainData(m.buf);
        let sum = 0;
        for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] * m.buf[i];
        const rms = Math.sqrt(sum / m.buf.length);
        m.samples++;
        if (rms > 0.02) m.active++; // measured noise floor sits around 0.011
        if (rms > m.peak) m.peak = rms;
      }
    }, 250);

    if (camError || micError || sysError) {
      showErr([camError && "Camera: " + camError, micError && "Microphone: " + micError, sysError && "System audio: " + sysError].filter(Boolean).join(" · "));
    }

    displayStream.getVideoTracks()[0]?.addEventListener("ended", () => { if (recording) stopRecording(); });

    window.__zrCaptureInfo = { width: settings.width || null, height: settings.height || null, hasCam, camError, micError };
  } catch (e) {
    if (stopInputTracking) { stopInputTracking(); stopInputTracking = null; }
    window.zr.stopTracking();
    window.zr.unsilence();
    // Release everything acquired before the failure — without this, a
    // failed start leaves the mic/cam/screen streams live indefinitely
    // (Windows shows the mic as permanently in use).
    [displayStream, sysStream, micStream, camStream].forEach((s) => { try { s && s.getTracks().forEach((t) => t.stop()); } catch (_) {} });
    try { audioCtx && audioCtx.close(); } catch (_) {}
    displayStream = null; sysStream = null; micStream = null; camStream = null; audioCtx = null; audioNodes = [];
    camPreview.srcObject = null;
    camWrap.classList.remove("show");
    if (camToggle.checked) openCamPreview();
    showErr(String(e.message || e));
    btn.disabled = false;
    startSourceRefresh();
  }
}

let stopping = false;

async function stopRecording() {
  // Stopping our own displayStream track below fires that track's "ended"
  // event, which is the same event the recording-start handler listens on to
  // auto-stop if the user ends screen-share from the OS. Without this guard
  // that self-triggered event re-enters stopRecording() while the original
  // call is still mid-flight (still awaiting recordingFinish), and the
  // reentrant call finishes first and re-enables the Start button before the
  // real cleanup is done.
  if (stopping) return;
  stopping = true;
  btn.disabled = true;
  btn.textContent = "Finishing…";
  clearInterval(timerHandle);
  if (stopInputTracking) stopInputTracking();
  window.zr.stopTracking();

  // Everything below is wrapped in try/finally: if recordingFinish (or
  // anything else here) throws, the state reset in `finally` still runs.
  // Without that guarantee, a thrown error would leave displayStream/
  // micStream/camStream/audioCtx pointing at stale (previous-session)
  // objects instead of null, and the very next startRecording() call would
  // fold their leftover tracks into its own audio mix.
  try {
    await Promise.all([
      new Promise((res) => { if (!screenRecorder || screenRecorder.state === "inactive") return res(); screenRecorder.onstop = res; screenRecorder.stop(); }),
      new Promise((res) => { if (!camRecorder || camRecorder.state === "inactive") return res(); camRecorder.onstop = res; camRecorder.stop(); }),
      new Promise((res) => { if (!micRecorder || micRecorder.state === "inactive") return res(); micRecorder.onstop = res; micRecorder.stop(); }),
    ]);

    // Snapshot the audio tracks while they're still live — stopping them below
    // resets readyState/muted and destroys the evidence.
    if (window.__zrAudioDiag) {
      window.__zrAudioDiag.end = {
        sys: describeTrack(sysStream && sysStream.getAudioTracks()[0]),
        mic: describeTrack(micStream && micStream.getAudioTracks()[0]),
      };
    }

    try { displayStream && displayStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { sysStream && sysStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { micStream && micStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { camStream && camStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { audioCtx && audioCtx.close(); } catch (e) {}

    // Final MediaRecorder chunks are async (arrayBuffer) — don't close the
    // write streams until they've actually been sent to main.
    if (window.__zrWaitForChunks) await window.__zrWaitForChunks();

    const info = window.__zrCaptureInfo || {};
    await window.zr.recordingFinish(sessionId, {
      id: sessionId,
      startEpoch: startedAt,
      events,
      captureW: info.width || null,
      captureH: info.height || null,
      hasWebcam: !!info.hasCam,
      camError: info.camError || null,
      micError: info.micError || null,
      audioActivity: audioMeters.map((m) => ({
        name: m.name,
        activePct: m.samples ? Math.round((m.active / m.samples) * 100) : 0,
        peak: +m.peak.toFixed(3),
      })),
      audioDiag: window.__zrAudioDiag || null,
    });

    window.zr.openEditor(sessionId);
  } finally {
    try { meterCtx && meterCtx !== audioCtx && meterCtx.close(); } catch (e) {}
    meterCtx = null; audioMeters = [];
    recording = false;
    screenRecorder = null; camRecorder = null; micRecorder = null;
    displayStream = null; sysStream = null; micStream = null; camStream = null; audioCtx = null; audioNodes = [];
    camPreview.srcObject = null;
    camWrap.classList.remove("show");
    if (camToggle.checked) openCamPreview(); // self-view comes straight back
    btn.textContent = "Start recording";
    btn.classList.remove("rec");
    btn.disabled = false;
    sub.textContent = "Pick what to record.";
    timerEl.style.display = "none";
    startSourceRefresh();
    loadRecordings();
    stopping = false;
  }
}

btn.onclick = () => {
  if (recording) stopRecording();
  else startRecording();
};

startSourceRefresh();
loadDevices();
loadRecordings();
