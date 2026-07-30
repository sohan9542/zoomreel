// Preload — the only place with Node/Electron API access. Exposes a small,
// explicit surface to the renderer via contextBridge (renderers themselves
// run with nodeIntegration:false, contextIsolation:true — standard, secure
// defaults for a local desktop app).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("zr", {
  getSources: () => ipcRenderer.invoke("zr:get-sources"),
  setCaptureSource: (sourceId, wantSystemAudio) => ipcRenderer.invoke("zr:set-capture-source", { sourceId, wantSystemAudio }),

  startTracking: (displayId) => ipcRenderer.send("zr:start-tracking", { displayId }),
  stopTracking: () => ipcRenderer.send("zr:stop-tracking"),
  onInputEvent: (cb) => {
    const handler = (event, ev) => cb(ev);
    ipcRenderer.on("zr:input-event", handler);
    return () => ipcRenderer.removeListener("zr:input-event", handler);
  },

  silenceForRecording: () => ipcRenderer.invoke("zr:silence-for-recording"),
  unsilence: () => ipcRenderer.invoke("zr:unsilence"),
  recordingStart: (id, hasCam, hasMic) => ipcRenderer.invoke("zr:recording-start", { id, hasCam, hasMic }),
  recordingChunk: (id, kind, chunk) => ipcRenderer.send("zr:recording-chunk", { id, kind, chunk }),
  recordingFinish: (id, meta) => ipcRenderer.invoke("zr:recording-finish", { id, meta }),

  listSessions: () => ipcRenderer.invoke("zr:list-sessions"),
  loadSession: (id) => ipcRenderer.invoke("zr:load-session", id),
  openEditor: (id) => ipcRenderer.send("zr:open-editor", id),

  saveExport: (defaultName, buffer) => ipcRenderer.invoke("zr:save-export", { defaultName, buffer }),

  onGlobalPause: (cb) => ipcRenderer.on("zr:global-pause", () => cb()),

  deleteSession: (id) => ipcRenderer.invoke("zr:delete-session", id),
  recordAgain: () => ipcRenderer.send("zr:record-again"),
});
