import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, FileSystem, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { Project, Task, TaskId } from "@huntaway/contracts"
import { fakeAgent, git, tempDir, TestBoard } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { Checkpoints } from "../git/Checkpoints.ts"
import { Worktrees } from "../git/Worktrees.ts"
import { Reactor } from "../lifecycle/Reactor.ts"
import { change, reload } from "../mcp/tools/tests/wait.ts"
import { Questions } from "../permissions/Questions.ts"
import { Actor } from "../platform/Changes.ts"
import type { ServerConfigShape } from "../platform/ServerConfig.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { RunEnds } from "../runs/RunEnds.ts"
import { RunOutput } from "../runs/RunOutput.ts"
import { Runs } from "../runs/Runs.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import { Threads } from "../threads/Threads.ts"
import { MergeGate } from "./MergeGate.ts"
import { Merges } from "./Merges.ts"

// The merge queue and its gate on the whole board's services: the cases of huntaway's agent/runner/merge.test.ts,
// api/tasks.test.ts (the merge ones) and api/incoming.test.ts's lanes that need a board. A test board has no ia-shim:
// the merge a task's turn starts registers its run (its request in the thread, the task running) and the launch then
// fails, which leaves the task in Needs attention, still merging (it holds its lane, as a merge waiting on the user
// does). A run that does its work is a scripted agent (`fakeAgent`), ended through `RunEnds` as the follower ends it.
// The lane rules themselves are decide.test.ts's table; what a request says is request.test.ts's.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

const board = <A, E, R>(effect: Effect.Effect<A, E, R>, config: Partial<ServerConfigShape> = {}) =>
  effect.pipe(Effect.scoped, Effect.provide(TestBoard(config)))

/** A repository on master with one commit, and a project "X" on it. */
const projectOnRepo = Effect.gen(function* () {
  const repo = `${yield* tempDir}/repo`
  yield* (yield* FileSystem.FileSystem).makeDirectory(repo, { recursive: true }).pipe(Effect.orDie)
  yield* git(repo, ["init", "-q", "-b", "master"])
  yield* git(repo, ["commit", "-q", "--allow-empty", "-m", "init"])
  const profile = (yield* (yield* Profiles).create({ name: "p" }).pipe(Effect.orDie)).id
  const project = yield* (yield* Projects).create({ profile_id: profile, name: "x", key: "X", repo_path: repo, base_branch: "master" }).pipe(Effect.orDie)
  return { repo, project }
})

/** A task whose worktree has a commit of its own, in In review (merging into `into`, if given). */
const taskWithWork = (project: Project, title: string, into?: Task) =>
  Effect.gen(function* () {
    const created = yield* (yield* Tasks)
      .create({ project_id: project.id, title, ...(into === undefined ? {} : { merges_into: into.id }) }, Actor.user)
      .pipe(Effect.orDie)
    const t = yield* (yield* Worktrees).setup(created.id).pipe(Effect.orDie)
    yield* git(t.worktree_path ?? "", ["commit", "-q", "--allow-empty", "-m", title])
    yield* change(t.id, { status: "in_review" })
    return yield* reload(t.id)
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

const update = (id: TaskId, patch: Parameters<Tasks["Service"]["update"]>[1], by = Actor.user) => Effect.flatMap(Tasks, (tasks) => tasks.update(id, patch, by))

const move = (id: TaskId, status: Task["status"]) => Effect.andThen(update(id, { status }).pipe(Effect.orDie), settle)

/** The last message the task's agent was sent. */
const lastPrompt = (id: TaskId) =>
  Effect.map(
    Effect.flatMap(ThreadReaders, (r) => r.lastUserMessage(id)),
    (m) => m?.text ?? "",
  )

const notices = (id: TaskId) =>
  Effect.map(Effect.flatMap(Threads, (t) => t.stored(id)).pipe(Effect.orDie), (s) => s.entries.flatMap((e) => (e.item.type === "notice" ? [e.item.text] : [])))

/** The task's merge approval cards: their request ids and how each stands. */
const approvalCards = (id: TaskId) =>
  Effect.map(Effect.flatMap(Threads, (t) => t.stored(id)).pipe(Effect.orDie), (s) =>
    s.requests.flatMap((r) =>
      r.type === "question" && r.metadata?.["merge_approval"] === true
        ? [{ id: r.id, state: r.resolution === undefined ? "pending" : r.resolution.outcome === "answer" ? "answered" : (r.resolution.message ?? "") }]
        : [],
    ),
  )

/** What a failure said (its `detail` or `reason`), or "" for a success. */
const failure = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return ""
  const e = Cause.squash(exit.cause)
  if (typeof e === "object" && e !== null && "detail" in e && typeof e.detail === "string") return e.detail
  if (typeof e === "object" && e !== null && "reason" in e && typeof e.reason === "string") return e.reason
  return String(e)
}

const RESULT = { type: "result", subtype: "success", is_error: false, result: "Done", session_id: "s1", total_cost_usd: 0, usage: {} }
const Json = Schema.fromJsonString(Schema.Unknown)

/** A run of `task`'s agent that does its turn and ends well, as the follower would end it. */
const runsWell = (id: TaskId) =>
  Effect.gen(function* () {
    const agent: FakeAgent = yield* fakeAgent({ task: id })
    yield* change(id, { running: true })
    const handler = yield* RunOutput
    const fs = yield* FileSystem.FileSystem
    yield* agent.write([RESULT])
    const end = Number((yield* fs.stat(`${agent.dir}/out.jsonl`).pipe(Effect.orDie)).size)
    yield* handler.handle(yield* agent.row, yield* Schema.encodeEffect(Json)(RESULT).pipe(Effect.orDie), end)
    yield* (yield* RunEnds).ended({ _tag: "RunExited", run: agent.run.id, task: id, exit: { code: 0, signal: null }, errorTail: "" })
    yield* settle
  })

describe("the merge queue", () => {
  it.effect("ready for merge queues the merge even before agents can run", () =>
    board(
      Effect.gen(function* () {
        const { project } = yield* projectOnRepo
        const t = yield* taskWithWork(project, "a")
        yield* move(t.id, "ready_for_merge")
        const now = yield* reload(t.id)
        assert.deepStrictEqual([now.status, now.merging, now.running], ["ready_for_merge", true, false])
        assert.include(
          yield* notices(t.id),
          "Agents can't run on this host yet (no Claude Code or Codex found), so the task waits in the merge queue until they can",
        )
      }),
      { noAgents: true },
    ),
  )

  it.effect("tasks merging into one task merge one at a time in a lane of their own", () =>
    board(
      Effect.gen(function* () {
        const { project } = yield* projectOnRepo
        const target = yield* taskWithWork(project, "Target")
        const a = yield* taskWithWork(project, "A", target)
        const b = yield* taskWithWork(project, "B", target)
        const other = yield* taskWithWork(project, "Other")
        yield* move(a.id, "ready_for_merge")
        assert.include(yield* lastPrompt(a.id), `This task merges into X-1 ("Target", in review): its work goes onto X-1's branch \`${target.branch}\``)
        // Its launch failed (no agent here): it waits on the user, still merging, and holds the lane.
        assert.deepStrictEqual([(yield* reload(a.id)).status, (yield* reload(a.id)).merging], ["needs_attention", true])
        // B waits for A, which merges into the same branch...
        yield* move(b.id, "ready_for_merge")
        assert.deepStrictEqual([(yield* reload(b.id)).status, yield* lastPrompt(b.id)], ["ready_for_merge", ""])
        // ...but a merge into the base branch doesn't.
        yield* move(other.id, "ready_for_merge")
        assert.include(yield* lastPrompt(other.id), "Merge branch `ia/x-4-other` into `master`")
        // A is done, so B merges.
        yield* move(a.id, "done")
        assert.include(yield* lastPrompt(b.id), "This task merges into X-1")
      }),
    ),
  )

  it.effect("a merge that needs changes lets the queue go and rejoins it at the back", () =>
    board(
      Effect.gen(function* () {
        const { project } = yield* projectOnRepo
        const a = yield* taskWithWork(project, "a")
        const b = yield* taskWithWork(project, "b")
        // A merging (its agent running), B queued behind it.
        yield* change(a.id, { status: "ready_for_merge", merging: true, running: true, position: 1 })
        yield* change(b.id, { status: "ready_for_merge", merging: true, position: 2 })
        yield* (yield* Merges).reconcileLane(project.id)
        assert.strictEqual(yield* lastPrompt(b.id), "")
        // Only a merging task steps out, and only into In progress.
        const wrong = yield* Effect.exit(update(a.id, { status: "in_review", remerge: true }, { _tag: "Agent", task_id: a.id }))
        assert.isTrue(Exit.isFailure(wrong))
        const out = yield* update(a.id, { status: "in_progress", remerge: true }, { _tag: "Agent", task_id: a.id }).pipe(Effect.orDie)
        assert.deepStrictEqual([out.status, out.merging, out.remerge], ["in_progress", false, true])
        assert.isTrue(Exit.isFailure(yield* Effect.exit(update(b.id, { status: "in_progress", remerge: true }))))
        yield* settle
        assert.include(yield* notices(a.id), "Stepped out of the merge queue to make changes; it rejoins the queue when its agent is done")
        // B merges while A makes its changes.
        assert.include(yield* lastPrompt(b.id), "Merge branch")
        // Done, A rejoins the back of the queue rather than going to In review.
        yield* change(a.id, { running: false })
        yield* runsWell(a.id)
        const back = yield* reload(a.id)
        assert.deepStrictEqual([back.status, back.merging, back.remerge], ["ready_for_merge", true, false])
        assert.include(yield* notices(a.id), "Back in the merge queue")
        // B (its launch failed: it waits on the user, still merging) holds the lane: A isn't asked to merge.
        assert.strictEqual(yield* lastPrompt(a.id), "")
      }),
    ),
  )

  it.effect("a message to a task queued behind another merge is refused", () =>
    board(
      Effect.gen(function* () {
        const { project } = yield* projectOnRepo
        const a = yield* taskWithWork(project, "a")
        const b = yield* taskWithWork(project, "b")
        yield* change(a.id, { status: "ready_for_merge", merging: true, running: true, position: 1 })
        yield* change(b.id, { status: "ready_for_merge", merging: true, position: 2 })
        const sent = yield* Effect.exit((yield* Runs).send(b.id, { text: "hi", source: "user" }))
        assert.isTrue(Exit.isFailure(sent))
        assert.include(failure(sent), 'this task is queued to merge after "a"')
      }),
    ),
  )

  it.effect("a merge that can't be asked for needs attention and holds its lane", () =>
    board(
      Effect.gen(function* () {
        const { project } = yield* projectOnRepo
        const target = yield* taskWithWork(project, "Target")
        const a = yield* taskWithWork(project, "A", target)
        // Its target has no branch any more (as if made in a column): it can't say where to merge.
        yield* change(target.id, { branch: null })
        yield* move(a.id, "ready_for_merge")
        const t = yield* reload(a.id)
        const reason = "Couldn't start the merge: X-1, which this task merges into, has no branch yet: start it (or set up its worktree) first"
        assert.deepStrictEqual([t.status, t.merging, t.attention_reason], ["needs_attention", true, reason])
      }),
    ),
  )
})

describe("the merge gate", () => {
  it.effect("a merge waits for the user's approval of its summary, and doesn't hold the lane meanwhile", () =>
    board(
      Effect.gen(function* () {
        const { project } = yield* projectOnRepo
        yield* (yield* Profiles).update(project.profile_id, { merge_approval: true }).pipe(Effect.orDie)
        const gate = yield* MergeGate
        let t = yield* taskWithWork(project, "a")
        // Not merging, it can't merge either.
        assert.include((yield* gate.blocked(t.id)) ?? "", "merges in this project need the user's approval")

        // Moved to Ready for merge, its agent summarises the merge, out of the merge queue.
        yield* update(t.id, { status: "ready_for_merge" }).pipe(Effect.orDie)
        yield* (yield* Reactor).idle
        t = yield* reload(t.id)
        assert.deepStrictEqual([t.status, t.merging, t.merge_approval], ["ready_for_merge", true, "pending"])
        assert.include(yield* lastPrompt(t.id), "Do not merge yet")
        assert.isTrue(((yield* gate.blocked(t.id)) ?? "").startsWith("Merging is disabled: the user hasn't approved this merge yet"))
        yield* settle

        // Once its summary run ends, the user is asked.
        yield* change(t.id, { status: "ready_for_merge", attention_reason: null })
        yield* runsWell(t.id)
        t = yield* reload(t.id)
        assert.deepStrictEqual([t.status, t.merging, t.merge_approval, t.attention_reason], ["needs_attention", true, "pending", "Approve or deny the merge"])
        const cards = yield* approvalCards(t.id)
        assert.deepStrictEqual(
          cards.map((c) => c.state),
          ["pending"],
        )
        // It doesn't hold the merge slot meanwhile: another, approved, merges.
        const other = yield* taskWithWork(project, "b")
        yield* change(other.id, { status: "ready_for_merge", merging: true, merge_approval: "approved" })
        yield* (yield* Merges).reconcileLane(project.id)
        assert.include(yield* lastPrompt(other.id), "The user approved the merge.")
        yield* settle
        yield* move(other.id, "done")

        // Approved, it merges.
        const questions = yield* Questions
        const card = cards[0]?.id ?? assert.fail("no card")
        yield* questions.answer(t.id, card, { choices: ["Approve"] }).pipe(Effect.orDie)
        yield* (yield* Reactor).idle
        t = yield* reload(t.id)
        assert.deepStrictEqual([t.merging, t.merge_approval], [true, "approved"])
        assert.include(yield* lastPrompt(t.id), "The user approved the merge.")
        assert.include(yield* notices(t.id), "Merge approved: it merges once no other task in the project is merging")
        assert.deepStrictEqual(
          (yield* approvalCards(t.id)).map((c) => c.state),
          ["answered"],
        )
        assert.isNull(yield* gate.blocked(t.id))
        assert.isTrue(Exit.isFailure(yield* Effect.exit(questions.answer(t.id, card, { choices: ["Deny"] }))), "answered once")
        yield* settle
        // Leaving the merge, it needs approving again.
        t = yield* update(t.id, { status: "in_review" }).pipe(Effect.orDie)
        assert.isNull(t.merge_approval)
        assert.isNotNull(yield* gate.blocked(t.id))
      }),
    ),
  )

  it.effect("a denied merge goes back to review; moved again, it's summarised again and the old card is replaced", () =>
    board(
      Effect.gen(function* () {
        const { project } = yield* projectOnRepo
        // The project's setting wins over the profile's.
        yield* (yield* Profiles).update(project.profile_id, { merge_approval: false }).pipe(Effect.orDie)
        yield* (yield* Projects).update(project.id, { merge_approval: true }).pipe(Effect.orDie)
        let t = yield* taskWithWork(project, "a")
        yield* move(t.id, "ready_for_merge")
        // It can't step out of a queue it isn't in.
        yield* change(t.id, { running: true })
        const stepOut = yield* Effect.exit(update(t.id, { status: "in_progress", remerge: true }, { _tag: "Agent", task_id: t.id }))
        assert.include(failure(stepOut), "the merge hasn't been approved yet")
        yield* change(t.id, { running: false, status: "ready_for_merge", attention_reason: null })
        yield* runsWell(t.id)
        const [card] = yield* approvalCards(t.id)
        t = yield* (yield* Questions).answer(t.id, card?.id ?? "", { choices: ["Deny"] }).pipe(Effect.orDie)
        assert.deepStrictEqual([t.status, t.merging, t.merge_approval, t.running], ["in_review", false, null, false])
        assert.include(yield* notices(t.id), "Merge denied: back in review")
        yield* settle

        // Moved there again, then again while it waits: the old card goes and it's summarised again.
        yield* move(t.id, "ready_for_merge")
        yield* change(t.id, { status: "ready_for_merge", attention_reason: null })
        yield* runsWell(t.id)
        yield* move(t.id, "in_review")
        yield* move(t.id, "ready_for_merge")
        t = yield* reload(t.id)
        assert.strictEqual(t.merge_approval, "pending")
        assert.deepStrictEqual(
          (yield* approvalCards(t.id)).map((c) => c.state),
          ["answered", "Replaced by a later question"],
        )
      }),
    ),
  )
})
