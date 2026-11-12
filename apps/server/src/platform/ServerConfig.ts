import { Config, Context, Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect"
import { Flag } from "effect/cli"
import { userInfo } from "node:os"
import { StartupError } from "./StartupError.ts"

/**
 * `serve`'s flags, each with a `HUNTAWAY_*` variable as its fallback (docs/plan/06-server.md, The CLI). This file is
 * the one place the server's own environment is read.
 */
export const serveFlags = {
  // No default here: a rehearsal (a read-only server) listens on 127.0.0.1 unless told otherwise, any other on 0.0.0.0
  // (`serveArgs`).
  host: Flag.String("host").pipe(
    Flag.withDescription("Address to listen on (default 0.0.0.0; 127.0.0.1 for a read-only rehearsal)"),
    Flag.withFallbackConfig(Config.String("HUNTAWAY_HOST")),
    Flag.optional,
  ),
  port: Flag.Int("port").pipe(
    Flag.withDescription("Port to listen on (0 picks a free one)"),
    Flag.withFallbackConfig(Config.Int("HUNTAWAY_PORT")),
    Flag.withDefault(7879),
  ),
  dataDir: Flag.String("data-dir").pipe(
    Flag.withDescription("The board's data folder (default ~/.local/share/huntaway-effect)"),
    Flag.withFallbackConfig(Config.String("HUNTAWAY_DATA_DIR")),
    Flag.optional,
  ),
  uiDir: Flag.String("ui-dir").pipe(
    Flag.withDescription("The built web UI to serve (default apps/web/dist of this checkout)"),
    Flag.withFallbackConfig(Config.String("HUNTAWAY_UI_DIR")),
    Flag.optional,
  ),
  name: Flag.String("name").pipe(Flag.withDescription("This host's name"), Flag.withFallbackConfig(Config.String("HUNTAWAY_NAME")), Flag.optional),
  token: Flag.Redacted("token").pipe(
    Flag.withDescription("The board token (default: the data folder's auth_token, made on first start)"),
    Flag.withFallbackConfig(Config.Redacted("HUNTAWAY_TOKEN")),
    Flag.optional,
  ),
  demo: Flag.Boolean("demo").pipe(
    Flag.withDescription("Seed a Default profile with a Demo project on a board with no profiles"),
    Flag.withFallbackConfig(Config.Boolean("HUNTAWAY_DEMO")),
    Flag.withDefault(false),
  ),
  openToken: Flag.Boolean("open-token").pipe(
    Flag.withDescription("Give the token to any browser that asks (previews and test servers)"),
    Flag.withFallbackConfig(Config.Boolean("HUNTAWAY_OPEN_TOKEN")),
    Flag.withDefault(false),
  ),
  profiles: Flag.String("profile").pipe(
    Flag.withDescription("NAME=DIR: make sure a profile of that name exists, on that Claude config folder (repeatable)"),
    Flag.atLeast(0),
  ),
  skipDbBackup: Flag.Boolean("skip-db-backup").pipe(
    Flag.withDescription("Start even when the database cannot be backed up before migrating"),
    Flag.withFallbackConfig(Config.Boolean("HUNTAWAY_SKIP_DB_BACKUP")),
    Flag.withDefault(false),
  ),
  shimBin: Flag.String("shim-bin").pipe(
    Flag.withDescription("The ia-shim binary agents run under (default: the checkout's target/{release,debug}, else beside bin/huntaway)"),
    Flag.withFallbackConfig(Config.String("HUNTAWAY_SHIM_BIN")),
    Flag.optional,
  ),
  claudeBin: Flag.String("claude-bin").pipe(
    Flag.withDescription("The Claude Code program agents' runs start (default claude, on PATH)"),
    Flag.withFallbackConfig(Config.String("HUNTAWAY_CLAUDE_BIN")),
    Flag.optional,
  ),
  ghBin: Flag.String("gh-bin").pipe(
    Flag.withDescription("The GitHub CLI the gh tools and the board's own GitHub calls run (default gh, on PATH)"),
    Flag.withFallbackConfig(Config.String("HUNTAWAY_GH_BIN")),
    Flag.optional,
  ),
  codexBin: Flag.String("codex-bin").pipe(
    Flag.withDescription("The Codex program Codex runs and queries start (default codex, on PATH)"),
    Flag.withFallbackConfig(Config.String("HUNTAWAY_CODEX_BIN")),
    Flag.optional,
  ),
  noAgents: Flag.Boolean("no-agents").pipe(
    Flag.withDescription("Run no agent at all (test servers)"),
    Flag.withFallbackConfig(Config.Boolean("HUNTAWAY_NO_AGENTS")),
    Flag.withDefault(false),
  ),
  // Hosts (docs/plan/08-hosts.md).
  hub: Flag.String("hub").pipe(
    Flag.withDescription("URL[,URL]: hubs to dial in to as one of their hosts (with --hub-token)"),
    Flag.withFallbackConfig(Config.String("HUNTAWAY_HUB")),
    Flag.optional,
  ),
  hubToken: Flag.Redacted("hub-token").pipe(
    Flag.withDescription("The hub token of the hubs given with --hub"),
    Flag.withFallbackConfig(Config.Redacted("HUNTAWAY_HUB_TOKEN")),
    Flag.optional,
  ),
  noDiscovery: Flag.Boolean("no-discovery").pipe(
    Flag.withDescription("Neither answer nor send mDNS queries for other hosts (test servers)"),
    Flag.withFallbackConfig(Config.Boolean("HUNTAWAY_NO_DISCOVERY")),
    Flag.withDefault(false),
  ),
  // Updates (plan tasks 8.1, 8.2).
  sourceDir: Flag.String("source-dir").pipe(
    Flag.withDescription("The source checkout to rebuild from (default: the checkout this server runs from, if any)"),
    Flag.withFallbackConfig(Config.String("HUNTAWAY_SOURCE_DIR")),
    Flag.optional,
  ),
  updateFrom: Flag.String("update-from").pipe(
    Flag.withDescription("URL of a deployment of the board whose commit this host offers to update to"),
    Flag.withFallbackConfig(Config.String("HUNTAWAY_UPDATE_FROM")),
    Flag.optional,
  ),
  releaseUpdates: Flag.String("release-updates").pipe(
    Flag.withDescription("OWNER/REPO: update from that GitHub repository's releases"),
    Flag.withFallbackConfig(Config.String("HUNTAWAY_RELEASE_UPDATES")),
    Flag.optional,
  ),
  // 6.9: telemetry's ClickHouse when the host's settings have none.
  telemetryUrl: Flag.String("telemetry-url").pipe(
    Flag.withDescription("The ClickHouse telemetry goes to while the host's settings have none (http://USER:PASSWORD@HOST:8123/DATABASE)"),
    Flag.withFallbackConfig(Config.String("HUNTAWAY_TELEMETRY_URL")),
    Flag.optional,
  ),
}

/**
 * The variables `huntaway serve` takes its settings from, which a service manager or the desktop app may have given
 * this server. Agents' runs, and what the server starts for agents and projects, do not get them (HA-185, HA-262): a
 * server an agent starts itself (`huntaway serve` in a checkout) would otherwise use this one's data folder, port,
 * hubs, tokens and release updates. The old `SERVE_ENV`, under the new names, with the ones this server adds.
 */
export const SERVE_ENV = [
  "HUNTAWAY_HOST",
  "HUNTAWAY_PORT",
  "HUNTAWAY_DATA_DIR",
  "HUNTAWAY_UI_DIR",
  "HUNTAWAY_SOURCE_DIR",
  "HUNTAWAY_UPDATE_FROM",
  "HUNTAWAY_RELEASE_UPDATES",
  "HUNTAWAY_RELEASE_API",
  "HUNTAWAY_NAME",
  "HUNTAWAY_HUB",
  "HUNTAWAY_HUB_TOKEN",
  "HUNTAWAY_TOKEN",
  "HUNTAWAY_DEMO",
  "HUNTAWAY_OPEN_TOKEN",
  "HUNTAWAY_PROFILES",
  "HUNTAWAY_DESKTOP_VERSION",
  "HUNTAWAY_DESKTOP_SHELL",
  "HUNTAWAY_DESKTOP_INSTALL",
  "HUNTAWAY_BUNDLED_SERVER",
  "HUNTAWAY_TELEMETRY_URL",
  "HUNTAWAY_SKIP_DB_BACKUP",
  "HUNTAWAY_NO_AGENTS",
  "HUNTAWAY_NO_DISCOVERY",
  "HUNTAWAY_SSH_BIN",
  "HUNTAWAY_GH_BIN",
  // 6.11: where Asana's API is (a fake one for a test server).
  "HUNTAWAY_ASANA_URL",
  // 6.10: the Cua Driver to run, the release to install, and a screen said to be locked or not (tests).
  "HUNTAWAY_CUA_DRIVER",
  "HUNTAWAY_CUA_DRIVER_RELEASE",
  "HUNTAWAY_DESKTOP_LOCKED",
  // The task an agent works on, which a server started by another board's agent (a test server) has.
  "HUNTAWAY_TASK_ID",
] as const

/** Over the server's own environment (`extendEnv`), what removes `SERVE_ENV` from a child's. */
const AGENT_ENV: Readonly<Record<string, undefined>> = Object.fromEntries(SERVE_ENV.map((name) => [name, undefined]))

/** What the CLI parsed from `serveFlags`: the address only if `--host` or `HUNTAWAY_HOST` gave one. */
export type ServeFlags = Omit<ServeArgs, "host"> & { readonly host: Option.Option<string> }

/** The default listening address. */
export const DEFAULT_HOST = "0.0.0.0"

/** `flags` with the address they give, else `defaultHost` (`DEFAULT_HOST`; a rehearsal's is 127.0.0.1). */
export const serveArgs = (flags: ServeFlags, defaultHost: string = DEFAULT_HOST): ServeArgs => ({
  ...flags,
  host: Option.getOrElse(flags.host, () => defaultHost),
})

/** `serveFlags` with the address resolved. */
export interface ServeArgs {
  readonly host: string
  readonly port: number
  readonly dataDir: Option.Option<string>
  readonly uiDir: Option.Option<string>
  readonly name: Option.Option<string>
  readonly token: Option.Option<Redacted.Redacted>
  readonly demo: boolean
  readonly openToken: boolean
  readonly profiles: ReadonlyArray<string>
  readonly skipDbBackup: boolean
  // Optional so that a command that serves nothing (`token`) need not give them.
  readonly shimBin?: Option.Option<string>
  readonly claudeBin?: Option.Option<string>
  readonly ghBin?: Option.Option<string>
  readonly codexBin?: Option.Option<string>
  readonly noAgents?: boolean
  readonly hub?: Option.Option<string>
  readonly hubToken?: Option.Option<Redacted.Redacted>
  readonly noDiscovery?: boolean
  readonly sourceDir?: Option.Option<string>
  readonly updateFrom?: Option.Option<string>
  readonly releaseUpdates?: Option.Option<string>
  readonly telemetryUrl?: Option.Option<string>
}

export interface ServerConfigShape {
  readonly host: string
  readonly port: number
  /** Absolute; not yet resolved through symbolic links (`DataDir` does that). */
  readonly dataDir: string
  readonly uiDir: string | null
  readonly name: string | null
  /** A token given on the command line or in the environment, which then replaces the data folder's `auth_token`. */
  readonly token: Redacted.Redacted | null
  readonly demo: boolean
  readonly openToken: boolean
  /** `--profile NAME=DIR` pairs. */
  readonly profiles: ReadonlyArray<{ readonly name: string; readonly dir: string }>
  readonly skipDbBackup: boolean
  /** The server's version, as `--version` prints it. */
  readonly version: string
  /** The commit this server runs, when known: a release's `build.json`, else `HUNTAWAY_COMMIT` (`pickCommit`); a checkout's HEAD is `About`'s. */
  readonly commit: string | null
  /** The machine's home folder, for defaults and `~` in paths. */
  readonly home: string
  /** `--shim-bin`/`HUNTAWAY_SHIM_BIN`: the ia-shim to run agents under; null to look for one (`runs/Shim`). */
  readonly shimBin: string | null
  /** `--claude-bin`/`HUNTAWAY_CLAUDE_BIN`: the Claude Code program (default `claude`). */
  readonly claudeBin: string
  /** `--gh-bin`/`HUNTAWAY_GH_BIN`: the GitHub CLI (default `gh`, on PATH). Tests give the fake (`@huntaway/testing`'s `fakeGitHub`). */
  readonly ghBin: string
  /** The server's `PATH`: a wait's command's gets the gh shim put in front of it (`github/Gh`); a rebuild looks for pnpm and cargo on it. */
  readonly path: string
  /** The user's cache folder (`$XDG_CACHE_HOME`, else `~/.cache`): the gh tools' private gh config folders go in it. */
  readonly cacheDir: string
  /** The SSH config `ssh -G` reads for a remote's host alias (`-F`); null for the user's own. Tests give `/dev/null`. */
  readonly sshConfig: string | null
  /** `--codex-bin`/`HUNTAWAY_CODEX_BIN`: the Codex program (default `codex`), which a Codex run's adapter is told of too. */
  readonly codexBin: string
  /** `--no-agents`/`HUNTAWAY_NO_AGENTS`: this host runs no agent at all (test servers). `Runs` checks it. */
  readonly noAgents: boolean
  /** The launcher this server was started by (`HUNTAWAY_EXE`, which bin/huntaway sets), if any. */
  readonly exe: string | null
  /**
   * The environment of an agent's run and of what the server starts for agents and projects, over the server's own
   * (`extendEnv: true`): `SERVE_ENV` removed.
   */
  readonly agentEnv: Readonly<Record<string, string | undefined>>
  /** The system's temp folder (`TMPDIR`, else `/tmp`), where the tasks' temp folders' root goes (`tasks/TaskTmp`). */
  readonly tmpDir: string
  /** The root of the tasks' temp folders when it is not the usual one in `tmpDir`: tests put it in their data folder. */
  readonly taskTmpRoot: string | null
  /** `--hub URL[,URL]`: the hubs this host dials in to, without a trailing slash. */
  readonly hubs: ReadonlyArray<string>
  /** `--hub-token`: what it presents to them. */
  readonly hubToken: Redacted.Redacted | null
  /** `--no-discovery`: no mDNS responder or browser (test servers, which must never find or answer a real board). */
  readonly noDiscovery: boolean
  /** `HUNTAWAY_SSH_BIN`: the ssh program SSH links run (default `ssh`; tests give a fake). */
  readonly sshBin: string
  // Updates (plan tasks 8.1, 8.2; docs/plan/06-server.md, Desktop, update, analytics).
  /** `--source-dir`, else the checkout this server runs from (a root with `Cargo.toml` and `apps/web/`); null for a release. */
  readonly sourceDir: string | null
  /** `--update-from`: a deployment whose `/api/health` commit this host follows, without a trailing `/`. */
  readonly updateFrom: string | null
  /** `--release-updates`: the `OWNER/REPO` whose GitHub releases this server updates from. */
  readonly releaseRepo: string | null
  /** `HUNTAWAY_RELEASE_API`: GitHub's API (tests serve a fake one). */
  readonly releaseApi: string
  /** `<os>-<arch>` as release assets name it (`linux-x64`, `mac-arm64`). */
  readonly platform: string
  /** `HUNTAWAY_DESKTOP_VERSION`, `_SHELL`, `_INSTALL`: the desktop app that started this server, if one did. */
  readonly desktopVersion: string | null
  readonly desktopShell: string | null
  readonly desktopInstall: string | null
  /** `HUNTAWAY_BUNDLED_SERVER`: the server this host was installed as, which Roll back can go back to. */
  readonly bundledServer: string | null
  /** Whether this server is a release package (a `build.json` beside its launcher), whose version and commit that file gives. */
  readonly release: boolean
  /** `bin/huntaway`'s restart file and process id, when it is this process's parent (taken out of the environment). */
  readonly supervisor: { readonly file: string; readonly pid: number } | null
  /** The arguments this server was started with (after the program), to start it again with. */
  readonly args: ReadonlyArray<string>
  /** Every `HUNTAWAY_*` variable of this server's environment, sorted by name (a service unit keeps those that configure it). */
  readonly huntawayEnv: ReadonlyArray<readonly [string, string]>
  /** The user's login shell (`SHELL`, else `/bin/sh`), the user's name, and the folder this server was started in. */
  readonly loginShell: string
  readonly user: string
  readonly cwd: string
  /** `XDG_CONFIG_HOME`, else `~/.config`: user units go in its `systemd/user`. */
  readonly configHome: string
  /** `XDG_RUNTIME_DIR`, else `/run/user/<uid>`: what `systemctl --user` needs to find the user's manager. */
  readonly runtimeDir: string | null
  /** 6.11: Asana's API (`HUNTAWAY_ASANA_URL`, default Asana's own); a test points it at a fake. Tests have none by default. */
  readonly asanaUrl: string
  /** 6.10: `HUNTAWAY_CUA_DRIVER`, the Cua Driver to run instead of one installed or on PATH (`desktop/CuaDriver`). Tests give the fake. */
  readonly cuaDriver: string | null
  /** 6.10: `HUNTAWAY_CUA_DRIVER_RELEASE` (JSON), the release the host's page installs instead of the pinned one (a fake download in tests). */
  readonly cuaRelease: CuaReleaseConfig | null
  /** 6.10: `HUNTAWAY_DESKTOP_LOCKED` (`1` or `0`), whether the screen is locked, instead of asking the session (tests). */
  readonly desktopLocked: boolean | null
  /** 6.9: `--telemetry-url`/`HUNTAWAY_TELEMETRY_URL`, used while the host's settings name no ClickHouse. */
  readonly telemetryUrl: string | null
  /** 6.9: the server's environment makes Claude Code export telemetry of its own (`CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_*`). */
  readonly ownTelemetryEnv: boolean
  /** 6.9: `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, the agents' default config folders when a config names none. */
  readonly claudeConfigDir: string | null
  readonly codexHome: string | null
  /** 6.9: a stall of the event loop this long (ms) or longer is logged (`HUNTAWAY_LAG_LOG_MS`, default 250; 0: none). */
  readonly lagLogMs: number
}

/** 6.10: a Cua Driver release archive: where it is, and what it must be. */
export const CuaReleaseConfig = Schema.Struct({ version: Schema.String, url: Schema.String, bytes: Schema.Int, sha256: Schema.String })
export type CuaReleaseConfig = typeof CuaReleaseConfig.Type

/** What a release package says of itself in `build.json`, beside its launcher. */
const ReleaseBuild = Schema.fromJsonString(Schema.Struct({ version: Schema.String, commit: Schema.optional(Schema.NullOr(Schema.String)) }))

/** The `build.json` beside the launcher `exe` (`HUNTAWAY_EXE`), when this server is a release package. */
export const releaseBuild = (exe: string | null) =>
  Effect.gen(function* () {
    if (exe === null) return null
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(`${exe.slice(0, Math.max(0, exe.lastIndexOf("/")))}/build.json`).pipe(Effect.option)
    if (Option.isNone(text)) return null
    return yield* Schema.decodeEffect(ReleaseBuild)(text.value).pipe(
      Effect.mapError((e) => new StartupError({ reason: `can't read the build.json beside ${exe}: ${e.message}` })),
    )
  })

/**
 * The commit a server without a checkout runs: the one its release was built from, else (not for a release, which
 * inherits the deployment's environment when it was updated to) what its deployment says (`HUNTAWAY_COMMIT`).
 */
export const pickCommit = (built: string | null, deployed: string | null, isRelease: boolean): string | null =>
  nonBlank(built) ?? (isRelease ? null : nonBlank(deployed))

/** Text trimmed, or null when there's none. */
const nonBlank = (c: string | null) => (c !== null && c.trim() !== "" ? c.trim() : null)

/** A variable, trimmed; null when unset or blank. */
const text = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map((value) => nonBlank(Option.getOrNull(value))),
  )

/** A GitHub repository named as `OWNER/REPO`, or null. */
export const ownerRepo = (repo: string): string | null => {
  const trimmed = repo.trim()
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed) ? trimmed : null
}

/** The checkout this file is in: `apps/server/src/platform/` is four folders below its root. */
const thisCheckout = new URL("../../../..", import.meta.url)

/**
 * `bin/huntaway`'s restart file and process id, taken out of the environment so that nothing this server starts sees
 * them, and kept when the launcher is this process's parent (docs/plan/inventory/05-hosts-update.md, section 9).
 */
function takeSupervisor(): { readonly file: string; readonly pid: number } | null {
  const file = process.env["HUNTAWAY_RESTART_FILE"]
  const pid = Number(process.env["HUNTAWAY_SUPERVISOR_PID"])
  delete process.env["HUNTAWAY_RESTART_FILE"]
  delete process.env["HUNTAWAY_SUPERVISOR_PID"]
  return file !== undefined && file !== "" && pid > 1 && process.ppid === pid ? { file, pid } : null
}

/** Every `HUNTAWAY_*` variable, sorted by name. */
function huntawayVariables(): ReadonlyArray<readonly [string, string]> {
  return Object.entries(process.env)
    .flatMap(([name, value]): ReadonlyArray<readonly [string, string]> => (name.startsWith("HUNTAWAY_") && value !== undefined ? [[name, value]] : []))
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/** What the update area reads of the environment (plan tasks 8.1, 8.2). */
const updateConfig = (args: ServeArgs, home: string, exe: string | null, expand: (path: string) => string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const supervisor = yield* Effect.sync(takeSupervisor)
    const build = yield* releaseBuild(exe)
    const isFile = (path: string) =>
      fs.stat(path).pipe(
        Effect.map((info) => info.type === "File"),
        Effect.orElseSucceed(() => false),
      )
    const given = args.sourceDir === undefined ? Option.none<string>() : Option.map(args.sourceDir, expand)
    const candidate = Option.isSome(given) ? given.value : build === null ? decodeURIComponent(thisCheckout.pathname).replace(/\/$/, "") : null
    const real = candidate === null ? null : yield* fs.realPath(candidate).pipe(Effect.orElseSucceed(() => null))
    const sourceDir = real !== null && (yield* isFile(`${real}/Cargo.toml`)) && (yield* isFile(`${real}/apps/web/package.json`)) ? real : null
    const repo = args.releaseUpdates === undefined ? null : Option.getOrNull(args.releaseUpdates)
    const releaseRepo = repo === null || repo.trim() === "" ? null : ownerRepo(repo)
    if (repo !== null && repo.trim() !== "" && releaseRepo === null) {
      return yield* new StartupError({ reason: `--release-updates "${repo}" isn't OWNER/REPO` })
    }
    const updateFrom = args.updateFrom === undefined ? null : Option.getOrNull(Option.map(args.updateFrom, (url) => url.trim().replace(/\/+$/, "")))
    const deployed = yield* text("HUNTAWAY_COMMIT")
    const uid = typeof process.getuid === "function" ? process.getuid() : null
    const huntawayEnv = yield* Effect.sync(huntawayVariables)
    return {
      sourceDir,
      updateFrom: updateFrom === "" ? null : updateFrom,
      releaseRepo,
      releaseApi: ((yield* text("HUNTAWAY_RELEASE_API")) ?? "https://api.github.com").replace(/\/+$/, ""),
      platform: `${process.platform === "darwin" ? "mac" : process.platform}-${process.arch}`,
      desktopVersion: yield* text("HUNTAWAY_DESKTOP_VERSION"),
      desktopShell: yield* text("HUNTAWAY_DESKTOP_SHELL"),
      desktopInstall: yield* text("HUNTAWAY_DESKTOP_INSTALL"),
      bundledServer: yield* text("HUNTAWAY_BUNDLED_SERVER"),
      release: build !== null,
      supervisor,
      args: process.argv.slice(2),
      huntawayEnv,
      loginShell: (yield* text("SHELL")) ?? "/bin/sh",
      user: (yield* text("USER")) ?? userInfo().username,
      cwd: process.cwd(),
      configHome: (yield* text("XDG_CONFIG_HOME")) ?? `${home}/.config`,
      runtimeDir: (yield* text("XDG_RUNTIME_DIR")) ?? (uid === null ? null : `/run/user/${uid}`),
      // A release reports its own version and commit, and serves its own UI, not the deployment's.
      ...(build === null
        ? { commit: pickCommit(null, deployed, false) }
        : {
            version: build.version,
            commit: pickCommit(build.commit ?? null, deployed, true),
            ...(exe !== null && Option.isNone(args.uiDir) ? { uiDir: `${exe.slice(0, exe.lastIndexOf("/"))}/ui` } : {}),
          }),
    } satisfies Partial<ServerConfigShape>
  })

/** The version of this build. A release sets it when it packages the server. */
export const VERSION = "0.1.0"

/** The server's configuration: flags and environment, read once. */
export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()("huntaway-server/platform/ServerConfig") {
  /** From the parsed flags; the rest of the environment is read here too. */
  static readonly layerFrom = (args: ServeArgs) =>
    Layer.effect(
      ServerConfig,
      Effect.gen(function* () {
        const home = yield* Config.String("HOME").pipe(Config.withDefault("/"))
        const dataHome = yield* Config.String("XDG_DATA_HOME").pipe(Config.withDefault(`${home}/.local/share`))
        const exe = yield* Config.String("HUNTAWAY_EXE").pipe(Config.option)
        const tmpDir = yield* Config.String("TMPDIR").pipe(Config.withDefault("/tmp"))
        const sshBin = yield* Config.String("HUNTAWAY_SSH_BIN").pipe(Config.option)
        const pathEnv = yield* Config.String("PATH").pipe(Config.withDefault(""))
        const cacheHome = yield* Config.String("XDG_CACHE_HOME").pipe(Config.withDefault(""))
        const asanaUrl = yield* Config.String("HUNTAWAY_ASANA_URL").pipe(Config.withDefault("https://app.asana.com/api/1.0"))
        // 6.10: computer use's overrides.
        const cuaDriver = yield* Config.String("HUNTAWAY_CUA_DRIVER").pipe(Config.option)
        const cuaRelease = yield* Config.schema(Schema.fromJsonString(CuaReleaseConfig), "HUNTAWAY_CUA_DRIVER_RELEASE").pipe(Config.option)
        const desktopLocked = yield* Config.String("HUNTAWAY_DESKTOP_LOCKED").pipe(Config.option)
        // 6.9
        const claudeConfigDir = yield* Config.String("CLAUDE_CONFIG_DIR").pipe(Config.option)
        const codexHome = yield* Config.String("CODEX_HOME").pipe(Config.option)
        const lagLogMs = yield* Config.Number("HUNTAWAY_LAG_LOG_MS").pipe(Config.withDefault(250))
        const expand = (path: string) => (path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path)
        const profiles = args.profiles.flatMap((pair) => {
          const at = pair.indexOf("=")
          return at > 0 ? [{ name: pair.slice(0, at), dir: expand(pair.slice(at + 1)) }] : []
        })
        return ServerConfig.of({
          host: args.host,
          port: args.port,
          dataDir: expand(Option.getOrElse(args.dataDir, () => `${dataHome}/huntaway-effect`)),
          uiDir: Option.getOrNull(Option.map(args.uiDir, expand)),
          name: Option.getOrNull(args.name),
          token: Option.getOrNull(args.token),
          demo: args.demo,
          openToken: args.openToken,
          profiles,
          skipDbBackup: args.skipDbBackup,
          version: VERSION,
          home,
          shimBin: args.shimBin === undefined ? null : Option.getOrNull(Option.map(args.shimBin, expand)),
          claudeBin: args.claudeBin === undefined ? "claude" : Option.getOrElse(Option.map(args.claudeBin, expand), () => "claude"),
          ghBin: args.ghBin === undefined ? "gh" : Option.getOrElse(Option.map(args.ghBin, expand), () => "gh"),
          path: pathEnv,
          cacheDir: cacheHome.startsWith("/") ? cacheHome : `${home}/.cache`,
          sshConfig: null,
          codexBin: args.codexBin === undefined ? "codex" : Option.getOrElse(Option.map(args.codexBin, expand), () => "codex"),
          noAgents: args.noAgents ?? false,
          exe: Option.getOrNull(exe),
          agentEnv: AGENT_ENV,
          tmpDir: tmpDir.length > 1 && tmpDir.endsWith("/") ? tmpDir.slice(0, -1) : tmpDir,
          taskTmpRoot: null,
          asanaUrl,
          cuaDriver: Option.getOrNull(
            Option.map(
              Option.filter(cuaDriver, (p) => p !== ""),
              expand,
            ),
          ),
          cuaRelease: Option.getOrNull(cuaRelease),
          desktopLocked: Option.getOrNull(
            Option.map(
              Option.filter(desktopLocked, (v) => v !== ""),
              (v) => v === "1",
            ),
          ),
          hubs: Option.match(args.hub ?? Option.none(), {
            onNone: () => [],
            onSome: (list) =>
              list
                .split(",")
                .map((url) => url.trim().replace(/\/+$/, ""))
                .filter((url) => url !== ""),
          }),
          hubToken: Option.getOrNull(args.hubToken ?? Option.none()),
          noDiscovery: args.noDiscovery ?? false,
          sshBin: Option.getOrElse(sshBin, () => "ssh"),
          ...(yield* updateConfig(args, home, Option.getOrNull(exe), expand)),
          // 6.9
          telemetryUrl: args.telemetryUrl === undefined ? null : Option.getOrNull(args.telemetryUrl),
          ownTelemetryEnv: Object.entries(process.env).some(
            ([k, v]) => (k === "CLAUDE_CODE_ENABLE_TELEMETRY" || k.startsWith("OTEL_")) && v !== undefined && v !== "",
          ),
          claudeConfigDir: Option.getOrNull(Option.map(claudeConfigDir, expand)),
          codexHome: Option.getOrNull(Option.map(codexHome, expand)),
          lagLogMs: Number.isFinite(lagLogMs) && lagLogMs >= 0 ? lagLogMs : 250,
        })
      }),
    )

  /** For tests: everything given. The tasks' temp folders are in the data folder (`task-tmp`), which goes with the test. */
  static readonly layerTest = (config: Partial<ServerConfigShape> & { readonly dataDir: string }) =>
    Layer.succeed(
      ServerConfig,
      ServerConfig.of({
        host: "127.0.0.1",
        port: 0,
        uiDir: null,
        name: "test",
        token: Redacted.make("test-token"),
        demo: false,
        openToken: false,
        profiles: [],
        skipDbBackup: false,
        version: VERSION,
        commit: null,
        home: config.dataDir,
        // No agent starts unless a test gives a shim (and a fake `claude`); never the real Claude Code.
        shimBin: "/nonexistent/ia-shim",
        claudeBin: `${config.dataDir}/no-claude-in-tests`,
        // Nor the real gh: a test gives the fake one.
        ghBin: `${config.dataDir}/no-gh-in-tests`,
        path: process.env["PATH"] ?? "",
        cacheDir: `${config.dataDir}/cache`,
        sshConfig: "/dev/null",
        codexBin: `${config.dataDir}/no-codex-in-tests`,
        noAgents: false,
        exe: null,
        agentEnv: AGENT_ENV,
        tmpDir: config.dataDir,
        taskTmpRoot: `${config.dataDir}/task-tmp`,
        // Never Asana's own: a test gives its fake's.
        asanaUrl: "http://127.0.0.1:9/no-asana-in-tests",
        // 6.10: never this machine's desktop, nor a download from GitHub: a test gives the fake driver and its own release.
        cuaDriver: `${config.dataDir}/no-cua-driver-in-tests`,
        cuaRelease: { version: "0.0.0-none", url: "http://127.0.0.1:1/no-downloads-in-tests", bytes: 1, sha256: "0".repeat(64) },
        desktopLocked: false,
        hubs: [],
        hubToken: null,
        noDiscovery: true,
        sshBin: "ssh",
        // No updates unless a test gives them; nothing outside the data folder.
        sourceDir: null,
        updateFrom: null,
        releaseRepo: null,
        releaseApi: "http://127.0.0.1:1",
        platform: "linux-x64",
        desktopVersion: null,
        desktopShell: null,
        desktopInstall: null,
        bundledServer: null,
        release: false,
        supervisor: null,
        args: ["serve"],
        huntawayEnv: [],
        loginShell: "/bin/sh",
        user: "test",
        cwd: config.dataDir,
        configHome: `${config.dataDir}/config`,
        runtimeDir: null,
        // 6.9
        telemetryUrl: null,
        ownTelemetryEnv: false,
        claudeConfigDir: null,
        codexHome: null,
        lagLogMs: 250,
        ...config,
      }),
    )
}
