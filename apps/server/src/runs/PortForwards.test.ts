import { assert, describe, it } from "@effect/vitest"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { Effect, Layer, Stream } from "effect"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import { fakeTask, TestRuns } from "@huntaway/testing"
import { Timestamp } from "@huntaway/contracts"
import type { BoardEvent, TaskId } from "@huntaway/contracts"
import { Events } from "../platform/Events.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { CHECK_EVERY, listenAddressOf, PortForwards, whyNotStarted } from "./PortForwards.ts"

// HE-81: sharing a task's dev server with tailcat, against fake tailcats: one that prints an address as `tailcat --json
// serve` does and stays, one that fails as tailcat does when it can't reach a relay, and none at all.

const dir = mkdtempSync(join(tmpdir(), "huntaway-tailcat-"))
const fake = (name: string, body: string) => {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/bash\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}
const argsFile = join(dir, "args")
const serving = fake(
  "tailcat",
  `echo "$*" >> ${argsFile}\necho "# 🐈 Server listening with new address: tcFAKE$$" >&2\necho '{"listenAddr":"tcFAKE'$$'"}'\nexec sleep 600`,
)
const failing = fake(
  "tailcat-fails",
  `echo "# Selected bootstrap relay region 302, San Francisco" >&2\necho "2026/11/23 11:53:01 couldn't reach the relay" >&2\nexit 1`,
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

const test = <A, E>(
  name: string,
  tailcatBin: string | null,
  body: Effect.Effect<A, E, PortForwards | TaskRepo | Scope.Scope | Layer.Success<ReturnType<typeof live>>>,
) => it.effect(name, () => body.pipe(Effect.scoped, Effect.provide(live(tailcatBin))), 20_000)

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
  test(
    "shares a task's server once, until the task no longer lists it",
    serving,
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
      assert.include(readFileSync(argsFile, "utf8"), "--json serve --key=new 4173")
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

  test(
    "shows the share ended when tailcat exits, and asks again for a new one",
    serving,
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

  test(
    "shows no server shared as the board starts",
    null,
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

  test(
    "says what tailcat said when it doesn't start",
    failing,
    Effect.gen(function* () {
      const forwards = yield* PortForwards
      const task = yield* fakeTask
      yield* listOn(task, [5000])
      const e = yield* Effect.flip(forwards.forward(task, 5000))
      assert.deepStrictEqual([e._tag, e._tag === "Unavailable" ? e.reason : ""], ["Unavailable", "tailcat: 2026/11/23 11:53:01 couldn't reach the relay"])
    }),
  )

  test(
    "says tailcat isn't installed",
    null,
    Effect.gen(function* () {
      const forwards = yield* PortForwards
      const task = yield* fakeTask
      yield* listOn(task, [5000])
      const e = yield* Effect.flip(forwards.forward(task, 5000))
      assert.match(e._tag === "Unavailable" ? e.reason : e._tag, /tailcat isn't installed on this host/)
    }),
  )
})
