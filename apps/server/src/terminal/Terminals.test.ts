import { spawnSync } from "node:child_process"
import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Fiber, Layer, Queue, Ref } from "effect"
import type { Scope } from "effect"
import { Socket } from "effect/socket"
import { TestClock } from "effect/testing"
import { fakeSocket, gitRepo, TestBoard } from "@huntaway/testing"
import type { SentFrame } from "@huntaway/testing"
import { TaskId } from "@huntaway/contracts"
import type { Project, Task } from "@huntaway/contracts"
import { Worktrees } from "../git/Worktrees.ts"
import { Reactor } from "../lifecycle/Reactor.ts"
import { Actor } from "../platform/Changes.ts"
import { DataDir } from "../platform/DataDir.ts"
import { Proc } from "../platform/Proc.ts"
import { SERVE_ENV } from "../platform/ServerConfig.ts"
import type { RunOptions } from "../platform/Proc.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { TaskDeletion } from "../runs/TaskDeletion.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { TaskTmp } from "../tasks/TaskTmp.ts"
import { READY } from "./attach.ts"
import { Pty } from "./Pty.ts"
import { Terminals, TICKET_MS, TOOL_LEASE_MS } from "./Terminals.ts"
import { socketPath } from "./tmux.ts"

// Terminals on a real tmux (and the pty helper on python3), on the data folder's own tmux server, which each test
// ends. The old server had no test of its own for terminals beyond its browser checks (tests/ui/terminal.test.mjs,
// ported to apps/web/tests/ui) and the scrubbed environment (agent/runs.test.ts, `tmux_command`), whose case is here.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

const hasTmux = spawnSync("tmux", ["-V"]).status === 0 && spawnSync("python3", ["-V"]).status === 0

/** Every command the terminals ran: tmux through `Proc`, and the pty's (`tmux attach-session`) through `Pty`. */
type Runs = ReadonlyArray<{ readonly command: string; readonly args: ReadonlyArray<string>; readonly env: RunOptions["env"] }>
class Ran extends Context.Service<Ran, Ref.Ref<Runs>>()("huntaway-server/terminal/Terminals.test/Ran") {}

const Recording = Layer.effect(
  Proc,
  Effect.gen(function* () {
    const real = yield* Proc
    const ran = yield* Ran
    return Proc.of({
      run: (command, args, options) =>
        Effect.andThen(
          Ref.update(ran, (l) => [...l, { command, args, env: options?.env }]),
          real.run(command, args, options),
        ),
    })
  }),
)
const RecordingPty = Layer.effect(
  Pty,
  Effect.gen(function* () {
    const real = yield* Pty
    const ran = yield* Ran
    return Pty.of({
      spawn: (command, args, options) =>
        Effect.andThen(
          Ref.update(ran, (l) => [...l, { command, args, env: options.env }]),
          real.spawn(command, args, options),
        ),
    })
  }),
)

/** The board's, but for its `Terminals`: one of the same over `Proc` and `Pty` that record what they run. */
const board = Layer.merge(TestBoard(), Layer.effect(Ran, Ref.make<Runs>([])))
const layer = Layer.fresh(Terminals.layer).pipe(
  Layer.provide(Layer.mergeAll(Recording, RecordingPty.pipe(Layer.provide(Pty.layer)))),
  Layer.provideMerge(board),
)

type Env = Layer.Success<typeof board> | Scope.Scope
/** With the data folder's tmux server ended after, whatever happened. */
const run = <A, E>(effect: Effect.Effect<A, E, Env>) =>
  Effect.gen(function* () {
    const proc = yield* Proc
    const sock = socketPath((yield* DataDir).root)
    yield* Effect.addFinalizer(() => proc.run("tmux", ["-S", sock, "kill-server"]).pipe(Effect.ignore))
    return yield* effect
  }).pipe(Effect.scoped, Effect.provide(layer))

const project = Effect.gen(function* () {
  const repo = yield* gitRepo
  const profile = yield* (yield* Profiles).create({ name: "p" })
  return yield* (yield* Projects).create({ profile_id: profile.id, name: "x", key: "X", repo_path: repo, base_branch: "main" })
}).pipe(Effect.orDie)
const newTask = (p: Project, title = "Do it") => Effect.flatMap(Tasks, (tasks) => tasks.create({ project_id: p.id, title }, Actor.user)).pipe(Effect.orDie)

const text = (frame: SentFrame) =>
  frame instanceof Uint8Array ? new TextDecoder().decode(frame) : Socket.isCloseEvent(frame) ? `<close ${frame.code}>` : frame

/** The terminal of `task` (or its `tool`) attached to a socket in memory, in the background. */
const attach = (task: Task, tool: string | null = null) =>
  Effect.gen(function* () {
    const terminals = yield* Terminals
    const ticket = yield* terminals.open(task.id, tool)
    const s = yield* fakeSocket
    const fiber = yield* terminals.serve(ticket, { cols: 400, rows: 30 }, Effect.succeed(s.socket)).pipe(Effect.scoped, Effect.forkChild)
    assert.strictEqual(yield* Queue.take(s.sent), READY)
    /** Output until it has `want` (the screen as tmux draws it, escapes and all); the close, if one comes first. */
    const until = (want: string) =>
      Effect.gen(function* () {
        let seen = ""
        while (!seen.includes(want)) {
          const frame = yield* Queue.take(s.sent)
          if (Socket.isCloseEvent(frame)) return frame
          seen += text(frame)
        }
        return seen
      })
    /** The close the server ended the socket with, past the output before it. */
    const closed = Effect.gen(function* () {
      for (;;) {
        const frame = yield* Queue.take(s.sent)
        if (Socket.isCloseEvent(frame)) return { code: frame.code, reason: frame.reason }
      }
    })
    const type = (line: string) => s.send(new TextEncoder().encode(line))
    return { ...s, fiber, until, closed, type, ticket }
  })

const sessions = Effect.gen(function* () {
  const out = yield* (yield* Proc).run("tmux", ["-S", socketPath((yield* DataDir).root), "list-sessions", "-F", "#{session_name}"]).pipe(Effect.orDie)
  return out.code === 0
    ? out.stdout
        .split("\n")
        .filter((l) => l !== "")
        .toSorted()
    : []
})

describe.skipIf(!hasTmux)("Terminals", () => {
  it.live("a task's shell: made where the task works, attached, typed into, and ended with its socket closed 1000", () =>
    run(
      Effect.gen(function* () {
        const terminals = yield* Terminals
        const p = yield* project
        const task = yield* newTask(p)
        const before = yield* terminals.status(task.id, null)
        assert.deepStrictEqual(before, { available: true, running: false, cwd: p.repo_path, reason: null, tool: null })
        const t = yield* attach(task)
        assert.isTrue((yield* terminals.status(task.id, null)).running)
        yield* t.type('echo "OK:$PWD:$TMPDIR:$COLORTERM"\r')
        const tmp = (yield* TaskTmp).dir(task)
        const out = yield* t.until(`OK:${p.repo_path}:${tmp}:truecolor`)
        assert.isString(out)
        yield* terminals.kill(task.id, null)
        assert.deepStrictEqual(yield* t.closed, { code: 1000, reason: "Session ended" })
        yield* Fiber.join(t.fiber)
        assert.isFalse((yield* terminals.status(task.id, null)).running)
      }),
    ),
  )

  it.live("every tmux it runs is the data folder's own server, by its socket's path: never the default one, nor the live board's", () =>
    run(
      Effect.gen(function* () {
        const p = yield* project
        const task = yield* newTask(p)
        const t = yield* attach(task)
        yield* t.type("exit\r")
        assert.strictEqual((yield* t.closed).code, 1000)
        const sock = socketPath((yield* DataDir).root)
        assert.isTrue(sock.startsWith(`${(yield* DataDir).root}/`))
        assert.notInclude(sock, "/issue-agent/")
        assert.notMatch(sock, /\/tmux-\d+\/default$/)
        const ran = (yield* Ref.get(yield* Ran)).filter((r) => r.command === "tmux" || r.args.includes("tmux"))
        assert.isAbove(ran.length, 3)
        for (const r of ran) {
          // `tmux -V` asks the program, not a server.
          if (r.args.length === 1 && r.args[0] === "-V") continue
          const args = r.command === "tmux" ? r.args : r.args.slice(r.args.indexOf("tmux") + 1)
          assert.deepStrictEqual(args.slice(0, 2), ["-S", sock], args.join(" "))
          assert.notInclude(args, "-L")
          // The tmux the server may run inside isn't the one these commands reach, and the shells don't get the server's
          // own settings and secrets (the old agent/runs.test.ts `tmux_command` case).
          for (const name of ["TMUX", ...SERVE_ENV]) assert.isTrue(r.env !== undefined && name in r.env && r.env[name] === undefined, name)
        }
      }),
    ),
  )

  it.live("a ticket opens one socket, once; a tool's session runs the tool; killAll ends the shell and the tools", () =>
    run(
      Effect.gen(function* () {
        const terminals = yield* Terminals
        yield* (yield* HostSettings).update({ terminal_tools: [{ id: "lg", name: "lazy", command: "printf 'TOOL-%s\\n' \"$IA_TOOL_NAME\"; exec cat" }] })
        const p = yield* project
        const task = yield* newTask(p)
        const other = yield* newTask(p, "Other")
        const tool = yield* attach(task, "lg")
        assert.isString(yield* tool.until("TOOL-lazy"))
        const shell = yield* attach(task)
        const keep = yield* attach(other)
        assert.deepStrictEqual((yield* terminals.status(task.id, "lg")).tool, {
          id: "lg",
          name: "lazy",
          command: "printf 'TOOL-%s\\n' \"$IA_TOOL_NAME\"; exec cat",
        })
        // A ticket opens one socket only.
        const again = yield* fakeSocket
        const used = yield* Effect.flip(terminals.serve(tool.ticket, { cols: 80, rows: 24 }, Effect.succeed(again.socket)).pipe(Effect.scoped))
        assert.strictEqual(used._tag, "TicketInvalid")
        assert.strictEqual((yield* Effect.flip(terminals.open(task.id, "nope")))._tag, "ToolNotFound")
        // A task that isn't there (the old routes' 404s).
        const gone = TaskId.make("gone")
        for (const e of [terminals.status(gone, null), terminals.open(gone, null), terminals.kill(gone, null), terminals.keepalive(gone, "lg")])
          assert.strictEqual((yield* Effect.flip(e))._tag, "TaskNotFound")
        assert.deepStrictEqual(yield* sessions, [`ia-${other.id}`, `ia-${task.id}`, `ia-${task.id}~lg`].toSorted())
        yield* terminals.killAll(task.id)
        assert.strictEqual((yield* tool.closed).code, 1000)
        assert.strictEqual((yield* shell.closed).code, 1000)
        assert.deepStrictEqual(yield* sessions, [`ia-${other.id}`])
        yield* keep.hangUp
        yield* Fiber.join(keep.fiber)
        // The board went: the session stays.
        assert.deepStrictEqual(yield* sessions, [`ia-${other.id}`])
      }),
    ),
  )

  it.effect("tickets expire after a minute; the reaper ends tool sessions no board keeps, and the sessions of tasks that are gone", () =>
    run(
      Effect.gen(function* () {
        const terminals = yield* Terminals
        const proc = yield* Proc
        const sock = socketPath((yield* DataDir).root)
        yield* (yield* HostSettings).update({ terminal_tools: [{ id: "c", name: "cat", command: "exec cat" }] })
        const p = yield* project
        const task = yield* newTask(p)
        const late = yield* terminals.open(task.id, null)
        yield* TestClock.adjust(TICKET_MS + 1)
        const s = yield* fakeSocket
        assert.strictEqual(
          (yield* Effect.flip(terminals.serve(late, { cols: 80, rows: 24 }, Effect.succeed(s.socket)).pipe(Effect.scoped)))._tag,
          "TicketInvalid",
        )
        // A tool's session and the shell's, with no board attached.
        for (const tool of ["c", null]) {
          const t = yield* attach(task, tool)
          yield* t.hangUp
          yield* Fiber.join(t.fiber)
        }
        // A session of a task that's gone (deleted while the server was down, or with its project).
        yield* proc.run("tmux", ["-S", sock, "new-session", "-d", "-s", "ia-gone", "--", "/bin/sh", "-c", "exec cat"]).pipe(Effect.orDie)
        yield* terminals.reap
        assert.deepStrictEqual(yield* sessions, [`ia-${task.id}`, `ia-${task.id}~c`].toSorted())
        // A board keeps the tool open.
        yield* TestClock.adjust(TOOL_LEASE_MS - 1000)
        yield* terminals.keepalive(task.id, "c")
        yield* TestClock.adjust(TOOL_LEASE_MS - 1000)
        yield* terminals.reap
        assert.deepStrictEqual(yield* sessions, [`ia-${task.id}`, `ia-${task.id}~c`].toSorted())
        // Then nobody does; the shell's session is never reaped.
        yield* TestClock.adjust(2000)
        yield* terminals.reap
        assert.deepStrictEqual(yield* sessions, [`ia-${task.id}`])
      }),
    ),
  )

  it.live("a task's terminals end when it's done, when it's deleted, and when its worktree is torn down", () =>
    run(
      Effect.gen(function* () {
        const tasks = yield* Tasks
        const reactor = yield* Reactor
        const p = yield* project
        const done = yield* newTask(p, "Done")
        const deleted = yield* newTask(p, "Deleted")
        const torn = yield* newTask(p, "Torn down")
        yield* (yield* Worktrees).setup(torn.id)
        for (const t of [done, deleted, torn]) yield* Effect.flatMap(attach(t), (a) => Effect.andThen(a.hangUp, Fiber.join(a.fiber)))
        assert.strictEqual((yield* sessions).length, 3)
        yield* tasks.change(done.id, () => ({ status: "done" }), Actor.board)
        yield* (yield* TaskDeletion).delete(deleted.id, { deleteBranch: false }, Actor.user)
        yield* reactor.idle
        assert.deepStrictEqual(yield* sessions, [`ia-${torn.id}`])
        yield* (yield* Worktrees).teardown(torn.id, { force: true, deleteBranch: false })
        assert.deepStrictEqual(yield* sessions, [])
      }).pipe(Effect.orDie),
    ),
  )
})
