import { Config, Context, Effect, Layer, Option, Redacted } from "effect"
import { Flag } from "effect/cli"

/**
 * `serve`'s flags, each with a `HUNTAWAY_*` variable as its fallback (docs/plan/06-server.md, The CLI). This file is
 * the one place the server's own environment is read.
 */
export const serveFlags = {
  host: Flag.String("host").pipe(
    Flag.withDescription("Address to listen on"),
    Flag.withFallbackConfig(Config.String("HUNTAWAY_HOST")),
    Flag.withDefault("0.0.0.0"),
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
  "HUNTAWAY_GH_BIN",
  // The task an agent works on, which a server started by another board's agent (a test server) has.
  "HUNTAWAY_TASK_ID",
] as const

/** Over the server's own environment (`extendEnv`), what removes `SERVE_ENV` from a child's. */
const AGENT_ENV: Readonly<Record<string, undefined>> = Object.fromEntries(SERVE_ENV.map((name) => [name, undefined]))

/** What the CLI parsed from `serveFlags`. */
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
  /** The commit this server runs, when known (`HUNTAWAY_COMMIT`, or none). */
  readonly commit: string | null
  /** The machine's home folder, for defaults and `~` in paths. */
  readonly home: string
  /** `--shim-bin`/`HUNTAWAY_SHIM_BIN`: the ia-shim to run agents under; null to look for one (`runs/Shim`). */
  readonly shimBin: string | null
  /** `--claude-bin`/`HUNTAWAY_CLAUDE_BIN`: the Claude Code program (default `claude`). */
  readonly claudeBin: string
  /** `--gh-bin`/`HUNTAWAY_GH_BIN`: the GitHub CLI (default `gh`, on PATH). Tests give the fake (`@huntaway/testing`'s `fakeGitHub`). */
  readonly ghBin: string
  /** The server's `PATH`, which a wait's command's gets the gh shim put in front of (`github/Gh`). */
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
        const commit = yield* Config.String("HUNTAWAY_COMMIT").pipe(Config.option)
        const exe = yield* Config.String("HUNTAWAY_EXE").pipe(Config.option)
        const tmpDir = yield* Config.String("TMPDIR").pipe(Config.withDefault("/tmp"))
        const pathEnv = yield* Config.String("PATH").pipe(Config.withDefault(""))
        const cacheHome = yield* Config.String("XDG_CACHE_HOME").pipe(Config.withDefault(""))
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
          commit: Option.getOrNull(commit),
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
