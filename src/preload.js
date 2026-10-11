// Preload — the only place with Node/Electron API access. Exposes a small,
// explicit surface to the renderer via contextBridge (renderers themselves
// run with nodeIntegration:false, contextIsolation:true — standard, secure
// defaults for a local desktop app).
const { contextBridge, ipcRenderer } = require("electron");

/**
 * @typedef {{ id: string, name: string, thumbnail: string, display_id: string|null }} CaptureSource
 * @typedef {{ t: number, x: number, y: number, k: string }} InputEvent
 */

contextBridge.exposeInMainWorld("zr", {
  /** @returns {Promise<CaptureSource[]>} */
  getSources: () => ipcRenderer.invoke("zr:get-sources"),
  /** @param {string} sourceId @param {boolean} wantSystemAudio */
  setCaptureSource: (sourceId, wantSystemAudio) =>
    ipcRenderer.invoke("zr:set-capture-source", { sourceId, wantSystemAudio }),

  /** @param {string|null} displayId */
  startTracking: (displayId) => ipcRenderer.send("zr:start-tracking", { displayId }),
  stopTracking: () => ipcRenderer.send("zr:stop-tracking"),
  /**
   * @param {(ev: InputEvent) => void} cb
   * @returns {() => void} unsubscribe
   */
  onInputEvent: (cb) => {
    const handler = (_event, ev) => cb(ev);
    ipcRenderer.on("zr:input-event", handler);
    return () => ipcRenderer.removeListener("zr:input-event", handler);
  },

  silenceForRecording: () => ipcRenderer.invoke("zr:silence-for-recording"),
  unsilence: () => ipcRenderer.invoke("zr:unsilence"),
  /** @param {string|number} id @param {boolean} hasCam @param {boolean} hasMic */
  recordingStart: (id, hasCam, hasMic) =>
    ipcRenderer.invoke("zr:recording-start", { id, hasCam, hasMic }),
  /** @param {string|number} id @param {"screen"|"cam"|"mic"} kind @param {ArrayBuffer} chunk */
  recordingChunk: (id, kind, chunk) => ipcRenderer.send("zr:recording-chunk", { id, kind, chunk }),
  /** @param {string|number} id @param {object} meta */
  recordingFinish: (id, meta) => ipcRenderer.invoke("zr:recording-finish", { id, meta }),

  listSessions: () => ipcRenderer.invoke("zr:list-sessions"),
  /** @param {string|number} id */
  loadSession: (id) => ipcRenderer.invoke("zr:load-session", id),
  /** @param {string|number} id */
  openEditor: (id) => ipcRenderer.send("zr:open-editor", id),

  /** @param {string} defaultName @param {ArrayBuffer|Uint8Array} buffer */
  saveExport: (defaultName, buffer) =>
    ipcRenderer.invoke("zr:save-export", { defaultName, buffer }),

  /** @param {() => void} cb */
  onGlobalPause: (cb) => ipcRenderer.on("zr:global-pause", () => cb()),

  /** @param {string|number} id */
  deleteSession: (id) => ipcRenderer.invoke("zr:delete-session", id),
  recordAgain: () => ipcRenderer.send("zr:record-again"),
});
