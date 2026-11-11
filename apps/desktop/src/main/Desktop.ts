import { Config, Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { configDirFor, dataDirFor, DEFAULT_PORT } from "../shared/paths.ts"
import { asObject } from "../shared/versions.ts"

/**
 * desktop.json (`<the shell's folder>/desktop.json`, read only): where the board is. Each field is taken when it has
 * the right type, as the old app took them.
 */
export interface DesktopFile {
  readonly port: number | null
  readonly dataDir: string | null
  readonly host: string | null
  readonly serverBin: string | null
  /** Remote mode: the board of a server on another machine; nothing is started here. */
  readonly serverUrl: string | null
  readonly token: string | null
  readonly skipDbBackup: boolean
}

/** What the main process knows about itself and its machine, read once at start. */
export interface DesktopShape {
  /** The shell's own folder (its window storage too) and its desktop.json. */
  readonly configDir: string
  readonly configPath: string
  readonly file: DesktopFile
  readonly port: number
  /** The server's data folder, as the server finds it. */
  readonly dataDir: string
  /** Whether the data folder was given (HUNTAWAY_DATA_DIR or desktop.json), so a server started here is given it too. */
  readonly dataDirGiven: boolean
  /** A release build's resources (the bundled server, ia-shim, Node and the UI), or null from a checkout. */
  readonly resourcesDir: string | null
  /** A UI served by `vp dev` (`HUNTAWAY_DEV_URL`): windows load it rather than the server's. One app may run beside another. */
  readonly devUrl: string | null
  /** `HUNTAWAY_RELEASE_UPDATES` as given (null when unset; blank turns release updates off). */
  readonly releaseUpdates: string | null
  /** GitHub's API (`HUNTAWAY_RELEASE_API`, for tests), without a trailing slash. */
  readonly releaseApi: string
  /** `HUNTAWAY_SERVER_BIN` or desktop.json's `serverBin`: the server to start, whatever else there is. */
  readonly serverBin: string | null
  /** install.sh's launcher (`HUNTAWAY_LAUNCHER`), which relaunches go through. */
  readonly launcher: string | null
  /** The AppImage's file, when the app runs as one. */
  readonly appimage: string | null
  readonly appVersion: string
  readonly electronVersion: string
  readonly isPackaged: boolean
  /** The package's root (`app.getAppPath()`): its dist/boot.cjs is the frame. */
  readonly appPath: string
  /** The folder of the running shell's files (this main.cjs and its preload.cjs). */
  readonly shellDir: string
  /** The checkout this shell runs from (three folders above dist/), or null for a packaged app. */
  readonly checkoutRoot: string | null
  readonly platform: string
  readonly arch: string
  readonly home: string
  /** `$SHELL`, for the login shell's PATH. */
  readonly loginShell: string
  /** The PATH the server is started with: this process's, and the login shell's for a packaged app (see loginPath.ts). */
  readonly path: string
}

/** What the entry point reads from Electron before anything else, synchronously. */
export interface DesktopInputs {
  readonly appData: string
  readonly appPath: string
  readonly shellDir: string
  readonly appVersion: string
  readonly electronVersion: string
  readonly isPackaged: boolean
  readonly resourcesPath: string
  readonly platform: string
  readonly arch: string
}

const Json = Schema.fromJsonString(Schema.Unknown)

const optionalEnv = (name: string) => Config.String(name).pipe(Config.option, Config.map(Option.getOrNull))

/** The shell's folder: `HUNTAWAY_DESKTOP_DIR`, else `<appData>/huntaway-effect`. Read before Electron is ready. */
export const configDir = (appData: string) => Effect.map(optionalEnv("HUNTAWAY_DESKTOP_DIR"), (envDir) => configDirFor({ envDir, appData }))

/** desktop.json's fields, from its parsed contents. */
export const desktopFile = (value: unknown): DesktopFile => {
  const o = asObject(value)
  const str = (key: string) => {
    const v = o[key]
    return typeof v === "string" && v !== "" ? v : null
  }
  const port = o["port"]
  return {
    port: typeof port === "number" && Number.isInteger(port) && port > 0 ? port : null,
    dataDir: str("dataDir"),
    host: str("host"),
    serverBin: str("serverBin"),
    serverUrl: str("serverUrl"),
    token: str("token"),
    skipDbBackup: o["skipDbBackup"] === true,
  }
}

export class Desktop extends Context.Service<Desktop, DesktopShape>()("huntaway-desktop/main/Desktop") {
  /** From what Electron said (`inputs`), the environment and desktop.json. */
  static readonly layerFrom = (inputs: DesktopInputs) =>
    Layer.effect(
      Desktop,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* configDir(inputs.appData)
        const configPath = path.join(dir, "desktop.json")
        const text = yield* fs.readFileString(configPath).pipe(Effect.option)
        const parsed = Option.isSome(text) ? yield* Schema.decodeEffect(Json)(text.value).pipe(Effect.option) : Option.none()
        const file = desktopFile(Option.getOrUndefined(parsed))
        const home = yield* Config.String("HOME").pipe(Config.withDefault("/"))
        const envDataDir = yield* optionalEnv("HUNTAWAY_DATA_DIR")
        const envPort = yield* Config.Int("HUNTAWAY_PORT").pipe(Config.option, Config.map(Option.getOrNull))
        const packagedResources = yield* optionalEnv("HUNTAWAY_PACKAGED_RESOURCES")
        const releaseApi = yield* optionalEnv("HUNTAWAY_RELEASE_API")
        const serverBin = yield* optionalEnv("HUNTAWAY_SERVER_BIN")
        const checkoutRoot = inputs.isPackaged ? null : path.resolve(inputs.shellDir, "..", "..", "..")
        return Desktop.of({
          configDir: dir,
          configPath,
          file,
          port: envPort ?? file.port ?? DEFAULT_PORT,
          dataDir: dataDirFor({ envDataDir, configDataDir: file.dataDir, home, xdgDataHome: yield* optionalEnv("XDG_DATA_HOME") }),
          dataDirGiven: (envDataDir !== null && envDataDir !== "") || file.dataDir !== null,
          resourcesDir: packagedResources ?? (inputs.isPackaged ? inputs.resourcesPath : null),
          devUrl: yield* optionalEnv("HUNTAWAY_DEV_URL"),
          releaseUpdates: yield* optionalEnv("HUNTAWAY_RELEASE_UPDATES"),
          releaseApi: (releaseApi === null || releaseApi.trim() === "" ? "https://api.github.com" : releaseApi.trim()).replace(/\/+$/, ""),
          serverBin: serverBin ?? file.serverBin,
          launcher: yield* optionalEnv("HUNTAWAY_LAUNCHER"),
          appimage: yield* optionalEnv("APPIMAGE"),
          appVersion: inputs.appVersion,
          electronVersion: inputs.electronVersion,
          isPackaged: inputs.isPackaged,
          appPath: inputs.appPath,
          shellDir: inputs.shellDir,
          checkoutRoot,
          platform: inputs.platform,
          arch: inputs.arch,
          home,
          loginShell: yield* Config.String("SHELL").pipe(Config.withDefault("/bin/sh")),
          path: yield* Config.String("PATH").pipe(Config.withDefault("/usr/bin:/bin")),
        })
      }),
    )

  /** For tests: a checkout's shell on port `port`, with everything else given or plain. */
  static readonly layerTest = (config: Partial<DesktopShape> & { readonly dataDir: string; readonly port: number }) =>
    Layer.succeed(
      Desktop,
      Desktop.of({
        configDir: config.dataDir,
        configPath: `${config.dataDir}/desktop.json`,
        file: desktopFile({}),
        dataDirGiven: true,
        resourcesDir: null,
        devUrl: null,
        releaseUpdates: null,
        releaseApi: "http://127.0.0.1:9",
        serverBin: null,
        launcher: null,
        appimage: null,
        appVersion: "0.1.0",
        electronVersion: "45.3.0",
        isPackaged: false,
        appPath: config.dataDir,
        shellDir: config.dataDir,
        checkoutRoot: null,
        platform: "linux",
        arch: "x64",
        home: config.dataDir,
        loginShell: "/bin/sh",
        path: "/usr/bin:/bin",
        ...config,
      }),
    )
}

/** Whether release updates are off for this app: a checkout, a remote server, or a blank `HUNTAWAY_RELEASE_UPDATES`. */
export const releaseUpdatesOff = (desktop: DesktopShape): boolean =>
  desktop.resourcesDir === null || desktop.file.serverUrl !== null || desktop.releaseUpdates?.trim() === ""
