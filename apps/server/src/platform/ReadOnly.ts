import { Effect, Layer, PlatformError } from "effect"
import { HttpClient, HttpClientError } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

// What a read-only server (docs/plan/06-server.md, `ImportGuard` and a read-only server; 11-migration.md, Rehearsal) may
// start and reach: one program, git, with reading subcommands only, and no network. Held at the spawner every process
// of the server goes through (`Proc.readOnly` and the areas that spawn directly, `Git` among them), and at the HTTP
// client. Code reached by mistake cannot act.

/** The git subcommands a read-only server runs: they read a repository and write nothing in it. */
export const READING_GIT: ReadonlySet<string> = new Set(["status", "diff", "log", "show", "rev-parse", "merge-base", "for-each-ref", "ls-files", "cat-file"])

/** `-c key=value` settings a reading command may carry: they turn things off or change how output is quoted. */
const SAFE_CONFIG: ReadonlyMap<string, (value: string) => boolean> = new Map<string, (value: string) => boolean>([
  ["core.quotepath", () => true],
  ["commit.gpgsign", () => true],
  ["core.hookspath", (v) => v === "/dev/null"],
  ["core.fsmonitor", (v) => v === "false"],
  ["maintenance.autodetach", () => true],
  ["gc.autodetach", () => true],
])

/** Global options (before the subcommand) that change nothing but where git looks or how it prints. */
const SAFE_GLOBAL = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects"])

/** Whether `command args` is git running one of `READING_GIT`, with nothing that writes a file (`--output`) or runs a program. */
export const isReadingGit = (command: string, args: ReadonlyArray<unknown>): boolean => {
  if (command !== "git") return false
  const words: Array<string> = []
  for (const arg of args) {
    if (typeof arg !== "string") return false
    words.push(arg)
  }
  let i = 0
  for (; i < words.length; i++) {
    const word = words[i] ?? ""
    if (word === "-C") {
      i++
      continue
    }
    if (word === "-c") {
      const setting = words[i + 1] ?? ""
      const at = setting.indexOf("=")
      const check = at > 0 ? SAFE_CONFIG.get(setting.slice(0, at).toLowerCase()) : undefined
      if (check === undefined || !check(setting.slice(at + 1))) return false
      i++
      continue
    }
    if (SAFE_GLOBAL.has(word)) continue
    break
  }
  const subcommand = words[i]
  if (subcommand === undefined || !READING_GIT.has(subcommand)) return false
  return words.slice(i + 1).every((w) => !w.startsWith("--output") && w !== "--ext-diff" && !w.startsWith("--exec"))
}

/** What a read-only server says when it is asked to start anything else. */
export const refusedCommand = (command: string, args: ReadonlyArray<unknown>) =>
  `${[command, ...args.map((a) => (typeof a === "string" ? a : "<redacted>"))].join(" ").slice(0, 200)}: not run on a read-only server (it runs reading git commands only)`

const commandLine = (command: ChildProcess.Command): string =>
  command._tag === "StandardCommand" ? `${command.command} ${command.args.map((a) => (typeof a === "string" ? a : "<redacted>")).join(" ")}` : "a pipeline"

/**
 * The spawner of a read-only server, over the environment's: a reading git command (`isReadingGit`), with no shell, is
 * started under `GIT_OPTIONAL_LOCKS=0`, so it takes no lock an agent's git may want and refreshes no index; anything
 * else, and any pipeline, fails as a permission denied without starting.
 */
export const ReadOnlySpawner = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand" || command.options.shell !== undefined || !isReadingGit(command.command, command.args))
        return Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "ChildProcess",
            method: "spawn",
            description:
              command._tag === "StandardCommand" ? refusedCommand(command.command, command.args) : `${commandLine(command)}: not run on a read-only server`,
          }),
        )
      const { options } = command
      return spawner.spawn(
        ChildProcess.make(command.command, command.args, {
          ...options,
          env: { ...options.env, GIT_OPTIONAL_LOCKS: "0" },
          extendEnv: options.env === undefined ? true : options.extendEnv,
        }),
      )
    })
  }),
)

/** The HTTP client of a read-only server: every request fails without leaving the process. */
export const RefusingHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: "a read-only server calls nothing on the network" }),
      }),
    ),
  ),
)
