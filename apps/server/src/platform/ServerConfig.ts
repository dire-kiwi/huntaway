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
}

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
        })
      }),
    )

  /** For tests: everything given. */
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
        ...config,
      }),
    )
}
