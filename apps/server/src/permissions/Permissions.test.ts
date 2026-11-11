import { existsSync, mkdirSync, symlinkSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Option, Result, Schema } from "effect"
import type { Scope } from "effect"
import type { SecureRandom } from "effect/crypto"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { ProfileId, RequestId, TaskId, Timestamp } from "@huntaway/contracts"
import type { PermissionAnswer, PermissionMode } from "@huntaway/contracts"
import { blockedReason } from "@huntaway/shared"
import type { Decision as RuleDecision } from "@huntaway/shared"
import { fakeAgent, TestBoard } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { ApprovalRules } from "../agents/ApprovalRules.ts"
import { DataDir } from "../platform/DataDir.ts"
import { AgentRequests } from "../runs/AgentRequests.ts"
import type { RunDir } from "../runs/RunDir.ts"
import { RunOutput } from "../runs/RunOutput.ts"
import { RunRepo } from "../runs/RunRepo.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Threads } from "../threads/Threads.ts"
import { ThreadStore } from "../threads/ThreadStore.ts"
import { PermissionRepo } from "./PermissionRepo.ts"
import { DONT_ASK_DENIAL, EXPIRED, EXPIRED_UNANSWERED, Permissions, promptCallId } from "./Permissions.ts"
import type { Decision } from "./Permissions.ts"
import { reason } from "./prompts.ts"

// Permission prompts on the whole board's services (huntaway's mcp/permissions/tests.test.ts, and the can_use_tool cases
// of agent/runner/requests.test.ts), with a scripted agent (`fakeAgent`) whose run is the task's live one. Ported as the
// old cases are, with `asking` standing in for the old `asked` loop that polled for the row.
//
// Dropped: Codex's questions answered by id (and `agent: "codex"` on the card) wait for Codex (M5); "a prompt from before
// answers were taken" is an old board's row without the columns this one adds, which the importer (11) writes; "a late
// approval leaves plan mode before its message starts a run" needs a run to start (`TEST_CAN_RUN`): the order (mode, then
// the message) is held by `answer` and checked by the late-answer case below through `Runs.send`.

type Env =
  | Permissions
  | DataDir
  | PermissionRepo
  | ApprovalRules
  | RunRepo
  | RunOutput
  | RunDir
  | AgentRequests
  | TaskRepo
  | Threads
  | ThreadStore
  | SqlClient.SqlClient
  | FileSystem.FileSystem
  | SecureRandom.SecureRandom
  | Scope.Scope

const run = <A, E>(effect: Effect.Effect<A, E, Env>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

const AT = Timestamp.make("2026-11-12T00:00:00.000Z")
const Json = Schema.fromJsonString(Schema.Unknown)

/** A running task of profile "p" (its own mode as given), and its run. */
const runningTask = (columns: { readonly mode?: PermissionMode; readonly task_type?: string } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES ('p', 'p', ${AT})`.pipe(Effect.orDie)
    const n = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM tasks`.pipe(
      Effect.map((rows) => rows[0]?.n ?? 0),
      Effect.orDie,
    )
    const id = TaskId.make(`t-${n}`)
    yield* sql`INSERT INTO tasks ${sql.insert({
      id,
      profile_id: ProfileId.make("p"),
      number: n + 1,
      title: "A task",
      status: "in_progress",
      running: 1,
      permission_mode: columns.mode ?? null,
      task_type: columns.task_type ?? null,
      last_activity_at: AT,
      created_at: AT,
      updated_at: AT,
    })}`.pipe(Effect.orDie)
    const agent = yield* fakeAgent({ task: id })
    return { task: id, agent }
  })

const setMode = (task: TaskId, mode: PermissionMode | null) =>
  Effect.gen(function* () {
    yield* (yield* TaskRepo).write(task, { permission_mode: mode }, AT)
  })

const taskRow = (id: TaskId) =>
  Effect.gen(function* () {
    const t = yield* (yield* TaskRepo).get(id)
    return t === null ? yield* Effect.die(`task ${id} is gone`) : t
  })

/** The run has ended, and the task's agent with it: a message for it now starts a run (its user message is written as it registers). */
const ended = (task: TaskId, agent: FakeAgent) =>
  Effect.gen(function* () {
    yield* (yield* RunRepo).end(agent.run.id, AT)
    yield* (yield* TaskRepo).write(task, { running: false }, AT)
  })

/** Asks about `tool` as call `call` of the agent's run, and waits until it is waiting on the user. */
const asked = (agent: FakeAgent, call: string, tool: string, input: unknown) =>
  Effect.gen(function* () {
    const permissions = yield* Permissions
    const told = yield* Effect.forkChild(permissions.ask({ run: agent.run, call_id: call }, { tool_name: tool, input, tool_use_id: null }))
    // (A prompt that fails before it waits ends the test with its cause.)
    const id = yield* Effect.raceFirst(
      permissions.asking(call),
      Effect.flatMap(Fiber.join(told), (d) => Effect.die(`decided without asking ${call}: ${d.behavior}`)),
    )
    return { id, told }
  })

/** What a prompt asked straight away (decided without the user). */
const decided = (agent: FakeAgent, call: string, tool: string, input: unknown = {}) =>
  Effect.gen(function* () {
    return yield* (yield* Permissions).ask({ run: agent.run, call_id: call }, { tool_name: tool, input, tool_use_id: null })
  })

const answer = (id: RequestId, a: PermissionAnswer) =>
  Effect.gen(function* () {
    return yield* (yield* Permissions).answer(id, a, "user")
  })
const tag = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) => Effect.map(Effect.flip(effect), (e) => e._tag)
const row = (id: RequestId) =>
  Effect.gen(function* () {
    const r = yield* (yield* PermissionRepo).get(id)
    return Option.isSome(r) ? r.value : yield* Effect.die(`no prompt ${id}`)
  })
/** The card data the thread's request carries. */
const card = (task: TaskId, id: RequestId) =>
  Effect.gen(function* () {
    const r = yield* (yield* ThreadStore).request(task, id)
    return r?.request.metadata ?? {}
  })

const twoQuestions = {
  questions: [
    { question: "Which season?", header: "Season", multiSelect: false, options: [{ label: "Summer", description: "Warm" }, { label: "Winter" }] },
    { question: "Which pets?", header: "Pets", multiSelect: true, options: [{ label: "Cats" }, { label: "Dogs" }, { label: "Birds" }] },
  ],
}

const deny = (message: string): Decision => ({ behavior: "deny", message })

describe("Permissions", () => {
  it.effect("answers to Claude's questions go back as its tool takes them", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* runningTask()
        const { id, told } = yield* asked(agent, "c1", "AskUserQuestion", twoQuestions)
        // The task says what it's waiting for: a question, not a permission.
        let t = yield* taskRow(task)
        assert.deepStrictEqual([t.status, t.attention_reason], ["needs_attention", "Which season? (and 1 more question)"])
        // Answers are checked against the questions.
        assert.strictEqual(yield* tag(answer(id, { decision: "allow", answers: [["Summer"]] })), "Invalid")
        assert.strictEqual(yield* tag(answer(id, { decision: "allow", answers: [["Summer", "Winter"], []] })), "Invalid")

        assert.strictEqual(yield* answer(id, { decision: "allow", answers: [[" Summer "], ["Cats", "Birds", "a lizard"]] }), "allowed")
        const updated = { ...twoQuestions, answers: { "Which season?": "Summer", "Which pets?": "Cats, Birds, a lizard" } }
        assert.deepStrictEqual(yield* Fiber.join(told), { behavior: "allow", updatedInput: updated })
        const shown = yield* card(task, id)
        assert.deepStrictEqual([shown["status"], shown["answers"]], ["allowed", [["Summer"], ["Cats", "Birds", "a lizard"]]])
        t = yield* taskRow(task)
        assert.deepStrictEqual([t.status, t.attention_reason], ["in_progress", null])
        // Not as an always-allowed tool.
        assert.deepStrictEqual(t.auto_allow, [])
      }),
    ),
  )

  it.effect("questions are asked whatever the thread's mode, unless it asks nothing", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* runningTask({ mode: "bypassPermissions" })
        // Bypass allows a tool call, but a question is still the user's to answer.
        assert.strictEqual((yield* decided(agent, "b", "Bash", { command: "ls" })).behavior, "allow")
        const question = yield* asked(agent, "q", "AskUserQuestion", twoQuestions)
        yield* setMode(task, "default")
        const bash = yield* asked(agent, "b2", "Bash", {})
        // Switching to Bypass settles the tool call, not the question.
        yield* setMode(task, "bypassPermissions")
        const permissions = yield* Permissions
        yield* permissions.applyMode(task)
        assert.strictEqual((yield* Fiber.join(bash.told)).behavior, "allow")
        assert.deepStrictEqual([(yield* row(bash.id)).status, (yield* row(question.id)).status], ["allowed", "pending"])
        // Don't ask denies it, as it does every prompt.
        yield* setMode(task, "dontAsk")
        yield* permissions.applyMode(task)
        assert.deepStrictEqual(yield* Fiber.join(question.told), deny(DONT_ASK_DENIAL))
        assert.strictEqual((yield* decided(agent, "q2", "AskUserQuestion", twoQuestions)).behavior, "deny")
      }),
    ),
  )

  it.effect("only the first answer counts: two at once, one wins", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* runningTask()
        const { id, told } = yield* asked(agent, "c1", "AskUserQuestion", twoQuestions)
        const [a, b] = yield* Effect.all(
          [
            Effect.result(answer(id, { decision: "allow", answers: [["Summer"], []] })),
            Effect.result(answer(id, { decision: "allow", answers: [["Winter"], []] })),
          ],
          { concurrency: 2 },
        )
        assert.strictEqual([a, b].filter(Result.isSuccess).length, 1)
        const loser = Result.isFailure(a) ? a : b
        assert.strictEqual(Result.isFailure(loser) ? loser.failure._tag : null, "PromptNotPending")
        const given = yield* Fiber.join(told)
        const season =
          given.behavior === "allow" && typeof given.updatedInput === "object" && given.updatedInput !== null
            ? Reflect.get(Reflect.get(given.updatedInput, "answers"), "Which season?")
            : null
        const shown = yield* card(task, id)
        assert.deepStrictEqual(shown["answers"], [[season], []])
        // Nor can it be denied after.
        assert.strictEqual(yield* tag(answer(id, { decision: "deny" })), "PromptNotPending")
      }),
    ),
  )

  it.effect("an answer that comes as the waiter registers, before it reads the row, is taken", () =>
    run(
      Effect.gen(function* () {
        const { agent } = yield* runningTask()
        const permissions = yield* Permissions
        const told = yield* Effect.forkChild(
          permissions.ask({ run: agent.run, call_id: "c1" }, { tool_name: "Bash", input: { command: "ls" }, tool_use_id: null }),
        )
        // Answered the moment it is waited on.
        const id = yield* permissions.asking("c1")
        yield* answer(id, { decision: "allow" })
        assert.deepStrictEqual(yield* Fiber.join(told), { behavior: "allow", updatedInput: { command: "ls" } })
        // Delivered again (a restart), the call finds the same prompt and its answer at once.
        assert.deepStrictEqual(yield* decided(agent, "c1", "Bash", { command: "ls" }), { behavior: "allow", updatedInput: { command: "ls" } })
      }),
    ),
  )

  it.effect("an approved plan carries on in the mode picked", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* runningTask({ mode: "plan" })
        const plan = { plan: "# Plan: add a cache\n\n1. Do it", planFilePath: "/p.md" }
        let p = yield* asked(agent, "p1", "ExitPlanMode", plan)
        assert.strictEqual((yield* taskRow(task)).attention_reason, "Plan ready for approval: add a cache")
        // Sent back with feedback.
        assert.strictEqual(yield* answer(p.id, { decision: "deny", feedback: " Add tests too. " }), "denied")
        const denied = yield* Fiber.join(p.told)
        assert.isTrue(denied.behavior === "deny" && denied.message.endsWith("Their feedback:\n\nAdd tests too."))
        assert.strictEqual((yield* card(task, p.id))["feedback"], "Add tests too.")
        assert.strictEqual((yield* taskRow(task)).permission_mode, "plan")

        // Approved, into Accept edits: the agent's Claude Code switches to it too.
        p = yield* asked(agent, "p2", "ExitPlanMode", plan)
        assert.strictEqual(yield* tag(answer(p.id, { decision: "allow", mode: "plan" })), "Invalid")
        yield* answer(p.id, { decision: "allow", mode: "acceptEdits" })
        assert.deepStrictEqual(yield* Fiber.join(p.told), {
          behavior: "allow",
          updatedInput: plan,
          updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
        })
        assert.strictEqual((yield* taskRow(task)).permission_mode, "acceptEdits")
        assert.strictEqual((yield* card(task, p.id))["mode"], "acceptEdits")

        // Into the thread's default (Ask): its own mode is cleared, and Claude Code goes to Ask by itself.
        yield* setMode(task, "plan")
        p = yield* asked(agent, "p3", "ExitPlanMode", plan)
        yield* answer(p.id, { decision: "allow", mode: "default" })
        assert.deepStrictEqual(yield* Fiber.join(p.told), { behavior: "allow", updatedInput: plan })
        assert.strictEqual((yield* taskRow(task)).permission_mode, null)

        // Without a pick: out of Plan, as before.
        yield* setMode(task, "plan")
        p = yield* asked(agent, "p4", "ExitPlanMode", plan)
        yield* answer(p.id, { decision: "allow" })
        assert.strictEqual((yield* Fiber.join(p.told)).behavior, "allow")
        assert.strictEqual((yield* taskRow(task)).permission_mode, null)
      }),
    ),
  )

  it.effect("approving a plan in the thread's own mode keeps it", () =>
    run(
      Effect.gen(function* () {
        // Its own mode is Accept edits (the host's default is Ask), and the agent went into plan mode by itself.
        const { task, agent } = yield* runningTask({ mode: "acceptEdits" })
        const plan = { plan: "Do it" }
        let p = yield* asked(agent, "p1", "ExitPlanMode", plan)
        yield* answer(p.id, { decision: "allow", mode: "acceptEdits" })
        const told = yield* Fiber.join(p.told)
        assert.deepStrictEqual(told.behavior === "allow" ? told.updatedPermissions : null, [{ type: "setMode", mode: "acceptEdits", destination: "session" }])
        assert.strictEqual((yield* taskRow(task)).permission_mode, "acceptEdits")
        p = yield* asked(agent, "p2", "ExitPlanMode", plan)
        yield* answer(p.id, { decision: "allow" })
        assert.strictEqual((yield* taskRow(task)).permission_mode, "acceptEdits")
        // Picking the default is a change back to it.
        p = yield* asked(agent, "p3", "ExitPlanMode", plan)
        yield* answer(p.id, { decision: "allow", mode: "default" })
        assert.strictEqual((yield* taskRow(task)).permission_mode, null)
        // A thread set to Ask itself stays so.
        yield* setMode(task, "default")
        p = yield* asked(agent, "p4", "ExitPlanMode", plan)
        yield* answer(p.id, { decision: "allow", mode: "default" })
        assert.strictEqual((yield* taskRow(task)).permission_mode, "default")
      }),
    ),
  )

  it.effect("a question or plan whose run ended is answered by message; a tool call isn't", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* runningTask()
        const question = yield* asked(agent, "c1", "AskUserQuestion", twoQuestions)
        const bash = yield* asked(agent, "c2", "Bash", { command: "ls" })
        const plan = yield* asked(agent, "c3", "ExitPlanMode", { plan: "Do it" })
        const permissions = yield* Permissions
        // Its run ended.
        yield* ended(task, agent)
        yield* permissions.expireFor({ _tag: "Task", task })
        assert.deepStrictEqual(yield* Fiber.join(question.told), deny(EXPIRED))
        assert.strictEqual(yield* tag(answer(bash.id, { decision: "allow" })), "PromptNotPending")

        assert.strictEqual(yield* answer(question.id, { decision: "allow", answers: [["Winter"], ["Dogs"]] }), "allowed")
        const said = (yield* (yield* Threads).stored(task)).entries.flatMap((e) => (e.item.type === "user_message" ? [e.item.text] : []))
        assert.deepStrictEqual(said, ["My answers to the questions you asked:\n\n- Which season?\n  Winter\n- Which pets?\n  Dogs"])
        const shown = yield* card(task, question.id)
        assert.deepStrictEqual([shown["status"], shown["late"], shown["answers"]], ["allowed", true, [["Winter"], ["Dogs"]]])
        assert.strictEqual(yield* tag(answer(question.id, { decision: "allow", answers: [["Summer"], []] })), "PromptNotPending")
        // The plan, after the message the answers sent: the conversation has moved on.
        assert.strictEqual(yield* tag(answer(plan.id, { decision: "allow", mode: "acceptEdits" })), "PromptMovedOn")
        assert.strictEqual((yield* row(plan.id)).status, "expired")
      }),
    ),
  )

  it.effect("a late plan's approval leaves plan mode before its message is sent", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* runningTask({ mode: "plan" })
        const plan = yield* asked(agent, "p1", "ExitPlanMode", { plan: "Do it" })
        yield* ended(task, agent)
        yield* (yield* Permissions).expireFor({ _tag: "Task", task })
        yield* answer(plan.id, { decision: "allow", mode: "acceptEdits" })
        const t = yield* taskRow(task)
        const said = (yield* (yield* Threads).stored(task)).entries.flatMap((e) => (e.item.type === "user_message" ? [e.item.text] : []))
        assert.deepStrictEqual([t.permission_mode, said], ["acceptEdits", ["Your plan is approved: go ahead and implement it."]])
        assert.strictEqual((yield* card(task, plan.id))["status"], "allowed")
      }),
    ),
  )

  it.effect("says what a question or plan waits for", () =>
    Effect.sync(() => {
      assert.strictEqual(reason("AskUserQuestion", { questions: [{ question: "Which\n  one?" }] }), "Which one?")
      assert.strictEqual(reason("request_user_input", { questions: [{ question: "A?" }, { question: "B?" }, { question: "C?" }] }), "A? (and 2 more questions)")
      assert.strictEqual(reason("AskUserQuestion", {}), "The agent has questions for you")
      assert.strictEqual(reason("ExitPlanMode", { plan: "\n## Plan: Add a cache\nSteps" }), "Plan ready for approval: Add a cache")
      assert.strictEqual(reason("ExitPlanMode", { plan: "Just do it" }), "Plan ready for approval")
      assert.strictEqual(reason("Bash", {}), "Approve Bash?")
    }),
  )

  it.effect("lists pending prompts, all or a task's", () =>
    run(
      Effect.gen(function* () {
        const a = yield* runningTask()
        const b = yield* runningTask()
        const first = yield* asked(a.agent, "r1", "Bash", { command: "ls" })
        const second = yield* asked(b.agent, "r2", "Bash", {})
        const third = yield* asked(a.agent, "r3", "Bash", {})
        yield* answer(third.id, { decision: "allow" })
        const permissions = yield* Permissions
        assert.deepStrictEqual(
          (yield* permissions.pending({})).map((p) => p.id),
          [first.id, second.id],
        )
        const onlyA = yield* permissions.pending({ task: a.task })
        assert.deepStrictEqual(
          onlyA.map((p) => [p.id, p.task_id, p.input]),
          [[first.id, a.task, { command: "ls" }]],
        )
        assert.strictEqual((yield* permissions.pending({ profile: ProfileId.make("p") })).length, 2)
      }),
    ),
  )

  it.effect("always allows the tool from then on", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* runningTask()
        const p = yield* asked(agent, "c1", "Bash", { command: "make" })
        yield* answer(p.id, { decision: "allow_always" })
        assert.strictEqual((yield* Fiber.join(p.told)).behavior, "allow")
        assert.deepStrictEqual((yield* taskRow(task)).auto_allow, ["Bash"])
        assert.deepStrictEqual(yield* decided(agent, "c2", "Bash", { command: "ls" }), { behavior: "allow", updatedInput: { command: "ls" } })
      }),
    ),
  )
})

describe("Permissions: the thread's own documents folder (6.2)", () => {
  // The old agent/documents.test.ts the_agent_writes_its_own_folder_without_asking.
  it.effect("a labelled task's agent writes its own folder without asking, but not through a link out of it", () =>
    run(
      Effect.gen(function* () {
        // In a mode that asks before edits, which would otherwise allow them all.
        const { task, agent } = yield* runningTask({ mode: "default" })
        // A group's task (projectless with neither, it would be a scratch task, which owns its folder).
        yield* (yield* TaskRepo).write(task, { labels: ["plan"], group_name: "Shop" }, AT)
        const dataDir = yield* DataDir
        const d = dataDir.documents(task)
        const allowed = (n: string, tool: string, file: string) => Effect.map(decided(agent, n, tool, { file_path: file }), (r) => r.behavior === "allow")
        assert.isTrue(yield* allowed("c1", "Write", `${d}/plan.html`))
        assert.isTrue(yield* allowed("c2", "Edit", `${d}/notes/a.md`))
        // Not own: these ask the user.
        yield* asked(agent, "c3", "Bash", { file_path: `${d}/plan.html` })
        yield* asked(agent, "c4", "Write", { file_path: `${d}/../other/plan.html` })
        yield* asked(agent, "c5", "Write", { file_path: `${dataDir.root}/x.html` })
        yield* asked(agent, "c6", "Write", { file_path: "plan.html" })
        // Not through a link out of the folder, nor through one to a file that doesn't exist yet (writing would create it).
        mkdirSync(d, { recursive: true })
        const outside = `${dataDir.root}/elsewhere`
        mkdirSync(outside, { recursive: true })
        symlinkSync(outside, `${d}/out`)
        yield* asked(agent, "c7", "Write", { file_path: `${d}/out/x.html` })
        symlinkSync(`${outside}/missing.html`, `${d}/link.html`)
        yield* asked(agent, "c8", "Write", { file_path: `${d}/link.html` })
        symlinkSync(`${outside}/gone/x`, `${d}/deep`)
        yield* asked(agent, "c9", "Write", { file_path: `${d}/deep/y.html` })
        assert.isFalse(existsSync(`${outside}/missing.html`))
        assert.isTrue(yield* allowed("c10", "Write", `${d}/new/dir/x.html`))
        // A task with no labels (nor a folder of its own) asks.
        const code = yield* runningTask({ mode: "default" })
        yield* (yield* TaskRepo).write(code.task, { group_name: "Shop" }, AT)
        yield* asked(code.agent, "c11", "Write", { file_path: `${dataDir.documents(code.task)}/a` })
      }),
    ),
  )
})

describe("Permissions: the assistant's workspace (6.7)", () => {
  // The old agent/assistant/tests.test.ts the_assistant_writes_its_workspace_without_asking.
  it.effect("the assistant writes its workspace without asking, and only it", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* runningTask({ mode: "default", task_type: "assistant" })
        yield* (yield* TaskRepo).write(task, { work_dir: `assistants/${task}` }, AT)
        const dataDir = yield* DataDir
        const ws = `${dataDir.root}/assistants/${task}`
        mkdirSync(ws, { recursive: true })
        const allowed = (n: string, file: string) => Effect.map(decided(agent, n, "Write", { file_path: file }), (r) => r.behavior === "allow")
        assert.isTrue(yield* allowed("c1", `${ws}/MEMORY.md`))
        assert.isTrue(yield* allowed("c2", `${ws}/memory/2026-11-04.md`))
        // Not another assistant's, nor the folder of all of them.
        yield* asked(agent, "c3", "Write", { file_path: `${dataDir.root}/assistants/other/MEMORY.md` })
        yield* asked(agent, "c4", "Write", { file_path: `${ws}/../x.md` })
      }),
    ),
  )
})

// ---------- approval rules and expiry ----------

/** A running assistant (where the rules hold) with `rules`. */
const assistant = (rules: ReadonlyArray<readonly [string, RuleDecision]>, mode: PermissionMode) =>
  Effect.gen(function* () {
    const made = yield* runningTask({ mode, task_type: "assistant" })
    yield* (yield* ApprovalRules).set(ProfileId.make("p"), { rules: rules.map(([tool, decision]) => ({ tool, decision })), expiry_minutes: 30 })
    return made
  })

const log = Effect.gen(function* () {
  const entries = yield* (yield* ApprovalRules).log({ profile_id: ProfileId.make("p") })
  return entries.map((a) => [a.tool_name, a.decision, a.outcome, a.answered_by]).toReversed()
})

/** The run's turn was started by an automation (`routine`) or by the user. */
const turnBy = (task: TaskId, agent: FakeAgent, routine: boolean) =>
  Effect.gen(function* () {
    const n = yield* (yield* Threads).userMessage(task, "check the mail", routine ? { routine: true } : {})
    yield* (yield* RunRepo).update(agent.run.id, { write_no: n })
    return yield* agent.row
  })

describe("Permissions: the board's own approvals", () => {
  it.effect("are asked whatever the mode, listed for the board, and give the input approved", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* runningTask({ mode: "bypassPermissions" })
        const permissions = yield* Permissions
        const input = {
          project: null,
          task: { id: task, key: null, title: "A task" },
          delete: { id: "t-9", key: "S-9", title: "Old", status: "todo", branch: null, running: false },
          delete_branch: false,
          reason: "It's done elsewhere",
        }
        const approved = yield* Effect.forkChild(permissions.approve({ run: agent.run, call_id: "d1" }, "delete_task", "delete_task", input))
        const id = yield* permissions.asking("d1")
        assert.strictEqual((yield* taskRow(task)).attention_reason, "Delete a task?")
        assert.deepStrictEqual(
          (yield* permissions.approvals).map((a) => [a.request_id, a.kind, a.tool_name, a.status]),
          [[id, "delete_task", "delete_task", "pending"]],
        )
        // A retried call finds what it asked.
        assert.deepStrictEqual(yield* permissions.asked("d1"), Option.some(input))
        // Each is approved on its own: "always" is not kept.
        yield* answer(id, { decision: "allow_always" })
        assert.deepStrictEqual(yield* Fiber.join(approved), Result.succeed(input))
        assert.deepStrictEqual((yield* taskRow(task)).auto_allow, [])
        assert.deepStrictEqual(yield* permissions.approvals, [])
        const shown = yield* card(task, id)
        assert.deepStrictEqual([shown["kind"], shown["status"]], ["delete_task", "allowed"])
      }),
    ),
  )
})

describe("Permissions: approval rules and expiry", () => {
  it.effect("an ask rule asks the user even in Bypass, and each time", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* assistant(
          [
            ["mcp__g__send*", "ask"],
            ["mcp__g__get*", "allow"],
          ],
          "bypassPermissions",
        )
        assert.strictEqual((yield* decided(agent, "a", "Bash")).behavior, "allow")
        assert.strictEqual((yield* decided(agent, "b", "mcp__g__get_mail")).behavior, "allow")
        const input = { to: "bob@example.com", subject: "Hi" }
        const p = yield* asked(agent, "c", "mcp__g__send_mail", input)
        const shown = yield* card(task, p.id)
        assert.deepStrictEqual(shown["rule"], { tool: "mcp__g__send*", decision: "ask" })
        assert.strictEqual(shown["expires_at"], undefined, "the user started this run")
        // Switching to Bypass (again) doesn't answer it for the user.
        yield* (yield* Permissions).applyMode(task)
        assert.strictEqual((yield* row(p.id)).status, "pending")
        assert.deepStrictEqual(yield* log, [["mcp__g__send_mail", "ask", "pending", null]])
        // "Always allow" allows it this once: the rule asks next time too.
        yield* answer(p.id, { decision: "allow_always" })
        assert.deepStrictEqual(yield* Fiber.join(p.told), { behavior: "allow", updatedInput: input })
        assert.deepStrictEqual((yield* taskRow(task)).auto_allow, [])
        assert.deepStrictEqual(yield* log, [["mcp__g__send_mail", "ask", "allowed", "user"]])
        const again = yield* asked(agent, "d", "mcp__g__send_mail", { to: "eve@example.com" })
        yield* (yield* Permissions).answer(again.id, { decision: "deny" }, "push")
        assert.strictEqual((yield* Fiber.join(again.told)).behavior, "deny")
        const [latest] = yield* (yield* ApprovalRules).log({ profile_id: ProfileId.make("p") })
        assert.deepStrictEqual([latest?.outcome, latest?.answered_by, latest?.summary, latest?.request_id], ["denied", "push", "to: eve@example.com", again.id])
      }),
    ),
  )

  it.effect("never rules block, and Don't ask denies what a rule asks", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* assistant(
          [
            ["mcp__g__send*", "ask"],
            ["mcp__g__*delete*", "never"],
          ],
          "default",
        )
        assert.deepStrictEqual(yield* decided(agent, "a", "mcp__g__delete_mail", { id: "m1" }), deny(blockedReason("mcp__g__*delete*")))
        yield* setMode(task, "dontAsk")
        assert.deepStrictEqual(yield* decided(agent, "b", "mcp__g__send_mail"), deny(DONT_ASK_DENIAL))
        // Neither was asked.
        assert.deepStrictEqual(yield* (yield* Permissions).pending({}), [])
        assert.deepStrictEqual(yield* log, [
          ["mcp__g__delete_mail", "never", "blocked", "rule"],
          ["mcp__g__send_mail", "ask", "denied", "mode"],
        ])
        // Another thread of the profile isn't the assistant's: its mode decides.
        const other = yield* runningTask({ mode: "bypassPermissions" })
        assert.strictEqual((yield* decided(other.agent, "c", "mcp__g__delete_mail")).behavior, "allow")
      }),
    ),
  )

  it.effect("prompts from routine runs are denied once they expire", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* assistant([["mcp__g__send*", "ask"]], "default")
        const routine = { ...agent, run: yield* turnBy(task, agent, true) }
        const p = yield* asked(routine, "r1", "mcp__g__send_mail", { to: "bob@example.com" })
        // Thirty minutes from when it was asked (the test clock starts at 0).
        const at = (yield* row(p.id)).expires_at
        assert.strictEqual(at, "1970-01-01T00:30:00.000Z")
        assert.strictEqual((yield* card(task, p.id))["expires_at"], at)
        // A tool no rule asks about expires too: background work never hangs on a card.
        const bash = yield* asked(routine, "r2", "Bash", { command: "make" })
        assert.strictEqual((yield* taskRow(task)).status, "needs_attention")
        // Not before its time; the sweeper denies it once it's past.
        yield* TestClock.adjust("29 minutes")
        assert.strictEqual((yield* row(p.id)).status, "pending")
        yield* TestClock.adjust("1 minute")
        assert.deepStrictEqual(yield* Fiber.join(p.told), deny(EXPIRED_UNANSWERED))
        assert.deepStrictEqual(yield* Fiber.join(bash.told), deny(EXPIRED_UNANSWERED))
        for (const id of [p.id, bash.id]) {
          const shown = yield* card(task, id)
          assert.deepStrictEqual([shown["status"], shown["note"]], ["expired", EXPIRED_UNANSWERED])
        }
        // Back to work, and the log says nobody answered.
        assert.strictEqual((yield* taskRow(task)).status, "in_progress")
        assert.deepStrictEqual(yield* log, [["mcp__g__send_mail", "ask", "expired", "expiry"]])
        // An answer after that is too late.
        assert.strictEqual(yield* tag(answer(p.id, { decision: "allow" })), "PromptNotPending")
      }),
    ),
  )

  it.effect("only routine runs' prompts expire, only if the profile says so, and only in the assistant's threads", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* assistant([], "default")
        // The user's own turn: it waits for them.
        const mine = yield* asked({ ...agent, run: yield* turnBy(task, agent, false) }, "u", "Bash", {})
        // No expiry set.
        yield* (yield* ApprovalRules).set(ProfileId.make("p"), { expiry_minutes: 0 })
        const routine = yield* asked({ ...agent, run: yield* turnBy(task, agent, true) }, "r", "Bash", {})
        // A project task an automation started: the rules, and expiry, are the assistant's.
        const other = yield* runningTask()
        const theirs = yield* asked({ ...other.agent, run: yield* turnBy(other.task, other.agent, true) }, "o", "Bash", {})
        for (const p of [mine, routine, theirs]) assert.strictEqual((yield* row(p.id)).expires_at, null)
        yield* TestClock.adjust("2 hours")
        assert.strictEqual((yield* (yield* Permissions).pending({})).length, 3)
      }),
    ),
  )

  it.effect("a prompt a rule asked whose run ends is logged as expired", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* assistant([["mcp__g__send*", "ask"]], "default")
        const p = yield* asked(agent, "c", "mcp__g__send_mail", {})
        yield* (yield* Permissions).expireFor({ _tag: "Task", task })
        assert.deepStrictEqual(yield* Fiber.join(p.told), deny(EXPIRED))
        assert.deepStrictEqual(yield* log, [["mcp__g__send_mail", "ask", "expired", "ended"]])
      }),
    ),
  )

  it.effect("a prompt that expired while the board was down is denied when its call comes again", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* assistant([["mcp__g__send*", "ask"]], "default")
        const routine = { ...agent, run: yield* turnBy(task, agent, true) }
        const p = yield* asked(routine, "r", "mcp__g__send_mail", {})
        // The board stops: nobody waits on the prompt any more.
        yield* Fiber.interrupt(p.told)
        yield* TestClock.adjust("35 minutes")
        assert.deepStrictEqual(yield* decided(routine, "r", "mcp__g__send_mail"), deny(EXPIRED_UNANSWERED))
        assert.deepStrictEqual(yield* log, [["mcp__g__send_mail", "ask", "expired", "expiry"]])
      }),
    ),
  )
})

// ---------- Claude's can_use_tool, on the run's files ----------

/** The agent writes `lines`, and the handler applies them as the follower would. */
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

const canUseTool = (requestId: string, tool: string, input: unknown, toolUseId = `toolu_${requestId}`) => ({
  type: "control_request",
  request_id: requestId,
  request: { subtype: "can_use_tool", tool_name: tool, input, tool_use_id: toolUseId },
})

/** The control responses on the run's input. */
const responses = (agent: FakeAgent) =>
  Effect.map(agent.input, (lines) =>
    lines.flatMap((l) => (typeof l === "object" && l !== null && Reflect.get(l, "type") === "control_response" ? [Reflect.get(l, "response")] : [])),
  )

/** Waits until the prompt of control request `requestId` is waited on. */
const waitingOn = (agent: FakeAgent, requestId: string) =>
  Effect.gen(function* () {
    return yield* (yield* Permissions).asking(promptCallId(agent.run.id, requestId))
  })

/** Waits until control request `requestId` is no longer being asked (answered on the input, or given up on). */
const answeredOn = (agent: FakeAgent, requestId: string) =>
  Effect.gen(function* () {
    yield* (yield* Permissions).settled(promptCallId(agent.run.id, requestId))
  })

describe("Permissions: can_use_tool on the run's output", () => {
  it.effect("a prompt on the output is asked, linked to its call, and answered on the input", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* runningTask()
        const call = {
          type: "assistant",
          message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "toolu_r1", name: "Bash", input: { command: "ls" } }] },
        }
        yield* output(agent, [call, canUseTool("r1", "Bash", { command: "ls" })])
        const id = yield* waitingOn(agent, "r1")
        const store = yield* ThreadStore
        const request = (yield* store.request(task, id))?.request
        assert.deepStrictEqual([request?.type, request?.tool_call_id], ["permission", "toolu_r1"])
        yield* answer(id, { decision: "allow" })
        yield* answeredOn(agent, "r1")
        assert.deepStrictEqual(yield* responses(agent), [
          { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: { command: "ls" } } },
        ])
        // Read again (the offset wasn't saved): asked and answered once.
        yield* output(agent, [canUseTool("r1", "Bash", { command: "ls" })])
        assert.strictEqual((yield* responses(agent)).length, 1)
      }),
    ),
  )

  it.effect("the thread's mode now decides what it asks, and a plan approved into a mode switches Claude to it", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* runningTask({ mode: "bypassPermissions" })
        yield* output(agent, [canUseTool("r1", "Bash", { command: "ls" })])
        yield* setMode(task, "plan")
        yield* output(agent, [canUseTool("r2", "ExitPlanMode", { plan: "Do it" })])
        const id = yield* waitingOn(agent, "r2")
        yield* answer(id, { decision: "allow", mode: "auto" })
        yield* answeredOn(agent, "r2")
        assert.deepStrictEqual(yield* responses(agent), [
          { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: { command: "ls" } } },
          {
            subtype: "success",
            request_id: "r2",
            response: { behavior: "allow", updatedInput: { plan: "Do it" }, updatedPermissions: [{ type: "setMode", mode: "auto", destination: "session" }] },
          },
        ])
      }),
    ),
  )

  it.effect("a prompt Claude cancels expires unanswered", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* runningTask()
        yield* output(agent, [canUseTool("r1", "Bash", { command: "ls" })])
        const id = yield* waitingOn(agent, "r1")
        yield* output(agent, [{ type: "control_cancel_request", request_id: "r1" }])
        assert.strictEqual((yield* row(id)).status, "expired")
        assert.deepStrictEqual(yield* responses(agent), [])
        // Back to work.
        assert.deepStrictEqual([(yield* taskRow(task)).status, (yield* taskRow(task)).attention_reason], ["in_progress", null])
      }),
    ),
  )

  it.effect("a run's end expires what it asked (AgentRequests' ended): its own, or its thread's when no later run started", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* runningTask()
        yield* output(agent, [canUseTool("r1", "Bash", { command: "ls" })])
        const first = yield* waitingOn(agent, "r1")
        // A later run of the thread asks too; the first run's end lets only its own prompt go.
        const later = yield* fakeAgent({ task })
        yield* output(later, [canUseTool("r2", "AskUserQuestion", twoQuestions)])
        const second = yield* waitingOn(later, "r2")
        const requests = yield* AgentRequests
        yield* requests.ended(agent.run, false)
        assert.deepStrictEqual([(yield* row(first)).status, (yield* row(second)).status], ["expired", "pending"])
        yield* requests.ended(later.run, true)
        assert.strictEqual((yield* row(second)).status, "expired")
        assert.deepStrictEqual(yield* responses(agent), [])
      }),
    ),
  )

  it.effect("after a restart an open prompt is found again and answered", () =>
    run(
      Effect.gen(function* () {
        const { task, agent } = yield* runningTask()
        const permissions = yield* Permissions
        // What a server that stopped left: a prompt on the run's output, answered, whose answer wasn't written.
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO permission_requests ${sql.insert({
          id: "old",
          task_id: task,
          write_no: 0,
          tool_name: "Bash",
          input: '{"command":"ls"}',
          status: "allowed",
          call_id: promptCallId(agent.run.id, "r1"),
          created_at: AT,
          run_id: agent.run.id,
          control_id: "r1",
        })}`.pipe(Effect.orDie)
        yield* permissions.resume(agent.run)
        yield* answeredOn(agent, "r1")
        assert.deepStrictEqual(yield* responses(agent), [
          { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: { command: "ls" } } },
        ])
        assert.isTrue((yield* row(RequestId.make("old"))).answered)
        // A prompt of a run that has ended expires.
        const other = yield* runningTask()
        yield* output(other.agent, [canUseTool("r2", "Bash", {})])
        const stale = yield* waitingOn(other.agent, "r2")
        yield* sql`UPDATE runs SET status = 'exited' WHERE id = ${other.agent.run.id}`.pipe(Effect.orDie)
        yield* permissions.expireOrphans
        assert.strictEqual((yield* row(stale)).status, "expired")
      }),
    ),
  )
})
