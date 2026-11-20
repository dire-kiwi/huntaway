import { contextBridge, ipcRenderer } from "electron"
import type { IpcRendererEvent } from "electron"

// What the desktop app adds to the board's page: `window.huntawayDesktop` (the web app reads it in its platform/ desktop
// bridge). It runs in every frame (nodeIntegrationInSubFrames), before the frame's own scripts: in the board's (the main
// frame), it adds that; in the others, where the plans and artifacts agents write are drawn, it takes WebRTC away
// (RTCPeerConnection, which Chromium doesn't hold to their Content-Security-Policy), so that a page can't send data to a
// STUN or TURN server of its choosing (HA-269). Taken away in each frame, including the srcdoc frames a page makes
// itself, it can't be got back from another. The main process checks the sender's origin for the members that act on
// the board (openWindow, updateShell, paneDebugger, setBrowserProxy). The six members are the old shell's, unchanged;
// `onServerProgress` is new (HE-44), `paneDebugger` (HE-62), and `setBrowserProxy` (HE-67).

/** What `updateShell` reports as it goes. */
interface Progress {
  readonly phase: "checking" | "downloading" | "installing" | "restarting"
  readonly version?: string
  readonly bytes?: number
  readonly total?: number
}

const isResult = (value: unknown): value is { readonly version?: string; readonly error?: string } => typeof value === "object" && value !== null

/**
 * HE-62: the browser pane's <webview> (by its `getWebContentsId()`), given to the server to drive for the task's agent:
 * `attach` takes its debugger, `send` sends a DevTools protocol command and answers `{result}` or `{error}`, `onEvent`
 * gets its events (`onDetached` when the debugger is let go), `detach` lets it go. Only when the board's server runs on
 * this machine (`huntaway:pane-local`): a remote server's board streams its tasks' browser instead.
 */
const paneDebugger = {
  attach: (id: unknown): Promise<unknown> => ipcRenderer.invoke("huntaway:browser-debug", id),
  send: (id: unknown, method: unknown, params: unknown): Promise<unknown> => ipcRenderer.invoke("huntaway:browser-send", id, method, params),
  detach: (id: unknown) => ipcRenderer.send("huntaway:browser-undebug", id),
  onEvent: (listener: (id: unknown, method: unknown, params: unknown) => void) => {
    const relay = (_event: IpcRendererEvent, id: unknown, method: unknown, params: unknown) => {
      if (typeof listener === "function") listener(id, method, params)
    }
    ipcRenderer.on("huntaway:browser-event", relay)
    return () => {
      ipcRenderer.removeListener("huntaway:browser-event", relay)
    }
  },
  onDetached: (listener: (id: unknown) => void) => {
    const relay = (_event: IpcRendererEvent, id: unknown) => {
      if (typeof listener === "function") listener(id)
    }
    ipcRenderer.on("huntaway:browser-detached", relay)
    return () => {
      ipcRenderer.removeListener("huntaway:browser-detached", relay)
    }
  },
}

if (process.isMainFrame) {
  const paneLocal = ipcRenderer.sendSync("huntaway:pane-local") === true
  contextBridge.exposeInMainWorld("huntawayDesktop", {
    /** The number on the dock or taskbar icon: the tasks that need attention. */
    setBadgeCount: (n: number) => ipcRenderer.send("huntaway:badge", n),
    /** The board may show web pages in a <webview> (the main process's will-attach-webview), for its browser pane (HA-275). */
    browserPane: true,
    /** HE-62: the browser pane given to the server to drive (above), only when the board's server is on this machine. */
    ...(paneLocal ? { paneDebugger } : {}),
    /**
     * HE-67: the SOCKS proxy (`socks5://host:port`, or null for none) the browser pane's pages go through: the board's
     * host's, when that host is this machine. Resolves whether it was taken.
     */
    ...(paneLocal ? { setBrowserProxy: (proxy: unknown): Promise<unknown> => ipcRenderer.invoke("huntaway:browser-proxy", proxy) } : {}),
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
    /**
     * How far the server this app started has got as it starts again (a Restart or an Update runs it in place): the
     * restart dialog's wait. `onProgress` gets {step, detail, share} as it changes; the function returned stops that.
     */
    onServerProgress: (onProgress: (progress: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, progress: unknown) => {
        if (typeof onProgress === "function") onProgress(progress)
      }
      ipcRenderer.on("huntaway:server-progress", listener)
      return () => {
        ipcRenderer.removeListener("huntaway:server-progress", listener)
      }
    },
  })
} else {
  contextBridge.executeInMainWorld({
    func: () => {
      for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) Reflect.deleteProperty(window, name)
    },
  })
}
