import { assert, describe, it } from "@effect/vitest"
import { spawn } from "node:child_process"
import { Deferred, Effect, Exit, FileSystem, Layer } from "effect"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import { fakeAgent, fakeTask, TestRuns } from "@huntaway/testing"
import { Timestamp } from "@huntaway/contracts"
import type { TaskId, TaskServer } from "@huntaway/contracts"
import { Leftovers } from "../tasks/Leftovers.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { leftRunning, parseStat, parseTcp, sharedSince, shellsServe, shown, TASK_ENV, taskOf } from "./devServers/proc.ts"
import type { LeftoverProc } from "../tasks/Leftovers.ts"
import { DevServers, SUPPORTED } from "./DevServers.ts"

// The old servers.test.ts (HA-405): reading /proc's tables, and finding a task's server and stopping it, against real
// processes on a free port. Each test signals only the servers it started.

const listed = (port: number, pid: number, since: string, address = "127.0.0.1"): TaskServer => ({
  port,
  address,
  pid,
  pgid: pid,
  command: "x",
  since: Timestamp.make(since),
  detached: true,
})

/** A process as `Leftovers` lists it. */
const proc = (pid: number, ppid: number, argv: ReadonlyArray<string>): LeftoverProc => ({
  pid,
  ppid,
  pgid: pid,
  uid: 1000,
  start: "1",
  argv,
  cmd: argv.join(" "),
  exe: null,
})

describe("DevServers' /proc readers", () => {
  it("reads listening sockets from /proc/net/tcp", () => {
    const tcp = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:10EB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 100 0 0 10 0",
      "   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4243 1 0000000000000000 100 0 0 10 0",
      // Connected, not listening.
      "   2: 0100007F:10EB 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 4244 1 0000000000000000 20 4 30 10 -1",
    ].join("\n")
    assert.deepStrictEqual(parseTcp(tcp), [
      { inode: "4242", address: "127.0.0.1", port: 4331 },
      { inode: "4243", address: "0.0.0.0", port: 8080 },
    ])
    const tcp6 = [
      "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5001 1",
      "   1: 00000000000000000000000001000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5002 1",
      "   2: 0000000000000000FFFF00000100007F:0BB9 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5003 1",
    ].join("\n")
    assert.deepStrictEqual(
      parseTcp(tcp6).map((l) => [l.address, l.port]),
      [
        ["::", 8080],
        ["::1", 3000],
        ["127.0.0.1", 3001],
      ],
    )
  })

  it("reads the task from a process's environment", () => {
    assert.strictEqual(taskOf("PATH=/bin\0HUNTAWAY_TASK_ID=t1\0HOME=/h\0"), "t1")
    assert.strictEqual(taskOf("PATH=/bin\0HUNTAWAY_TASK_ID_X=t1\0"), null)
    assert.strictEqual(taskOf(""), null)
  })

  it("tells whether each of an agent's background shells, a session of its own, has a process listening (HA-409)", () => {
    assert.deepStrictEqual(parseStat("42 (node (x) y) S 7 42 40 0 -1"), { ppid: 7, pgid: 42, sid: 40 })
    const agent = 100
    const procs = [
      // Its MCP server, in its own session: not a shell.
      { pid: 101, ppid: agent, sid: agent, sockets: [] },
      // A shell, and the dev server under it, which listens.
      { pid: 200, ppid: agent, sid: 200, sockets: [] },
      { pid: 201, ppid: 200, sid: 200, sockets: ["9", "10"] },
    ]
    assert.isTrue(shellsServe(procs, new Set(["10"]), agent))
    assert.isFalse(shellsServe(procs, new Set(["11"]), agent))
    // A second shell that listens on nothing.
    assert.isFalse(shellsServe([...procs, { pid: 300, ppid: agent, sid: 300, sockets: ["9"] }], new Set(["10"]), agent))
    // No shells at all.
    assert.isFalse(shellsServe(procs.slice(0, 1), new Set(["10"]), agent))
  })

  it("stops only what a task's agents left running: never the board, a board's server or a shim, nor what is under them", () => {
    const procs = [
      proc(10, 1, ["systemd", "--user"]),
      // The board, started by an agent of the task, and what it started.
      proc(20, 10, ["node", "main.ts", "serve"]),
      proc(21, 20, ["git", "status"]),
      // Another board, and a live run's shim, agent and shell.
      proc(30, 10, ["/opt/huntaway", "serve", "--data-dir", "/d"]),
      proc(40, 1, ["/x/ia-shim", "/d/runs/r", "--", "claude"]),
      proc(41, 40, ["claude"]),
      proc(42, 41, ["bash", "-c", "pnpm dev"]),
      // A dev server whose agent is gone, and another task's.
      proc(50, 1, ["node", "vite"]),
      proc(60, 1, ["node", "vite"]),
    ]
    const named = new Map(procs.map((p) => [p.pid, p.pid === 60 ? "other" : "t"] as const))
    assert.deepStrictEqual(
      leftRunning(procs, named, "t", 20, new Set()).map((p) => p.pid),
      [50],
    )
    assert.deepStrictEqual(leftRunning(procs, named, "t", 20, new Set([50])), [])
  })

  it("keeps when a server was first seen, one per port, and says when nothing changed", () => {
    const before = [listed(3000, 1, "a")]
    assert.strictEqual(shown(before, [listed(3000, 1, "b")]), null)
    assert.deepStrictEqual(shown(before, [listed(4000, 2, "b"), listed(3000, 1, "b"), listed(3000, 1, "b", "::")]), [
      listed(3000, 1, "a"),
      listed(4000, 2, "b"),
    ])
    assert.deepStrictEqual(shown(before, []), [])
    // HE-85: of a port's, one reached as localhost, whichever was found first.
    assert.deepStrictEqual(shown([], [listed(3000, 1, "a", "192.168.1.5"), listed(3000, 2, "a", "0.0.0.0")]), [listed(3000, 2, "a", "0.0.0.0")])
    assert.deepStrictEqual(shown([], [listed(3000, 1, "a", "192.168.1.5")]), [listed(3000, 1, "a", "192.168.1.5")])
  })

  it("keeps that a port is shared with tailcat, by port", () => {
    const forwarded = Timestamp.make("2026-11-23T01:00:00.000Z")
    const before = [sharedSince(listed(3000, 1, "a"), forwarded)]
    assert.strictEqual(shown(before, [listed(3000, 1, "b")]), null)
    // Another process on the port: still shared (tailcat serves the port).
    assert.deepStrictEqual(shown(before, [listed(3000, 2, "b"), listed(4000, 3, "b")]), [sharedSince(listed(3000, 2, "b"), forwarded), listed(4000, 3, "b")])
  })
})

const TestLive = DevServers.layer.pipe(Layer.provideMerge(Layer.mergeAll(TaskRepo.layer, Leftovers.layer)), Layer.provideMerge(TestRuns()))

/**
 * A server on a free port started for `task`, in a process group of its own (`detached`) or the test's, listening on
 * each of `hosts` in turn (a socket each, on one port); killed with the scope.
 */
const server = (task: TaskId, detached: boolean, hosts: ReadonlyArray<string> = ["127.0.0.1"]) =>
  Effect.gen(function* () {
    const port = yield* Deferred.make<number, string>()
    const exited = yield* Deferred.make<void>()
    const script = `/* dev-server */ const net = require('node:net'); const hosts = [${hosts.map((h) => `'${h}'`).join(", ")}];
const next = (i, port) => i === hosts.length ? console.log('port ' + port) : net.createServer().listen(port, hosts[i], function () { next(i + 1, this.address().port) });
next(0, 0)`
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const p = spawn(process.execPath, ["-e", script], { detached, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, [TASK_ENV]: task } })
        let out = ""
        p.stdout.on("data", (d: Buffer) => {
          out += d.toString()
          const m = /port (\d+)/.exec(out)
          if (m !== null) Deferred.doneUnsafe(port, Exit.succeed(Number(m[1])))
        })
        p.on("exit", () => {
          Deferred.doneUnsafe(port, Exit.fail("the server exited"))
          Deferred.doneUnsafe(exited, Exit.void)
        })
        return p
      }),
      (p) =>
        Effect.sync(() => {
          if (p.exitCode !== null || p.signalCode !== null || p.pid === undefined) return
          try {
            process.kill(p.pid, "SIGKILL")
          } catch {
            // Gone already.
          }
        }),
    )
    return { pid: child.pid ?? 0, port: yield* Deferred.await(port), exited: Deferred.await(exited) }
  })

const servers = (task: TaskId) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo
    return (yield* repo.get(task))?.servers ?? []
  })

const test = <A, E>(name: string, body: Effect.Effect<A, E, DevServers | TaskRepo | FileSystem.FileSystem | Scope.Scope | Layer.Success<typeof TestLive>>) =>
  it.effect.skipIf(!SUPPORTED)(name, () => body.pipe(Effect.scoped, Effect.provide(TestLive)), 20_000)

describe("DevServers", () => {
  test(
    "finds a task's server and stops it",
    Effect.gen(function* () {
      const dev = yield* DevServers
      const task = yield* fakeTask
      const other = yield* fakeTask
      const s = yield* server(task, true)
      // Not looked for: no run, nor one that ended lately.
      yield* dev.scan
      assert.deepStrictEqual(yield* servers(task), [])
      // Its run ended, and left it going (nohup, setsid, or the run was stopped).
      yield* dev.notifyRunEnded(task)
      yield* dev.scan
      const [found] = yield* servers(task)
      assert.isDefined(found)
      assert.deepStrictEqual([found?.port, found?.address, found?.pid, found?.pgid, found?.detached], [s.port, "127.0.0.1", s.pid, s.pid, true])
      assert.isTrue(found?.command.includes("dev-server"), found?.command)
      assert.deepStrictEqual(yield* servers(other), [])
      // Still there: what's shown doesn't change.
      yield* TestClock.adjust("1 second")
      yield* dev.scan
      assert.strictEqual((yield* servers(task))[0]?.since, found?.since)
      // Another task's port isn't this one's to stop; nor is a port that isn't a number.
      const theirs = yield* Effect.flip(dev.stop(other, s.port))
      assert.deepStrictEqual([theirs._tag, theirs._tag === "NotFound" ? theirs.what : ""], ["NotFound", "server"])
      assert.strictEqual((yield* Effect.flip(dev.stop(task, 0)))._tag, "Invalid")
      yield* dev.stop(task, s.port)
      yield* s.exited
      yield* dev.scan
      // Listed until it's gone, then not.
      assert.deepStrictEqual(yield* servers(task), [])
      // Once the five minutes after its run are over, the task isn't looked at any more.
      yield* TestClock.adjust("5 minutes")
      const again = yield* server(task, true)
      yield* dev.scan
      assert.deepStrictEqual(yield* servers(task), [])
      assert.isAbove(again.port, 0)
    }),
  )

  test(
    "a server its live run started is listed as the run's, and stopping it leaves the agent's process group alone",
    Effect.gen(function* () {
      const dev = yield* DevServers
      const fs = yield* FileSystem.FileSystem
      // The run's agent is this test's process: the server, its child, is in its process group.
      const agent = yield* fakeAgent()
      yield* fs.writeFileString(`${agent.dir}/pid`, String(process.pid))
      const task = agent.run.task_id
      const s = yield* server(task, false)
      // Looked for while the run is live.
      yield* dev.scan
      const [found] = yield* servers(task)
      assert.deepStrictEqual([found?.port, found?.pid, found?.detached], [s.port, s.pid, false])
      // Its group is the agent's: only its own tree is signalled, and this process goes on.
      yield* dev.stop(task, s.port)
      yield* s.exited
      yield* dev.scan
      assert.deepStrictEqual(yield* servers(task), [])
    }),
  )

  test(
    "a server that stopped by itself is not stopped again, and goes from the list",
    Effect.gen(function* () {
      const dev = yield* DevServers
      const task = yield* fakeTask
      const s = yield* server(task, true)
      yield* dev.notifyRunEnded(task)
      yield* dev.scan
      assert.strictEqual((yield* servers(task)).length, 1)
      process.kill(s.pid, "SIGKILL")
      yield* s.exited
      const gone = yield* Effect.flip(dev.stop(task, s.port))
      assert.deepStrictEqual([gone._tag, gone._tag === "Conflict" ? gone.detail : ""], ["Conflict", "that server isn't running any more"])
      // The stop looked again.
      assert.deepStrictEqual(yield* servers(task), [])
    }),
  )

  test(
    "lists a server on another address and on localhost as on localhost, and one only on another address as on that (HE-85)",
    Effect.gen(function* () {
      const dev = yield* DevServers
      const task = yield* fakeTask
      // 127.0.0.2 is loopback, but not localhost's address: tailcat would need a mapping for it. Its socket comes first.
      const both = yield* server(task, true, ["127.0.0.2", "127.0.0.1"])
      const only = yield* server(task, true, ["127.0.0.2"])
      yield* dev.notifyRunEnded(task)
      yield* dev.scan
      assert.deepStrictEqual(
        (yield* servers(task)).map((s) => [s.port, s.address]).toSorted(([a], [b]) => Number(a) - Number(b)),
        [
          [both.port, "127.0.0.1"],
          [only.port, "127.0.0.2"],
        ].toSorted(([a], [b]) => Number(a) - Number(b)),
      )
    }),
  )
})
