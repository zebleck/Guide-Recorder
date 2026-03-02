const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("recorderApi", {
  listSources: () => ipcRenderer.invoke("recorder:listSources"),
  pickArea: () => ipcRenderer.invoke("recorder:pickArea"),
  fitWindow: (payload) => ipcRenderer.invoke("recorder:fitWindow", payload),
  startRecording: (payload) => ipcRenderer.invoke("recorder:startRecording", payload),
  stopRecording: () => ipcRenderer.invoke("recorder:stopRecording"),
});
