import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { TestMcp } from "@huntaway/testing"
import { Projects } from "../projects/Projects.ts"
import { agentOf, assistant, call, err, grant, keys, list, ok, profile, project, str, task } from "./tools/tests/board.ts"

// Which boards, projects and tasks a name or key means (the old mcp/tools/resolve.test.ts), through the board's tools
// as an agent calls them. Dropped: the parts that change a project's key with `update_project` (3.4's; the key is
// changed with `Projects.update` here), and `send_to_task` on a review thread (it comes with `Runs`).

const sorted = (xs: ReadonlyArray<string>) => xs.toSorted()

describe("resolve", () => {
  it.effect("leaves archived projects out of lists", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const ia = yield* project(p, "ia", "IA")
      const old = yield* project(p, "old", "OLD")
      yield* task(ia, "live")
      yield* task(old, "shelved")
      yield* (yield* Projects).update(old.id, { archived: true })
      const me = yield* agentOf(p)
      assert.deepStrictEqual(keys(list(yield* call(me, "list_projects", {})), "key"), ["personal:IA"])
      assert.deepStrictEqual(keys(list(yield* call(me, "list_tasks", { project_id: "all" })), "key"), ["personal:IA-1"])
      // Still found when named, and says it's archived.
      assert.strictEqual(ok(yield* call(me, "get_project", { project_id: "OLD" }))["archived"], true)
      assert.strictEqual(ok(yield* call(me, "get_project", { project_id: "IA" }))["archived"], false)
      const e = err(yield* call(me, "create_task", { project_id: "OLD", title: "more", start: false }))
      assert.include(e, "is archived")
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("lists other profiles' boards that let it in", () =>
    Effect.gen(function* () {
      const personal = yield* profile("personal")
      const work = yield* profile("work")
      yield* project(personal, "ia", "IA")
      const sd = yield* project(work, "sd", "SD")
      yield* task(sd, "deploy")
      const me = yield* agentOf(personal)
      // Opt-in: other boards are closed until they let the profile in.
      assert.deepStrictEqual(keys(list(yield* call(me, "list_projects", {})), "key"), ["personal:IA"])
      assert.include(err(yield* call(me, "get_task", { task_id: "SD-1" })), "task SD-1")
      assert.include(err(yield* call(me, "list_tasks", { profile: "work", project_id: "all" })), "Settings → Profiles")

      yield* grant(work, ["personal"])
      assert.deepStrictEqual(keys(list(yield* call(me, "list_projects", {})), "key"), ["personal:IA", "work:SD"])
      assert.deepStrictEqual(keys(list(yield* call(me, "list_projects", { profile: "work" })), "key"), ["work:SD"])
      // 'all' is the caller's own board unless it names another (or every one).
      assert.strictEqual(list(yield* call(me, "list_tasks", { project_id: "all" })).length, 0)
      assert.deepStrictEqual(keys(list(yield* call(me, "list_tasks", { project_id: "all", profile: "all" })), "key"), ["work:SD-1"])
      assert.deepStrictEqual(keys(list(yield* call(me, "list_tasks", { project_id: "SD" })), "key"), ["work:SD-1"])
      assert.strictEqual(ok(yield* call(me, "get_task", { task_id: "SD-1" }))["title"], "deploy")
      // Access is one way.
      assert.deepStrictEqual(keys(list(yield* call(yield* agentOf(work), "list_projects", {})), "key"), ["work:SD"])
      // `*` lets every profile in.
      const lab = yield* profile("lab")
      yield* grant(personal, ["*"])
      assert.deepStrictEqual(keys(list(yield* call(yield* agentOf(lab), "list_projects", {})), "key"), ["personal:IA"])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("keys used on several boards need a profile", () =>
    Effect.gen(function* () {
      const personal = yield* profile("personal")
      const work = yield* profile("work", ["personal"])
      const lab = yield* profile("lab", ["personal"])
      const iaPersonal = yield* project(personal, "ia-personal", "IA")
      const iaWork = yield* project(work, "ia-work", "IA")
      const sdWork = yield* project(work, "sd-work", "SD")
      const sdLab = yield* project(lab, "sd-lab", "SD")
      for (const p of [iaPersonal, iaWork, sdWork, sdLab]) yield* task(p, p.name)
      const me = yield* agentOf(personal)
      const title = (args: unknown) => Effect.map(call(me, "get_task", args), (r) => str(ok(r), "title"))
      // The caller's own board wins.
      assert.strictEqual(yield* title({ task_id: "IA-1" }), "ia-personal")
      assert.strictEqual(yield* title({ task_id: "work:IA-1" }), "ia-work")
      // On two other boards, the key must say which.
      const e = err(yield* call(me, "get_task", { task_id: "SD-1" }))
      assert.isTrue(e.includes("work:SD-1") && e.includes("lab:SD-1"), e)
      assert.strictEqual(yield* title({ task_id: "lab:SD-1" }), "sd-lab")
      assert.strictEqual(yield* title({ task_id: "SD-1", profile: "work" }), "sd-work")
      // Ids need no profile.
      const id = str(list(yield* call(me, "list_tasks", { project_id: "lab:SD" }))[0] ?? {}, "id")
      assert.strictEqual(yield* title({ task_id: id }), "sd-lab")
      // Projects too, by key or name.
      assert.include(err(yield* call(me, "list_tasks", { project_id: "SD" })), "work:SD")
      assert.deepStrictEqual(keys(list(yield* call(me, "list_tasks", { project_id: "sd-work" })), "title"), ["work:sd-work"])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a renamed project's old key still names its tasks", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const os = yield* project(p, "os", "OS")
      const web = yield* project(p, "web", "WEB")
      yield* task(os, "Sandbox")
      yield* (yield* Projects).update(os.id, { key: "OMS" })
      const me = yield* agentOf(p)
      assert.strictEqual(ok(yield* call(me, "get_task", { task_id: "OMS-1" }))["key"], "OMS-1")
      assert.strictEqual(ok(yield* call(me, "get_task", { task_id: "os-1" }))["key"], "OMS-1")
      assert.strictEqual(ok(yield* call(me, "get_project", { project_id: "OS" }))["key"], "OMS")
      // Projects that shared a key before it was checked: their tasks are named by id instead.
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE projects SET former_keys = '["OS"]' WHERE id = ${web.id}`.pipe(Effect.orDie)
      yield* task(web, "Site")
      const e = err(yield* call(me, "get_task", { task_id: "OS-1" }))
      assert.isTrue(e.includes("more than one task") && e.includes("Sandbox (id ") && e.includes("in web)"), e)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a task named by key is its project's task of that number", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      yield* project(p, "web", "WEB")
      const api = yield* project(p, "api", "API")
      const me = yield* agentOf(p)
      for (const title of ["One", "Two"]) ok(yield* call(me, "create_task", { title, project_id: "WEB", start: false }))
      yield* task(api, "Elsewhere")
      assert.strictEqual(ok(yield* call(me, "get_task", { task_id: "WEB-2" }))["title"], "Two")
      assert.strictEqual(ok(yield* call(me, "get_task", { task_id: "web-1" }))["title"], "One")
      assert.strictEqual(ok(yield* call(me, "get_task", { task_id: "API-1" }))["title"], "Elsewhere")
      for (const key of ["WEB-0", "WEB-3"]) assert.strictEqual(err(yield* call(me, "get_task", { task_id: key })), `not found: task ${key}`)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a review thread isn't a task by its id either", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const reviewed = yield* task(kiw, "Reviewed")
      const sql = yield* SqlClient.SqlClient
      const thread = "review-thread"
      yield* sql`INSERT INTO tasks (id, profile_id, project_id, kind, parent_id, title, status, last_activity_at, created_at, updated_at)
        VALUES (${thread}, ${p.id}, ${kiw.id}, 'review', ${reviewed.id}, 'review', 'todo', '', '', '')`.pipe(Effect.orDie)
      const me = yield* agentOf(p)
      assert.strictEqual(err(yield* call(me, "get_task", { task_id: thread })), `not found: task ${thread}`)
      assert.strictEqual(ok(yield* call(me, "get_task", { task_id: reviewed.id }))["title"], "Reviewed")
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a project name with a colon isn't read as a profile", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      yield* (yield* Projects).update(kiw.id, { name: "Ops: infra" })
      const me = yield* agentOf(p)
      assert.strictEqual(ok(yield* call(me, "get_project", { project_id: "Ops: infra" }))["key"], "KIW")
      // A profile's name still qualifies a key, and one that doesn't let the caller in says so.
      assert.strictEqual(ok(yield* call(me, "get_project", { project_id: "personal:KIW" }))["key"], "KIW")
      // Even if a profile is called Ops, whether it lets the caller in or not.
      const ops = yield* profile("ops")
      assert.strictEqual(ok(yield* call(me, "get_project", { project_id: "Ops: infra" }))["key"], "KIW")
      assert.include(err(yield* call(me, "get_project", { project_id: "ops:KIW" })), "doesn't let agents in profile personal")
      yield* grant(ops, ["personal"])
      assert.strictEqual(ok(yield* call(me, "get_project", { project_id: "Ops: infra" }))["key"], "KIW")
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("only its own profile's agents reach the assistant", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal", ["work"])
      const work = yield* profile("work", ["personal"])
      yield* task(yield* project(p, "web", "WEB"), "build")
      yield* task(yield* project(work, "sd", "SD"), "deploy")
      const me = yield* agentOf(p)
      const mine = me.run.task_id
      const theirs = yield* assistant(work)
      // Off list_tasks unless it's asked for, and then only the caller's own.
      assert.deepStrictEqual(keys(list(yield* call(me, "list_tasks", { project_id: "all" })), "key"), ["personal:WEB-1"])
      const all = list(yield* call(me, "list_tasks", { project_id: "all", include_assistant: true }))
      assert.deepStrictEqual(sorted(keys(all, "key")), ["personal:A-1", "personal:WEB-1"])
      assert.strictEqual(all.find((t) => t["key"] === "A-1")?.["type"], "assistant")
      const every = list(yield* call(me, "list_tasks", { project_id: "all", profile: "all", include_assistant: true }))
      assert.deepStrictEqual(sorted(keys(every, "key")), ["personal:A-1", "personal:WEB-1", "work:SD-1"])
      // By key or id, its own and not the other profile's.
      assert.strictEqual(ok(yield* call(me, "get_task", { task_id: "A-1" }))["id"], mine)
      assert.strictEqual(ok(yield* call(me, "get_task", { task_id: mine }))["key"], "A-1")
      for (const r of ["work:A-1", theirs]) {
        err(yield* call(me, "get_task", { task_id: r }))
        err(yield* call(me, "update_task", { task_id: r, title: "Mine now" }))
      }
      err(yield* call(me, "get_task", { task_id: "A-1", profile: "work" }))
      // The other profile's own agents reach theirs.
      assert.strictEqual(ok(yield* call(yield* agentOf(work), "get_task", { task_id: "A-1" }))["id"], theirs)
    }).pipe(Effect.provide(TestMcp())),
  )
})
