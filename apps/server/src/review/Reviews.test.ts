import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Schema } from "effect"
import type { Scope } from "effect"
import type { SecureRandom } from "effect/crypto"
import type { ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql"
import { ProfileId, ProjectId, RunId, TaskId, Timestamp } from "@huntaway/contracts"
import type { ChangeSummary, Item, Review, Reviewer, Task } from "@huntaway/contracts"
import { fakeAgent, git, gitRepo, TestBoard } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import type { ServerConfigShape } from "../platform/ServerConfig.ts"
import { Checkpoints } from "../git/Checkpoints.ts"
import { Reactor } from "../lifecycle/Reactor.ts"
import { toJson } from "../platform/columns.ts"
import type { RunDir } from "../runs/RunDir.ts"
import { RunEnds } from "../runs/RunEnds.ts"
import { RunOutput } from "../runs/RunOutput.ts"
import type { RunRepo } from "../runs/RunRepo.ts"
import { Runs } from "../runs/Runs.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { ThreadReaders } from "../threads/ThreadReaders.ts"
import { Threads } from "../threads/Threads.ts"
import { failureText } from "./model.ts"
import { ReviewRepo } from "./ReviewRepo.ts"
import { Reviews } from "./Reviews.ts"
import { Summaries } from "./Summaries.ts"

// Reviews and summaries on the whole board's services (docs/plan/10-testing.md): the cases of huntaway's
// review/tests.test.ts, review/summary.test.ts and review/stats.test.ts that need a board. A test board has no ia-shim,
// so the runs a review or summary starts register (their prompts are in their threads) and then fail to launch, which
// ends their parts as failed through the reactor; a reviewer's or summarizer's run that does its work is a scripted
// agent (`fakeAgent`) on the thread, ended through `RunEnds` as the follower ends it.
//
// Left out: the race hooks (`review:last-run`, `review:recording`, `review:reviewer-started`), which stopped the old
// review start between its steps: the later-run check and the recording are one transaction under the task's lock here,
// and a reviewer started as `supersede` stopped the review is stopped after its send (both read in `Reviews.start`);
// the analytics report of the review rows (`token_report`, plan task 6.x); the backfills of rows from before rounds and
// minor issues were kept (the old database's migrations 79 and 82: the importer brings their rows); a summary saved before
// there could be several and a project's single `summarizer` (the importer's).

const AT = Timestamp.make("2026-11-12T00:00:00.000Z")
const Json = Schema.fromJsonString(Schema.Unknown)

type Env =
  | SqlClient.SqlClient
  | FileSystem.FileSystem
  | Scope.Scope
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | Reviews
  | Summaries
  | ReviewRepo
  | Runs
  | RunEnds
  | RunOutput
  | Reactor
  | Checkpoints
  | TaskRepo
  | Threads
  | ThreadReaders
  | RunRepo
  | RunDir

const run = <A, E>(effect: Effect.Effect<A, E, Env>, config: Partial<ServerConfigShape> = {}) => effect.pipe(Effect.scoped, Effect.provide(TestBoard(config)))

const R = (r: Partial<Reviewer>): Reviewer => ({ claude_config_id: null, model: null, effort: null, ...r })

interface Setup {
  /** The project's settings, as columns. */
  readonly project?: Readonly<Record<string, unknown>>
  /** The branch has no commits of its own. */
  readonly elsewhere?: boolean
  readonly status?: Task["status"]
}

const PROJECT = ProjectId.make("pr")
const TASK = TaskId.make("t1")

/**
 * A task X-1 in project X (profile "p") whose worktree is a repository at a commit of its own on `ia/x` (branched from
 * `main`), ready, in In review; with `elsewhere`, the branch is where `main` is.
 */
const reviewable = (options: Setup = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const dir = yield* gitRepo
    yield* git(dir, ["checkout", "-q", "-b", "ia/x"])
    if (options.elsewhere !== true) yield* git(dir, ["commit", "-q", "--allow-empty", "-m", "work"])
    yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES ('p', 'p', ${AT})`
    yield* sql`INSERT INTO projects ${sql.insert({
      id: PROJECT,
      profile_id: "p",
      name: "x",
      key: "X",
      repo_path: dir,
      scratch_path: `${dir}/.s`,
      worktrees_root: `${dir}/.w`,
      base_branch: "main",
      created_at: AT,
      ...options.project,
    })}`
    yield* sql`INSERT INTO tasks ${sql.insert({
      id: TASK,
      profile_id: "p",
      project_id: PROJECT,
      number: 1,
      title: "Fix it",
      status: options.status ?? "in_review",
      use_worktree: 1,
      worktree_state: "ready",
      worktree_path: dir,
      branch: "ia/x",
      last_activity_at: AT,
      created_at: AT,
      updated_at: AT,
    })}`
    return dir
  }).pipe(Effect.orDie)

/** A JSON column's text. */
const json = (value: unknown) => toJson(value)

const setProject = (columns: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE projects SET ${sql.update(columns)} WHERE id = ${PROJECT}`
  }).pipe(Effect.orDie)

const task = (id: TaskId = TASK) =>
  Effect.gen(function* () {
    const t = yield* (yield* TaskRepo).get(id)
    return t === null ? yield* Effect.die(`task ${id} is gone`) : t
  })
const reviewOf = Effect.map(task(), (t) => t.review)

const setTask = (id: TaskId, columns: Readonly<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const row: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(columns)) row[k] = v !== null && typeof v === "object" ? yield* json(v) : v
    yield* sql`UPDATE tasks SET ${sql.update(row)} WHERE id = ${id}`
  }).pipe(Effect.orDie)

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
      // The checkpoints a run's end takes go on in the background: done before the test's repository goes.
      yield* checkpoints.settled(id)
    }
    yield* reactor.idle
  }
})

/** The first message a thread was sent. */
const asked = (thread: TaskId) =>
  Effect.gen(function* () {
    const readers = yield* ThreadReaders
    const n = yield* readers.firstUserMessage(thread)
    return n === null ? "" : ((yield* readers.userMessage(thread, n))?.text ?? "")
  })

const notices = (id: TaskId) =>
  Effect.gen(function* () {
    const stored = yield* (yield* Threads).stored(id).pipe(Effect.orDie)
    return stored.entries.map((e): Item => e.item).flatMap((i) => (i.type === "notice" ? [i.text] : []))
  })

/** Review threads (of `type`) under the task. */
const threadsOf = (type: string | null) =>
  Effect.gen(function* () {
    return (yield* (yield* TaskRepo).reviewThreads(TASK)).filter((t) => t.task_type === type)
  })

/** What a refusal said, or "" when it succeeded. */
const refusal = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? failureText(exit.cause) : "")

/** `n` reviewer threads under the task and a review in progress by them (r0, r1…), each with no run before it. */
const reviewing = (n: number, over: Partial<Review> = {}) =>
  Effect.gen(function* () {
    const repo = yield* ReviewRepo
    const ids: Array<TaskId> = []
    for (let i = 0; i < n; i++) {
      const id = TaskId.make(`rv${i}`)
      yield* repo.insertThread(
        id,
        {
          profile_id: ProfileId.make("p"),
          project_id: PROJECT,
          parent_id: TASK,
          task_type: null,
          title: `Review ${i}`,
          description: "",
          model: null,
          effort: null,
          claude_config_id: null,
        },
        AT,
      )
      ids.push(id)
    }
    const review: Review = Object.assign(
      {
        thread_id: ids[0] ?? TASK,
        state: "running" as const,
        head: "abc",
        summary: null,
        issues: [],
        fixes: 0,
        extra_rounds: 0,
        updated_at: AT,
        started_at: AT,
        reviewers: ids.map((id, i) => ({ thread_id: id, label: `r${i}`, state: "running" as const, summary: null, issues: [], after_run: RunId.make("") })),
      },
      over,
    )
    yield* setTask(TASK, { review })
    return ids
  })

/** A reviewer's (or summarizer's) run on `thread`, as a scripted agent. */
const reviewer = (thread: TaskId) => fakeAgent({ task: thread, kind: "review" })

/** The agent's lines, handled as the follower hands them. */
const output = (agent: FakeAgent, lines: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    const handler = yield* RunOutput
    const fs = yield* FileSystem.FileSystem
    for (const line of lines) {
      yield* agent.write([line])
      const end = Number((yield* fs.stat(`${agent.dir}/out.jsonl`).pipe(Effect.orDie)).size)
      yield* handler.handle(yield* agent.row, yield* Schema.encodeEffect(Json)(line).pipe(Effect.orDie), end)
    }
  })
const RESULT = { type: "result", subtype: "success", is_error: false, total_cost_usd: 0, num_turns: 1, session_id: "s1" }
const said = (text: string) => ({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text }] }, session_id: "s1" })

/**
 * The agent's run ends (a turn ended: fine), as the follower ends it; then what the reactor does with that, and with
 * `all`, what follows from it (the runs it starts failing to launch).
 */
const ends = (agent: FakeAgent, ok = true, all = true) =>
  Effect.gen(function* () {
    if (ok) yield* output(agent, [RESULT])
    yield* (yield* RunEnds).ended({ _tag: "RunExited", run: agent.run.id, task: agent.run.task_id, exit: { code: ok ? 0 : 1, signal: null }, errorTail: "" })
    if (all) yield* settle
    else yield* (yield* Reactor).idle
  })

const submit = (thread: TaskId, agent: FakeAgent, args: Parameters<Reviews["Service"]["submit"]>[2]) =>
  Effect.gen(function* () {
    return yield* (yield* Reviews).submit(yield* task(thread), agent.run.id, args)
  })

describe("starting a review", () => {
  it.effect("each reviewer reviews in a thread of its own, with its own instructions and skills, kept to the next review", () =>
    run(
      Effect.gen(function* () {
        yield* reviewable()
        const security = R({ model: "opus", prompt: " Only look for security holes. ", skills: ["audit"] })
        yield* setProject({ review_prompt: "Check the project's rules.", reviewers: yield* json([security, R({ model: "haiku" })]) })
        const reviews = yield* Reviews
        const started = yield* reviews.start(TASK, true)
        assert.isNotNull(started)
        const r = yield* reviewOf
        assert.deepStrictEqual(
          r?.reviewers.map((p) => [p.label, p.state]),
          [
            ["Claude · opus", "running"],
            ["Claude · haiku", "running"],
          ],
        )
        const [a, b] = r?.reviewers.map((p) => p.thread_id) ?? []
        assert.isDefined(a)
        assert.isDefined(b)
        const [first, second] = [yield* asked(a), yield* asked(b)]
        assert.isTrue(first.includes("Only look for security holes.") && !first.includes("Check the project's rules."), first)
        assert.isTrue(
          first.includes("Use this skill while you review: `/audit` (invoke each with the `Skill` tool).") && !second.includes("while you review"),
          first,
        )
        assert.isTrue(second.includes("Check the project's rules.") && !second.includes("security holes"), second)
        assert.isTrue(first.startsWith('Review the work on task X-1: "Fix it".'), first)
        const repo = yield* ReviewRepo
        assert.deepStrictEqual([yield* repo.skills(a), yield* repo.skills(b)], [["audit"], []])
        const threads = yield* threadsOf(null)
        assert.deepStrictEqual(
          threads.map((t) => [t.title, t.kind, t.parent_id, t.model]).toSorted((x, y) => String(x[0]).localeCompare(String(y[0]))),
          [
            ["Review of X-1 (Claude · haiku)", "review", TASK, "haiku"],
            ["Review of X-1 (Claude · opus)", "review", TASK, "opus"],
          ],
        )
        // The reviewers can't start on a test board: their parts fail, and the review didn't finish.
        yield* settle
        const failed = yield* reviewOf
        assert.deepStrictEqual([failed?.state, failed?.reviewers[0]?.state], ["failed", "failed"])
        assert.include(yield* notices(TASK), "Review didn't finish")

        // Reviewed again with other settings, the same threads follow them.
        yield* setProject({ reviewers: yield* json([R({ model: "opus" })]) })
        yield* reviews.start(TASK, true)
        const again = yield* reviewOf
        assert.deepStrictEqual(
          again?.reviewers.map((p) => p.thread_id),
          [a],
        )
        assert.deepStrictEqual(yield* repo.skills(a), [])
        yield* settle
      }),
    ),
  )

  it.effect("a review waits for the agent, and a commit reviewed isn't reviewed again by itself", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* reviewable()
        const reviews = yield* Reviews
        const agent = yield* fakeAgent({ task: TASK })
        yield* setTask(TASK, { running: 1, status: "in_progress" })
        const refused = yield* Effect.exit(reviews.start(TASK, true))
        assert.strictEqual(refusal(refused), "Can't review: the agent is still working; its changes are reviewed when it finishes")
        assert.isNull(yield* reviews.start(TASK, false))
        yield* ends(agent)
        // Its run's end reviewed it (its column, In review, is the review's), and the parts failed to start.
        const head = yield* git(dir, ["rev-parse", "HEAD"])
        assert.strictEqual((yield* reviewOf)?.head, head)
        const passed: Review = Object.assign({}, (yield* reviewOf) ?? undefined, { state: "passed" as const })
        yield* setTask(TASK, { review: passed })
        assert.isNull(yield* reviews.start(TASK, false))
        // Asked for, it is.
        assert.isNotNull(yield* reviews.start(TASK, true))
        yield* settle
      }),
    ),
  )

  it.effect("a project that reviews by itself only; one with workflows has them review instead", () =>
    run(
      Effect.gen(function* () {
        yield* reviewable({ project: { auto_review: 0 } })
        const reviews = yield* Reviews
        assert.isNull(yield* reviews.start(TASK, false))
        yield* setProject({ auto_review: 1, use_workflows: 1 })
        assert.isNull(yield* reviews.start(TASK, false))
        assert.isNull(yield* reviewOf)
        // Review now still reviews.
        assert.isNotNull(yield* reviews.start(TASK, true))
        yield* settle
      }),
    ),
  )

  it.effect("a branch without commits of its own is reviewed only when the agent changed code", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* reviewable({ elsewhere: true })
        const reviews = yield* Reviews
        assert.isNull(yield* reviews.start(TASK, false))
        assert.isNull(yield* reviewOf)
        assert.include(yield* notices(TASK), "Not reviewed: no code changes")
        // Before its first review, a pull request counts.
        yield* setTask(TASK, { pr_url: "https://github.com/o/deploy/pull/4" })
        assert.isNotNull(yield* reviews.start(TASK, false))
        const r = yield* reviewOf
        const sent = yield* asked(r?.reviewers[0]?.thread_id ?? TASK)
        assert.isTrue(sent.includes("no commits of its own") && sent.includes("https://github.com/o/deploy/pull/4"), sent)
        yield* settle
        // After a review, only what the agent did since counts, and uncommitted changes.
        yield* setTask(TASK, { review: Object.assign({}, yield* reviewOf, { state: "issues" as const }) })
        assert.isNull(yield* reviews.start(TASK, false))
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${dir}/a.txt`, "x").pipe(Effect.orDie)
        assert.isNotNull(yield* reviews.start(TASK, false))
        yield* settle
      }),
    ),
  )

  it.effect("a task that started after its base branch is reviewed from where it started", () =>
    Effect.gen(function* () {
      for (const offMain of [true, false]) {
        yield* run(
          Effect.gen(function* () {
            const dir = yield* reviewable({ elsewhere: true })
            // It starts at a commit main doesn't have, or at main's latest, and has a pull request into main either way.
            yield* git(dir, ["checkout", "-q", "main"])
            yield* git(dir, ["branch", "-q", "-D", "ia/x"])
            let from: string
            if (offMain) {
              yield* git(dir, ["commit", "-q", "--allow-empty", "-m", "someone else's"])
              from = yield* git(dir, ["rev-parse", "HEAD"])
            } else from = yield* git(dir, ["rev-parse", "main"])
            yield* git(dir, ["checkout", "-q", "-b", "ia/x"])
            if (offMain) yield* git(dir, ["branch", "-q", "-f", "main", "HEAD~1"])
            yield* git(dir, ["update-ref", `refs/huntaway/start/${TASK}`, "HEAD"])
            yield* git(dir, ["commit", "-q", "--allow-empty", "-m", "its own"])
            yield* setTask(TASK, { base_branch: "main", start_from: { type: "commit", commit: from }, pr_url: "https://github.com/o/r/pull/3" })
            yield* (yield* Reviews).start(TASK, true)
            const [thread] = yield* threadsOf(null)
            const sent = yield* asked(thread?.id ?? TASK)
            const own = `\`git diff ${from}...HEAD\`) rather than \`pr_diff\``
            if (offMain) assert.isTrue(sent.includes(own) && sent.includes("only for its description and comments"), sent)
            else assert.isTrue(!sent.includes("rather than `pr_diff`") && sent.includes("review the pull request's changes"), sent)
            yield* settle
          }),
        )
      }
    }),
  )

  it.effect("Review now from Needs attention moves the task to In review and starts a fresh cycle of fixes", () =>
    run(
      Effect.gen(function* () {
        yield* reviewable({ status: "needs_attention" })
        yield* setTask(TASK, {
          attention_reason: "found",
          review: Object.assign({}, REVIEW_DONE, { state: "issues" as const, issues: ["x"], fixes: 2, extra_rounds: 1 }),
        })
        const t = yield* (yield* Reviews).start(TASK, true)
        assert.deepStrictEqual([t?.status, t?.attention_reason, t?.review?.fixes, t?.review?.extra_rounds], ["in_review", null, 0, 0])
        // The issues it was asked to fix are checked again.
        assert.include(
          yield* asked(t?.review?.thread_id ?? TASK),
          "The previous review found these serious issues, and the agent was asked to fix them. Check that they're fixed:\n\n- x",
        )
        yield* settle
      }),
    ),
  )
})

/** A review that finished, for tests to start from. */
const REVIEW_DONE: Review = {
  thread_id: TaskId.make("old"),
  state: "passed",
  head: "abc",
  summary: "Fine.",
  issues: [],
  fixes: 0,
  extra_rounds: 0,
  updated_at: AT,
  reviewers: [],
}

describe("a review's outcome", () => {
  it.effect("the review waits for every reviewer and combines their issues; out of rounds, it's left for the user", () =>
    run(
      Effect.gen(function* () {
        yield* reviewable({ project: { review_rounds: 0 } })
        const threads = yield* reviewing(3)
        const [a, b, c] = threads
        assert.isDefined(a)
        assert.isDefined(b)
        assert.isDefined(c)
        const ra = yield* reviewer(a)
        yield* submit(a, ra, { verdict: "pass", summary: "Looks good.", serious_issues: [] })
        yield* ends(ra)
        assert.deepStrictEqual([(yield* reviewOf)?.state, (yield* reviewOf)?.reviewers[0]?.state], ["running", "passed"])
        const rb = yield* reviewer(b)
        yield* submit(b, rb, { verdict: "needs_fixes", summary: "One bug.", serious_issues: ["the bug"] })
        yield* ends(rb)
        // The last one fails: the issues the others found still count.
        yield* ends(yield* reviewer(c), false)
        const r = yield* reviewOf
        assert.deepStrictEqual([r?.state, r?.issues], ["issues", ["(r1) the bug"]])
        assert.deepStrictEqual(
          r?.reviewers.map((p) => p.state),
          ["passed", "issues", "failed"],
        )
        // No rounds of fixes: left for the user.
        const t = yield* task()
        assert.deepStrictEqual([t.status, t.attention_reason], ["needs_attention", "The 3 reviewers found 1 serious issue"])
        assert.include(yield* notices(TASK), "The 3 reviewers found 1 serious issue")
        // A reviewer that has finished can't submit again.
        const again = yield* Effect.exit(submit(a, ra, { verdict: "pass", summary: "", serious_issues: [] }))
        assert.strictEqual(refusal(again), "no review is in progress, so there's nothing to submit")
      }),
    ),
  )

  it.effect("serious issues go back to the agent while the task waits in In review with rounds left", () =>
    run(
      Effect.gen(function* () {
        yield* reviewable()
        const [a] = yield* reviewing(1)
        assert.isDefined(a)
        const ra = yield* reviewer(a)
        yield* submit(a, ra, { verdict: "needs_fixes", summary: "A bug.", serious_issues: ["the bug"] })
        yield* ends(ra, true, false)
        const r = yield* reviewOf
        assert.deepStrictEqual([r?.state, r?.fixes], ["issues", 1])
        const sent = yield* (yield* ThreadReaders).lastUserMessage(TASK)
        assert.deepStrictEqual([sent?.review_round, sent?.auto], [1, true])
        assert.isTrue(sent?.text.startsWith("The review found 1 serious issue in your changes:\n\n1. the bug\n\n") ?? false, sent?.text)
        yield* settle
      }),
    ),
  )

  it.effect("a passed review starts the summaries", () =>
    run(
      Effect.gen(function* () {
        yield* reviewable()
        const [a] = yield* reviewing(1)
        assert.isDefined(a)
        const ra = yield* reviewer(a)
        yield* submit(a, ra, { verdict: "pass", summary: "Fine.", serious_issues: [] })
        yield* ends(ra, true, false)
        const t = yield* task()
        assert.deepStrictEqual([t.review?.state, t.summaries.map((s) => s.state)], ["passed", ["running"]])
        assert.include(yield* notices(TASK), "Review passed")
        yield* settle
      }),
    ),
  )

  it.effect("each submission is kept for statistics, with the effort the work was done at", () =>
    run(
      Effect.gen(function* () {
        yield* reviewable()
        const sql = yield* SqlClient.SqlClient
        const [a, b, c] = yield* reviewing(3, { started_at: Timestamp.make("2026-10-01T10:00:00.000Z") })
        assert.isDefined(a)
        assert.isDefined(b)
        assert.isDefined(c)
        const work = (at: string, effort: string | null) =>
          Effect.gen(function* () {
            const agent = yield* fakeAgent({ task: TASK })
            yield* sql`UPDATE runs SET created_at = ${at}, effort = ${effort}, status = 'exited' WHERE id = ${agent.run.id}`.pipe(Effect.orDie)
          })
        // A task from before runs kept their efforts: what it's set to now, the host's default while it has none of its own.
        yield* sql`INSERT INTO settings (key, value) VALUES ('default_effort', 'medium')`.pipe(Effect.orDie)
        yield* work("1969-12-29T00:00:00.000Z", null)
        const ra = yield* reviewer(a)
        yield* submit(a, ra, { verdict: "pass", summary: "Fine at first.", serious_issues: [] })
        // Submitted again in the same run: this one counts instead.
        yield* submit(a, ra, { verdict: "needs_fixes", summary: "One bug, and a nit.", serious_issues: ["the bug"], minor_issues: ["a nit", "another"] })
        // The work run's own effort, as its agent was given it, whatever the task and the host are set to after.
        yield* work("1969-12-30T00:00:00.000Z", "low")
        yield* setTask(TASK, { effort: "xhigh" })
        yield* sql`UPDATE settings SET value = 'max' WHERE key = 'default_effort'`.pipe(Effect.orDie)
        yield* submit(b, yield* reviewer(b), { verdict: "pass", summary: "Fine.", serious_issues: [] })
        // A run with the agent's own default.
        yield* work("1969-12-31T00:00:00.000Z", "")
        yield* submit(c, yield* reviewer(c), { verdict: "pass", summary: "Fine.", serious_issues: [] })
        const rows = yield* sql<{
          readonly thread_id: string
          readonly round: string
          readonly run_id: string
          readonly verdict: string
          readonly serious: number
          readonly minor: number
          readonly minor_noted: number
          readonly label: string
          readonly effort: string | null
        }>`SELECT thread_id, round, run_id, verdict, serious, minor, minor_noted, label, effort FROM review_stats ORDER BY id`.pipe(Effect.orDie)
        const round = "2026-10-01T10:00:00.000Z"
        assert.deepStrictEqual(
          rows.map((r) => [r.thread_id, r.round, r.run_id === ra.run.id, r.verdict, r.serious, r.minor, r.minor_noted, r.label, r.effort]),
          [
            [a, round, true, "issues", 1, 2, 1, "r0", "medium"],
            [b, round, false, "pass", 0, 0, 0, "r1", "low"],
            [c, round, false, "pass", 0, 0, 0, "r2", null],
          ],
        )
      }),
    ),
  )

  it.effect("a verdict from an earlier round doesn't count", () =>
    run(
      Effect.gen(function* () {
        yield* reviewable()
        const [thread] = yield* reviewing(1)
        assert.isDefined(thread)
        // A's verdict is cut short (it never submits), A ends, and B starts the next round.
        const a = yield* reviewer(thread)
        yield* ends(a)
        assert.deepStrictEqual(
          [(yield* reviewOf)?.state, (yield* reviewOf)?.reviewers[0]?.summary],
          ["failed", "The reviewer finished without submitting a verdict."],
        )
        const r = (yield* reviewOf) ?? REVIEW_DONE
        yield* setTask(TASK, {
          review: Object.assign({}, r, {
            state: "running" as const,
            reviewers: r.reviewers.map((p) => Object.assign({}, p, { state: "running" as const, after_run: a.run.id })),
          }),
        })
        const b = yield* reviewer(thread)
        yield* submit(thread, b, { verdict: "needs_fixes", summary: "A bug.", serious_issues: ["the bug"] })
        // A's verdict, retried, is turned away; B's stands.
        const late = yield* Effect.exit(submit(thread, a, { verdict: "pass", summary: "", serious_issues: [] }))
        assert.strictEqual(refusal(late), "the review this run was asked for has ended, so there's nothing to submit")
        yield* ends(b)
        const after = yield* reviewOf
        assert.deepStrictEqual([after?.state, after?.issues], ["issues", ["the bug"]])
      }),
    ),
  )

  it.effect("submit_review is only for a review thread with a part in progress", () =>
    run(
      Effect.gen(function* () {
        yield* reviewable()
        const reviews = yield* Reviews
        const agent = yield* fakeAgent({ task: TASK })
        const own = yield* Effect.exit(reviews.submit(yield* task(), agent.run.id, { verdict: "pass", serious_issues: [] }))
        assert.strictEqual(refusal(own), "submit_review is only for review threads")
        const [thread] = yield* reviewing(1, { state: "passed" })
        assert.isDefined(thread)
        const none = yield* Effect.exit(submit(thread, yield* reviewer(thread), { verdict: "pass", serious_issues: [] }))
        assert.strictEqual(refusal(none), "no review is in progress, so there's nothing to submit")
      }),
    ),
  )
})

describe("stopping a review", () => {
  it.effect("the agent working again stops every reviewer; the stopped runs ending don't change it", () =>
    run(
      Effect.gen(function* () {
        yield* reviewable()
        const [a, b] = yield* reviewing(2)
        assert.isDefined(a)
        assert.isDefined(b)
        const ra = yield* reviewer(a)
        yield* submit(a, ra, { verdict: "pass", summary: "", serious_issues: [] })
        yield* ends(ra)
        const rb = yield* reviewer(b)
        yield* (yield* Runs).send(TASK, { text: "one more thing", source: "user" })
        yield* (yield* Reactor).idle
        const r = yield* reviewOf
        assert.deepStrictEqual([r?.state, r?.summary], ["stopped", "Stopped because the agent started working on the task again."])
        assert.deepStrictEqual(
          r?.reviewers.map((p) => p.state),
          ["passed", "stopped"],
        )
        // Its reviewer was asked to stop.
        assert.strictEqual((yield* rb.row).stop, "requested")
        yield* ends(rb, false)
        assert.strictEqual((yield* reviewOf)?.state, "stopped")
      }),
    ),
  )

  it.effect("the user's Stop stops the review and the summaries", () =>
    run(
      Effect.gen(function* () {
        yield* reviewable()
        yield* reviewing(2)
        const reviews = yield* Reviews
        assert.deepStrictEqual(yield* reviews.stopTask(TASK), { stopped: true })
        const r = yield* reviewOf
        assert.deepStrictEqual([r?.state, r?.summary], ["stopped", "Stopped by the user."])
        assert.isTrue(r?.reviewers.every((p) => p.state === "stopped"))
        assert.include(yield* notices(TASK), "Review stopped")
        // Nothing left to stop.
        assert.deepStrictEqual(yield* reviews.stopTask(TASK), { stopped: false })
      }),
    ),
  )

  it.effect("a reviewer whose run never started, or whose end the server missed, still ends its part after a restart", () =>
    run(
      Effect.gen(function* () {
        yield* reviewable()
        const [a, b] = yield* reviewing(2)
        assert.isDefined(a)
        assert.isDefined(b)
        // B's run submitted and ended, but the server stopped before its end was handled.
        const rb = yield* reviewer(b)
        yield* submit(b, rb, { verdict: "pass", summary: "Fine.", serious_issues: [] })
        yield* output(rb, [RESULT])
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE runs SET status = 'exited' WHERE id = ${rb.run.id}`.pipe(Effect.orDie)
        yield* (yield* Reviews).reconcileAll
        const r = yield* reviewOf
        assert.deepStrictEqual(
          r?.reviewers.map((p) => [p.state, p.summary]),
          [
            ["failed", "Couldn't start the review: the server stopped first"],
            ["passed", "Fine."],
          ],
        )
        assert.strictEqual(r?.state, "failed")
      }),
    ),
  )
})

/** A task with `rounds` rounds of fixes whose review found an issue after `fixes` of them. */
const outOfRounds = (rounds: number, fixes: number) =>
  Effect.gen(function* () {
    yield* reviewable({ status: "needs_attention", project: { review_rounds: rounds } })
    yield* setTask(TASK, { attention_reason: "found", review: Object.assign({}, REVIEW_DONE, { state: "issues" as const, issues: ["the bug"], fixes }) })
  })

describe("more rounds of fixes", () => {
  it.effect("a task out of rounds of fixes can be given as many again", () =>
    run(
      Effect.gen(function* () {
        yield* outOfRounds(2, 2)
        const reviews = yield* Reviews
        const t = yield* reviews.extend(TASK)
        assert.deepStrictEqual([t.status, t.attention_reason, t.running], ["in_progress", null, true])
        assert.deepStrictEqual([t.review?.fixes, t.review?.extra_rounds], [3, 2])
        const sent = yield* (yield* ThreadReaders).lastUserMessage(TASK)
        assert.strictEqual(sent?.review_round, 3)
        assert.include(sent?.text ?? "", "1. the bug")
        assert.include(yield* notices(TASK), "Given 2 more rounds of fixes")
        // Not twice.
        const twice = yield* Effect.exit(reviews.extend(TASK))
        assert.strictEqual(refusal(twice), "the task hasn't used up its rounds of fixes")
        yield* settle
      }),
    ),
  )

  it.effect("rounds of fixes are given back if the agent can't start", () =>
    run(
      Effect.gen(function* () {
        // A project with no rounds of fixes gets one; this host runs no agents.
        yield* outOfRounds(0, 0)
        assert.isTrue(Exit.isFailure(yield* Effect.exit((yield* Reviews).extend(TASK))))
        const t = yield* task()
        assert.deepStrictEqual([t.review?.fixes, t.review?.extra_rounds, t.status], [0, 0, "needs_attention"])
      }),
      { noAgents: true },
    ),
  )
})

/** A task whose review passed, in a project that summarises. */
const passed = (project: Readonly<Record<string, unknown>> = {}) =>
  Effect.gen(function* () {
    const dir = yield* reviewable({ project })
    yield* setTask(TASK, { review: REVIEW_DONE })
    return dir
  })

/** A summary being written in `id`. */
const beingWritten = (id: TaskId): ChangeSummary => ({ thread_id: id, label: "Claude", state: "running", head: "abc", text: null, updated_at: AT })

describe("summaries", () => {
  const summaries = Effect.map(task(), (t) => t.summaries)

  it.effect("a passed review is summarised by the project's summarizer, in a thread of its own", () =>
    run(
      Effect.gen(function* () {
        yield* passed({ summarizers: yield* json([R({ model: "haiku" })]) })
        const s = yield* Summaries
        assert.isNotNull(yield* s.start(TASK, false))
        const [sum] = yield* summaries
        assert.deepStrictEqual([sum?.state, sum?.label], ["running", "Claude · haiku"])
        const threads = yield* threadsOf("summary")
        assert.deepStrictEqual(
          threads.map((t) => [t.id, t.model, t.parent_id, t.title]),
          [[sum?.thread_id ?? null, "haiku", TASK, "Summary of X-1"]],
        )
        const text = yield* asked(sum?.thread_id ?? TASK)
        assert.isTrue(text.startsWith('Summarise the changes made for task X-1: "Fix it".') && text.includes("> Fine."), text)
        // The task stays where it is; its summary can't be written on a test board.
        yield* settle
        assert.strictEqual((yield* task()).status, "in_review")
        assert.strictEqual((yield* summaries)[0]?.state, "failed")
        // Asked for, it's written again, in the same thread.
        assert.isNotNull(yield* s.start(TASK, true))
        assert.strictEqual((yield* threadsOf("summary")).length, 1)
        yield* settle
      }),
    ),
  )

  it.effect("a summary is what its summarizer wrote since it was asked; a commit summarised isn't again by itself", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* passed()
        const s = yield* Summaries
        yield* s.start(TASK, false)
        yield* settle
        const [thread] = yield* threadsOf("summary")
        assert.isDefined(thread)
        const head = yield* git(dir, ["rev-parse", "HEAD"])
        const writing = (after: RunId): ChangeSummary => ({
          thread_id: thread.id,
          label: "Claude",
          state: "running",
          head,
          text: null,
          after_run: after,
          updated_at: AT,
        })
        const latest = yield* (yield* ReviewRepo).latestRun(thread.id)
        yield* setTask(TASK, { summaries: [writing(latest ?? RunId.make(""))] })
        const agent = yield* reviewer(thread.id)
        yield* output(agent, [said("  ## What changed\n\nA fix.  ")])
        yield* ends(agent)
        const [done] = yield* summaries
        assert.deepStrictEqual([done?.state, done?.text], ["done", "## What changed\n\nA fix."])
        assert.include(yield* notices(TASK), "Changes summarised")
        // This commit has its summary.
        assert.isNull(yield* s.start(TASK, false))
        // A run that says nothing new doesn't pass off the last summary as its own.
        yield* setTask(TASK, { summaries: [writing(agent.run.id)] })
        yield* (yield* Threads).userMessage(thread.id, "again", { auto: true }).pipe(Effect.orDie)
        yield* ends(yield* reviewer(thread.id))
        assert.strictEqual((yield* summaries)[0]?.state, "failed")
      }),
    ),
  )

  it.effect("only a passed review in a project that summarises is summarised by itself", () =>
    run(
      Effect.gen(function* () {
        yield* passed({ auto_summary: 0 })
        const s = yield* Summaries
        assert.isNull(yield* s.start(TASK, false))
        yield* setProject({ auto_summary: 1 })
        yield* setTask(TASK, { review: Object.assign({}, REVIEW_DONE, { state: "issues" as const }) })
        assert.isNull(yield* s.start(TASK, false))
        yield* setTask(TASK, { review: REVIEW_DONE, status: "ready_for_merge" })
        assert.isNull(yield* s.start(TASK, false))
        yield* setTask(TASK, { status: "in_review" })
        yield* setProject({ use_workflows: 1 })
        assert.isNull(yield* s.start(TASK, false))
        assert.deepStrictEqual([(yield* summaries).length, (yield* threadsOf("summary")).length], [0, 0])
      }),
    ),
  )

  it.effect("a project without summarizers uses its profile's, and its own over them", () =>
    run(
      Effect.gen(function* () {
        yield* passed()
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE profiles SET summarizers = ${yield* json([R({ model: "haiku" })])} WHERE id = 'p'`.pipe(Effect.orDie)
        const s = yield* Summaries
        yield* s.start(TASK, false)
        assert.strictEqual((yield* summaries)[0]?.label, "Claude · haiku")
        yield* settle
        yield* setProject({ summarizers: yield* json([R({ model: "sonnet" })]) })
        yield* s.start(TASK, true)
        assert.strictEqual((yield* summaries)[0]?.label, "Claude · sonnet")
        assert.strictEqual((yield* threadsOf("summary")).length, 2)
        yield* settle
      }),
    ),
  )

  it.effect(
    "each summarizer writes in a thread of its own; one added later is written without redoing the others; out or reordered, the summaries follow",
    () =>
      run(
        Effect.gen(function* () {
          const dir = yield* passed()
          const plain = R({ name: "Plain" })
          const skilled = R({ name: "Skilled", skills: ["tldr"], prompt: "Be brief." })
          yield* setProject({ summarizers: yield* json([plain, skilled]) })
          const s = yield* Summaries
          yield* s.start(TASK, false)
          let all = yield* summaries
          assert.deepStrictEqual(
            all.map((x) => [x.name ?? null, x.state, x.skills ?? [], x.custom_prompt ?? false]),
            [
              ["Plain", "running", [], false],
              ["Skilled", "running", ["tldr"], true],
            ],
          )
          const [p, k] = all.map((x) => x.thread_id)
          assert.isDefined(p)
          assert.isDefined(k)
          assert.strictEqual((yield* task(k)).title, "Summary of X-1 · Skilled")
          const [pt, kt] = [yield* asked(p), yield* asked(k)]
          assert.isTrue(!pt.includes("/tldr") && kt.includes("`/tldr`") && kt.includes("Be brief."), kt)
          yield* settle
          // Both written at this commit: nothing to write, until a summarizer is added.
          const head = yield* git(dir, ["rev-parse", "HEAD"])
          const done = (id: TaskId, name: string): ChangeSummary => ({
            thread_id: id,
            label: "Claude",
            name,
            state: "done",
            head,
            text: "Done.",
            updated_at: AT,
          })
          yield* setTask(TASK, { summaries: [done(p, "Plain"), done(k, "Skilled")] })
          assert.isNull(yield* s.start(TASK, false))
          yield* setProject({ summarizers: yield* json([plain, skilled, R({ model: "haiku" })]) })
          assert.isNotNull(yield* s.start(TASK, false))
          all = yield* summaries
          assert.deepStrictEqual(
            all.map((x) => x.state),
            ["done", "done", "running"],
          )
          // The others' threads weren't asked again.
          assert.strictEqual(yield* asked(p), pt)
          yield* settle
          // Reordered: the summaries follow. One taken out: its summary goes.
          yield* setTask(TASK, { summaries: [done(p, "Plain"), done(k, "Skilled")] })
          yield* setProject({ summarizers: yield* json([skilled, plain]) })
          assert.isNull(yield* s.start(TASK, false))
          assert.deepStrictEqual(
            (yield* summaries).map((x) => x.name),
            ["Skilled", "Plain"],
          )
          yield* setProject({ summarizers: yield* json([plain]) })
          assert.isNull(yield* s.start(TASK, false))
          assert.deepStrictEqual(
            (yield* summaries).map((x) => x.name),
            ["Plain"],
          )
        }),
      ),
  )

  it.effect("the agent working again, or the user's Stop, stops the summaries being written", () =>
    run(
      Effect.gen(function* () {
        yield* passed()
        const t1 = TaskId.make("s1")
        const t2 = TaskId.make("s2")
        yield* setTask(TASK, { summaries: [Object.assign(beingWritten(t1), { state: "done" as const }), beingWritten(t2)] })
        assert.deepStrictEqual(yield* (yield* Reviews).stopTask(TASK), { stopped: true })
        assert.deepStrictEqual(
          (yield* summaries).map((x) => [x.state, x.text]),
          [
            ["done", null],
            ["stopped", "Stopped by the user."],
          ],
        )
        yield* setTask(TASK, { summaries: [beingWritten(t2)] })
        yield* (yield* Runs).send(TASK, { text: "one more thing", source: "user" })
        yield* (yield* Reactor).idle
        assert.deepStrictEqual(
          (yield* summaries).map((x) => [x.state, x.text]),
          [["stopped", "Stopped because the agent started working on the task again."]],
        )
        yield* settle
      }),
    ),
  )

  it.effect("a review doesn't take a summary thread for a reviewer's", () =>
    run(
      Effect.gen(function* () {
        yield* passed()
        yield* (yield* Summaries).start(TASK, false)
        yield* settle
        const [thread] = yield* threadsOf("summary")
        yield* (yield* Reviews).start(TASK, true)
        assert.notStrictEqual((yield* reviewOf)?.reviewers[0]?.thread_id, thread?.id)
        yield* settle
      }),
    ),
  )
})
