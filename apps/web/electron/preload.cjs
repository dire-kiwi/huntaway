// What the desktop app adds to the board's page (window.huntawayDesktop, see src/notifier.ts).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("huntawayDesktop", {
  /** The number on the dock or taskbar icon: the tasks that need attention. */
  setBadgeCount: (n) => ipcRenderer.send("huntaway:badge", n),
  /** Brings the window to the front, as clicking a notification does. */
  focus: () => ipcRenderer.send("huntaway:focus"),
  /** How the app can install its own package: "appimage", "pacman", or null where it can't (HA-68). */
  shellUpdateKind: () => ipcRenderer.sendSync("huntaway:shell-update-kind"),
  /**
   * Installs the latest release's app package, then relaunches the app. `onProgress` gets {phase, version, bytes, total}
   * ("checking", "downloading", "installing", "restarting"). Rejects with why it didn't.
   */
  updateShell: async (onProgress) => {
    const listener = (_e, p) => typeof onProgress === "function" && onProgress(p);
    ipcRenderer.on("huntaway:update-shell-progress", listener);
    try {
      const r = await ipcRenderer.invoke("huntaway:update-shell");
      if (r?.error) throw new Error(r.error);
      return r;
    } finally {
      ipcRenderer.removeListener("huntaway:update-shell-progress", listener);
    }
  },
});
