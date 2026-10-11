"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const ZR_CAMERA = require("../src/camera.js");

describe("ZR_CAMERA.settingsFromUI", () => {
  it("maps smoothness into zoom timing windows", () => {
    const low = ZR_CAMERA.settingsFromUI({ smooth: 0, zoom: 2 });
    const high = ZR_CAMERA.settingsFromUI({ smooth: 1, zoom: 2 });

    assert.equal(low.zoomLevel, 2);
    assert.ok(low.zoomInMs < high.zoomInMs);
    assert.ok(low.zoomOutMs < high.zoomOutMs);
    assert.ok(low.holdMs < high.holdMs);
    assert.ok(low.pathWindowMs < high.pathWindowMs);
  });

  it("falls back to defaults when UI fields are omitted", () => {
    const cfg = ZR_CAMERA.settingsFromUI({});
    assert.equal(cfg.zoomLevel, ZR_CAMERA.DEFAULTS.zoomLevel);
    assert.equal(cfg.mergeMs, ZR_CAMERA.DEFAULTS.mergeMs);
  });
});

describe("ZR_CAMERA.prepare / evaluate", () => {
  it("stays unzoomed when there are no click or key events", () => {
    const events = [
      { t: 0, x: 0.2, y: 0.3, k: "m" },
      { t: 100, x: 0.4, y: 0.4, k: "m" },
      { t: 200, x: 0.6, y: 0.5, k: "m" },
    ];
    const prepared = ZR_CAMERA.prepare(events, 1000, { zoom: 1.8, smooth: 0.06 });
    const frame = ZR_CAMERA.evaluate(500, prepared, { zoomMode: "auto" });

    assert.ok(Math.abs(frame.zoom - 1) < 0.02);
    assert.ok(Number.isFinite(frame.cursor.x));
    assert.ok(Number.isFinite(frame.cursor.y));
  });

  it("zooms in after a click trigger", () => {
    const events = [
      { t: 0, x: 0.5, y: 0.5, k: "m" },
      { t: 200, x: 0.55, y: 0.52, k: "c" },
      { t: 400, x: 0.56, y: 0.53, k: "m" },
      { t: 800, x: 0.57, y: 0.54, k: "m" },
    ];
    const prepared = ZR_CAMERA.prepare(events, 3000, { zoom: 1.8, smooth: 0.06 });
    const frame = ZR_CAMERA.evaluate(900, prepared, { zoomMode: "auto" });

    assert.ok(frame.zoom > 1.2, `expected zoom > 1.2, got ${frame.zoom}`);
    assert.ok(frame.cx > 0.3 && frame.cx < 0.7);
    assert.ok(frame.cy > 0.3 && frame.cy < 0.7);
  });

  it("anchors keypress events that lack coordinates to the cursor path", () => {
    const events = [
      { t: 0, x: 0.25, y: 0.75, k: "m" },
      { t: 50, x: 0.25, y: 0.75, k: "m" },
      { t: 100, x: NaN, y: NaN, k: "k" },
    ];
    const prepared = ZR_CAMERA.prepare(events, 2000, { zoom: 1.7, smooth: 0.06 });

    assert.equal(prepared.triggers.length, 1);
    assert.ok(Number.isFinite(prepared.triggers[0].x));
    assert.ok(Number.isFinite(prepared.triggers[0].y));
  });

  it("honors manual zoom mode over auto track", () => {
    const events = [{ t: 0, x: 0.5, y: 0.5, k: "m" }];
    const ui = {
      zoom: 1.7,
      smooth: 0.06,
      zoomMode: "manual",
      manualZooms: [{ start: 0, end: 2000, cx: 0.2, cy: 0.8, zoom: 2.2 }],
    };
    const prepared = ZR_CAMERA.prepare(events, 2000, ui);
    const mid = ZR_CAMERA.evaluate(800, prepared, ui);

    assert.ok(mid.zoom > 1.5);
    assert.ok(mid.cx < 0.4);
    assert.ok(mid.cy > 0.6);
  });
});
