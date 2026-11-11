import { homedir } from "node:os"
import { join } from "node:path"
import { app } from "electron"
import { configDirFor, dataDirFor } from "../shared/paths.ts"
import { BOOT_API } from "../shared/versions.ts"
import type { BootApi } from "../shared/versions.ts"
import { findShell, readJson, readShellState, settleCrash, tryingOf, markShellBad, writeShellState } from "./shells.ts"

// The desktop app's entry point (package.json's `main`, built to dist/boot.cjs), and the only part of the shell that a
// release can't replace: the "frame". Plain TypeScript with no effect import, so that it stays small and changes
// rarely: its stamp (and Electron's version) is what the server compares to say the app needs a new package.
//
// A release build's server updates itself in place: each release is unpacked into `<data dir>/app/<v>/`, and the app
// starts that version's server rather than the one in its package. This does the same for the shell: it loads
// `main.cjs` and the files beside it from that version's `electron/` (the release workflow puts dist/main.cjs,
// dist/preload.cjs and a `shell.json` there), so a release that changes only the main process or the preload reaches an
// installed app without a new AppImage or pacman package. Otherwise, the shell beside this file.
//
// Which shell: the one in the version the server will run (findShell), when it has an `electron/` that suits this
// Electron and boot API and is not marked bad. Once an Update has restarted the server onto a version with another
// shell, the main process asks `globalThis.huntawayBoot.choose()` (this file's own logic, so that the answer is the one
// the next start acts on) and relaunches onto it.
//
// A shell that throws as it loads is marked bad at once, and the app relaunches without it. One that dies later leaves
// its marker in `app/shell-state.json` (`trying`, with the app's pid): the next start sees that no process runs under
// that pid, marks the shell bad and runs the package's. The marker is cleared after the shell has run for SURVIVED_MS,
// or when the app quits.

const SURVIVED_MS = 20_000

const env = (name: string): string | null => process.env[name] ?? null

const own = () => require(join(__dirname, "main.cjs"))

const boot = (): void => {
  const resources = env("HUNTAWAY_PACKAGED_RESOURCES") ?? (app.isPackaged ? process.resourcesPath : null)
  const config = readJson(join(configDirFor({ envDir: env("HUNTAWAY_DESKTOP_DIR"), appData: app.getPath("appData") }), "desktop.json"))
  // What the main process does for release updates: a checkout, a remote server and a blank HUNTAWAY_RELEASE_UPDATES
  // have none.
  if (resources === null || typeof config["serverUrl"] === "string" || env("HUNTAWAY_RELEASE_UPDATES")?.trim() === "") {
    own()
    return
  }
  const appDir = join(
    dataDirFor({
      envDataDir: env("HUNTAWAY_DATA_DIR"),
      configDataDir: typeof config["dataDir"] === "string" ? config["dataDir"] : null,
      home: homedir(),
      xdgDataHome: env("XDG_DATA_HOME"),
    }),
    "app",
  )
  const params = { appDir, appVersion: app.getVersion(), electronVersion: process.versions.electron ?? "" }
  const otherRunning = settleCrash(appDir, (line) => console.error(line))
  const choice = findShell(params)
  const api: BootApi = { api: BOOT_API, running: choice, choose: () => findShell(params) }
  Reflect.set(globalThis, "huntawayBoot", api)
  if (choice === null) {
    own()
    return
  }

  const clearMarker = () => {
    try {
      const state = readShellState(appDir)
      if (tryingOf(state)?.pid === process.pid) {
        const { trying: _trying, ...rest } = state
        writeShellState(appDir, rest)
      }
    } catch {
      // Nothing to do about it: at worst the next start trusts the shell a little less.
    }
  }
  if (!otherRunning) writeShellState(appDir, { ...readShellState(appDir), trying: { version: choice.version, pid: process.pid } })
  try {
    console.log(`loading the desktop shell from huntaway ${choice.version}: ${choice.dir}`)
    require(join(choice.dir, "main.cjs"))
  } catch (error) {
    console.error(`the desktop shell in huntaway ${choice.version} failed to load: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    markShellBad(appDir, choice.version)
    const appimage = env("APPIMAGE")
    app.relaunch(appimage === null ? undefined : { execPath: appimage, args: process.argv.slice(1) })
    app.exit(0)
    return
  }
  setTimeout(clearMarker, SURVIVED_MS).unref()
  app.on("before-quit", clearMarker)
}

boot()
