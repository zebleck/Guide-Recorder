const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("recordingControlsApi", {
  getState: () => ipcRenderer.invoke("recorder:getState"),
  togglePause: () => ipcRenderer.invoke("recorder:togglePause"),
  stopRecording: () => ipcRenderer.invoke("recorder:stopRecording"),
  cancelRecording: () => ipcRenderer.invoke("recorder:cancelRecording"),
  onState: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("recorder:state", handler);
    return () => {
      ipcRenderer.removeListener("recorder:state", handler);
    };
  },
});
