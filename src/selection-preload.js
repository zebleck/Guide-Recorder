const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("selectionApi", {
  getContext: () => ipcRenderer.invoke("selector:getContext"),
  confirm: (rect) => ipcRenderer.send("selector:confirm", rect),
  cancel: () => ipcRenderer.send("selector:cancel"),
});
