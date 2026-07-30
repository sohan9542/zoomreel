// Cinematic virtual camera, Screen Studio-style:
//  - clicks/typing open a zoom "segment"; nearby actions merge into one segment
//  - while zoomed the camera FOLLOWS the cursor (spring + dead zone), never
//    zooming out mid-activity
//  - zoom eases out only after real inactivity
// The camera is simulated once over the whole timeline into keyframes, so
// evaluate(t) is pure and scrubbing/export work.
const ZR_CAMERA = (() => {
  const DEFAULTS = {
    zoomLevel: 1.7,
    zoomInMs: 1000,
    zoomOutMs: 1300,
    mergeMs: 4000,   // actions closer than this share one zoom segment
    holdMs: 1800,    // stay zoomed this long after the last action
    pathWindowMs: 150,
  };

  // --- Cubic-bezier easing (CSS control points) ---
  function cubicBezier(x1, y1, x2, y2) {
    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;

    const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
    const sampleY = (t) => ((ay * t + by) * t + cy) * t;
    const sampleDX = (t) => (3 * ax * t + 2 * bx) * t + cx;

    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) {
        const err = sampleX(t) - x;
        if (Math.abs(err) < 1e-6) break;
        const dx = sampleDX(t);
        if (Math.abs(dx) < 1e-6) break;
        t -= err / dx;
      }
      return sampleY(t);
    };
  }

  const EASE_OUT = cubicBezier(0.22, 1, 0.36, 1);
  const EASE_IN_OUT = cubicBezier(0.42, 0, 0.58, 1);

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // --- Gaussian pre-filter on move samples ---
  // Symmetric, so it removes jitter WITHOUT introducing any delay — the
  // smoothed point sits at the same instant as the raw one. That property is
  // what lets the camera be smooth and on-time at once.
  // Two-pointer window rather than scanning every sample against every other:
  // this now runs twice (cursor path + the wider camera path) and the old
  // O(n²) form was ~324M iterations on a five-minute take, re-run on every
  // slider nudge.
  function gaussianSmooth(moves, windowMs) {
    if (moves.length < 3) return moves;
    const sigma = windowMs * 0.38;
    const denom = 2 * sigma * sigma;
    const out = new Array(moves.length);
    let lo = 0, hi = 0;
    for (let i = 0; i < moves.length; i++) {
      const e = moves[i];
      while (lo < moves.length && moves[lo].t < e.t - windowMs) lo++;
      if (hi < lo) hi = lo;
      while (hi < moves.length && moves[hi].t <= e.t + windowMs) hi++;
      let wx = 0, wy = 0, w = 0;
      for (let j = lo; j < hi; j++) {
        const dt = moves[j].t - e.t;
        const k = Math.exp(-(dt * dt) / denom);
        wx += moves[j].x * k;
        wy += moves[j].y * k;
        w += k;
      }
      out[i] = { t: e.t, x: wx / w, y: wy / w, k: "m" };
    }
    return out;
  }

  function catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
      (2 * p1) +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
  }

  function buildPath(moves, windowMs) {
    const pts = gaussianSmooth(moves, windowMs);
    if (!pts.length) {
      return { sample: () => ({ x: 0.5, y: 0.5 }), velocity: () => ({ x: 0, y: 0 }) };
    }
    if (pts.length === 1) {
      const p = pts[0];
      return { sample: () => ({ x: p.x, y: p.y }), velocity: () => ({ x: 0, y: 0 }) };
    }

    function sample(t) {
      return sampleSpline(pts, t);
    }

    function velocity(t) {
      const dt = 33;
      const p0 = sample(Math.max(0, t - dt));
      const p1 = sample(t + dt);
      return { x: (p1.x - p0.x) / (2 * dt) * 1000, y: (p1.y - p0.y) / (2 * dt) * 1000 };
    }

    return { sample, velocity };
  }

  function sampleSpline(pts, t) {
    if (t <= pts[0].t) return { x: pts[0].x, y: pts[0].y };
    if (t >= pts[pts.length - 1].t) return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };

    let lo = 0, hi = pts.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (pts[m].t <= t) lo = m;
      else hi = m - 1;
    }
    const i = lo;
    const a = pts[i], b = pts[i + 1] || a;
    const span = (b.t - a.t) || 1;
    const u = clamp((t - a.t) / span, 0, 1);

    return {
      x: catmullRom(pts[Math.max(0, i - 1)].x, a.x, b.x, pts[Math.min(pts.length - 1, i + 2)].x, u),
      y: catmullRom(pts[Math.max(0, i - 1)].y, a.y, b.y, pts[Math.min(pts.length - 1, i + 2)].y, u),
    };
  }

  function attachCursorToKeys(events, path) {
    for (const e of events) {
      if ((e.k === "k" || e.k === "c" || e.k === "h") && (!Number.isFinite(e.x) || !Number.isFinite(e.y))) {
        const p = path.sample(e.t);
        e.x = p.x;
        e.y = p.y;
      }
    }
  }

  // --- Activity segments: zoom in on click/type, stay until scroll ---
  // Scroll is the only intentional zoom-out. Without that, a short holdMs made
  // the camera keep popping out mid-demo. Older takes with no "s" events fall
  // back to the previous hold/merge behaviour.
  function buildSegmentsHold(triggers, totalMs, cfg) {
    const segs = [];
    for (const trig of triggers) {
      const last = segs[segs.length - 1];
      if (last && trig.t - last.lastT < cfg.mergeMs) {
        last.lastT = trig.t;
      } else {
        segs.push({ start: trig.t, lastT: trig.t });
      }
    }
    for (const s of segs) {
      s.end = Math.min(
        Math.max(s.lastT + cfg.holdMs, s.start + cfg.zoomInMs + 400),
        totalMs
      );
      s.zEnd = lerp(1, cfg.zoomLevel,
        EASE_IN_OUT(clamp((s.end - s.start) / cfg.zoomInMs, 0, 1)));
    }
    return segs;
  }

  function buildSegments(triggers, scrolls, totalMs, cfg) {
    if (!scrolls.length) return buildSegmentsHold(triggers, totalMs, cfg);

    const segs = [];
    for (const trig of triggers) {
      const last = segs[segs.length - 1];
      // Still inside an open zoom → just refresh activity, don't restart.
      if (last && trig.t < last.end) {
        last.lastT = trig.t;
        continue;
      }
      // End at the next scroll after this action (grace so a click's own
      // trackpad jitter doesn't immediately cancel the zoom-in).
      let end = totalMs;
      for (const sc of scrolls) {
        if (sc.t > trig.t + 150) {
          end = sc.t;
          break;
        }
      }
      end = Math.min(totalMs, Math.max(end, trig.t + cfg.zoomInMs + 400));
      segs.push({ start: trig.t, lastT: trig.t, end });
    }
    for (const s of segs) {
      s.zEnd = lerp(1, cfg.zoomLevel,
        EASE_IN_OUT(clamp((s.end - s.start) / cfg.zoomInMs, 0, 1)));
    }
    return segs;
  }

  function zoomAtT(t, segs, cfg) {
    let z = 1;
    for (const s of segs) {
      let local = 1;
      if (t >= s.start && t < s.end) {
        local = lerp(1, cfg.zoomLevel, EASE_IN_OUT(clamp((t - s.start) / cfg.zoomInMs, 0, 1)));
      } else if (t >= s.end && t < s.end + cfg.zoomOutMs) {
        local = lerp(s.zEnd, 1, EASE_IN_OUT((t - s.end) / cfg.zoomOutMs));
      }
      z = Math.max(z, local);
    }
    return z;
  }

  // --- Offline camera: dead-zone follow while zoomed ---
  // On zoom-in, centre on the click. While zoomed, the visible crop is a dead
  // zone: cursor moving inside it does NOT pan. Only when the cursor leaves
  // that rectangle does the camera push just enough to keep it on-screen.
  // (camPath is still Gaussian-smoothed so edge-follow isn't jittery.)
  function smoothTrackPan(track, windowMs) {
    if (track.length < 3 || windowMs < 16) return track;
    const sigma = windowMs * 0.38;
    const denom = 2 * sigma * sigma;
    const step = (track[1].t - track[0].t) || 16;
    const radius = Math.ceil(windowMs / step);
    const out = new Array(track.length);
    for (let i = 0; i < track.length; i++) {
      let wx = 0, wy = 0, w = 0;
      const lo = Math.max(0, i - radius);
      const hi = Math.min(track.length - 1, i + radius);
      for (let j = lo; j <= hi; j++) {
        const dt = track[j].t - track[i].t;
        const k = Math.exp(-(dt * dt) / denom);
        wx += track[j].cx * k;
        wy += track[j].cy * k;
        w += k;
      }
      const half = 0.5 / track[i].zoom;
      out[i] = {
        t: track[i].t,
        zoom: track[i].zoom,
        cx: clamp(wx / w, half, 1 - half),
        cy: clamp(wy / w, half, 1 - half),
      };
    }
    return out;
  }

  function simulateCamera(camPath, segs, totalMs, cfg) {
    const stepMs = 16;
    const track = [];
    let cx = 0.5, cy = 0.5;
    let zoomed = false;

    for (let t = 0; t <= totalMs + stepMs; t += stepMs) {
      const zoom = zoomAtT(t, segs, cfg);
      const half = 0.5 / zoom;
      const cur = camPath.sample(t);

      if (zoom <= 1.001) {
        cx = 0.5;
        cy = 0.5;
        zoomed = false;
      } else {
        if (!zoomed) {
          cx = cur.x;
          cy = cur.y;
          zoomed = true;
        } else {
          // Soft dead zone: a little parallax inside the crop, stronger near
          // the edges, hard catch-up only once the cursor leaves the frame.
          const followAxis = (c, p) => {
            const d = p - c;
            const n = Math.abs(d) / (half || 1); // 0 centre → 1 edge → >1 outside
            if (n > 1) {
              // Cursor left the visible crop — push just enough to keep it in.
              return d > 0 ? p - half : p + half;
            }
            // Inside: subtle drift (more as you near the edge).
            const soft = 0.05 + 0.2 * (n * n);
            return lerp(c, p, soft);
          };
          cx = followAxis(cx, cur.x);
          cy = followAxis(cy, cur.y);
        }
        cx = clamp(cx, half, 1 - half);
        cy = clamp(cy, half, 1 - half);
      }

      track.push({ t, zoom, cx, cy });
    }
    return smoothTrackPan(track, 180);
  }

  // --- Manual zoom: user-authored regions instead of click/typing triggers ---
  // Each zoom = {start, end, cx, cy, zoom} (ms, normalized center, multiplier).
  // Same ease-in/hold/ease-out shape as the auto camera, just aimed at a
  // fixed point the user picked instead of following the cursor.
  function simulateManualTrack(zooms, totalMs, cfg) {
    const stepMs = 16;
    const track = [];
    const sorted = [...zooms].sort((a, b) => a.start - b.start);

    for (let t = 0; t <= totalMs + stepMs; t += stepMs) {
      let cx = 0.5, cy = 0.5, zoom = 1;
      for (const seg of sorted) {
        if (t < seg.start || t >= seg.end) continue;
        const zoomInMs = Math.min(cfg.zoomInMs, seg.end - seg.start);
        const zoomOutMs = Math.min(cfg.zoomOutMs, seg.end - seg.start);
        const outStart = Math.max(seg.start, seg.end - zoomOutMs);
        if (t >= outStart) {
          const p = EASE_IN_OUT(clamp((t - outStart) / (zoomOutMs || 1), 0, 1));
          zoom = lerp(seg.zoom, 1, p);
          cx = lerp(seg.cx, 0.5, p);
          cy = lerp(seg.cy, 0.5, p);
        } else {
          const p = EASE_IN_OUT(clamp((t - seg.start) / (zoomInMs || 1), 0, 1));
          zoom = lerp(1, seg.zoom, p);
          cx = lerp(0.5, seg.cx, p);
          cy = lerp(0.5, seg.cy, p);
        }
      }
      track.push({ t, zoom, cx, cy });
    }
    return track;
  }

  function sampleTrack(track, t) {
    if (t <= track[0].t) return track[0];
    if (t >= track[track.length - 1].t) return track[track.length - 1];
    let lo = 0, hi = track.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (track[m].t <= t) lo = m;
      else hi = m - 1;
    }
    const a = track[lo], b = track[lo + 1];
    const u = (t - a.t) / ((b.t - a.t) || 1);
    return {
      zoom: lerp(a.zoom, b.zoom, u),
      cx: lerp(a.cx, b.cx, u),
      cy: lerp(a.cy, b.cy, u),
    };
  }

  function settingsFromUI(ui) {
    const s = ui.smooth ?? 0.06;
    return {
      zoomLevel: ui.zoom ?? DEFAULTS.zoomLevel,
      zoomInMs: Math.round(800 + s * 2500),
      zoomOutMs: Math.round(1000 + s * 3000),
      mergeMs: DEFAULTS.mergeMs,
      holdMs: Math.round(1600 + s * 2000),
      // THE smoothness control now. Width of the symmetric Gaussian the camera
      // follows: wider = calmer, ignoring more of the small stuff; narrower =
      // tracks the cursor more literally. Because the filter is symmetric this
      // costs no delay at any width, so "smoother" never means "later".
      cameraWindowMs: 1200,
      pathWindowMs: Math.round(110 + s * 180),
    };
  }

  function prepare(rawEvents, totalMs, uiSettings) {
    const cfg = settingsFromUI(uiSettings);
    const events = rawEvents
      .filter((e) => Number.isFinite(e.t))
      .sort((a, b) => a.t - b.t);

    const moves = events.filter((e) => e.k === "m" && Number.isFinite(e.x) && Number.isFinite(e.y));
    const path = buildPath(moves, cfg.pathWindowMs);

    // Keyboard events carry no coords — anchor them to the cursor path
    // BEFORE filtering, or typing never triggers a zoom.
    attachCursorToKeys(events, path);
    // "h" = hold pulse (user inside an extension popup) — extends the session.
    const triggers = events.filter(
      (e) => (e.k === "c" || e.k === "k" || e.k === "h") && Number.isFinite(e.x) && Number.isFinite(e.y)
    );
    const scrolls = events.filter((e) => e.k === "s");

    const total = totalMs || 60000;
    const segments = buildSegments(triggers, scrolls, total, cfg);
    // A second, much wider smoothing of the same cursor data, for the camera
    // only. `path` stays tight so click ripples land where you actually
    // clicked; the camera wants calm, not precision.
    // Fold click/key points into the cam path as ordinary samples so the
    // Gaussian curves through them smoothly (no sudden pin-pull).
    const camMoves = moves.slice();
    for (const e of triggers) {
      if ((e.k !== "c" && e.k !== "k") || !Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
      camMoves.push({ t: e.t, x: e.x, y: e.y, k: "m" });
    }
    camMoves.sort((a, b) => a.t - b.t);
    const camPath = buildPath(camMoves, cfg.cameraWindowMs);
    const track = simulateCamera(camPath, segments, total, cfg);
    const manualTrack = simulateManualTrack(uiSettings.manualZooms || [], total, cfg);

    return { path, track, triggers, segments, cfg, manualTrack };
  }

  function evaluate(t, prepared, uiSettings) {
    const cursor = prepared.path.sample(t);
    const vel = prepared.path.velocity(t);
    if (uiSettings.zoomMode === "manual") {
      const f = sampleTrack(prepared.manualTrack, t);
      return { zoom: f.zoom, cx: f.cx, cy: f.cy, cursor, vel };
    }
    const f = sampleTrack(prepared.track, t);
    return { zoom: f.zoom, cx: f.cx, cy: f.cy, cursor, vel };
  }

  return { prepare, evaluate, settingsFromUI, DEFAULTS, EASE_IN_OUT, EASE_OUT };
})();
