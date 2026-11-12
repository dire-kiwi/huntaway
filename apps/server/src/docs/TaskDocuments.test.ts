import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { TaskId } from "@huntaway/contracts"
import type { DocumentLabel, Task } from "@huntaway/contracts"
import { TestBoard, TestPlatform } from "@huntaway/testing"
import { Actor } from "../platform/Changes.ts"
import { DataDir } from "../platform/DataDir.ts"
import { Db } from "../platform/Db.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { TurnHooks } from "../runs/TurnHooks.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { ThreadStore } from "../threads/ThreadStore.ts"
import { Threads } from "../threads/Threads.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import { TaskDocumentRepo } from "./TaskDocumentRepo.ts"
import { DOCUMENT_FILE, MAX_SIZE, TaskDocuments } from "./TaskDocuments.ts"

// The old agent/documents.test.ts's cases for the documents (the others are where their code went: `/plan` in
// runs/Runs.test.ts and agents/prompts, labels in tasks/decide.test.ts, the work folder in runs/LaunchFacts, writing the
// folder without asking in permissions/Permissions.test.ts); a Codex edit's in runs/codex/output.test.ts.

const board = TestBoard()

/** The documents alone, with no loop that the test clock's moving would run (the whole board's sweepers). */
const alone = TaskDocuments.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(TaskDocumentRepo.layer, Threads.layer)),
  Layer.provideMerge(Layer.mergeAll(ThreadStore.layer, TaskRepo.layer, AgentConfigRepo.layer)),
  Layer.provideMerge(TestPlatform()),
)

/** A task in a project "Web" with `labels` (a profile and project made the first time). */
const taskWith = (labels: ReadonlyArray<DocumentLabel>) =>
  Effect.gen(function* () {
    const profiles = yield* Profiles
    const projects = yield* Projects
    const dataDir = yield* DataDir
    const profile = (yield* profiles.list)[0] ?? (yield* profiles.create({ name: "p" }))
    const repo = `${dataDir.root}/web`
    mkdirSync(repo, { recursive: true })
    const project =
      (yield* projects.list(profile.id, false))[0] ??
      (yield* projects.create({ profile_id: profile.id, name: "Web", repo_path: repo, key: "WEB", base_branch: null, use_worktrees: false }))
    return yield* (yield* Tasks).create({ project_id: project.id, title: "A task", labels }, Actor.board)
  }).pipe(Effect.orDie)

/** Writes the document with a modification time of its own, as the next edit would have. */
const write = (file: string, text: string, secs: number) => {
  mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true })
  writeFileSync(file, text)
  utimesSync(file, 1_000_000 + secs, 1_000_000 + secs)
}

const fileOf = (task: Task, label: DocumentLabel) => Effect.map(TaskDocuments, (d) => `${d.folder(task.id)}/${DOCUMENT_FILE[label]}`)

/** The task's versions: label, version, content, open. */
const labelled = (task: TaskId) =>
  Effect.gen(function* () {
    const { sql } = yield* Db
    const rows = yield* sql<{ label: string; version: number; content: string; open: number }>`
      SELECT label, version, content, open FROM documents WHERE task_id = ${task} ORDER BY label, version`.pipe(Effect.orDie)
    return rows.map((r) => [r.label, r.version, r.content, r.open === 1] as const)
  })

const versions = (task: TaskId) => Effect.map(labelled(task), (rows) => rows.map(([, v, c, o]) => [v, c, o] as const))

describe("TaskDocuments", () => {
  it.effect("a version follows the file during a turn, and the next turn starts another", () =>
    Effect.gen(function* () {
      const documents = yield* TaskDocuments
      const task = yield* taskWith(["diagram"])
      const file = yield* fileOf(task, "diagram")
      assert.isTrue(file.endsWith("/diagram.mmd"))

      // Nothing written yet: no version.
      yield* documents.follow(task.id)
      yield* documents.turnEnded(task.id)
      assert.deepStrictEqual(yield* versions(task.id), [])

      write(file, "flowchart LR\n  a", 1)
      yield* documents.follow(task.id)
      write(file, "flowchart LR\n  a --> b", 2)
      yield* documents.follow(task.id)
      assert.deepStrictEqual(yield* versions(task.id), [[1, "flowchart LR\n  a --> b", true]])
      assert.notStrictEqual((yield* (yield* TaskRepo).get(task.id))?.document_at ?? null, null)
      yield* documents.turnEnded(task.id)
      assert.deepStrictEqual(yield* versions(task.id), [[1, "flowchart LR\n  a --> b", false]])

      // A turn that doesn't change it adds nothing; the next change is version 2.
      yield* documents.turnEnded(task.id)
      write(file, "flowchart LR\n  a --> c", 3)
      yield* documents.turnEnded(task.id)
      assert.deepStrictEqual(yield* versions(task.id), [
        [1, "flowchart LR\n  a --> b", false],
        [2, "flowchart LR\n  a --> c", false],
      ])

      // A task with no labels has no documents.
      const code = yield* taskWith([])
      write(`${documents.folder(code.id)}/plan.html`, "<h1>Plan</h1>", 1)
      yield* documents.turnEnded(code.id)
      assert.deepStrictEqual(yield* versions(code.id), [])
    }).pipe(Effect.scoped, Effect.provide(board)),
  )

  it.effect("a task keeps a document for each label; a label taken off mid-turn still has its version closed", () =>
    Effect.gen(function* () {
      const documents = yield* TaskDocuments
      const task = yield* taskWith(["diagram", "plan"])
      assert.deepStrictEqual(task.labels, ["plan", "diagram"])
      const plan = yield* fileOf(task, "plan")
      write(plan, "<h1>Plan</h1>", 1)
      write(yield* fileOf(task, "diagram"), "flowchart LR", 1)
      yield* documents.follow(task.id)
      assert.deepStrictEqual(yield* labelled(task.id), [
        ["diagram", 1, "flowchart LR", true],
        ["plan", 1, "<h1>Plan</h1>", true],
      ])
      yield* documents.turnEnded(task.id)
      write(plan, "<h1>Plan 2</h1>", 2)
      // Taking a label off mid-turn closes its version all the same, and stops following its file.
      yield* documents.follow(task.id)
      yield* (yield* Tasks).change(task.id, () => ({ labels: ["diagram"] }), Actor.board).pipe(Effect.orDie)
      write(plan, "<h1>Plan 3</h1>", 3)
      yield* documents.turnEnded(task.id)
      assert.deepStrictEqual(yield* labelled(task.id), [
        ["diagram", 1, "flowchart LR", false],
        ["plan", 1, "<h1>Plan</h1>", false],
        ["plan", 2, "<h1>Plan 2</h1>", false],
      ])
    }).pipe(Effect.scoped, Effect.provide(board)),
  )

  it.effect("a file over 5 MB isn't kept, and the turn's end says so in the thread", () =>
    Effect.gen(function* () {
      const documents = yield* TaskDocuments
      const task = yield* taskWith(["artifact"])
      write(yield* fileOf(task, "artifact"), "x".repeat(MAX_SIZE + 1), 1)
      yield* documents.follow(task.id)
      yield* documents.turnEnded(task.id)
      assert.deepStrictEqual(yield* versions(task.id), [])
      const entries = yield* (yield* ThreadStore).entries(task.id)
      assert.deepStrictEqual(
        entries.flatMap((e) => (e.item.type === "notice" ? [e.item.text] : [])),
        ["artifact.html is over 5 MB, so this version isn't kept"],
      )
    }).pipe(Effect.scoped, Effect.provide(board)),
  )

  it.effect("tasks.document: a version of a label's document and the list of its versions", () =>
    Effect.gen(function* () {
      const documents = yield* TaskDocuments
      const task = yield* taskWith(["plan", "diagram"])
      const plan = yield* fileOf(task, "plan")
      // None yet: its first label's, with no version.
      assert.deepStrictEqual(yield* documents.get(task.id), { label: "plan", file: plan, versions: [], version: null, content: null })
      write(plan, "<h1>One</h1>", 1)
      yield* documents.turnEnded(task.id)
      write(plan, "<h1>Two</h1>", 2)
      yield* documents.follow(task.id)
      const latest = yield* documents.get(task.id)
      assert.deepStrictEqual(
        [latest.version, latest.content, latest.versions.map((v) => [v.version, v.open, v.size])],
        [
          2,
          "<h1>Two</h1>",
          [
            [1, false, 12],
            [2, true, 12],
          ],
        ],
      )
      assert.strictEqual((yield* documents.get(task.id, "plan", 1)).content, "<h1>One</h1>")
      assert.deepStrictEqual(yield* documents.get(task.id, "diagram").pipe(Effect.map((d) => [d.label, d.version])), ["diagram", null])
      assert.strictEqual((yield* documents.get(task.id, "plan", 3).pipe(Effect.flip))._tag, "VersionNotFound")
      assert.strictEqual((yield* documents.get(TaskId.make("nope")).pipe(Effect.flip))._tag, "TaskNotFound")
    }).pipe(Effect.scoped, Effect.provide(board)),
  )

  it.effect("the run's lines reach it through TurnHooks", () =>
    Effect.gen(function* () {
      const hooks = yield* TurnHooks
      const task = yield* taskWith(["plan"])
      write(yield* fileOf(task, "plan"), "<h1>Plan</h1>", 1)
      yield* hooks.toolDone(task.id)
      assert.deepStrictEqual(yield* versions(task.id), [[1, "<h1>Plan</h1>", true]])
      yield* hooks.turnEnded(task.id)
      assert.deepStrictEqual(yield* versions(task.id), [[1, "<h1>Plan</h1>", false]])
    }).pipe(Effect.scoped, Effect.provide(board)),
  )

  it.effect("a daily document keeps one version a day, also across turns", () =>
    Effect.gen(function* () {
      const documents = yield* TaskDocuments
      const { sql } = yield* Db
      const task = TaskId.make("assistant")
      yield* sql`INSERT INTO profiles (id, name, created_at) VALUES ('p', 'p', '2026-11-12T00:00:00.000Z')`.pipe(Effect.orDie)
      yield* sql`INSERT INTO tasks (id, profile_id, title, status, last_activity_at, created_at, updated_at)
        VALUES (${task}, 'p', 'Assistant', 'in_progress', '2026-11-12T00:00:00.000Z', '2026-11-12T00:00:00.000Z', '2026-11-12T00:00:00.000Z')`.pipe(
        Effect.orDie,
      )
      const file = `${documents.folder(task)}/brief.html`
      const day = DateTime.makeUnsafe("2026-11-12T12:00:00Z")
      yield* TestClock.setTime(DateTime.toEpochMillis(day))
      const at = (secs: number) => DateTime.toEpochMillis(day) / 1000 + secs
      const writeAt = (text: string, secs: number) => {
        write(file, text, 0)
        utimesSync(file, at(secs), at(secs))
      }
      const keep = documents.keepFile(task, "brief", file, { endOfTurn: true, daily: true })
      writeAt("<p>one</p>", 0)
      assert.isTrue(yield* keep)
      writeAt("<p>two</p>", 60)
      assert.isTrue(yield* keep)
      assert.deepStrictEqual(yield* versions(task), [[1, "<p>two</p>", false]])
      // The next day, the same content written again is that day's version; left as it was, it isn't.
      yield* TestClock.adjust("1 day")
      assert.isFalse(yield* keep)
      writeAt("<p>two</p>", 86400 + 60)
      assert.isTrue(yield* keep)
      assert.deepStrictEqual(yield* versions(task), [
        [1, "<p>two</p>", false],
        [2, "<p>two</p>", false],
      ])
    }).pipe(Effect.scoped, Effect.provide(alone)),
  )

  it.effect("a deleted task's folder goes, and a sweep takes those whose task is gone (a deleted project's)", () =>
    Effect.gen(function* () {
      const documents = yield* TaskDocuments
      const one = yield* taskWith(["plan"])
      const two = yield* taskWith(["plan"])
      write(yield* fileOf(one, "plan"), "<h1>One</h1>", 1)
      write(yield* fileOf(two, "plan"), "<h1>Two</h1>", 1)
      yield* documents.removed(one.id)
      assert.deepStrictEqual([existsSync(documents.folder(one.id)), existsSync(documents.folder(two.id))], [false, true])
      write(`${documents.folder(TaskId.make("gone"))}/plan.html`, "<h1>Gone</h1>", 1)
      yield* documents.sweep
      assert.deepStrictEqual([existsSync(documents.folder(TaskId.make("gone"))), existsSync(documents.folder(two.id))], [false, true])
    }).pipe(Effect.scoped, Effect.provide(board)),
  )
})
