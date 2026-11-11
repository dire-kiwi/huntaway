import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import type { Scope } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { tempDir, TestBoard } from "@huntaway/testing"
import { Status } from "@huntaway/contracts"
import type { Project, Task } from "@huntaway/contracts"
import { Reactor } from "../lifecycle/Reactor.ts"
import { Actor } from "../platform/Changes.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { StatusScripts } from "./StatusScripts.ts"
import { runScript } from "./worktree/scripts.ts"

// huntaway's integrations/status_script.test.ts: a project's scripts on a task's status changes, run by the reactor in
// the background, a task's in order.

type Needs =
  | Tasks
  | Projects
  | Profiles
  | Threads
  | Reactor
  | StatusScripts
  | ServerConfig
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope
const run = <A, E>(effect: Effect.Effect<A, E, Needs>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

const read = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(Effect.orDie)

/** A project on a folder that isn't a repository, and a task in it. */
const projectAndTask = Effect.gen(function* () {
  const dir = yield* tempDir
  const profile = yield* (yield* Profiles).create({ name: "p" }).pipe(Effect.orDie)
  const project = yield* (yield* Projects).create({ profile_id: profile.id, name: "x", key: "X", repo_path: dir }).pipe(Effect.orDie)
  const task = yield* (yield* Tasks).create({ project_id: project.id, title: "Do it" }, Actor.user).pipe(Effect.orDie)
  return { dir: project.repo_path, project, task }
})

const move = (task: Task, status: Status) => Effect.flatMap(Tasks, (tasks) => tasks.change(task.id, () => ({ status }), Actor.board)).pipe(Effect.orDie)
const rename = (task: Task, title: string) => Effect.flatMap(Tasks, (tasks) => tasks.change(task.id, () => ({ title }), Actor.board)).pipe(Effect.orDie)
const update = (project: Project, patch: Parameters<Projects["Service"]["update"]>[1]) =>
  Effect.flatMap(Projects, (projects) => projects.update(project.id, patch)).pipe(Effect.orDie)
/** Every change handled, and the scripts they queued run. */
const settled = Effect.andThen(
  Effect.flatMap(Reactor, (r) => r.idle),
  Effect.flatMap(StatusScripts, (s) => s.idle),
)
const notices = (task: Task) =>
  Effect.map(Effect.flatMap(Threads, (t) => t.stored(task.id)).pipe(Effect.orDie), (s) =>
    s.entries.flatMap((e) => (e.item.type === "notice" ? [{ text: e.item.text, detail: e.item.detail }] : [])),
  )

describe("StatusScripts", () => {
  it.live("runs the status script for each status change, in order", () =>
    run(
      Effect.gen(function* () {
        const { dir, project, task } = yield* projectAndTask
        const log = `${dir}/log`
        yield* update(project, { status_script: `echo "$IA_TASK_KEY $IA_OLD_STATUS $IA_NEW_STATUS $PWD" >> ${log}\necho moved` })
        yield* move(task, "in_progress")
        // Not a status change.
        yield* rename(task, "Renamed")
        yield* move(task, "in_progress")
        yield* move(task, "in_review")
        yield* move(task, "done")
        yield* settled
        const key = `X-${task.number}`
        assert.strictEqual(yield* read(log), `${key} todo in_progress ${dir}\n${key} in_progress in_review ${dir}\n${key} in_review done ${dir}\n`)
        let ev = yield* notices(task)
        assert.strictEqual(ev.length, 3)
        assert.deepStrictEqual(ev[0], { text: "Status script ran (To do → In progress)", detail: "moved" })
        // A failing script says so in the thread.
        yield* update(project, { status_script: "echo nope >&2; exit 3" })
        yield* move(task, "todo")
        yield* settled
        ev = yield* notices(task)
        assert.strictEqual(ev.at(-1)?.text, "Status script failed (Done → To do)")
        assert.include(ev.at(-1)?.detail, "nope")
      }),
    ),
  )

  it.live("runs a column's script when a task moves into its column, after the status script", () =>
    run(
      Effect.gen(function* () {
        const { dir, project, task } = yield* projectAndTask
        const log = `${dir}/log`
        yield* update(project, { status_scripts: { done: `echo "done $IA_OLD_STATUS" >> ${log}`, in_review: `echo review >> ${log}` } })
        for (const s of ["in_progress", "in_review", "in_progress", "done"] as const) yield* move(task, s)
        yield* settled
        assert.strictEqual(yield* read(log), "review\ndone in_progress\n")
        assert.deepStrictEqual(
          (yield* notices(task)).map((e) => e.text),
          ["In review script ran (In progress → In review)", "Done script ran (In progress → Done)"],
        )
        // The status script runs too, before the column's.
        yield* update(project, { status_script: `echo any >> ${log}` })
        yield* move(task, "in_review")
        yield* move(task, "todo")
        yield* settled
        assert.strictEqual(yield* read(log), "review\ndone in_progress\nany\nreview\nany\n")
      }),
    ),
  )

  it.live("runs nothing without a script", () =>
    run(
      Effect.gen(function* () {
        const { task } = yield* projectAndTask
        yield* move(task, "in_progress")
        yield* settled
        assert.deepStrictEqual(yield* notices(task), [])
      }),
    ),
  )

  it.live("runs changes made at once in the order they were made", () =>
    run(
      Effect.gen(function* () {
        const { dir, project, task } = yield* projectAndTask
        const log = `${dir}/log`
        yield* update(project, { status_script: `echo "$IA_OLD_STATUS $IA_NEW_STATUS" >> ${log}` })
        const statuses = Status.literals
        // Several movers at once, each with its own sequence.
        yield* Effect.forEach(
          [0, 1, 2, 3],
          (i) =>
            Effect.forEach(
              Array.from({ length: 25 }, (_, n) => statuses[(i * 3 + n) % statuses.length] ?? "todo"),
              (s) => Effect.andThen(move(task, s), Effect.yieldNow),
              { concurrency: 1 },
            ),
          { concurrency: 4 },
        )
        yield* settled
        // Each script starts where the one before it left off, and the last ends where the task is.
        const text = yield* read(log)
        let at = "todo"
        const lines = text.split("\n").filter((l) => l !== "")
        for (const line of lines) {
          const [old, next] = line.split(" ")
          assert.strictEqual(old, at, `out of order:\n${text}`)
          at = next ?? ""
        }
        assert.isTrue(lines.length > 10)
        assert.strictEqual(at, (yield* (yield* Tasks).get(task.id)).status)
      }),
    ),
  )

  it.live("stops a script that runs over, with what it started", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* tempDir
        const config = yield* ServerConfig
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const script = `sleep 600 & echo $! > ${dir}/pid; echo started; wait`
        const e = yield* Effect.flip(runScript({ spawner, agentEnv: config.agentEnv }, script, dir, [], "500 millis"))
        assert.include(e.reason, "stopped it")
        assert.include(e.reason, "started")
        const pid = (yield* read(`${dir}/pid`)).trim()
        // Killed with its group: gone, or a zombie until it's reaped.
        const stat = yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(`/proc/${pid}/stat`)).pipe(Effect.orElseSucceed(() => ""))
        assert.isTrue(stat === "" || stat.includes(") Z "), `sleep ${pid} is still running: ${stat}`)
      }),
    ),
  )
})
