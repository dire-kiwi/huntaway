import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Console, Effect, Layer, Option } from "effect"
import { Digest } from "effect/crypto"
import { FetchHttpClient } from "effect/http"
import { app } from "electron"
import { configDir, Desktop } from "./Desktop.ts"
import type { DesktopInputs } from "./Desktop.ts"
import { Servers } from "./Servers.ts"
import { runWindows } from "./Windows.ts"

// The desktop shell's main process (docs/plan/09-frontend.md, The desktop shell): an Effect program, and an entry point,
// so it provides its layers and runs itself. The frame (src/boot) loads it: this package's dist/main.cjs, or a
// release's electron/main.cjs.
//
// Local mode (the default): use a server already listening on the port, or start one through the launcher (the bundled
// server, an installed release's, or the checkout's apps/server/bin/huntaway) and stop it on quit. The windows load the
// UI from the server itself. Remote mode: desktop.json's `serverUrl` (and `token`) is a server on another machine.

/** What Electron says about this app, read before anything else. */
const inputs: DesktopInputs = {
  appData: app.getPath("appData"),
  appPath: app.getAppPath(),
  shellDir: __dirname,
  appVersion: app.getVersion(),
  electronVersion: process.versions.electron ?? "",
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  platform: process.platform,
  arch: process.arch,
}

/**
 * Before Electron is ready: the window storage goes in the shell's own folder (beside desktop.json), and one app runs
 * per folder: starting it again opens another window in the one that's running (HA-298). One run on a dev UI
 * (`HUNTAWAY_DEV_URL`) runs on its own. Succeeds with whether this process goes on.
 */
const early = Effect.gen(function* () {
  app.setPath("userData", yield* configDir(inputs.appData))
  const devUrl = yield* Config.String("HUNTAWAY_DEV_URL").pipe(Config.option)
  if (Option.isNone(devUrl) && !app.requestSingleInstanceLock()) {
    // After the frame has added its before-quit handler (once this file has loaded), which takes away the marker it
    // wrote for this process: otherwise the next start would take this shell for one that crashed.
    yield* Effect.yieldNow
    app.quit()
    return false
  }
  return true
})

const shell = Effect.gen(function* () {
  const desktop = yield* Desktop
  // Pages on plain HTTP get no notifications (browsers keep them to HTTPS and localhost), so a remote server reached over
  // HTTP counts as secure here: it is the one this app was set up to use.
  const remote = desktop.file.serverUrl
  if (remote !== null && remote.startsWith("http:") && URL.canParse(remote)) {
    if (app.isReady()) yield* Console.error("desktop.json was read after Electron was ready: notifications from an http: serverUrl may not work")
    app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", new URL(remote).origin)
  }
  yield* Effect.promise(() => app.whenReady())
  return yield* runWindows
}).pipe(Effect.scoped)

const shellLayer = Servers.layer.pipe(
  Layer.provideMerge(Desktop.layerFrom(inputs)),
  Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, Digest.layerWebCrypto)),
  Layer.provideMerge(NodeServices.layer),
)

early.pipe(
  Effect.flatMap((goOn) =>
    goOn
      ? shell.pipe(
          Effect.provide(shellLayer),
          // Stopped from outside (SIGTERM, Ctrl-C): the server started here has been stopped with the layers; the app goes too.
          Effect.ensuring(Effect.sync(() => app.quit())),
        )
      : Effect.void,
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
