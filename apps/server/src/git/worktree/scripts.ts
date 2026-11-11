import { Duration, Effect, Stream } from "effect"
import type { PlatformError } from "effect"
import type { Project, Task } from "@huntaway/contracts"
import { ChildProcess } from "effect/process"
import type { ChildProcessSpawner } from "effect/process"
import { truncate } from "../paths.ts"
import { WorktreeFailed } from "./failed.ts"

// Running a project's scripts with bash (huntaway's git/worktree/scripts.ts; inventory 04, section 2.5): setup and
// teardown scripts in a worktree, status scripts in a worktree or the repository.

/**
 * How long a setup or teardown script may run (an install or a build, say): it holds the task's worktree lock
 * meanwhile, so one that hangs is stopped.
 */
export const SCRIPT_LIMIT = "30 minutes"

/** What a script runs with: the spawner, and the agents' environment (the server's without its own settings). */
export interface ScriptDeps {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
  readonly agentEnv: Readonly<Record<string, string | undefined>>
}

const decoder = new TextDecoder()

/** Chunks of output as one text. */
const joined = (chunks: ReadonlyArray<Uint8Array>): string => {
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.length
  }
  return decoder.decode(all)
}

/** Keeps what `s` prints in `into`. */
const keep = (into: Array<Uint8Array>) => (s: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  Stream.runForEach(s, (chunk) => Effect.sync(() => into.push(chunk)))

/**
 * Run `script` with `bash -c` in `cwd`, in a process group of its own, with `env` over the agents' environment, and
 * return what it printed (stdout, then stderr). One that runs over `limit` is stopped with everything it started
 * (`SIGKILL` to its group); one that fails fails with its status and the first 8,000 bytes of its output. What a script
 * that succeeded left running was started to outlive it, and is left alone.
 */
export const runScript = (deps: ScriptDeps, script: string, cwd: string, env: ReadonlyArray<readonly [string, string]>, limit: Duration.Input) =>
  Effect.scoped(
    Effect.gen(function* () {
      const out: Array<Uint8Array> = []
      const err: Array<Uint8Array> = []
      const handle = yield* deps.spawner
        .spawn(
          ChildProcess.make("bash", ["-c", script], {
            cwd,
            env: { ...deps.agentEnv, ...Object.fromEntries(env) },
            extendEnv: true,
            detached: true,
            killSignal: "SIGKILL",
            stdin: "ignore",
          }),
        )
        .pipe(Effect.mapError((e) => new WorktreeFailed({ reason: `failed to run script: ${e.message}` })))
      const log = () => joined([...out, ...err])
      const ran = yield* Effect.all([keep(out)(handle.stdout), keep(err)(handle.stderr), handle.exitCode], { concurrency: 3 }).pipe(
        Effect.map(([, , code]) => ({ _tag: "Exited", code: Number(code) }) as const),
        Effect.catch((e) => Effect.succeed({ _tag: "Signalled", reason: e.message } as const)),
        Effect.timeoutOrElse({ duration: limit, orElse: () => Effect.succeed({ _tag: "Over" } as const) }),
      )
      if (ran._tag === "Over") {
        yield* handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)
        return yield* new WorktreeFailed({
          reason: `script still running after ${Duration.format(Duration.fromInputUnsafe(limit))}; stopped it\n${truncate(log(), 8000)}`,
        })
      }
      if (ran._tag === "Signalled") return yield* new WorktreeFailed({ reason: `script exited with ${ran.reason}\n${truncate(log(), 8000)}` })
      if (ran.code !== 0) return yield* new WorktreeFailed({ reason: `script exited with exit status: ${ran.code}\n${truncate(log(), 8000)}` })
      // It finished: anything it left running in its group was started to outlive it.
      yield* handle.unref.pipe(Effect.ignore)
      return log()
    }),
  )

/** The setup and teardown scripts' variables. */
export const scriptEnv = (
  project: Pick<Project, "repo_path" | "key">,
  task: Pick<Task, "id" | "number">,
  wt: string,
  branch: string,
): ReadonlyArray<readonly [string, string]> => [
  ["IA_REPO_PATH", project.repo_path],
  ["IA_WORKTREE_PATH", wt],
  ["IA_BRANCH", branch],
  ["IA_TASK_ID", task.id],
  ["IA_TASK_NUMBER", String(task.number)],
  ["IA_PROJECT_KEY", project.key],
]
