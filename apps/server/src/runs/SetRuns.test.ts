import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Option, Schema } from "effect"
import type { Scope } from "effect"
import type { SecureRandom } from "effect/crypto"
import type { ChildProcessSpawner } from "effect/process"
import type { SqlClient } from "effect/sql"
import { fakeAgent, git, gitRepo, TestBoard } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import type { Item, Project, Task, TaskId } from "@huntaway/contracts"
import { Worktrees } from "../git/Worktrees.ts"
import { Reactor } from "../lifecycle/Reactor.ts"
import { Actor } from "../platform/Changes.ts"
import { AgentConfigs } from "../profiles/AgentConfigs.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Threads } from "../threads/Threads.ts"
import { RunDir } from "./RunDir.ts"
import { RunEnds } from "./RunEnds.ts"
import { RunOutput } from "./RunOutput.ts"
import { RunRepo } from "./RunRepo.ts"
import { Runs } from "./Runs.ts"

// A set's lead's runs on real repositories (HE-118; docs/plan/07-agents.md, Work across repositories): its launch sets
// up the set's worktrees and is given those of the tasks waiting in To do; while it runs they stay in To do and their
// own agents wait; its end moves them on their work. This test board has no ia-shim, so a launch writes its run's
// folder (its spec, its system prompt) and gives up; a run that goes on is a fake agent's.

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null"
process.env["GIT_CONFIG_NOSYSTEM"] = "1"

type Env =
  | Tasks
  | TaskRepo
  | Projects
  | Profiles
  | AgentConfigs
  | Worktrees
  | Runs
  | RunEnds
  | RunRepo
  | RunDir
  | RunOutput
  | Reactor
  | Threads
  | SqlClient.SqlClient
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | Scope.Scope
const run = <A, E>(effect: Effect.Effect<A, E, Env>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard()))
/** A Codex run needs the launcher it runs `codex-run` with (none is run here: there's no ia-shim). */
const runWithLauncher = <A, E>(effect: Effect.Effect<A, E, Env>) => effect.pipe(Effect.scoped, Effect.provide(TestBoard({ exe: "/opt/huntaway/bin/huntaway" })))
const Json = Schema.fromJsonString(Schema.Unknown)

/** A profile with a project on a fresh repository (on `main`) for each key, none reviewing automatically. */
const board = (keys: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const profile = yield* (yield* Profiles).create({ name: "me" })
    const out: Array<{ readonly project: Project; readonly repo: string }> = []
    for (const key of keys) {
      const repo = yield* gitRepo
      const made = yield* (yield* Projects).create({ profile_id: profile.id, name: key.toLowerCase(), key, repo_path: repo, base_branch: "main" })
      out.push({ project: yield* (yield* Projects).update(made.id, { auto_review: false }), repo })
    }
    return { profile, projects: out }
  }).pipe(Effect.orDie)

/** A set led from the first project, with a task in each of the others; the lead and its followers, in order. */
const makeSet = (projects: ReadonlyArray<{ readonly project: Project }>, status: "todo" | "in_progress" = "todo") =>
  Effect.gen(function* () {
    const tasks = yield* Tasks
    const [first, ...rest] = projects
    if (first === undefined) return yield* Effect.die("no projects")
    const lead = yield* tasks.create(
      { project_id: first.project.id, title: "API and client", also_in: rest.map((p) => p.project.id), status, start: false },
      Actor.user,
    )
    const set = yield* (yield* TaskRepo).inSet(lead.id)
    return { lead, followers: set.slice(1) }
  }).pipe(Effect.orDie)

const get = (id: TaskId) =>
  Effect.gen(function* () {
    const t = yield* (yield* TaskRepo).get(id)
    return t === null ? yield* Effect.die(`task ${id} is gone`) : t
  })
/** The `i`th of `list`, which the test made. */
const nth = <A>(list: ReadonlyArray<A>, i: number): A => {
  const x = list[i]
  if (x === undefined) throw new Error(`no item ${i}`)
  return x
}
const update = (t: Task, status: Task["status"]) => Effect.flatMap(Tasks, (tasks) => tasks.update(t.id, { status }, Actor.user))
const notices = (id: TaskId) =>
  Effect.map(
    Effect.flatMap(Threads, (threads) => threads.stored(id).pipe(Effect.orDie)),
    (s) =>
      s.entries.flatMap((e): ReadonlyArray<string> => {
        const i: Item = e.item
        return i.type === "notice" ? [i.detail === undefined || i.detail === null ? i.text : `${i.text}: ${i.detail}`] : []
      }),
  )

/** The latest run of `task`, launched (and, with no ia-shim, given up on) and ended by the reactor. */
const launchedRun = (task: TaskId) =>
  Effect.gen(function* () {
    yield* (yield* Runs).launched(task)
    yield* (yield* Reactor).idle
    const latest = yield* (yield* RunRepo).latest(task)
    return Option.getOrThrowWith(latest, () => new Error(`no run of ${task}`))
  })

/** What a Claude run was launched with: its extra folders and its system prompt. */
const claudeLaunch = (task: TaskId) =>
  Effect.gen(function* () {
    const r = yield* launchedRun(task)
    const dir = yield* RunDir
    const spec = yield* dir.spec(r.id)
    const args = spec?.args ?? []
    const addDirs = args.flatMap((a, i) => (args[i - 1] === "--add-dir" ? [a] : []))
    const system = yield* (yield* FileSystem.FileSystem).readFileString(`${dir.path(r.id)}/system-prompt.md`).pipe(Effect.orDie)
    return { run: r, addDirs, system, granted: yield* (yield* RunRepo).granted(r.id) }
  })

/** What a Codex run was launched with: its writable roots and its instructions. */
const codexLaunch = (task: TaskId) =>
  Effect.gen(function* () {
    const r = yield* launchedRun(task)
    const text = yield* (yield* FileSystem.FileSystem).readFileString(`${(yield* RunDir).path(r.id)}/codex.json`).pipe(Effect.orDie)
    const spec = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Struct({ writable_roots: Schema.Array(Schema.String), developer_instructions: Schema.String })),
    )(text).pipe(Effect.orDie)
    return { run: r, roots: spec.writable_roots, system: spec.developer_instructions, granted: yield* (yield* RunRepo).granted(r.id) }
  })

const send = (task: TaskId, text: string) => Effect.flatMap(Runs, (runs) => runs.send(task, { text, source: "user" }))

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
const success = { type: "result", subtype: "success", is_error: false, total_cost_usd: 0, num_turns: 1, session_id: "s1" }

/** A fake agent's run of the lead, given the followers' worktrees as a launch would; `finish` ends it with a result. */
const leadRun = (lead: Task, granted: ReadonlyArray<Task>) =>
  Effect.gen(function* () {
    const agent = yield* fakeAgent({ task: lead.id })
    for (const f of granted) yield* (yield* RunRepo).grant(agent.run.id, f.id)
    const finish = Effect.gen(function* () {
      yield* output(agent, [success])
      yield* (yield* RunEnds).ended({ _tag: "RunExited", run: agent.run.id, task: lead.id, exit: { code: 0, signal: null }, errorTail: "" })
      yield* (yield* Reactor).idle
    })
    return { agent, finish }
  })

describe("a set's lead's launch", () => {
  it.live("sets up the whole set and is given the worktrees of those in To do; a follower's own run gets none (Claude)", () =>
    run(
      Effect.gen(function* () {
        const { projects } = yield* board(["API", "WEB", "DOC"])
        const { lead, followers } = yield* makeSet(projects)
        const web = nth(followers, 0)
        const doc = nth(followers, 1)
        // DOC has left To do: its worktree is its own agent's.
        yield* update(doc, "in_review")

        yield* send(lead.id, "Do it")
        const launch = yield* claudeLaunch(lead.id)
        const [l, w, d] = [yield* get(lead.id), yield* get(web.id), yield* get(doc.id)]
        // Every worktree is set up with the lead's, each on the set's branch in its own repository.
        assert.deepStrictEqual(
          [l, w, d].map((t) => [t.worktree_state, t.branch]),
          [
            ["ready", "ia/api-1-api-and-client"],
            ["ready", "ia/api-1-api-and-client"],
            ["ready", "ia/api-1-api-and-client"],
          ],
        )
        assert.strictEqual(yield* git(w.worktree_path ?? "", ["rev-parse", "--abbrev-ref", "HEAD"]), "ia/api-1-api-and-client")
        // Only WEB's, which is in To do with no run of its own.
        assert.deepStrictEqual(launch.granted, [web.id])
        assert.include(launch.addDirs, w.worktree_path ?? "?")
        assert.notInclude(launch.addDirs, d.worktree_path ?? "?")
        assert.include((yield* notices(web.id)).join("\n"), "This task waits in To do while its lead, API-1, works in this worktree")
        // Its system prompt lists the set, says where it works and what it hands on.
        assert.include(launch.system, "This task leads a set of tasks across repositories")
        assert.include(launch.system, `- WEB-1: project web, repository ${projects[1]?.repo ?? "?"}, worktree ${w.worktree_path ?? "?"} on branch`)
        assert.include(launch.system, "To do; given to you for this run")
        assert.include(launch.system, "This run was given the worktrees of WEB-1 besides your own")
        assert.include(launch.system, "Don't work in the worktrees of DOC-1")

        // A follower's own run (its lead's run is over) works in its worktree alone, and is told of its lead.
        yield* send(doc.id, "Fix the client")
        const own = yield* claudeLaunch(doc.id)
        assert.deepStrictEqual(own.granted, [])
        assert.isFalse(own.addDirs.some((a) => a === w.worktree_path || a === l.worktree_path))
        assert.include(own.system, 'Its lead, API-1 ("API and client"), does the set\'s work')
        assert.include(own.system, "Refer anything outside it to the lead with `send_to_task` (task API-1)")
      }),
    ),
  )

  it.live("gives a Codex lead the waiting followers' worktrees as writable roots, and a follower none", () =>
    runWithLauncher(
      Effect.gen(function* () {
        const { profile, projects } = yield* board(["API", "WEB", "DOC"])
        const codex = yield* (yield* AgentConfigs).create({ name: "Codex", agent: "codex" }).pipe(Effect.orDie)
        yield* (yield* Profiles).update(profile.id, { claude_config_ids: [codex.id] }).pipe(Effect.orDie)
        const { lead, followers } = yield* makeSet(projects)
        const web = nth(followers, 0)
        const doc = nth(followers, 1)
        yield* update(doc, "in_review")

        yield* send(lead.id, "Do it")
        const launch = yield* codexLaunch(lead.id)
        const [w, d] = [yield* get(web.id), yield* get(doc.id)]
        assert.deepStrictEqual(launch.granted, [web.id])
        assert.include(launch.roots, w.worktree_path ?? "?")
        assert.notInclude(launch.roots, d.worktree_path ?? "?")
        assert.include(launch.system, "This run was given the worktrees of WEB-1 besides your own")

        yield* send(web.id, "Fix the client")
        const own = yield* codexLaunch(web.id)
        assert.deepStrictEqual(own.granted, [])
        const l = yield* get(lead.id)
        assert.isFalse(own.roots.some((r) => r === d.worktree_path || r === l.worktree_path))
        assert.include(own.system, "Refer anything outside it to the lead with `send_to_task` (task API-1)")
      }),
    ),
  )

  it.live("fails when a follower's worktree can't be set up, its thread saying which", () =>
    run(
      Effect.gen(function* () {
        const { projects } = yield* board(["API", "WEB", "OPS"])
        const ops = nth(projects, 2)
        yield* (yield* Projects).update(ops.project.id, { setup_script: "echo broken >&2; exit 3" }).pipe(Effect.orDie)
        const { lead, followers } = yield* makeSet(projects)

        yield* send(lead.id, "Do it")
        const launch = yield* launchedRun(lead.id)
        const l = yield* get(lead.id)
        assert.strictEqual(l.status, "needs_attention")
        assert.include(l.attention_reason ?? "", `OPS-1's worktree (ops, ${ops.repo}) couldn't be set up`)
        assert.include((yield* notices(lead.id)).join("\n"), `Couldn't set up OPS-1's worktree (ops, ${ops.repo})`)
        const o = yield* get(followers[1]?.id ?? lead.id)
        assert.deepStrictEqual([o.status, o.worktree_state], ["todo", "error"])
        assert.deepStrictEqual(yield* (yield* RunRepo).granted(launch.id), [])
      }),
    ),
  )
})

describe("while a lead's run has a follower's worktree", () => {
  it.live("the follower stays in To do: its message waits for the run's end, and a move out of To do is refused", () =>
    run(
      Effect.gen(function* () {
        const { projects } = yield* board(["API", "WEB", "DOC"])
        const { lead, followers } = yield* makeSet(projects, "in_progress")
        const web = nth(followers, 0)
        const doc = nth(followers, 1)
        const worktrees = yield* Worktrees
        for (const t of [lead, web, doc]) yield* worktrees.setup(t.id).pipe(Effect.orDie)
        const { finish } = yield* leadRun(lead, [web])

        const held = yield* send(web.id, "Rename the client's call")
        assert.deepStrictEqual([held.status, held.running, held.queued_message], ["todo", false, "Rename the client's call"])
        assert.include((yield* notices(web.id)).join("\n"), "Queued until API-1's run ends: its lead is working in this task's worktree")
        const refused = yield* Effect.flip(update(web, "in_progress"))
        assert.isTrue(refused._tag === "Invalid" && refused.reason.startsWith("its lead is working in it"), String(refused))
        // DOC wasn't given to it: it moves as any task.
        assert.strictEqual((yield* update(doc, "backlog")).status, "backlog")

        // The lead's run ends: the message is sent, and WEB's own run starts (and, with no ia-shim, fails).
        yield* finish
        yield* (yield* Runs).launched(web.id)
        yield* (yield* Reactor).idle
        const w = yield* get(web.id)
        assert.notStrictEqual(w.status, "todo")
        const sent = Option.getOrNull(yield* (yield* RunRepo).latest(web.id))
        assert.isNotNull(sent)
        // So it had a run of its own as the lead's ended: it's its own run's end that moves it, not the lead's.
        assert.notStrictEqual(w.status, "in_review")
      }),
    ),
  )
})

describe("the end of a lead's run with its work finished", () => {
  it.live("moves a follower with commits or only uncommitted changes to In review and closes one with neither", () =>
    run(
      Effect.gen(function* () {
        const { projects } = yield* board(["API", "WEB", "DOC", "OPS", "CLI"])
        const { lead, followers } = yield* makeSet(projects, "in_progress")
        const web = nth(followers, 0)
        const doc = nth(followers, 1)
        const ops = nth(followers, 2)
        const cli = nth(followers, 3)
        const worktrees = yield* Worktrees
        const fs = yield* FileSystem.FileSystem
        const ready = yield* Effect.forEach([web, doc, ops], (t) => worktrees.setup(t.id).pipe(Effect.orDie), { concurrency: 1 })
        const [w, d] = ready
        // WEB has a commit; DOC only a change it never committed; OPS neither. CLI left To do (its own agent's).
        yield* fs.writeFileString(`${w?.worktree_path ?? "?"}/client.ts`, "export {}\n").pipe(Effect.orDie)
        yield* git(w?.worktree_path ?? "?", ["add", "."])
        yield* git(w?.worktree_path ?? "?", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "client"])
        yield* fs.writeFileString(`${d?.worktree_path ?? "?"}/notes.md`, "the new call\n").pipe(Effect.orDie)
        yield* update(cli, "backlog")
        const { finish } = yield* leadRun(lead, [web, doc, ops])

        yield* finish
        const [l, ...after] = yield* Effect.forEach([lead, web, doc, ops, cli], (t) => get(t.id), { concurrency: 1 })
        assert.strictEqual(l?.status, "in_review")
        assert.deepStrictEqual(
          after.map((t) => [t.key, t.status, t.resolution]),
          [
            ["WEB-1", "in_review", null],
            ["DOC-1", "in_review", null],
            ["OPS-1", "done", "not_done"],
            ["CLI-1", "backlog", null],
          ],
        )
        const said = (yield* notices(lead.id)).join("\n")
        assert.include(said, "Moved WEB-1 to In review")
        assert.include(said, "Moved DOC-1 to In review")
        assert.include(said, "Closed OPS-1 as not done: no changes in this repository")
        assert.include((yield* notices(ops.id)).join("\n"), "Closed as not done when API-1's run ended: no changes in this repository")
      }),
    ),
  )

  it.live("moves none of them when it ends any other way", () =>
    run(
      Effect.gen(function* () {
        const { projects } = yield* board(["API", "WEB"])
        const { lead, followers } = yield* makeSet(projects, "in_progress")
        const web = nth(followers, 0)
        yield* (yield* Worktrees).setup(web.id).pipe(Effect.orDie)
        const { agent } = yield* leadRun(lead, [web])
        yield* (yield* Runs).stop(lead.id)
        yield* output(agent, [{ ...success, subtype: "error_during_execution", is_error: true }])
        yield* (yield* RunEnds).ended({ _tag: "RunExited", run: agent.run.id, task: lead.id, exit: { code: 0, signal: null }, errorTail: "" })
        yield* (yield* Reactor).idle
        assert.deepStrictEqual([(yield* get(lead.id)).status, (yield* get(web.id)).status], ["needs_attention", "todo"])
      }),
    ),
  )
})
