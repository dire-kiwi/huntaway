import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { AgentConfigId, ProfileId, TaskId, Timestamp } from "@huntaway/contracts"
import type { NewTask, Task } from "@huntaway/contracts"
import { TestBoard } from "@huntaway/testing"
import { Reactor } from "../lifecycle/Reactor.ts"
import { change } from "../mcp/tools/tests/wait.ts"
import { Actor } from "../platform/Changes.ts"
import { Projects } from "../projects/Projects.ts"
import { stackOf } from "../tasks/lanes.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { StackTitles } from "./StackTitles.ts"
import { parseStackReply, stackInput } from "./stackTitles/text.ts"
import { TitleScript } from "./TitleModel.ts"

// A stack's title and description (HA-387), kept on its bottom task and written by the scripted title model as the stack
// forms and its levels change: the cases of huntaway's agent/stack_title.test.ts on the whole board's services. The pause
// before a write (5 s) and the pass after a start (60 s) are on the test clock. Left out of the cases:
// - the old "they're in the task's JSON but not what they were written from" check: `stack_input` isn't in the `Task`
//   schema, so it can't be on the wire;
// - MCP `get_task` showing the stack's fields on each of its tasks (`task_details`): the board tools' task view is 3.x's,
//   and doesn't read stacks yet;
// - the body checks of the old PATCH that the contract's schema now makes (a title that isn't a string, `regenerate:
//   "yes"`): only those that are the service's are kept;
// - the title an agent writes a level (`title.generate`) is a title change like any other here (`Tasks.change`).

const AT = Timestamp.make("2026-11-12T00:00:00.000Z")
const P = ProfileId.make("p")

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))

const profile = (id: string) =>
  Effect.gen(function* () {
    yield* (yield* SqlClient.SqlClient)`INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES (${id}, ${id}, ${AT})`.pipe(Effect.orDie)
    return ProfileId.make(id)
  })

/** Task `below` is what `t` lands after (none: it lands after nothing), as the board changes it. */
const landsAfter = (t: Task, below: Task | null) =>
  Effect.flatMap(Tasks, (tasks) =>
    tasks.change(t.id, () => ({ start_from: below === null ? null : { type: "task", task_id: below.id } }), Actor.user).pipe(Effect.orDie),
  )

/** A task in profile `p`'s no project titled `title`, landing after `below` if given. */
const mk = (title: string, below: Task | null = null, more: Partial<NewTask> = {}, profileId: ProfileId = P) =>
  Effect.gen(function* () {
    yield* profile(profileId)
    const made = yield* (yield* Tasks).create({ profile_id: profileId, title, ...more }, Actor.user).pipe(Effect.orDie)
    return below === null ? made : yield* landsAfter(made, below)
  })

const reload = (id: TaskId) =>
  Effect.map(
    Effect.flatMap(TaskRepo, (r) => r.get(id)),
    (t) => t ?? assert.fail(`task ${id} is gone`),
  )
const fields = (id: TaskId) => Effect.map(reload(id), (t) => [t.stack_title, t.stack_description, t.stack_pinned] as const)
const NONE = [null, null, false] as const

/** What a failure was (its tag and fields), or "" for a success. */
const refused = (e: Exit.Exit<unknown, unknown>) => (Exit.isFailure(e) ? String(e.cause) : "")

/** Let what the changes scheduled settle: the reactor's steps, the pause, and the writes. */
const settled = Effect.gen(function* () {
  const reactor = yield* Reactor
  const stacks = yield* StackTitles
  for (let i = 0; i < 2; i++) {
    yield* reactor.idle
    yield* TestClock.adjust("5 seconds")
    yield* stacks.settled
    yield* reactor.idle
  }
})

const reply = (text: string) => Effect.flatMap(TitleScript, (s) => s.setReply(text))
const asked = Effect.flatMap(TitleScript, (s) => s.asked)
const update = (id: TaskId, edit: Parameters<StackTitles["Service"]["update"]>[1]) => Effect.flatMap(StackTitles, (s) => s.update(id, edit))
const del = (id: TaskId) => Effect.flatMap(Tasks, (t) => t.delete(id, { deleteBranch: false }, Actor.user).pipe(Effect.orDie))
const edit = (id: TaskId, patch: Partial<Pick<Task, "title" | "description" | "status" | "starred" | "merges_into">>) =>
  Effect.flatMap(Tasks, (t) => t.change(id, () => patch, Actor.user).pipe(Effect.orDie))

describe("stack titles", () => {
  it.effect("a stack's title is written as it forms, from its levels in landing order, and kept on its bottom", () =>
    run(
      Effect.gen(function* () {
        yield* reply("Title: Ship the login rework\nDescription: Rebuilds login on sessions. In two steps.")
        const a = yield* mk("Add the session table", null, { description: "Sessions in SQLite" })
        yield* settled
        // A task alone isn't a stack.
        assert.strictEqual((yield* asked).length, 0)
        const b = yield* mk("Use sessions in login", a)
        yield* settled
        assert.deepStrictEqual(yield* asked, [
          `<stack>\n<task n="1">\n<title>Add the session table</title>\n<description>\nSessions in SQLite\n</description>\n</task>\n<task n="2">\n<title>Use sessions in login</title>\n</task>\n</stack>`,
        ])
        assert.deepStrictEqual(yield* fields(a.id), ["Ship the login rework", "Rebuilds login on sessions. In two steps.", false])
        assert.deepStrictEqual(yield* fields(b.id), NONE)

        // A change that doesn't change what they're written from doesn't ask again.
        yield* edit(b.id, { status: "in_progress" })
        yield* edit(a.id, { starred: true })
        yield* settled
        assert.strictEqual((yield* asked).length, 1)
        // A level's description does, and so does a new title.
        yield* reply("Title: Ship sessions\nDescription: Login and logout on sessions.")
        yield* edit(b.id, { description: "And logout" })
        yield* settled
        assert.strictEqual((yield* asked).length, 2)
        assert.deepStrictEqual(yield* fields(a.id), ["Ship sessions", "Login and logout on sessions.", false])
        yield* edit(b.id, { title: "Move login to sessions" })
        yield* settled
        const all = yield* asked
        assert.strictEqual(all.length, 3)
        assert.include(all[2] ?? "", "<title>Move login to sessions</title>")
      }),
    ),
  )

  it.effect("a task created on another forms a stack; one merging into it isn't a level", () =>
    run(
      Effect.gen(function* () {
        yield* profile("p")
        const project = yield* (yield* Projects).create({ profile_id: P, name: "web", key: "WEB", repo_path: "/tmp/no-such-repo" }).pipe(Effect.orDie)
        yield* reply("Title: Dark mode\nDescription: Adds a dark theme.")
        const tasks = yield* Tasks
        const first = yield* tasks.create({ project_id: project.id, title: "Theme tokens", use_worktree: true }, Actor.user).pipe(Effect.orDie)
        yield* tasks.create({ project_id: project.id, title: "Dark palette", use_worktree: true, start_from: "WEB-1" }, Actor.user).pipe(Effect.orDie)
        yield* tasks.create({ project_id: project.id, title: "Into it", use_worktree: true, merges_into: "WEB-1" }, Actor.user).pipe(Effect.orDie)
        yield* settled
        const all = yield* asked
        assert.strictEqual(all.length, 1)
        assert.notInclude(all[0] ?? "", "Into it")
        assert.deepStrictEqual(yield* fields(first.id), ["Dark mode", "Adds a dark theme.", false])
      }),
    ),
  )

  it.effect("levels made in a row are written once, and never two at once", () =>
    run(
      Effect.gen(function* () {
        yield* reply("Title: Four steps\nDescription: All four.")
        const a = yield* mk("One")
        const b = yield* mk("Two", a)
        const c = yield* mk("Three", b)
        yield* mk("Four", c)
        yield* edit(b.id, { description: "more" })
        yield* edit(b.id, { description: "more still" })
        yield* settled
        let all = yield* asked
        assert.strictEqual(all.length, 1)
        assert.isTrue((all[0] ?? "").includes("<title>Four</title>") && (all[0] ?? "").includes("more still"), all[0])

        // A change while one's being written waits for it, and is then written from what the levels say by then.
        const script = yield* TitleScript
        const gate = yield* Deferred.make<void>()
        const took = yield* Deferred.make<void>()
        yield* script.push("Title: Slow\nDescription: x", { gate, took })
        yield* edit(c.id, { title: "Three, changed" })
        yield* (yield* Reactor).idle
        yield* TestClock.adjust("5 seconds")
        yield* Deferred.await(took)
        yield* edit(c.id, { title: "Three, changed again" })
        yield* (yield* Reactor).idle
        yield* TestClock.adjust("5 seconds")
        assert.strictEqual((yield* asked).length, 2)
        yield* Deferred.succeed(gate, undefined)
        yield* settled
        all = yield* asked
        assert.strictEqual(all.length, 3)
        assert.include(all[2] ?? "", "Three, changed again")
        assert.strictEqual((yield* reload(a.id)).stack_title, "Four steps")
      }),
    ),
  )

  it.effect("a fork is one stack, in landing order", () =>
    run(
      Effect.gen(function* () {
        yield* reply("Title: Search\nDescription: Search everywhere.")
        const a = yield* mk("Index")
        const b = yield* mk("Query", a)
        const c = yield* mk("Beside it", a)
        const d = yield* mk("Ranking", b)
        yield* settled
        const rows = yield* (yield* TaskRepo).list({ _tag: "Projectless", profile_id: P })
        for (const t of [a, b, c, d]) assert.strictEqual(stackOf(rows, yield* reload(t.id))?.bottom.id, a.id)
        assert.deepStrictEqual(
          stackOf(rows, yield* reload(c.id))?.levels.map((t) => t.title),
          ["Index", "Query", "Ranking", "Beside it"],
        )
        const all = yield* asked
        assert.strictEqual(all.length, 1)
        assert.include(all[0] ?? "", `<task n="3">\n<title>Ranking</title>`)
        assert.include(all[0] ?? "", `<task n="4" lands_after="1">\n<title>Beside it</title>`)
        assert.strictEqual((yield* reload(a.id)).stack_title, "Search")
      }),
    ),
  )

  it.effect("a stack whose tasks are all done isn't written unless asked", () =>
    run(
      Effect.gen(function* () {
        yield* reply("Title: Done work\nDescription: Old.")
        const a = yield* mk("A", null, { status: "done" })
        yield* mk("B", a, { status: "done" })
        yield* settled
        assert.strictEqual((yield* asked).length, 0)
        yield* update(a.id, { regenerate: true }).pipe(Effect.orDie)
        yield* settled
        assert.deepStrictEqual(yield* fields(a.id), ["Done work", "Old.", false])
      }),
    ),
  )

  it.effect("edited by hand they stay until regenerated", () =>
    run(
      Effect.gen(function* () {
        yield* reply("Title: Model's\nDescription: The model's.")
        const a = yield* mk("A")
        const b = yield* mk("B", a)
        yield* settled
        // Through any task of the stack, answered with its bottom.
        const t = yield* update(b.id, { title: "  Mine  " }).pipe(Effect.orDie)
        assert.deepStrictEqual([t.id, t.stack_title, t.stack_description, t.stack_pinned], [a.id, "Mine", "The model's.", true])
        yield* update(a.id, { description: "My own." }).pipe(Effect.orDie)
        yield* mk("C", b)
        yield* edit(b.id, { description: "changed" })
        yield* settled
        assert.strictEqual((yield* asked).length, 1)
        assert.deepStrictEqual(yield* fields(a.id), ["Mine", "My own.", true])
        const u = yield* update(b.id, { regenerate: true }).pipe(Effect.orDie)
        assert.isFalse(u.stack_pinned)
        yield* settled
        assert.strictEqual((yield* asked).length, 2)
        assert.deepStrictEqual(yield* fields(a.id), ["Model's", "The model's.", false])

        for (const body of [{}, { title: "x", regenerate: true }, { title: "x".repeat(201) }]) {
          assert.include(refused(yield* Effect.exit(update(b.id, body))), "StackInvalid", Object.keys(body).join(", "))
        }
        // Not for a task that isn't in a stack, or isn't there.
        assert.include(refused(yield* Effect.exit(update((yield* mk("Alone")).id, { title: "x" }))), "StackInvalid")
        assert.include(refused(yield* Effect.exit(update(TaskId.make("nope"), { title: "x" }))), "TaskNotFound")
        // Nor for another profile's: a task of its that names one of this one's as the task it starts from isn't in its stack.
        const theirs = yield* mk("Theirs", null, {}, ProfileId.make("q"))
        yield* change(theirs.id, { start_from: { type: "task", task_id: a.id } })
        assert.include(refused(yield* Effect.exit(update(theirs.id, { title: "Taken" }))), "StackInvalid")
        assert.strictEqual((yield* reload(a.id)).stack_title, "Model's")
      }),
    ),
  )

  it.effect("given a level below, or joined to another stack, the fields go to the new bottom", () =>
    run(
      Effect.gen(function* () {
        yield* reply("Title: First\nDescription: One.")
        const a = yield* mk("A")
        const b = yield* mk("B", a)
        yield* settled
        yield* update(a.id, { title: "Pinned" }).pipe(Effect.orDie)
        // A is given a level below: its pinned fields go there, and aren't written again.
        const z = yield* mk("Z")
        yield* landsAfter(yield* reload(a.id), z)
        yield* settled
        assert.deepStrictEqual(yield* fields(z.id), ["Pinned", "One.", true])
        assert.deepStrictEqual(yield* fields(a.id), NONE)
        assert.strictEqual((yield* asked).length, 1)

        // Joined to another stack, whose bottom keeps its own (unpinned, so they're written again).
        yield* reply("Title: Other\nDescription: Two.")
        const x = yield* mk("X")
        const y = yield* mk("Y", x)
        yield* settled
        assert.deepStrictEqual(yield* fields(x.id), ["Other", "Two.", false])
        yield* update(z.id, { regenerate: true }).pipe(Effect.orDie)
        yield* settled
        assert.strictEqual((yield* reload(z.id)).stack_title, "Other")
        yield* reply("Title: Joined\nDescription: Both.")
        yield* landsAfter(yield* reload(z.id), y)
        yield* settled
        assert.deepStrictEqual(yield* fields(x.id), ["Joined", "Both.", false])
        for (const t of [z, a, b, y]) assert.deepStrictEqual(yield* fields(t.id), NONE, t.title)
        assert.include((yield* asked).at(-1) ?? "", "<title>B</title>")
      }),
    ),
  )

  it.effect("a stack split in two keeps its fields, and the part split off is written", () =>
    run(
      Effect.gen(function* () {
        yield* reply("Title: Whole\nDescription: All of it.")
        const a = yield* mk("A")
        const b = yield* mk("B", a)
        const c = yield* mk("C", b)
        yield* mk("D", c)
        yield* settled
        yield* update(a.id, { title: "Kept" }).pipe(Effect.orDie)
        yield* reply("Title: Split off\nDescription: The top.")
        yield* landsAfter(yield* reload(c.id), null)
        yield* settled
        assert.deepStrictEqual(yield* fields(a.id), ["Kept", "All of it.", true])
        assert.deepStrictEqual(yield* fields(c.id), ["Split off", "The top.", false])
        // It stops being a level by merging into a task instead: A's stack is A alone, and has none.
        yield* edit(b.id, { merges_into: a.id })
        yield* settled
        assert.deepStrictEqual(yield* fields(a.id), NONE)
      }),
    ),
  )

  it.effect("deleting the bottom, a middle level or the last level", () =>
    run(
      Effect.gen(function* () {
        yield* reply("Title: Gen\nDescription: Generated.")
        // The bottom: its fields go to the new bottom.
        let a = yield* mk("A")
        let b = yield* mk("B", a)
        yield* mk("C", b)
        yield* settled
        yield* update(a.id, { title: "Mine" }).pipe(Effect.orDie)
        yield* del(a.id)
        yield* settled
        assert.deepStrictEqual(yield* fields(b.id), ["Mine", "Generated.", true])

        // Unpinned, they go there too and are written again, without what was deleted.
        a = yield* mk("A2")
        b = yield* mk("B2", a)
        yield* mk("C2", b)
        yield* settled
        yield* reply("Title: After\nDescription: Without A2.")
        yield* del(a.id)
        yield* settled
        assert.deepStrictEqual(yield* fields(b.id), ["After", "Without A2.", false])
        assert.notInclude((yield* asked).at(-1) ?? "", "A2")

        // A level in the middle: the levels below and above are each alone, and so not stacks.
        yield* reply("Title: Gen\nDescription: Generated.")
        a = yield* mk("A3")
        b = yield* mk("B3", a)
        const c = yield* mk("C3", b)
        yield* settled
        assert.strictEqual((yield* reload(a.id)).stack_title, "Gen")
        yield* del(b.id)
        yield* settled
        assert.deepStrictEqual(yield* fields(a.id), NONE)
        assert.deepStrictEqual(yield* fields(c.id), NONE)

        // The last level: the stack's gone.
        a = yield* mk("A4")
        b = yield* mk("B4", a)
        yield* settled
        assert.strictEqual((yield* reload(a.id)).stack_title, "Gen")
        yield* del(b.id)
        yield* settled
        assert.deepStrictEqual(yield* fields(a.id), NONE)
      }),
    ),
  )

  it.effect("stacks from before are written once after a start", () =>
    run(
      Effect.gen(function* () {
        // Made as a stack while the board wasn't looking (no change told), and one whose tasks are all done, which isn't.
        const a = yield* mk("A")
        const b = yield* mk("B")
        yield* change(b.id, { start_from: { type: "task", task_id: a.id } })
        const d = yield* mk("D", null, { status: "done" })
        const e = yield* mk("E", null, { status: "done" })
        yield* change(e.id, { start_from: { type: "task", task_id: d.id } })
        yield* reply("Title: Upgraded\nDescription: From before.")
        yield* (yield* Reactor).idle
        // The board's own start looked a minute after it was built.
        yield* TestClock.adjust("60 seconds")
        yield* settled
        assert.strictEqual((yield* asked).length, 1)
        assert.deepStrictEqual(yield* fields(a.id), ["Upgraded", "From before.", false])
        // The next start has nothing to write.
        yield* (yield* StackTitles).resume
        yield* TestClock.adjust("60 seconds")
        yield* settled
        assert.strictEqual((yield* asked).length, 1)
      }),
    ),
  )

  it.effect("written with the bottom's login, Claude or Codex", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* reply("Title: T\nDescription: D.")
        let seen = 0
        for (const agent of ["codex", "claude"] as const) {
          const id = AgentConfigId.make(`cfg-${agent}`)
          yield* sql`INSERT INTO agent_configs ${sql.insert({ id, name: agent, config_dir: `/tmp/.${agent}-a`, agent, created_at: AT })}`.pipe(Effect.orDie)
          yield* profile("p")
          yield* sql`UPDATE profiles SET claude_config_ids = ${`["${id}"]`} WHERE id = 'p'`.pipe(Effect.orDie)
          const a = yield* mk(`On ${agent}`, null, { claude_config_id: id })
          yield* mk("Above", a)
          yield* settled
          const runtimes = yield* (yield* TitleScript).runtimes
          assert.deepStrictEqual(runtimes.slice(seen), [agent])
          seen = runtimes.length
          assert.strictEqual((yield* reload(a.id)).stack_title, "T")
        }
      }),
    ),
  )

  it.effect("a split that leaves the bottom on its own hands its fields to the rest", () =>
    run(
      Effect.gen(function* () {
        for (const how of ["deleted", "detached"] as const)
          for (const pinned of [true, false]) {
            const what = `${how}, ${pinned ? "pinned" : "unpinned"}`
            yield* reply("Title: Whole\nDescription: All four.")
            const a = yield* mk(`A ${what}`)
            const b = yield* mk(`B ${what}`, a)
            const c = yield* mk(`C ${what}`, b)
            yield* mk(`D ${what}`, c)
            yield* settled
            if (pinned) yield* update(a.id, { title: "Mine" }).pipe(Effect.orDie)
            yield* reply("Title: Rest\nDescription: Without A.")
            const calls = (yield* asked).length
            if (how === "deleted") yield* del(b.id)
            else yield* landsAfter(yield* reload(b.id), null)
            yield* settled
            // A is on its own: its fields go to what's left of the stack, whose bottom is C once B's deleted, else B.
            const rest = how === "deleted" ? c : b
            assert.deepStrictEqual(yield* fields(a.id), NONE, what)
            assert.deepStrictEqual(yield* fields(rest.id), pinned ? ["Mine", "All four.", true] : ["Rest", "Without A.", false], what)
            // Pinned, they're kept as they are; unpinned, they're written again for what's left.
            assert.strictEqual((yield* asked).length, calls + (pinned ? 0 : 1), what)
          }
      }),
    ),
  )
})

describe("what a stack's title is written from, and read back", () => {
  it("replies give a title and a description", () => {
    assert.deepStrictEqual(parseStackReply("Title: Ship sessions\nDescription: Login on sessions."), {
      title: "Ship sessions",
      description: "Login on sessions.",
    })
    assert.deepStrictEqual(parseStackReply('**Title:** "Ship sessions."\n\n**Description:** Login on sessions.\nThen logout.'), {
      title: "Ship sessions",
      description: "Login on sessions. Then logout.",
    })
    assert.deepStrictEqual(parseStackReply("Description: Login on sessions.\nTitle: Ship sessions"), {
      title: "Ship sessions",
      description: "Login on sessions.",
    })
    assert.deepStrictEqual(parseStackReply("Ship sessions\nLogin on sessions."), { title: "Ship sessions", description: "Login on sessions." })
    assert.deepStrictEqual(parseStackReply("Title: Ship sessions"), { title: "Ship sessions", description: null })
    assert.isNull(parseStackReply(""))
    assert.isNull(parseStackReply("Title: one two three four five six seven eight nine ten eleven twelve thirteen\nDescription: x"))
    assert.strictEqual(parseStackReply(`Title: T\nDescription: ${"x".repeat(1000)}`)?.description?.length, 401)
  })

  it.effect("what it's written from cuts long descriptions", () =>
    run(
      Effect.gen(function* () {
        const a = yield* mk("A", null, { description: "y".repeat(5000) })
        const b = yield* mk("B", a)
        const rows = yield* (yield* TaskRepo).list({ _tag: "Projectless", profile_id: P })
        const text = stackInput(rows, stackOf(rows, yield* reload(b.id))?.levels ?? [])
        assert.isTrue(text.includes(`${"y".repeat(1000)}…\n</description>`) && !text.includes("y".repeat(1001)), String(text.length))
      }),
    ),
  )
})
