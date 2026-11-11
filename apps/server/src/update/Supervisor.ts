import { Context, Effect, FileSystem, Layer, Schedule, Schema } from "effect"
import { ServerConfig } from "../platform/ServerConfig.ts"

// The launcher's side of a restart (docs/plan/inventory/05-hosts-update.md, section 9, Update). Node can't exec, so
// `bin/huntaway` runs node as its child and holds the process id that service managers, the desktop app and test
// scripts go by: to restart, or to start a release in its place, the server writes what to exec to the launcher's
// restart file and exits with `EXEC_CODE`, and the launcher sources the file and execs it. `ServerConfig` takes the
// file and the launcher's id out of the environment first thing (they are this server's, not its children's).

/** The exit code with which this server asks `bin/huntaway` to exec what it wrote to its restart file. */
export const EXEC_CODE = 75

/** Why an exec fails in a server the launcher did not start (a test's, or `node src/bin.ts`). */
export const NOT_SUPERVISED = "not started by bin/huntaway, which execs for this server"

/**
 * The serve flags that ask the start they're given to for something once. A restart leaves them out: an older build
 * that Roll back starts wouldn't know the flag and would exit. None today (the old `--recopy-db` is dropped with the
 * two-file database, docs/plan/14-dropped-and-open.md); their variables (`HUNTAWAY_SKIP_DB_BACKUP_ONCE`) the launcher
 * gives only to the first server it starts.
 */
export const ONE_SHOT_ARGS: ReadonlyArray<string> = []

/** This server's arguments, for a restart: without `ONE_SHOT_ARGS`. */
export const restartArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> => args.filter((a) => !ONE_SHOT_ARGS.includes(a))

/** An argument for `sh`, single-quoted. */
export const shQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

/** A value in a message, in double quotes. */
export const quoted = (s: string) => `"${s.replaceAll('"', '\\"')}"`

/** What the launcher sources:the program to exec, its arguments, and variables to add to its environment. */
export const restartScript = (exe: string, args: ReadonlyArray<string>, env: ReadonlyArray<readonly [string, string]>) =>
  [`next=${shQuote(exe)}`, `set -- ${args.map(shQuote).join(" ")}`, ...env.map(([k, v]) => `${k}=${shQuote(v)}; export ${k}`)].join("\n") + "\n"

/** An exec this server could not ask for: `failed to exec <exe>: <reason>`. */
export class ExecFailed extends Schema.TaggedError<ExecFailed, { readonly brand: unique symbol }>()("ExecFailed", {
  exe: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `failed to exec ${this.exe}: ${this.reason}`
  }
}

/** An exec asked for: what `bin/huntaway` would run. */
export interface ExecCall {
  readonly exe: string
  readonly args: ReadonlyArray<string>
  readonly env: ReadonlyArray<readonly [string, string]>
}

export interface SupervisorShape {
  /** `bin/huntaway`'s process id, when it started this server: the server's process as a service manager sees it. */
  readonly pid: number | null
  /**
   * Tell the launcher the server is up (it is listening, and has said so): `started` beside the restart file. From then
   * on the launcher starts it again if it crashes; one that exits before then is not started again.
   */
  readonly started: Effect.Effect<void>
  /** Replace this process with `exe` (its arguments, and `env` on top of this environment). Only returns on failure. */
  readonly exec: (exe: string, args: ReadonlyArray<string>, env: ReadonlyArray<readonly [string, string]>) => Effect.Effect<never, ExecFailed>
}

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `bin/huntaway`, as this server sees it: started, exec, and gone. */
export class Supervisor extends Context.Service<Supervisor, SupervisorShape>()("huntaway-server/update/Supervisor") {
  static readonly layer = Layer.effect(
    Supervisor,
    Effect.gen(function* () {
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const supervisor = config.supervisor
      if (supervisor === null) {
        return Supervisor.of({
          pid: null,
          started: Effect.void,
          exec: (exe) => Effect.fail(new ExecFailed({ exe, reason: NOT_SUPERVISED })),
        })
      }
      const dir = supervisor.file.slice(0, supervisor.file.lastIndexOf("/"))
      // The launcher killed (SIGKILL, say): this server doesn't outlive the process id it was known by.
      yield* Effect.sync(() => process.ppid !== supervisor.pid).pipe(
        Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (gone) => gone }),
        Effect.andThen(Effect.logWarning(`bin/huntaway (${supervisor.pid}) has gone; shutting down`)),
        Effect.andThen(Effect.sync(() => process.kill(process.pid, "SIGTERM"))),
        Effect.forkScoped,
      )
      const exec = Effect.fn("Supervisor.exec")(function* (exe: string, args: ReadonlyArray<string>, env: ReadonlyArray<readonly [string, string]>) {
        const failed = (reason: string) => new ExecFailed({ exe, reason: reason.slice(0, 500) })
        const info = yield* fs.stat(exe).pipe(Effect.mapError((e) => failed(e.message)))
        if (info.type !== "File") return yield* failed("Permission denied (not a file)")
        if ((info.mode & 0o111) === 0) return yield* failed("Permission denied (not executable)")
        const bad = env.find(([k]) => !VARIABLE.test(k))
        if (bad !== undefined) return yield* failed(`${quoted(bad[0])} isn't a variable name`)
        const tmp = `${supervisor.file}.${process.pid}.tmp`
        yield* fs.writeFileString(tmp, restartScript(exe, args, env), { mode: 0o600 }).pipe(
          Effect.andThen(fs.rename(tmp, supervisor.file)),
          Effect.mapError((e) => failed(`writing ${supervisor.file}: ${e.message}`)),
          Effect.tapError(() => fs.remove(tmp, { force: true }).pipe(Effect.ignore)),
        )
        yield* Effect.logInfo(`re-executing ${exe}`)
        // The launcher sources the file and execs it, as this server's process.
        return yield* Effect.sync(() => process.exit(EXEC_CODE))
      })
      return Supervisor.of({
        pid: supervisor.pid,
        started: fs
          .writeFileString(`${dir}/started`, `${process.pid}\n`)
          .pipe(Effect.catch((e) => Effect.logWarning(`telling bin/huntaway the server is up: ${e.message}`))),
        exec,
      })
    }).pipe(Effect.annotateLogs({ module: "supervisor" })),
  )

  /**
   * For tests: a server the launcher did not start, which tells `onExec` what it would have exec'd (as the old
   * `reached("exec")` and `exec_args()` did) and then fails as such a server does.
   */
  static readonly layerTest = (onExec: (call: ExecCall) => Effect.Effect<void>) =>
    Layer.succeed(
      Supervisor,
      Supervisor.of({
        pid: null,
        started: Effect.void,
        exec: (exe, args, env) => onExec({ exe, args, env }).pipe(Effect.andThen(Effect.fail(new ExecFailed({ exe, reason: NOT_SUPERVISED })))),
      }),
    )
}
