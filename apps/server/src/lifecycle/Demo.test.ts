import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem } from "effect"
import { TestBoard } from "@huntaway/testing"
import { TaskId } from "@huntaway/contracts"
import { TaskDocuments } from "../docs/TaskDocuments.ts"
import { DataDir } from "../platform/DataDir.ts"
import { AgentConfigs } from "../profiles/AgentConfigs.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { DEMO_README, DEMO_TODOS, seedDemo } from "./Demo.ts"

// The demo board (huntaway's demo.ts and demo.test.ts), seeded at startup by a board started with `--demo`.

describe("the demo board", () => {
  it.effect("is seeded on a fresh board: a Default profile, the Demo project and its sample tasks, the one at work with its todo list", () =>
    Effect.gen(function* () {
      const [profile, ...others] = yield* (yield* Profiles).list
      assert.deepStrictEqual([profile?.name, others.length], ["Default", 0])
      if (profile === undefined) return
      const configs = yield* (yield* AgentConfigs).list
      assert.deepStrictEqual(
        configs.filter((c) => profile.claude_config_ids.includes(c.id)).map((c) => c.config_dir),
        ["~/.claude"],
      )
      const [project] = yield* (yield* Projects).list(profile.id, false)
      const dataDir = yield* DataDir
      assert.deepStrictEqual([project?.name, project?.key, project?.repo_path, project?.use_worktrees], ["Demo", "DEMO", `${dataDir.root}/demo`, false])
      assert.strictEqual(yield* (yield* FileSystem.FileSystem).readFileString(`${dataDir.root}/demo/README.md`), DEMO_README)
      if (project === undefined) return
      const tasks = yield* (yield* TaskRepo).list({ _tag: "ByProject", project_id: project.id })
      assert.deepStrictEqual(
        tasks.map((t) => [t.key, t.status]).toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
        [
          ["DEMO-1", "todo"],
          ["DEMO-10", "in_review"],
          ["DEMO-11", "in_review"],
          ["DEMO-2", "todo"],
          ["DEMO-3", "in_progress"],
          ["DEMO-4", "needs_attention"],
          ["DEMO-5", "in_review"],
          ["DEMO-6", "done"],
          ["DEMO-7", "backlog"],
          ["DEMO-8", "done"],
          ["DEMO-9", "in_review"],
        ],
      )
      const working = tasks.find((t) => t.title === "Something being worked on")
      assert.strictEqual(working?.todos.length, 7)
      assert.deepStrictEqual(working?.todos, DEMO_TODOS)
      assert.deepStrictEqual(working?.todos[2], { text: "Show it on the task's card", status: "in_progress" })
      // Done a week ago, so archived.
      const shipped = tasks.find((t) => t.title === "Shipped last week")
      const now = yield* DateTime.now
      assert.strictEqual(shipped?.done_at, DateTime.formatIso(DateTime.subtract(now, { days: 7 })))
      // A diagram, a plan and an artifact, each with a version of its document, as its agent's turn would have kept it (6.2).
      const documents = yield* TaskDocuments
      for (const [title, label] of [
        ["How a task moves across the board", "diagram"],
        ["Plan a dark mode for the demo site", "plan"],
        ["A release notes card", "artifact"],
      ] as const) {
        const t = tasks.find((x) => x.title === title)
        assert.deepStrictEqual(t?.labels, [label])
        if (t === undefined) continue
        assert.notStrictEqual(t.document_at, null)
        const doc = yield* documents.get(t.id)
        assert.deepStrictEqual([doc.label, doc.version, doc.versions.map((v) => v.open)], [label, 1, [false]])
      }
      assert.include((yield* documents.get(TaskId.make(tasks.find((x) => x.labels.includes("plan"))?.id ?? ""))).content ?? "", "<ia-question")
      // And a scratch task in no project.
      const scratch = yield* (yield* TaskRepo).list({ _tag: "Projectless", profile_id: profile.id })
      assert.deepStrictEqual(
        scratch.map((t) => [t.key, t.title]),
        [["S-1", "Try a scratch task"]],
      )

      // Seeded only on a board with no profiles: started again, it is left as it is.
      yield* seedDemo
      assert.strictEqual((yield* (yield* Profiles).list).length, 1)
      assert.strictEqual((yield* (yield* TaskRepo).all).length, 12)
    }).pipe(Effect.scoped, Effect.provide(TestBoard({ demo: true }))),
  )

  it.effect("is not seeded without --demo, nor on a board that has a profile", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles
      assert.deepStrictEqual(yield* profiles.list, [])
      yield* profiles.create({ name: "me" })
      yield* seedDemo
      assert.deepStrictEqual(
        (yield* profiles.list).map((p) => p.name),
        ["me"],
      )
      assert.deepStrictEqual(yield* (yield* TaskRepo).all, [])
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )
})
