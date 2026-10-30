// What the desktop app adds to the board's page (window.huntawayDesktop, see src/notifier.ts).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("huntawayDesktop", {
  /** The number on the dock or taskbar icon: the tasks that need attention. */
  setBadgeCount: (n) => ipcRenderer.send("huntaway:badge", n),
  /** Brings the window to the front, as clicking a notification does. */
  focus: () => ipcRenderer.send("huntaway:focus"),
});
