import { contextBridge, ipcRenderer } from "electron"
import type { IpcRendererEvent } from "electron"

// What the desktop app adds to the board's page: `window.huntawayDesktop` (the web app reads it in its platform/ desktop
// bridge). It runs in every frame (nodeIntegrationInSubFrames), before the frame's own scripts: in the board's (the main
// frame), it adds that; in the others, where the plans and artifacts agents write are drawn, it takes WebRTC away
// (RTCPeerConnection, which Chromium doesn't hold to their Content-Security-Policy), so that a page can't send data to a
// STUN or TURN server of its choosing (HA-269). Taken away in each frame, including the srcdoc frames a page makes
// itself, it can't be got back from another. The main process checks the sender's origin for the members that act on
// the board (openWindow, updateShell). The six members are the old shell's, unchanged.

/** What `updateShell` reports as it goes. */
interface Progress {
  readonly phase: "checking" | "downloading" | "installing" | "restarting"
  readonly version?: string
  readonly bytes?: number
  readonly total?: number
}

const isResult = (value: unknown): value is { readonly version?: string; readonly error?: string } => typeof value === "object" && value !== null

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("huntawayDesktop", {
    /** The number on the dock or taskbar icon: the tasks that need attention. */
    setBadgeCount: (n: number) => ipcRenderer.send("huntaway:badge", n),
    /** The board may show web pages in a <webview> (the main process's will-attach-webview), for its browser pane (HA-275). */
    browserPane: true,
    /** Opens page `path` of the board (`/profile/work`) in a new window of the app (HA-298). */
    openWindow: (path: unknown) => ipcRenderer.send("huntaway:open-window", String(path)),
    /** Brings the window to the front, as clicking a notification does. */
    focus: () => ipcRenderer.send("huntaway:focus"),
    /** How the app can install its own package: "appimage", "pacman", or null where it can't (HA-68). */
    shellUpdateKind: (): unknown => ipcRenderer.sendSync("huntaway:shell-update-kind"),
    /**
     * Installs the latest release's app package, then relaunches the app. `onProgress` gets {phase, version, bytes,
     * total} ("checking", "downloading", "installing", "restarting"). Rejects with why it didn't.
     */
    updateShell: (onProgress?: (progress: Progress) => void) => {
      const listener = (_event: IpcRendererEvent, progress: Progress) => {
        if (typeof onProgress === "function") onProgress(progress)
      }
      ipcRenderer.on("huntaway:update-shell-progress", listener)
      return ipcRenderer
        .invoke("huntaway:update-shell")
        .then((result: unknown) => {
          if (isResult(result) && typeof result.error === "string") throw new Error(result.error)
          return result
        })
        .finally(() => ipcRenderer.removeListener("huntaway:update-shell-progress", listener))
    },
  })
} else {
  contextBridge.executeInMainWorld({
    func: () => {
      for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) Reflect.deleteProperty(window, name)
    },
  })
}
