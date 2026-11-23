import { assert, describe, it } from "@effect/vitest"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { Effect, Fiber, Layer, Stream } from "effect"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import { fakeTask, TestRuns } from "@huntaway/testing"
import { Timestamp } from "@huntaway/contracts"
import type { BoardEvent, TaskId } from "@huntaway/contracts"
import { Events } from "../platform/Events.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { CHECK_EVERY, listenAddressOf, PortForwards, whyNotStarted } from "./PortForwards.ts"

// HE-81: sharing a task's dev server with tailcat, against fake tailcats: one that prints an address as `tailcat --json
// serve` does and stays, one that fails as tailcat does when it can't reach a relay, and none at all. HE-84: one slow to
// start beside a quick one, and one whose reason comes after it exits.

/** A folder for a test's fake tailcats, removed after it. */
const fakesDir = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "huntaway-tailcat-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

/** A fake tailcat `name` in `dir`, running `body`. */
const fake = (dir: string, name: string, body: string) => {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/bash\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}
/** Where the fakes write the arguments they're started with, a line each. */
const argsFile = (dir: string) => join(dir, "args")
const serving = (dir: string) =>
  fake(
    dir,
    "tailcat",
    `echo "$*" >> ${argsFile(dir)}\necho "# 🐈 Server listening with new address: tcFAKE$$" >&2\necho '{"listenAddr":"tcFAKE'$$'"}'\nexec sleep 600`,
  )
const failing = (dir: string) =>
  fake(dir, "tailcat-fails", `echo "# Selected bootstrap relay region 302, San Francisco" >&2\necho "2026/11/23 11:53:01 couldn't reach the relay" >&2\nexit 1`)
/**
 * One whose reason comes after it exits, as the end of its stderr may be read after its exit is seen: written by a
 * process in a session of its own (so the watchdog's kill doesn't reach it) once tailcat is gone.
 */
const failingLate = (dir: string) =>
  fake(
    dir,
    "tailcat-fails-late",
    `setsid bash -c 'touch "$2"; while kill -0 "$1" 2>/dev/null; do sleep 0.01; done; sleep 0.2; echo "# no relay would take us" >&2' _ $$ ${join(dir, "late")} </dev/null >/dev/null &
echo "# Selected bootstrap relay region 302, San Francisco" >&2
# Not before that's in its own session, out of reach of the kill of tailcat's process group as it exits.
while [ ! -e ${join(dir, "late")} ]; do sleep 0.01; done
exit 1`,
  )
/** Port 5101's is slow: it prints its address once sent SIGUSR1 (its pid in `slow.pid`). Every other port's is quick. */
const slowOn5101 = (dir: string) =>
  fake(
    dir,
    "tailcat-slow",
    `echo "$4" >> ${argsFile(dir)}
if [ "$4" != 5101 ]; then echo '{"listenAddr":"tcQUICK'$$'"}'; exec sleep 600; fi
trap 'echo "{\\"listenAddr\\":\\"tcSLOW$$\\"}"' USR1
echo $$ > ${join(dir, "slow.pid")}
while :; do sleep 600 & wait $!; done`,
  )

const listOn = (task: TaskId, ports: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo
    const since = Timestamp.make("2026-11-23T00:00:00.000Z")
    const servers = ports.map((port) => ({ port, address: "127.0.0.1", pid: 1, pgid: 1, command: "vite", since, detached: false }))
    yield* repo.write(task, { servers }, since)
  })

/** What the task shows of its servers: port and since when it's shared. */
const shownShared = (task: TaskId): Effect.Effect<ReadonlyArray<readonly [number, string | null]>, never, TaskRepo> =>
  Effect.gen(function* () {
    const row = yield* (yield* TaskRepo).get(task)
    return (row?.servers ?? []).map((s) => [s.port, s.forwarded ?? null] as const)
  })

/** The task's `forwarded` on its first server, from its next task event. */
const nextShown = (live: Stream.Stream<BoardEvent>) =>
  live.pipe(
    Stream.filter((e) => e.type === "task"),
    Stream.map((e) => (e.type === "task" ? (e.task.servers[0]?.forwarded ?? null) : null)),
    Stream.runHead,
    Effect.map((o) => (o._tag === "Some" ? o.value : "no event")),
  )

/** Whether the process `pid` is there. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Whether the process `pid` is gone, after turns of the event loop (no sleep: tailcat's exit is real). */
const gone = (pid: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 10_000; i++) {
      yield* Effect.promise(() => setImmediate())
      if (!alive(pid)) return true
    }
    return false
  })

const live = (tailcatBin: string | null) =>
  PortForwards.layer.pipe(Layer.provideMerge(TaskRepo.layer), Layer.provideMerge(TestRuns(undefined, tailcatBin === null ? {} : { tailcatBin })))

/** A test of `body` with the fake tailcat `tailcat` makes in its folder (none, for null). */
const test = <A, E>(
  name: string,
  tailcat: ((dir: string) => string) | null,
  body: (dir: string) => Effect.Effect<A, E, PortForwards | TaskRepo | Scope.Scope | Layer.Success<ReturnType<typeof live>>>,
) =>
  it.effect(
    name,
    () => Effect.scoped(Effect.flatMap(fakesDir, (dir) => body(dir).pipe(Effect.scoped, Effect.provide(live(tailcat === null ? null : tailcat(dir)))))),
    20_000,
  )

/** Once `file` is there, after turns of the event loop (no sleep: the fake tailcat writing it is real). */
const appeared = (file: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 100_000; i++) {
      if (existsSync(file)) return readFileSync(file, "utf8")
      yield* Effect.promise(() => setImmediate())
    }
    return assert.fail(`${file} never appeared`)
  })

describe("tailcat's output", () => {
  it("reads the address from `tailcat --json serve`", () => {
    assert.strictEqual(listenAddressOf('{"listenAddr":"tcpGFwWCAniKg-_x9"}\n'), "tcpGFwWCAniKg-_x9")
    assert.strictEqual(listenAddressOf("# 🐈 Server listening with new address: tcX"), null)
    assert.strictEqual(listenAddressOf('{"listenAddr":"not an address"}'), null)
  })

  it("says why it didn't start", () => {
    assert.match(whyNotStarted(127, "", "tailcat"), /isn't installed on this host/)
    assert.strictEqual(whyNotStarted(1, "# Selected region\n2026 couldn't reach the relay\n\n", "tailcat"), "tailcat: 2026 couldn't reach the relay")
    assert.strictEqual(whyNotStarted(2, "", "tailcat"), "tailcat stopped with exit code 2 before it printed an address")
  })
})

describe("PortForwards", () => {
  test("shares a task's server once, until the task no longer lists it", serving, (dir) =>
    Effect.gen(function* () {
      const forwards = yield* PortForwards
      const task = yield* fakeTask
      yield* listOn(task, [4173])
      const watch = yield* (yield* Events).watch(undefined)
      const first = yield* forwards.forward(task, 4173)
      assert.match(first.address, /^tcFAKE\d+$/)
      assert.strictEqual(first.port, 4173)
      // The task shows it shared, since the share started, and every client is told.
      assert.isString(first.since)
      assert.deepStrictEqual(yield* shownShared(task), [[4173, first.since ?? null]])
      assert.strictEqual(yield* nextShown(watch.live), first.since)
      assert.include(readFileSync(argsFile(dir), "utf8"), "--json serve --key=new 4173")
      // Asked again: the same share.
      assert.deepStrictEqual(yield* forwards.forward(task, 4173), first)
      // A port the task doesn't list, and one that isn't a port.
      const other = yield* Effect.flip(forwards.forward(task, 4174))
      assert.deepStrictEqual([other._tag, other._tag === "NotFound" ? other.what : ""], ["NotFound", "server"])
      assert.strictEqual((yield* Effect.flip(forwards.forward(task, 0)))._tag, "Invalid")
      // Its server goes: so does tailcat, and the next share has a new address.
      const pid = Number(first.address.slice("tcFAKE".length))
      yield* listOn(task, [])
      yield* TestClock.adjust(CHECK_EVERY)
      assert.isTrue(yield* gone(pid))
      yield* listOn(task, [4173])
      const second = yield* forwards.forward(task, 4173)
      assert.notStrictEqual(second.address, first.address)
    }),
  )

  test("shows the share ended when tailcat exits, and asks again for a new one", serving, () =>
    Effect.gen(function* () {
      const forwards = yield* PortForwards
      const task = yield* fakeTask
      yield* listOn(task, [4180])
      const first = yield* forwards.forward(task, 4180)
      assert.deepStrictEqual(yield* shownShared(task), [[4180, first.since ?? null]])
      // A scan that missed the server and found it again wrote it without `forwarded`: shown shared again.
      yield* listOn(task, [4180])
      yield* TestClock.adjust(CHECK_EVERY)
      assert.deepStrictEqual(yield* shownShared(task), [[4180, first.since ?? null]])
      // tailcat exits on the host: the task no longer shows it shared.
      const watch = yield* (yield* Events).watch(undefined)
      process.kill(Number(first.address.slice("tcFAKE".length)), "SIGTERM")
      assert.isNull(yield* nextShown(watch.live))
      assert.deepStrictEqual(yield* shownShared(task), [[4180, null]])
      yield* TestClock.adjust("1 second")
      const second = yield* forwards.forward(task, 4180)
      assert.notStrictEqual(second.address, first.address)
      assert.deepStrictEqual(yield* shownShared(task), [[4180, second.since ?? null]])
    }),
  )

  test("shows no server shared as the board starts", null, () =>
    Effect.gen(function* () {
      const repo = yield* TaskRepo
      const task = yield* fakeTask
      const since = Timestamp.make("2026-11-23T00:00:00.000Z")
      const server = { port: 4190, address: "127.0.0.1", pid: 1, pgid: 1, command: "vite", since, detached: false }
      yield* repo.write(
        task,
        {
          servers: [
            { ...server, forwarded: since },
            { ...server, port: 4191 },
          ],
        },
        since,
      )
      yield* Layer.build(PortForwards.reset)
      assert.deepStrictEqual(yield* shownShared(task), [
        [4190, null],
        [4191, null],
      ])
    }),
  )

  test("says what tailcat said when it doesn't start", failing, () =>
    Effect.gen(function* () {
      const forwards = yield* PortForwards
      const task = yield* fakeTask
      yield* listOn(task, [5000])
      const e = yield* Effect.flip(forwards.forward(task, 5000))
      assert.deepStrictEqual([e._tag, e._tag === "Unavailable" ? e.reason : ""], ["Unavailable", "tailcat: 2026/11/23 11:53:01 couldn't reach the relay"])
    }),
  )

  test("says tailcat isn't installed", null, () =>
    Effect.gen(function* () {
      const forwards = yield* PortForwards
      const task = yield* fakeTask
      yield* listOn(task, [5000])
      const e = yield* Effect.flip(forwards.forward(task, 5000))
      assert.match(e._tag === "Unavailable" ? e.reason : e._tag, /tailcat isn't installed on this host/)
    }),
  )

  test("says tailcat's reason when the last of its stderr comes after it exits", failingLate, () =>
    Effect.gen(function* () {
      const forwards = yield* PortForwards
      const task = yield* fakeTask
      yield* listOn(task, [5000])
      const e = yield* Effect.flip(forwards.forward(task, 5000))
      assert.strictEqual(e._tag === "Unavailable" ? e.reason : e._tag, "tailcat: no relay would take us")
    }),
  )

  test("a slow start doesn't hold up another port's, and two asks of one port start one tailcat", slowOn5101, (dir) =>
    Effect.gen(function* () {
      const forwards = yield* PortForwards
      const task = yield* fakeTask
      const other = yield* fakeTask
      yield* listOn(task, [5101, 5102])
      yield* listOn(other, [5103])
      // Two clicks on the slow port, and its tailcat started.
      const first = yield* Effect.forkChild(forwards.forward(task, 5101))
      const second = yield* Effect.forkChild(forwards.forward(task, 5101))
      const pid = Number(yield* appeared(join(dir, "slow.pid")))
      // Meanwhile, the task's other port and another task's: no wait for it.
      assert.match((yield* forwards.forward(task, 5102)).address, /^tcQUICK\d+$/)
      assert.match((yield* forwards.forward(other, 5103)).address, /^tcQUICK\d+$/)
      // It prints its address: both clicks get it, from the one tailcat.
      process.kill(pid, "SIGUSR1")
      const a = yield* Fiber.join(first)
      assert.strictEqual(a.address, `tcSLOW${pid}`)
      assert.deepStrictEqual(yield* Fiber.join(second), a)
      assert.deepStrictEqual(
        readFileSync(argsFile(dir), "utf8")
          .split("\n")
          .filter((l) => l === "5101"),
        ["5101"],
      )
    }),
  )
})
