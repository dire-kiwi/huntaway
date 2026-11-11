import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { Approval, RequestId } from "@huntaway/contracts"
import { tempDir, TestMcp, TestMcpOver } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { ApprovalRules } from "../../agents/ApprovalRules.ts"
import { Permissions } from "../../permissions/Permissions.ts"
import { Actor } from "../../platform/Changes.ts"
import { ProjectRepo } from "../../projects/ProjectRepo.ts"
import { Projects } from "../../projects/Projects.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { Tasks } from "../../tasks/Tasks.ts"
import { agentOf, agentOn, at, call, err, ok, profile, project, setTask, task } from "./tests/board.ts"

// The board's changes that always ask (the old mcp/tools/approvals.test.ts and projects.test.ts, and dispatch.test.ts's
// "an ask rule on the whole board leaves tools that ask for themselves to ask once"), as an agent calls them through
// `ToolCalls`, the user answering through `Permissions`. A restart is the board's MCP area built again over the same
// board (`TestMcpOver`): the first one's calls are left executing, their approvals pending.
//
// Dropped, with why:
// - "an agent on another host has no thread here to ask in" (`ctx(p)` without a task): linked hosts are M7's; every
//   call here comes from a run with a thread;
// - the subproject cases (`tasks_added_while_the_user_is_asked…`, `no_task_joins_a_subproject…`,
//   `deleting_a_subproject_lists_its_tasks…`): there are no subprojects any more;
// - `a_repository_path_it_cant_have_is_refused_before_asking`'s relocation texts: moving a project's folder is M4's
//   (`Projects` refuses a new repo_path); what is kept is that it's refused before asking, and `move_repo` without one;
// - `agents_read_and_change_a_projects_prompts`' Codex reviewer config and the one `summarizer` read back: no configs
//   are made here, and `get_project` leaves `summarizer` out (3.2);
// - "the agent configs are the user's to change" (`claude_config_ids`): it isn't an argument of update_project, so the
//   argument check refuses it before the tool runs.

/** The approval call `id` is waiting on, as the board lists it, once it is being waited on. */
const asked = (id: string) =>
  Effect.gen(function* () {
    const permissions = yield* Permissions
    const request = yield* permissions.asking(id)
    const found = (yield* permissions.approvals).find((a) => a.request_id === request)
    return found === undefined ? assert.fail(`no approval ${request}`) : found
  })

/** The user answers request `request`. */
const answer = (request: RequestId, allow: boolean) =>
  Effect.flatMap(Permissions, (p) => p.answer(request, { decision: allow ? "allow" : "deny" }, "user")).pipe(Effect.orDie)

/** Call `id` of `agent`, answered `allow` by the user once it asks: what it gave, and what it asked. */
const answered = (agent: FakeAgent, tool: string, args: unknown, id: string, allow: boolean) =>
  Effect.gen(function* () {
    const running = yield* Effect.forkChild(call(agent, tool, args, id))
    const approval = yield* asked(id)
    yield* answer(approval.request_id, allow)
    return { result: yield* Fiber.join(running), approval }
  })

/** What an approval asked to do, as JSON. */
const input = (a: Approval): unknown => a.input

/** The board's server stops while call `id` asks the user: the call is left executing, its approval pending. */
const cutShort = (agent: FakeAgent, tool: string, args: unknown, id: string) =>
  Effect.gen(function* () {
    yield* Effect.forkChild(call(agent, tool, args, id))
    return (yield* asked(id)).request_id
  }).pipe(Effect.provide(TestMcpOver()))

/** The board's own approvals waiting for the user. */
const pendingApprovals = Effect.map(
  Effect.flatMap(Permissions, (p) => p.approvals),
  (all) => all.filter((a) => a.status === "pending").length,
)

/** Item `i` of a list in a result. */
const nth = (v: unknown, i: number): unknown => (Array.isArray(v) ? v[i] : undefined)

const exists = (id: string) =>
  Effect.map(
    Effect.flatMap(TaskRepo, (r) => r.get(id)),
    (t) => t !== null,
  )

describe("delete_task", () => {
  it.effect("deletes a task only once the user confirms", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      // Even a thread that may do anything without asking asks first.
      const caller = yield* task(kiw, "Caller")
      yield* setTask(caller.id, { permission_mode: "bypassPermissions" })
      const me = yield* agentOn(caller)
      const doomed = yield* task(kiw, "Doomed")
      const kept = yield* task(kiw, "Kept")

      assert.include(err(yield* call(me, "delete_task", { task_id: "KIW-1" }, "c0")), "can't delete your own task")
      assert.strictEqual(yield* pendingApprovals, 0)

      // Denied: nothing is deleted.
      let { result, approval } = yield* answered(me, "delete_task", { task_id: "KIW-3", reason: "A duplicate of KIW-2" }, "c1", false)
      assert.include(err(result), "didn't approve deleting KIW-3, so nothing was deleted")
      assert.isTrue(yield* exists(kept.id))
      assert.deepStrictEqual([approval.kind, approval.tool_name], ["delete_task", "delete_task"])
      const shown = input(approval)
      assert.deepStrictEqual(
        [at(shown, "delete", "key"), at(shown, "delete", "title"), at(shown, "task", "key"), at(shown, "project", "key")],
        ["KIW-3", "Kept", "KIW-1", "KIW"],
      )
      assert.deepStrictEqual([at(shown, "reason"), at(shown, "delete_branch")], ["A duplicate of KIW-2", false])
      // It flagged the asking task.
      assert.strictEqual((yield* (yield* TaskRepo).get(caller.id))?.attention_reason, "Delete a task?")

      // Confirmed: it's deleted.
      ;({ result } = yield* answered(me, "delete_task", { task_id: "KIW-2" }, "c2", true))
      assert.deepStrictEqual([ok(result)["deleted"], ok(result)["key"]], [true, "KIW-2"])
      assert.deepStrictEqual([yield* exists(doomed.id), yield* exists(kept.id)], [false, true])

      // Deleted by someone else while the user is asked: the question goes, and the call says so.
      const running = yield* Effect.forkChild(call(me, "delete_task", { task_id: "KIW-3" }, "c3"))
      yield* asked("c3")
      yield* (yield* Tasks).delete(kept.id, { deleteBranch: false }, Actor.user)
      assert.deepStrictEqual(ok(yield* Fiber.join(running)), { deleted: false, key: "KIW-3", note: "It was deleted meanwhile (not by this call)." })
      assert.strictEqual(yield* pendingApprovals, 0)
      // The profile's assistant can't be deleted.
      yield* agentOf(p)
      assert.include(err(yield* call(me, "delete_task", { task_id: "A-1" }, "c4")), "the profile's assistant can't be deleted")
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a retried delete deletes what it asked about, after a restart", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const me = yield* agentOn(yield* task(kiw, "Caller"))
      const doomed = yield* task(kiw, "Doomed")
      const kept = yield* task(kiw, "Kept")
      // The server stops while the user is asked.
      yield* cutShort(me, "delete_task", { task_id: "KIW-2" }, "c1")
      // Redelivered (with other arguments, even), the call waits for the same question, and deletes the task it named.
      const { result } = yield* answered(me, "delete_task", { task_id: "KIW-3" }, "c1", true).pipe(Effect.provide(TestMcpOver()))
      assert.strictEqual(ok(result)["key"], "KIW-2")
      assert.deepStrictEqual([yield* exists(doomed.id), yield* exists(kept.id)], [false, true])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("an ask rule on the whole board leaves it to ask once; a never rule still refuses it", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const doomed = yield* task(kiw, "Doomed")
      const kept = yield* task(kiw, "Kept")
      const rules = yield* ApprovalRules
      yield* rules.set(p.id, { rules: [{ tool: "mcp__huntaway", decision: "ask" }] })
      const mine = yield* agentOf(p)
      // delete_task asks with its own card, which shows what's deleted, and does it once that's approved.
      const running = yield* Effect.forkChild(call(mine, "delete_task", { task_id: doomed.id }, "d"))
      const a = yield* asked("d")
      assert.deepStrictEqual([a.kind, at(input(a), "delete", "key")], ["delete_task", "KIW-1"])
      // Its one card is the rule's asking.
      const pending = yield* (yield* Permissions).pending({ task: mine.run.task_id })
      assert.deepStrictEqual(
        pending.map((r) => r.rule),
        ["mcp__huntaway"],
      )
      yield* answer(a.request_id, true)
      assert.isTrue(ok(yield* Fiber.join(running))["deleted"] === true)
      assert.isFalse(yield* exists(doomed.id))
      const sql = yield* SqlClient.SqlClient
      const ruled = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM permission_requests WHERE rule IS NOT NULL`.pipe(Effect.orDie)
      assert.strictEqual(ruled[0]?.n, 1, "delete_task was asked about twice")
      const log = yield* rules.log({ profile_id: p.id })
      assert.deepStrictEqual(
        log.map((l) => [l.tool_name, l.rule, l.outcome, l.answered_by]),
        [["mcp__huntaway__delete_task", "mcp__huntaway", "allowed", "user"]],
      )
      // A never rule still refuses a tool that asks for itself.
      yield* rules.set(p.id, { rules: [{ tool: "mcp__huntaway__delete_task", decision: "never" }] })
      assert.include(err(yield* call(mine, "delete_task", { task_id: kept.id }, "d2")), "mcp__huntaway__delete_task")
      assert.isTrue(yield* exists(kept.id))
    }).pipe(Effect.provide(TestMcp())),
  )
})

describe("update_project", () => {
  it.effect("changes how agents are prompted without asking; a new repo_path is refused before asking", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const me = yield* agentOn(yield* task(kiw, "Caller"))
      let v = ok(yield* call(me, "update_project", { merge_prompt: "Squash-merge it.", review_rounds: 3 }))
      assert.deepStrictEqual(v["merge_prompt"], { instructions: "Squash-merge it.", default: false })
      assert.deepStrictEqual([at(v, "start_prompt", "default"), v["review_rounds"]], [true, 3])
      // An empty string goes back to the default.
      v = ok(yield* call(me, "update_project", { project_id: "KIW", merge_prompt: "", name: "Kiwi CD", model: "opus" }))
      assert.deepStrictEqual([at(v, "merge_prompt", "default"), v["name"], v["model"]], [true, "Kiwi CD", "opus"])
      assert.isNull(ok(yield* call(me, "update_project", { model: "" }))["model"])
      // Setting a risky one to what it already is asks nothing.
      yield* call(me, "update_project", { setup_script: "", use_worktrees: true })
      assert.strictEqual(yield* pendingApprovals, 0)
      assert.include(err(yield* call(me, "update_project", { name: " " })), "name can't be blank")
      assert.include(err(yield* call(me, "update_project", {})), "nothing to change")
      // Reviewers: blanks dropped, configs checked, an empty list (or null) back to the profile's.
      v = ok(yield* call(me, "update_project", { reviewers: [{ model: " opus ", effort: "" }] }))
      assert.deepStrictEqual(v["reviewers"], [{ claude_config_id: null, model: "opus", effort: null }])
      assert.include(err(yield* call(me, "update_project", { reviewers: [{ claude_config_id: "nope" }] })), "nope")
      assert.deepStrictEqual(ok(yield* call(me, "update_project", { reviewers: null }))["reviewers"], [])
      // A summarizer of its own (the one, or several), and back to the profile's with null.
      v = ok(yield* call(me, "update_project", { summarizer: { model: "sonnet" } }))
      assert.strictEqual(at(nth(v["summarizers"], 0), "model"), "sonnet")
      v = ok(yield* call(me, "update_project", { summarizers: [{ name: "A" }, { name: "B", skills: ["tldr"] }] }))
      assert.deepStrictEqual(at(nth(v["summarizers"], 1), "skills"), ["tldr"])
      assert.deepStrictEqual(ok(yield* call(me, "update_project", { summarizer: null }))["summarizers"], [])
      assert.strictEqual(ok(yield* call(me, "update_project", { group_name: "Kiwi" }))["group_name"], "Kiwi")
      assert.isNull(ok(yield* call(me, "update_project", { group_name: "" }))["group_name"])
      // A repository path it can't have is refused before the user is asked.
      assert.include(err(yield* call(me, "update_project", { repo_path: "/nowhere" })), "moving a project's folder")
      assert.include(err(yield* call(me, "update_project", { move_repo: true })), "move_repo needs a new repo_path")
      assert.include(err(yield* call(me, "update_project", { repo_path: kiw.repo_path, move_repo: true })), "move_repo needs a new repo_path")
      assert.include(err(yield* call(me, "update_project", { status_scripts: { later: "x" } })), 'unknown status "later" in status_scripts')
      assert.strictEqual(yield* pendingApprovals, 0)
      assert.strictEqual(Option.getOrThrow(yield* (yield* ProjectRepo).get(kiw.id)).repo_path, kiw.repo_path)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("the user approves risky changes; denied, nothing changes; only what differs is shown and made", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      // Even a thread that may do anything without asking asks for these.
      const caller = yield* task(kiw, "Caller")
      yield* setTask(caller.id, { permission_mode: "bypassPermissions" })
      const me = yield* agentOn(caller)
      const projects = yield* Projects
      const change = { permission_mode: "bypassPermissions", setup_script: "npm ci", base_branch: "main", reason: "Faster setup" }

      // Denied: nothing changes, and the agent hears why.
      let { result, approval } = yield* answered(me, "update_project", change, "c1", false)
      assert.include(err(result), "didn't approve changing setup_script, permission_mode, so nothing was changed")
      let stored = yield* projects.get(kiw.id)
      assert.deepStrictEqual([stored.permission_mode, stored.setup_script, stored.base_branch], [null, "", null])
      assert.deepStrictEqual([approval.kind, approval.tool_name, approval.task_id], ["project", "update_project", caller.id])
      const shown = input(approval)
      assert.deepStrictEqual([at(shown, "project", "key"), at(shown, "task", "key"), at(shown, "reason")], ["KIW", "KIW-1", "Faster setup"])
      const changes = at(shown, "changes")
      const field = (f: string) => (Array.isArray(changes) ? changes.find((c) => at(c, "field") === f) : undefined)
      assert.deepStrictEqual(field("permission_mode"), { field: "permission_mode", from: null, to: "bypassPermissions", needs_approval: true })
      assert.strictEqual(at(field("base_branch"), "needs_approval"), false)

      // A changed thread mode doesn't settle it either; approved, the whole call is made.
      const running = yield* Effect.forkChild(call(me, "update_project", change, "c2"))
      const a2 = yield* asked("c2")
      yield* setTask(caller.id, { permission_mode: "dontAsk" })
      yield* (yield* Permissions).applyMode(caller.id)
      yield* answer(a2.request_id, true)
      const v = ok(yield* Fiber.join(running))
      assert.deepStrictEqual([v["permission_mode"], v["setup_script"], v["base_branch"]], ["bypassPermissions", "npm ci", "main"])
      assert.deepStrictEqual((yield* (yield* TaskRepo).get(caller.id))?.auto_allow, [])

      // Only what differs is shown and made: a setting the call leaves as it was isn't written back over a change made
      // while the user decides.
      const again = { permission_mode: "bypassPermissions", setup_script: "npm install" }
      const running3 = yield* Effect.forkChild(call(me, "update_project", again, "c5"))
      const a3 = yield* asked("c5")
      yield* projects.update(kiw.id, { permission_mode: "default" })
      yield* answer(a3.request_id, true)
      const fields = at(input(a3), "changes")
      assert.deepStrictEqual(Array.isArray(fields) ? fields.map((c) => at(c, "field")) : [], ["setup_script"])
      assert.strictEqual(ok(yield* Fiber.join(running3))["permission_mode"], "default")
      stored = yield* projects.get(kiw.id)
      assert.deepStrictEqual([stored.permission_mode, stored.setup_script], ["default", "npm install"])

      // Settings given in another form than they're kept in, but that come to what they are (a blank column script is
      // none, no reviewers is the profile's), aren't changes, so nothing is asked.
      const same = { status_scripts: { done: "  " }, reviewers: [], use_worktrees: true, repo_path: kiw.repo_path }
      const left = ok(yield* call(me, "update_project", same, "c6"))
      assert.deepStrictEqual([left["status_scripts"], left["reviewers"]], [{}, []])
      assert.strictEqual(yield* pendingApprovals, 0)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("files brought into worktrees need the user's approval", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const me = yield* agentOn(yield* task(kiw, "Caller"))
      const change = { copy_files: ".env", link_folders: "models" }
      const denied = yield* answered(me, "update_project", change, "c1", false)
      assert.include(err(denied.result), "didn't approve changing copy_files, link_folders")
      const fields = at(input(denied.approval), "changes")
      assert.deepStrictEqual(Array.isArray(fields) ? fields.map((c) => at(c, "field")) : [], ["copy_files", "link_folders"])
      const stored = yield* (yield* Projects).get(kiw.id)
      assert.deepStrictEqual([stored.copy_files, stored.link_folders], ["", ""])
      const v = ok((yield* answered(me, "update_project", change, "c2", true)).result)
      assert.deepStrictEqual([v["copy_files"], v["link_folders"]], [".env", "models"])
      // Checked as the board checks them, before asking.
      assert.include(err(yield* call(me, "update_project", { link_folders: "../elsewhere" }, "c3")), "link_folders: ../elsewhere")
      assert.strictEqual(yield* pendingApprovals, 0)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a retried call carries on with its approval and applies only the fields it showed", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const me = yield* agentOn(yield* task(kiw, "Caller"))
      const projects = yield* Projects
      // The server stops while the user is asked about the script (the name is as it was).
      const change = { name: "kiwicd", setup_script: "npm ci" }
      yield* cutShort(me, "update_project", change, "c1")
      // Meanwhile the user renames the project and sets the script themselves.
      yield* projects.update(kiw.id, { name: "Kiwi", setup_script: "npm ci" })
      // Redelivered, the call waits for the same approval and makes only what it showed.
      const { result, approval } = yield* answered(me, "update_project", change, "c1", true).pipe(Effect.provide(TestMcpOver()))
      assert.strictEqual(ok(result)["name"], "Kiwi")
      const shown = at(input(approval), "changes")
      assert.strictEqual(Array.isArray(shown) ? shown.length : 0, 1)
      assert.strictEqual(yield* pendingApprovals, 0)

      // Answered already: a denial stands, without asking again.
      const r2 = yield* cutShort(me, "update_project", { setup_script: "make" }, "c2")
      yield* answer(r2, false)
      yield* projects.update(kiw.id, { setup_script: "" })
      const e = yield* Effect.map(call(me, "update_project", { setup_script: "make" }, "c2"), err).pipe(Effect.provide(TestMcpOver()))
      assert.include(e, "didn't approve changing setup_script")
      assert.strictEqual((yield* projects.get(kiw.id)).setup_script, "")

      // Approved before the retry: the change may have been made as the server stopped, so it isn't made again.
      const r3 = yield* cutShort(me, "update_project", { setup_script: "make" }, "c3")
      yield* answer(r3, true)
      const e3 = yield* Effect.map(call(me, "update_project", { setup_script: "make" }, "c3"), err).pipe(Effect.provide(TestMcpOver()))
      assert.include(e3, "interrupted")
      assert.strictEqual((yield* projects.get(kiw.id)).setup_script, "")
      // There's no tool to delete a project.
      assert.include(err(yield* call(me, "delete_project", { project_id: "KIW" }, "c4")), "delete_project")
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("deleting the asking thread, or the project the change is for, settles its approval", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const oth = yield* project(p, "other", "OTH")
      const asker = yield* task(kiw, "Asker")
      const otherAsker = yield* agentOn(yield* task(kiw, "Other asker"))
      const running = yield* Effect.forkChild(call(yield* agentOn(asker), "update_project", { setup_script: "make" }, "c1"))
      yield* asked("c1")
      yield* (yield* Tasks).delete(asker.id, { deleteBranch: false }, Actor.user)
      assert.include(err(yield* Fiber.join(running)), "Request expired")
      assert.strictEqual(yield* pendingApprovals, 0)
      // The project the change is for is deleted, from another project's thread.
      const running2 = yield* Effect.forkChild(call(otherAsker, "update_project", { project_id: "OTH", setup_script: "make" }, "c2"))
      yield* asked("c2")
      yield* (yield* Projects).delete(oth.id)
      assert.include(err(yield* Fiber.join(running2)), "Request expired")
      assert.strictEqual(yield* pendingApprovals, 0)
    }).pipe(Effect.provide(TestMcp())),
  )
})

describe("create_project", () => {
  it.effect("adds a folder only once the user approves it, where the user saw it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      // Even a thread that may do anything without asking asks first.
      const caller = yield* task(kiw, "Caller")
      yield* setTask(caller.id, { permission_mode: "bypassPermissions" })
      const me = yield* agentOn(caller)
      const root = yield* fs.realPath(yield* tempDir).pipe(Effect.orDie)
      const home = `${root}/home`
      yield* fs.makeDirectory(home).pipe(Effect.orDie)
      const count = Effect.map(
        Effect.flatMap(ProjectRepo, (r) => r.list(p.id)),
        (all) => all.length,
      )

      // Denied: no project, and no folder made.
      const fresh = `${root}/new/site`
      const denied = yield* answered(me, "create_project", { repo_path: fresh, name: "Site", reason: "The user asked for one" }, "c1", false)
      assert.include(err(denied.result), `didn't approve adding ${fresh} as a project, so nothing was added`)
      assert.deepStrictEqual([yield* count, yield* fs.exists(`${root}/new`).pipe(Effect.orDie)], [1, false])
      assert.deepStrictEqual([denied.approval.kind, denied.approval.tool_name], ["project", "create_project"])
      const shown = input(denied.approval)
      assert.deepStrictEqual([at(shown, "op"), at(shown, "repo_path"), at(shown, "exists"), at(shown, "git")], ["create", fresh, false, false])
      assert.deepStrictEqual([at(shown, "project", "name"), at(shown, "project", "key"), at(shown, "board")], ["Site", "SIT", "personal"])
      assert.deepStrictEqual([at(shown, "task", "key"), at(shown, "reason"), at(shown, "permission_mode")], ["KIW-1", "The user asked for one", "default"])
      assert.strictEqual((yield* (yield* TaskRepo).get(caller.id))?.attention_reason, "Add a project?")

      // Approved: it's added where the user saw, with symlinks and `..` resolved first.
      yield* fs.symlink(home, `${root}/link`).pipe(Effect.orDie)
      const approved = yield* answered(me, "create_project", { repo_path: `${root}/link/../link` }, "c2", true)
      const v = ok(approved.result)
      const asked2 = input(approved.approval)
      assert.deepStrictEqual([at(asked2, "repo_path"), at(asked2, "exists"), at(asked2, "project", "name")], [home, true, "home"])
      assert.deepStrictEqual([v["repo_path"], v["name"], v["profile"]], [home, "home", "personal"])
      assert.strictEqual(yield* count, 2)

      // Paths that aren't plainly somewhere aren't asked about.
      for (const bad of ["relative/path", "/nonexistent-ia/../x"]) {
        const e = err(yield* call(me, "create_project", { repo_path: bad }, `bad-${bad}`))
        assert.isTrue(e.includes("absolute path") || e.includes("can be created"), `${bad}: ${e}`)
      }
      assert.include(err(yield* call(me, "create_project", { repo_path: "" }, "c3")), "create_project needs repo_path")
      yield* fs.writeFileString(`${root}/file`, "").pipe(Effect.orDie)
      assert.include(err(yield* call(me, "create_project", { repo_path: `${root}/file` }, "c4")), "is not a directory")
      assert.strictEqual(yield* pendingApprovals, 0)

      // Cut short by a restart while the user is asked, the retried call waits for the same answer.
      const later = `${root}/later`
      yield* cutShort(me, "create_project", { repo_path: later }, "m1")
      const retried = yield* answered(me, "create_project", { repo_path: later }, "m1", true).pipe(Effect.provide(TestMcpOver()))
      assert.strictEqual(ok(retried.result)["repo_path"], later)
      assert.strictEqual(yield* count, 3)
      assert.strictEqual((yield* fs.stat(later).pipe(Effect.orDie)).type, "Directory")
    }).pipe(Effect.provide(TestMcp())),
  )
})
