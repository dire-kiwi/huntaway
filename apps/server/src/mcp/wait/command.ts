import { Effect, Fiber, Ref, Stream } from "effect"
import type { Scope } from "effect"
import { ChildProcess } from "effect/process"
import type { ChildProcessSpawner } from "effect/process"
import { ToolError } from "../tool.ts"

// A wait's command (docs/plan/inventory/03-mcp.md 2.8; huntaway's mcp/wait.ts `run_command`): the agent's own check of
// something the board can't see (CI, a deploy, a file), run with bash in its working directory while it waits. It runs
// in a process group of its own, killed (SIGKILL) once the command exits or the wait ends some other way (the scope it
// is started in closes), so nothing it started outlives it; and a watchdog in the group kills it when the server's
// end of its stdin closes, which the kernel does however the server goes (an exec, an exit, a crash). Its output
// (stdout and stderr together) is kept to its last `OUTPUT_MAX` bytes.

/** How much of the end of a command's output the tool returns (bytes). */
export const OUTPUT_MAX = 4000

/**
 * The watchdog: a subshell that waits on the command's stdin and kills the group once that closes. Its other end is held
 * by the server only, so the kernel closes it however the server goes, none of which run the code that kills the group
 * otherwise. stderr goes where stdout does (one pipe, so their lines keep their order). The command itself runs in a
 * bash of its own (exec'd), which doesn't count the watchdog among its jobs.
 */
export const LAUNCH = `exec 3<&0 </dev/null 2>&1; (read -r _ <&3; kill -KILL 0) & exec 3<&-; exec bash -c "$1"`

/** The end of a command's output so far: its last bytes and how many there were in all. */
interface Tail {
  readonly bytes: Uint8Array
  readonly total: number
}

const append = (t: Tail, chunk: Uint8Array): Tail => {
  const joined = new Uint8Array(t.bytes.length + chunk.length)
  joined.set(t.bytes)
  joined.set(chunk, t.bytes.length)
  return { bytes: joined.length > OUTPUT_MAX ? joined.slice(joined.length - OUTPUT_MAX) : joined, total: t.total + chunk.length }
}

/** The end of a command's output: `OUTPUT_MAX` bytes at most, saying how much came before. */
export const tailText = (t: Tail): string => {
  const out = new TextDecoder().decode(t.bytes)
  return t.total > OUTPUT_MAX ? `… [${t.total - OUTPUT_MAX} bytes before this]\n${out}` : out
}

/** A wait's command while it runs. */
export interface RunningCommand {
  /** Its exit code (null if a signal ended it) and the end of its output, once it has exited and its group is gone. */
  readonly exited: Effect.Effect<{ readonly code: number | null; readonly output: string }>
  /** The end of its output so far. */
  readonly soFar: Effect.Effect<string>
}

/**
 * Start `command` (see `LAUNCH`) with `spawner` in `cwd` with `env` over the server's, for as long as the scope lasts:
 * its group is killed when the scope closes. Fails with why it couldn't be started.
 */
export const startCommand = Effect.fnUntraced(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Effect.fn.Return<RunningCommand, ToolError, Scope.Scope> {
  const handle = yield* spawner
    .spawn(
      ChildProcess.make("bash", ["-c", LAUNCH, "issue-agent-wait", command], {
        cwd,
        env,
        extendEnv: true,
        // A process group (and session) of its own, killed with everything in it.
        detached: true,
        killSignal: "SIGKILL",
        // The server's end of the watchdog's pipe: held open, never written.
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      }),
    )
    .pipe(Effect.mapError((e) => ToolError.other(`running the command in ${cwd}: ${e.message}`)))
  const tail = yield* Ref.make<Tail>({ bytes: new Uint8Array(0), total: 0 })
  const reading = yield* handle.stdout.pipe(
    Stream.runForEach((chunk) => Ref.update(tail, (t) => append(t, chunk))),
    Effect.ignore,
    Effect.forkScoped,
  )
  const exited = Effect.gen(function* () {
    const code = yield* handle.exitCode.pipe(
      Effect.map((c): number | null => Number(c)),
      // Ended by a signal.
      Effect.orElseSucceed(() => null),
    )
    // Killed after the shell exits, as the group goes with what's left in it; then its output ends.
    yield* Effect.ignore(handle.kill({ killSignal: "SIGKILL" }))
    yield* Fiber.await(reading)
    return { code, output: tailText(yield* Ref.get(tail)) }
  })
  const running: RunningCommand = { exited, soFar: Effect.map(Ref.get(tail), tailText) }
  return running
})
