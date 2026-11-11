import { Console, Effect, FiberSet, FileSystem, Option, Path, Predicate, Ref, Schema, Stream } from "effect"
import type { Digest } from "effect/crypto"
import type { HttpClient } from "effect/http"
import type { ChildProcessSpawner } from "effect/process"
import { app, BrowserWindow, ipcMain, Menu, session, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions, WebContents } from "electron"
import { assetPlatform, RELEASE_REPO, shellChange, updateKind } from "../shared/versions.ts"
import type { UpdateKind } from "../shared/versions.ts"
import { Desktop, releaseUpdatesOff } from "./Desktop.ts"
import { errorPage } from "./errorPage.ts"
import { installKindOf } from "./install.ts"
import { Servers, ServerUnavailable } from "./Servers.ts"
import { updateShell } from "./shellUpdate.ts"
import type { Progress } from "./shellUpdate.ts"
import { shellStamp } from "./stamp.ts"
import { badgeCount, boardUrlPath, BROWSER_PERMISSIONS, isBrowsable, isWebUrl, originOf, RETRY_URL, SKIP_BACKUP_URL, windowsToReopen } from "./urls.ts"

// The board's windows (docs/plan/inventory/10-web-client.md §9.1, Windows; HA-298), their navigation rules, the browser
// pane, the menu, the IPC the preload calls, relaunching and the app's own package update. Each window loads the board
// from the server `Servers` finds (`<base><path>?token=<token>`); one that can't shows the error page and keeps where it
// was, for when it loads the board again.

/** The browser pane's pages' session: their cookies and storage are kept apart from the board's (and from the app's preload). */
const BROWSER_PARTITION = "persist:huntaway-browser"

const Json = Schema.fromJsonString(Schema.Unknown)

/** What the windows' effects run on. */
type Needs = Desktop | Servers | FileSystem.FileSystem | Path.Path | Digest.Digest | HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner

const versionOf = (v: unknown) => (Predicate.hasProperty(v, "version") && typeof v.version === "string" ? v.version : null)

/** The frame's view, from `globalThis.huntawayBoot` (src/boot): the running release shell and the one it would load now. */
const bootView = (): { readonly running: string | null; readonly chosen: string | null } | null => {
  const boot: unknown = Reflect.get(globalThis, "huntawayBoot")
  if (!Predicate.hasProperty(boot, "choose") || !Predicate.isFunction(boot.choose)) return null
  const chosen: unknown = Reflect.apply(boot.choose, boot, [])
  return { running: versionOf(Predicate.hasProperty(boot, "running") ? boot.running : null), chosen: versionOf(chosen) }
}

const onErrorPage = (win: BrowserWindow) => win.webContents.getURL().startsWith("data:")

const loadUrl = (win: BrowserWindow, url: string) =>
  Effect.tryPromise({ try: () => win.loadURL(url), catch: String }).pipe(
    Effect.tapError((error) => Console.error(`couldn't load ${url.slice(0, 80)}: ${error}`)),
  )

const senderOrigin = (event: IpcMainEvent | IpcMainInvokeEvent) => originOf(event.senderFrame?.url ?? "")

/** Opens the board's windows and runs them until the app quits. */
export const runWindows = Effect.gen(function* () {
  const desktop = yield* Desktop
  const servers = yield* Servers
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const run = yield* FiberSet.makeRuntime<Needs>()
  const runPromise = yield* FiberSet.makeRuntimePromise<Needs>()

  /** Every board window, and the page each is to load (path and query: where it was, for one on the error page now). */
  const boards = new Set<BrowserWindow>()
  const wanted = new WeakMap<BrowserWindow, string>()
  /** The board's origin once it has loaded: the one navigation the windows take. */
  const boardOrigin = yield* Ref.make<string | null>(null)
  /** A relaunch is under way: each window's board reloads after an update, and only one relaunch is to start. */
  const relaunching = yield* Ref.make(false)
  /** The package update under way, so that a second click doesn't start another. */
  const updatingShell = yield* Ref.make(false)
  const windowsFile = path.join(app.getPath("userData"), "relaunch-windows.json")
  const startStamp = yield* shellStamp(desktop.shellDir, desktop.electronVersion).pipe(Effect.orElseSucceed(() => ""))
  const install = desktop.resourcesDir === null ? null : yield* installKindOf(desktop)
  /** What the app can install of its own package: none for a mac app, a checkout, or a remote server (whose release status is that machine's). */
  const shellUpdateKind: UpdateKind | null = releaseUpdatesOff(desktop) ? null : updateKind(install)

  const openBoards = () => [...boards].filter((win) => !win.isDestroyed())
  const origin = () => Ref.getUnsafe(boardOrigin)
  const wantedPath = (win: BrowserWindow) => boardUrlPath(win.webContents.getURL(), origin()) ?? wanted.get(win) ?? "/"

  /** Shows the error page for `error` in `win`, keeping where it was on the board for when it loads the board again. */
  const showError = (win: BrowserWindow, error: ServerUnavailable) =>
    Effect.gen(function* () {
      if (win.isDestroyed()) return
      wanted.set(win, wantedPath(win))
      const page = errorPage({ message: error.message, title: error.title, backup: error.backup, log: yield* servers.log, configPath: desktop.configPath })
      yield* loadUrl(win, page).pipe(Effect.ignore)
    })

  /** Loads the board in `win`, from the server there is (found or started), or the error page. */
  const load = (win: BrowserWindow) =>
    Effect.gen(function* () {
      const found = yield* Effect.result(servers.resolve)
      if (found._tag === "Failure") {
        yield* showError(win, found.failure)
        return
      }
      const ui = desktop.devUrl ?? found.success.base
      const uiOrigin = originOf(ui)
      yield* Ref.set(boardOrigin, uiOrigin)
      if (win.isDestroyed() || uiOrigin === null) return
      const at = wanted.get(win) ?? "/"
      const url = URL.canParse(at, ui) ? new URL(at, ui) : null
      if (url?.origin !== uiOrigin) {
        yield* showError(win, new ServerUnavailable({ message: `Not a page of the board: ${at}`, title: null, backup: null }))
        return
      }
      if (found.success.token !== "") url.searchParams.set("token", found.success.token)
      yield* loadUrl(win, url.href).pipe(Effect.ignore)
    })

  /** Loads the board again in every window on the error page: the server is there now, or Retry was clicked. */
  const reloadErrored = Effect.suspend(() => Effect.forEach(openBoards().filter(onErrorPage), load, { concurrency: "unbounded", discard: true }))

  const saveWindows = Effect.gen(function* () {
    const text = yield* Schema.encodeEffect(Json)(openBoards().map(wantedPath)).pipe(Effect.orDie)
    yield* fs
      .writeFileString(windowsFile, text)
      .pipe(Effect.catch((error) => Console.error(`couldn't save the windows to open after the relaunch: ${error.message}`)))
  })

  /** Start the app again, as the package does it: through install.sh's launcher, the AppImage's file (its mount goes away on quitting), or itself. */
  const relaunch = Effect.gen(function* () {
    if (yield* Ref.getAndSet(relaunching, true)) return
    yield* saveWindows
    if (desktop.launcher !== null) app.relaunch({ execPath: desktop.launcher, args: process.argv.slice(2) })
    else if (desktop.appimage !== null) app.relaunch({ execPath: desktop.appimage, args: process.argv.slice(1) })
    else app.relaunch()
    app.quit()
  })

  /** After a window's page loaded (a rebuild or an Update reloads the board): relaunch if the shell changed. */
  const checkShell = Effect.gen(function* () {
    const boot = bootView()
    const stampNow = boot?.running == null ? Option.getOrNull(yield* Effect.option(shellStamp(desktop.shellDir, desktop.electronVersion))) : null
    const why = shellChange({ boot, stampNow, startStamp })
    if (why === null || (yield* Ref.get(relaunching))) return
    yield* Console.log(`${why}; relaunching`)
    yield* relaunch
  })

  /**
   * The board's browser pane (HA-275) is a <webview>. Only the board itself gets one, for a web page, sandboxed with no
   * preload and no Node, in its own session, and its pages stay web pages.
   */
  const attachBrowser = (win: BrowserWindow) => {
    const pages = session.fromPartition(BROWSER_PARTITION)
    // Electron grants every permission by default: a page in the pane gets none of the camera, location, notifications…
    pages.setPermissionRequestHandler((_contents, permission, callback) => callback(BROWSER_PERMISSIONS.has(permission)))
    pages.setPermissionCheckHandler((_contents, permission) => BROWSER_PERMISSIONS.has(permission))
    win.webContents.on("will-attach-webview", (event, prefs, params) => {
      const board = origin()
      if (board === null || originOf(win.webContents.getURL()) !== board || !isBrowsable(params.src ?? "")) {
        event.preventDefault()
        return
      }
      delete prefs.preload
      Object.assign(prefs, {
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        partition: BROWSER_PARTITION,
      })
    })
    win.webContents.on("did-attach-webview", (_event, guest: WebContents) => {
      guest.setWindowOpenHandler(({ url }) => {
        if (isBrowsable(url)) guest.loadURL(url).catch(() => undefined)
        else if (isWebUrl(url)) shell.openExternal(url).catch(() => undefined)
        return { action: "deny" }
      })
      guest.on("will-navigate", (event, url) => {
        if (isBrowsable(url)) return
        event.preventDefault()
        if (isWebUrl(url)) shell.openExternal(url).catch(() => undefined)
      })
    })
  }

  /** Opens a window on page `at` of the board (a path, "/" for the home page). */
  const createWindow = (at = "/"): Effect.Effect<void, never, Needs> =>
    Effect.gen(function* () {
      // A second window opens a little down and right of the one it was opened from, at its size.
      const from = BrowserWindow.getFocusedWindow()
      const place = from !== null && boards.has(from) && !from.isMaximized() && !from.isFullScreen() ? from.getBounds() : null
      const win = new BrowserWindow({
        width: place?.width ?? 1440,
        height: place?.height ?? 900,
        ...(place === null ? {} : { x: place.x + 30, y: place.y + 30 }),
        minWidth: 900,
        minHeight: 600,
        backgroundColor: "#0b0b0e",
        autoHideMenuBar: true,
        title: "Huntaway",
        // The preload runs in frames too, to take WebRTC away from the pages agents write (see the preload).
        // webviewTag: the board's browser pane, held to web pages with nothing of the app's (attachBrowser).
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegrationInSubFrames: true,
          webviewTag: true,
          preload: path.join(desktop.shellDir, "preload.cjs"),
        },
      })
      boards.add(win)
      yield* servers.setWindows(openBoards().length)
      win.on("closed", () => {
        boards.delete(win)
        run(servers.setWindows(openBoards().length))
      })
      wanted.set(win, at)
      // Should the preload miss a frame, WebRTC there sends no UDP (STUN, TURN over UDP) that isn't proxied (HA-269).
      win.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp")
      attachBrowser(win)
      win.webContents.on("did-finish-load", () => {
        run(checkShell)
      })
      // A page of the board opened in a new tab opens in a window of the app. Other links open in the browser, web links
      // only: a plan or artifact is a page an agent wrote, so file:, custom schemes and the like stay out of the OS handlers.
      win.webContents.setWindowOpenHandler(({ url }) => {
        const page = boardUrlPath(url, origin())
        if (page !== null) run(createWindow(page))
        else if (isWebUrl(url)) shell.openExternal(url).catch(() => undefined)
        return { action: "deny" }
      })
      // The error page's Retry; otherwise the window stays on the board: a file dropped outside a drop zone, or a link
      // dragged in, would replace it (a web link opens in the browser instead).
      win.webContents.on("will-navigate", (event, url) => {
        if (url === RETRY_URL || url === SKIP_BACKUP_URL) {
          event.preventDefault()
          run((url === SKIP_BACKUP_URL ? servers.skipBackupOnce : Effect.void).pipe(Effect.andThen(reloadErrored)))
          return
        }
        const board = origin()
        if (board !== null && originOf(url) !== board) {
          event.preventDefault()
          if (isWebUrl(url)) shell.openExternal(url).catch(() => undefined)
        }
      })
      yield* load(win)
    })

  /** The app's package update: install the latest release's package and relaunch. It takes nothing from the page. */
  const updateOwnPackage = (event: IpcMainInvokeEvent) =>
    Effect.gen(function* () {
      const target = yield* servers.target
      if (shellUpdateKind === null || Option.isNone(target)) return { error: "This app can't install its own package." }
      if (senderOrigin(event) !== origin()) return { error: "Only the board can update the app." }
      if (yield* Ref.getAndSet(updatingShell, true)) return { error: "The app is already being updated." }
      const sender = event.sender
      let sent = 0
      // Downloads report every chunk: a few a second is enough for the page.
      const progress = (p: Progress) =>
        Effect.gen(function* () {
          const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
          if (p.phase === "downloading" && p.bytes !== undefined && p.bytes !== 0 && p.bytes !== p.total && now - sent < 200) return
          sent = now
          if (!sender.isDestroyed()) sender.send("huntaway:update-shell-progress", p)
        })
      const result = yield* updateShell({
        kind: shellUpdateKind,
        appimage: desktop.appimage,
        base: target.value.base,
        token: target.value.token,
        current: desktop.appVersion,
        api: desktop.releaseApi,
        repo: desktop.releaseUpdates?.trim() || RELEASE_REPO,
        platform: assetPlatform(desktop.platform, desktop.arch),
        tmpdir: app.getPath("temp"),
        onProgress: progress,
      }).pipe(Effect.result)
      if (result._tag === "Failure") {
        yield* Console.error(`updating the desktop app failed: ${result.failure.message}`)
        yield* Ref.set(updatingShell, false)
        return { error: result.failure.message }
      }
      const version = result.success
      yield* Console.log(`installed the desktop app v${version}; relaunching`)
      yield* progress({ phase: "restarting", version })
      yield* Ref.set(relaunching, true)
      yield* saveWindows
      // The AppImage's new file is at the same path, and so is the package's app in /opt.
      if (shellUpdateKind === "appimage" && desktop.appimage !== null) app.relaunch({ execPath: desktop.appimage, args: process.argv.slice(1) })
      else app.relaunch()
      app.quit()
      return { version }
    })

  ipcMain.on("huntaway:badge", (_event, n: unknown) => {
    app.setBadgeCount(badgeCount(n))
  })
  ipcMain.on("huntaway:focus", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win === null) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  // The board's "Open in new window": a window on page `at` (a path of the board), from the board itself.
  ipcMain.on("huntaway:open-window", (event, at: unknown) => {
    const board = origin()
    if (typeof at !== "string" || !at.startsWith("/") || board === null || senderOrigin(event) !== board) return
    const page = URL.canParse(at, board) ? boardUrlPath(new URL(at, board).href, board) : null
    if (page !== null) run(createWindow(page))
  })
  ipcMain.on("huntaway:shell-update-kind", (event) => {
    event.returnValue = shellUpdateKind
  })
  ipcMain.handle("huntaway:update-shell", (event) => runPromise(updateOwnPackage(event)))
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const channel of ["huntaway:badge", "huntaway:focus", "huntaway:open-window", "huntaway:shell-update-kind"]) ipcMain.removeAllListeners(channel)
      ipcMain.removeHandler("huntaway:update-shell")
    }),
  )

  /** The app's menu: Electron's own (which shows on Alt in Linux and Windows), with New Window in its File menu. */
  const mac = desktop.platform === "darwin"
  const template: Array<MenuItemConstructorOptions> = [
    ...(mac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: () => run(createWindow()) },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  // Starting the app again opens another window in the one that's running, as its New Window does.
  app.on("second-instance", () => {
    run(createWindow())
  })
  app.on("window-all-closed", () => {
    if (!mac) app.quit()
  })
  app.on("activate", () => {
    if (openBoards().length === 0) run(createWindow())
  })
  app.on("before-quit", (event) => {
    // Agents run under ia-shim and outlive the server; the next start picks them back up. A server this app attached to
    // is left running.
    if (!servers.runningNow()) return
    event.preventDefault()
    run(servers.quit(Effect.sync(() => app.quit())))
  })

  // The windows hear about the server: one there now loads the board where the error page is; none shows why, everywhere.
  yield* Stream.fromPubSub(servers.news).pipe(
    Stream.runForEach((news) =>
      news._tag === "Up" ? reloadErrored : Effect.forEach(openBoards(), (win) => showError(win, news.error), { concurrency: "unbounded", discard: true }),
    ),
    Effect.forkScoped,
  )

  // After a relaunch, the windows it had, on the pages they were on (once: deleted on reading); the first loads before
  // the others are made, so that only it starts the server.
  const saved = yield* fs.readFileString(windowsFile).pipe(Effect.option)
  if (Option.isSome(saved)) yield* fs.remove(windowsFile, { force: true }).pipe(Effect.ignore)
  const reopen = windowsToReopen(Option.isSome(saved) ? Option.getOrUndefined(yield* Schema.decodeEffect(Json)(saved.value).pipe(Effect.option)) : undefined)
  const [first = "/", ...more] = reopen
  yield* createWindow(first)
  yield* Effect.forEach(more, (at) => createWindow(at), { concurrency: 1, discard: true })
  return yield* Effect.never
})
