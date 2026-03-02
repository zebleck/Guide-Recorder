const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("recorderApi", {
  listSources: () => ipcRenderer.invoke("recorder:listSources"),
  pickArea: () => ipcRenderer.invoke("recorder:pickArea"),
  fitWindow: (payload) => ipcRenderer.invoke("recorder:fitWindow", payload),
  startRecording: (payload) => ipcRenderer.invoke("recorder:startRecording", payload),
  stopRecording: () => ipcRenderer.invoke("recorder:stopRecording"),
  quitApp: () => ipcRenderer.invoke("recorder:quit"),
  setAreaPreview: (payload) => ipcRenderer.invoke("recorder:setAreaPreview", payload),
  onRecordingStopped: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("recorder:recordingStopped", handler);
    return () => {
      ipcRenderer.removeListener("recorder:recordingStopped", handler);
    };
  },
});
