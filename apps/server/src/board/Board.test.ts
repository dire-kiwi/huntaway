import { assert, layer } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import type { BoardMessage } from "@huntaway/contracts"
import { TestBoard, tempDir } from "@huntaway/testing"
import { Actor } from "../platform/Changes.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Board } from "./Board.ts"
import { Reactor } from "../lifecycle/Reactor.ts"

const kinds = (messages: ReadonlyArray<BoardMessage>) => messages.map((m) => (m.type === "task" ? `task:${m.task.title}` : m.type))

layer(TestBoard())("Board", (it) => {
  it.effect("hello, a snapshot of the board, then every change; a resume replays only what came after", () =>
    Effect.gen(function* () {
      const board = yield* Board
      const profiles = yield* Profiles
      const projects = yield* Projects
      const tasks = yield* Tasks
      const profile = yield* profiles.create({ name: "me" })
      const project = yield* projects.create({ profile_id: profile.id, repo_path: yield* tempDir, name: "Web" })
      const first = yield* tasks.create({ project_id: project.id, title: "First" }, Actor.user)

      // A fresh subscription: hello, then a snapshot with what is there.
      const opened = yield* board.watch(undefined).pipe(Stream.take(4), Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      const [hello, snapshot] = yield* board.watch(undefined).pipe(Stream.take(2), Stream.runCollect)
      assert.strictEqual(hello?.type, "hello")
      assert.strictEqual(snapshot?.type, "snapshot")
      if (snapshot?.type !== "snapshot" || hello?.type !== "hello") return
      assert.deepStrictEqual(
        snapshot.tasks.map((t) => t.key),
        ["WEB-1"],
      )
      assert.deepStrictEqual(
        snapshot.profiles.map((p) => p.name),
        ["me"],
      )
      assert.deepStrictEqual(
        snapshot.projects.map((p) => p.name),
        ["Web"],
      )

      // Changes after it arrive as events, in order.
      yield* tasks.create({ project_id: project.id, title: "Second" }, Actor.user)
      yield* tasks.update(first.id, { status: "in_progress" }, Actor.user)
      assert.deepStrictEqual(kinds(yield* Fiber.join(opened)), ["hello", "snapshot", "task:Second", "task:First"])

      // A resume from the snapshot's seq gets only the two events, no snapshot.
      const resumed = yield* board.watch({ boot: hello.boot, seq: snapshot.seq }).pipe(Stream.take(3), Stream.runCollect)
      assert.deepStrictEqual(kinds(resumed), ["hello", "task:Second", "task:First"])
      // A resume from another boot gets a snapshot.
      const other = yield* board.watch({ boot: "earlier", seq: snapshot.seq }).pipe(Stream.take(2), Stream.runCollect)
      assert.deepStrictEqual(kinds(other), ["hello", "snapshot"])
      yield* (yield* Reactor).idle
    }),
  )
})
