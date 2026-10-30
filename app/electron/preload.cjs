// Exposes the desktop app's updater to the board as `window.huntawayDesktop` (see src/desktop.ts).
// Sandboxed preloads can only require electron's renderer modules.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("huntawayDesktop", {
  update: {
    get: () => ipcRenderer.invoke("update:get"),
    check: () => ipcRenderer.invoke("update:check"),
    install: () => ipcRenderer.invoke("update:install"),
    /** Calls `cb` with the update state now and on every change, and stops the native update dialog. */
    subscribe: (cb) => {
      const listener = (_e, state) => cb(state);
      ipcRenderer.on("update:state", listener);
      ipcRenderer.send("update:subscribe");
      return () => ipcRenderer.removeListener("update:state", listener);
    },
  },
});
