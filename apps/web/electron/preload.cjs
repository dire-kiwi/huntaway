// What the desktop app adds to the board's page (window.huntawayDesktop, see src/notifier.ts). It runs in every frame
// (nodeIntegrationInSubFrames), before the frame's own scripts: in the board's, it adds that; in the others, where the
// plans and artifacts agents write are drawn, it takes WebRTC away (RTCPeerConnection, which Chromium doesn't hold to
// their Content-Security-Policy), so that a page can't send data to a STUN or TURN server of its choosing (HA-269).
// Taken away in each frame, including the srcdoc frames a page makes itself, it can't be got back from another. A
// javascript: URL frame's document gets no preload, but the frame's policy (FRAME_CSP's Trusted Types) refuses those.
const { contextBridge, ipcRenderer } = require("electron");

if (!process.isMainFrame) {
  contextBridge.executeInMainWorld({
    func: () => {
      for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) delete window[name];
    },
  });
} else
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
