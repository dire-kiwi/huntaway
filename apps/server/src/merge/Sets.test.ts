import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { Project, Task, TaskId } from "@huntaway/contracts"
import { git, gitRepo, TestBoard } from "@huntaway/testing"
import { Checkpoints } from "../git/Checkpoints.ts"
import { Worktrees } from "../git/Worktrees.ts"
import { Reactor } from "../lifecycle/Reactor.ts"
import { change, reload } from "../mcp/tools/tests/wait.ts"
import { Actor } from "../platform/Changes.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { Runs } from "../runs/Runs.ts"
import type { TaskColumns } from "../tasks/decide.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import { Threads } from "../threads/Threads.ts"

// Sets across repositories landing together (HE-119), on the whole board's services and real repositories: a set's
// task in Ready for merge waits for every open task of its set, then each merges in its own project's queue; a merge
// failing once others merged is told to the lead's thread; a lead deleted or closed hands the set on. A test board has
// no ia-shim: a merge asked for registers its run (its request in the thread) and the launch then fails, leaving the
// task in Needs attention, still merging, as Merges.test.ts says. The rule itself is decide.test.ts's table.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

const board = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

/** Projects API, WEB and DOC of one profile, each on a repository of its own on `main`. */
const projects = Effect.gen(function* () {
  const profile = (yield* (yield* Profiles).create({ name: "me" }).pipe(Effect.orDie)).id
  const one = (key: string) =>
    Effect.gen(function* () {
      const repo = yield* gitRepo
      return yield* (yield* Projects).create({ profile_id: profile, name: key.toLowerCase(), key, repo_path: repo, base_branch: "main" }).pipe(Effect.orDie)
    })
  return { api: yield* one("API"), web: yield* one("WEB"), doc: yield* one("DOC") }
})

/** Wait until every run being launched has started or given up, and the reactor has handled what followed. */
const settle = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const runs = yield* Runs
  const reactor = yield* Reactor
  const checkpoints = yield* Checkpoints
  for (let i = 0; i < 4; i++) {
    yield* reactor.idle
    for (const { id } of yield* sql<{ readonly id: TaskId }>`SELECT id FROM tasks`.pipe(Effect.orDie)) {
      yield* runs.launched(id)
      yield* checkpoints.settled(id)
    }
    yield* reactor.idle
  }
})

/** A set led in `lead`, also in `also`: its tasks, the lead first. */
const createSet = (lead: Project, title: string, also: ReadonlyArray<Project>) =>
  Effect.gen(function* () {
    const tasks = yield* Tasks
    const made = yield* tasks.create({ project_id: lead.id, title, also_in: also.map((p) => p.key) }, Actor.user).pipe(Effect.orDie)
    const all: Array<Task> = [made]
    for (const p of also) {
      const found = (yield* tasks.list({ _tag: "ByProject", project_id: p.id }).pipe(Effect.orDie)).find((t) => t.lead_id === made.id && t.title === title)
      all.push(found ?? assert.fail(`no task of the set in ${p.key}`))
    }
    return all
  })

/** The `i`th task of a set, as `createSet` gives them. */
const nth = (all: ReadonlyArray<Task>, i: number): Task => all[i] ?? assert.fail(`the set has no task ${i}`)

/** Set up `t`'s worktree (on the set's branch), commit work in it, and put it in In review. */
const withWork = (t: Task) =>
  Effect.gen(function* () {
    const ready = yield* (yield* Worktrees).setup(t.id).pipe(Effect.orDie)
    yield* git(ready.worktree_path ?? "", ["commit", "-q", "--allow-empty", "-m", t.title])
    yield* change(t.id, { status: "in_review" })
    return yield* reload(t.id)
  })

const move = (t: Task, status: Task["status"], resolution?: Task["resolution"]) =>
  Effect.andThen(
    Effect.flatMap(Tasks, (tasks) => tasks.update(t.id, { status, ...(resolution === undefined ? {} : { resolution }) }, Actor.user)).pipe(Effect.orDie),
    settle,
  )

/** Change `t`'s row as the board does, through `Tasks.change`, so the reactor sees it. */
const boardChange = (t: Task, columns: TaskColumns) =>
  Effect.andThen(Effect.flatMap(Tasks, (tasks) => tasks.change(t.id, () => columns, Actor.board)).pipe(Effect.orDie), settle)

const lastPrompt = (t: Task) =>
  Effect.map(
    Effect.flatMap(ThreadReaders, (r) => r.lastUserMessage(t.id)),
    (m) => m?.text ?? "",
  )

const notices = (t: Task) =>
  Effect.map(Effect.flatMap(Threads, (th) => th.stored(t.id)).pipe(Effect.orDie), (s) =>
    s.entries.flatMap((e) => (e.item.type === "notice" ? [e.item.text] : [])),
  )

const leads = (tasks: ReadonlyArray<Task>) => Effect.forEach(tasks, (t) => Effect.map(reload(t.id), (x) => x.lead_id ?? null), { concurrency: 1 })

describe("a set lands together", () => {
  it.effect("Ready for merge waits for every open task of the set, then each merges in its own project's queue", () =>
    board(
      Effect.gen(function* () {
        const { api, web, doc } = yield* projects
        const made = yield* createSet(api, "API and client", [web, doc])
        const lead = nth(made, 0)
        const follower = nth(made, 1)
        const closed = nth(made, 2)
        const a = yield* withWork(lead)
        const w = yield* withWork(follower)
        assert.strictEqual(a.branch, "ia/api-1-api-and-client")
        assert.strictEqual(w.branch, a.branch)
        // One closed as not done doesn't count.
        yield* move(closed, "done", "not_done")

        // The lead in Ready for merge waits for the follower in review, and says so.
        yield* move(a, "ready_for_merge")
        assert.deepStrictEqual([(yield* reload(a.id)).status, (yield* reload(a.id)).merging, yield* lastPrompt(a)], ["ready_for_merge", true, ""])
        assert.include(
          yield* notices(a),
          "Waits for the rest of its set before it merges: WEB-1 (In review). Once every open task of the set is in Ready for merge, each merges in its own project's queue",
        )

        // The follower comes: both are asked to merge, each into its own repository's base branch.
        yield* move(w, "ready_for_merge")
        assert.include(yield* lastPrompt(a), `Merge branch \`${a.branch}\` into \`main\``)
        assert.include(yield* lastPrompt(w), `Merge branch \`${w.branch}\` into \`main\``)
        assert.notInclude((yield* notices(w)).join("\n"), "Waits for the rest of its set")
      }),
    ),
  )

  it.effect("a merge failing once others of the set merged is told to the lead's thread", () =>
    board(
      Effect.gen(function* () {
        const { api, web, doc } = yield* projects
        const made = yield* createSet(api, "Three ways", [web, doc])
        const lead = nth(made, 0)
        const one = nth(made, 1)
        const two = nth(made, 2)
        const tasks = [yield* withWork(lead), yield* withWork(one), yield* withWork(two)]
        for (const t of tasks) yield* move(t, "ready_for_merge")
        const [a, w, d] = [nth(tasks, 0), nth(tasks, 1), nth(tasks, 2)]
        // The lead and DOC-1 merge (their launches failed here: they're in Needs attention, still merging).
        yield* move(a, "done")
        yield* move(d, "done")
        // WEB-1's merge is under way, then fails.
        yield* boardChange(w, { status: "ready_for_merge", attention_reason: null, running: true })
        yield* boardChange(w, { status: "needs_attention", attention_reason: "Merge conflict in client.ts", running: false })
        assert.include(
          yield* notices(a),
          "WEB-1 couldn't merge, after API-1, DOC-1 of its set have merged: Merge conflict in client.ts. The set's tasks not merged yet wait until it's in Ready for merge again; settle it with WEB-1, or close it as not done",
        )
        assert.notInclude((yield* notices(w)).join("\n"), "couldn't merge, after")
      }),
    ),
  )

  it.effect("a message to a set's task waiting for the rest takes it out of Ready for merge while its agent works", () =>
    board(
      Effect.gen(function* () {
        const { api, web } = yield* projects
        const made = yield* createSet(api, "Talk", [web])
        const lead = nth(made, 0)
        const follower = nth(made, 1)
        const a = yield* withWork(lead)
        yield* withWork(follower)
        yield* move(a, "ready_for_merge")
        // Waiting for WEB-1, it isn't asked to merge.
        assert.deepStrictEqual([(yield* reload(a.id)).status, yield* lastPrompt(a)], ["ready_for_merge", ""])
        yield* Effect.flatMap(Runs, (runs) => runs.send(a.id, { text: "One more thing", source: "user" })).pipe(Effect.ignore)
        yield* settle
        const now = yield* reload(a.id)
        assert.deepStrictEqual([now.merging, now.remerge], [false, true])
        assert.include(yield* notices(a), "Out of Ready for merge while its agent works: it goes back to waiting for the rest of its set when it's done")
      }),
    ),
  )
})

describe("leaving the set", () => {
  it.effect("the lead closed hands the set to the next open task; deleted, the next; one left is an ordinary task", () =>
    board(
      Effect.gen(function* () {
        const { api, web, doc } = yield* projects
        const made = yield* createSet(api, "Handed on", [web, doc])
        const a = nth(made, 0)
        const w = nth(made, 1)
        const d = nth(made, 2)
        // Closed as won't fix: WEB-1 leads, and the closed lead follows it (back in the set once reopened).
        yield* move(a, "done", "wont_fix")
        assert.deepStrictEqual(yield* leads([a, w, d]), [w.id, null, w.id])
        // WEB-1 deleted: the next open task by creation (DOC-1, not the closed API-1) leads.
        yield* Effect.flatMap(Tasks, (tasks) => tasks.delete(w.id, { deleteBranch: false }, Actor.user)).pipe(Effect.orDie)
        yield* settle
        assert.deepStrictEqual(yield* leads([a, d]), [d.id, null])
        // A follower deleted changes no one's; DOC-1, alone, is an ordinary task.
        yield* Effect.flatMap(Tasks, (tasks) => tasks.delete(a.id, { deleteBranch: false }, Actor.user)).pipe(Effect.orDie)
        assert.deepStrictEqual(yield* leads([d]), [null])
        const view = yield* reload(d.id)
        assert.strictEqual(view.status, "todo")
      }),
    ),
  )

  it.effect("the lead deleted with one follower leaves an ordinary task", () =>
    board(
      Effect.gen(function* () {
        const { api, web } = yield* projects
        const made = yield* createSet(api, "Two", [web])
        const a = nth(made, 0)
        const w = nth(made, 1)
        assert.strictEqual(w.lead_id, a.id)
        yield* Effect.flatMap(Tasks, (tasks) => tasks.delete(a.id, { deleteBranch: false }, Actor.user)).pipe(Effect.orDie)
        assert.deepStrictEqual(yield* leads([w]), [null])
      }),
    ),
  )
})
