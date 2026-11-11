import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Timestamp } from "@huntaway/contracts"
import { gitRepo, TestMcp } from "@huntaway/testing"
import { toJson } from "../../platform/columns.ts"
import { Projects } from "../../projects/Projects.ts"
import { Tasks } from "../../tasks/Tasks.ts"
import { Threads } from "../../threads/Threads.ts"
import { McpServers } from "../McpServers.ts"
import { BAD_REMIND_AT, reminderTime } from "./reminders.ts"
import { overview, TASK_FIELD_DEFAULT_LIMIT, TASK_FIELD_MAX_LIMIT } from "./taskJson.ts"
import { agentOf, agentOn, at, byText, call, err, grant, idOf, keys, list, ok, profile, project, setTask, str, task } from "./tests/board.ts"

// The task tools (the old mcp/tools/tasks.test.ts, local.test.ts and model_effort.test.ts), as an agent calls them
// through `ToolCalls`. Dropped, with why:
// - every case about linked hosts and old helpers (`handle_remote`, `task_fields`, `too_old`): M7;
// - subprojects (made by `testing.legacy_subproject`): there are none any more, and `type: "subproject"` is refused by
//   the schema; a named one is "not a subproject";
// - `group_tasks_follow_their_group_when_its_renamed`, `a_database_from_before…`: the database's, not the tools';
// - `start_from` a branch or a pull request on a worktree task: worktrees are M4's (`merges_into`, which starts it from
//   the other task, is tested on a repository);
// - starting agents, `send_to_task`: in starting.test.ts;
// - a task's config on another profile's board, and Codex configs: no configs are made here; the model and effort are
//   kept whatever the config, as `Tasks` does;
// - exact type-error texts ("starred must be", "model must be a string", "effort must be one of"): the arguments'
//   schema refuses a wrong type now, with a message that says so.

const chars = (s: string) => Array.from(s).length
const AT = "2026-11-12T00:00:00.000Z"

describe("task tools", () => {
  it.effect("large task fields are summarized and can be reassembled", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const ia = yield* project(p, "ia", "IA")
      const t = yield* task(ia, "A large task")
      const me = yield* agentOf(p)
      const description = "A lengthy description\n".repeat(5000)
      const message = 'Latest reply: ā🙂\n"quoted"\\\t'.repeat(4000)
      const review = {
        thread_id: t.id,
        state: "issues",
        head: null,
        summary: "Review\n".repeat(2000),
        issues: ["Fix it".repeat(1000)],
        fixes: 0,
        extra_rounds: 0,
        updated_at: AT,
        reviewers: [],
      }
      yield* setTask(t.id, { description, review: yield* toJson(review) })
      yield* (yield* Threads).appendFromAgent(t.id, [
        { type: "item.added", item: { id: "m1", type: "assistant_message", text: message, created_at: Timestamp.make(AT) } },
      ])
      // Arrays can grow too; no unbounded review is smuggled in through created_tasks.
      const child = yield* task(ia, "Child")
      yield* setTask(child.id, { created_by: t.id, review: yield* toJson(review) })
      const seen = ok(yield* call(me, "get_task", { task_id: "IA-1" }))
      assert.isBelow(new TextEncoder().encode(yield* toJson(seen)).length, 10000)
      assert.deepStrictEqual([seen["key"], seen["title"]], ["IA-1", "A large task"])
      const omitted = seen["omitted_fields"]
      for (const name of ["description", "last_message", "review", "created_tasks"]) {
        assert.isUndefined(seen[name], `${name} was inlined`)
        assert.isTrue(Array.isArray(omitted) && omitted.includes(name), name)
      }
      const length = (name: string) => at(seen, "field_lengths", name)
      assert.strictEqual(length("description"), chars(description))
      assert.strictEqual(length("last_message"), chars(message))
      for (const [name, expected] of [
        ["description", description],
        ["last_message", message],
      ] as const) {
        let offset = 0
        let assembled = ""
        for (;;) {
          const page = ok(yield* call(me, "get_task_field", { task_id: t.id, field: name, offset }))
          const content = str(page, "content")
          assert.strictEqual(page["format"], "text")
          assert.strictEqual(page["total_length"], length(name))
          assert.isAtMost(chars(content), TASK_FIELD_DEFAULT_LIMIT)
          assembled += content
          const next = page["next_offset"]
          if (typeof next !== "number") break
          assert.isAbove(next, offset)
          offset = next
        }
        assert.strictEqual(assembled, expected)
      }
      const page = ok(yield* call(me, "get_task_field", { task_id: "IA-1", field: "review" }))
      assert.strictEqual(page["format"], "json")
      assert.strictEqual(page["total_length"], length("review"))
      assert.strictEqual(typeof page["next_offset"], "number")
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("task field pages count characters and validate ranges", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const t = yield* task(yield* project(p, "ia", "IA"), "Small task")
      const me = yield* agentOf(p)
      yield* setTask(t.id, { description: 'aā🙂\n"\\\u0000z' })
      const page = (extra: Readonly<Record<string, unknown>>) => call(me, "get_task_field", { task_id: "IA-1", field: "description", ...extra })
      let v = ok(yield* page({ offset: 1, limit: 3 }))
      assert.deepStrictEqual([v["content"], v["length"], v["total_length"], v["next_offset"]], ["ā🙂\n", 3, 8, 4])
      v = ok(yield* page({ offset: 7, limit: TASK_FIELD_MAX_LIMIT }))
      assert.deepStrictEqual([v["content"], v["next_offset"]], ["z", null])
      for (const offset of [8, 9, Number.MAX_SAFE_INTEGER]) {
        v = ok(yield* page({ offset }))
        assert.deepStrictEqual([v["content"], v["length"], v["next_offset"]], ["", 0, null])
      }
      for (const extra of [
        { offset: -1 },
        { offset: 1.5 },
        { offset: "1" },
        { offset: null },
        { limit: -1 },
        { limit: 0 },
        { limit: TASK_FIELD_MAX_LIMIT + 1 },
        { limit: 1.5 },
        { limit: "1" },
        { limit: null },
        { field: "session_id" },
      ]) {
        err(yield* page(extra))
      }
      // Null, scalar and empty fields have exact lengths matching their paginated representation.
      const seen = ok(yield* call(me, "get_task", { task_id: "IA-1" }))
      assert.strictEqual(seen["description"], 'aā🙂\n"\\\u0000z')
      const lengths = seen["field_lengths"]
      for (const [name, content, format] of [
        ["last_message", "null", "json"],
        ["running", "false", "json"],
        ["title", "Small task", "text"],
      ] as const) {
        v = ok(yield* page({ field: name }))
        assert.deepStrictEqual([v["content"], v["format"]], [content, format])
        assert.strictEqual(at(lengths, name), chars(content))
      }
      yield* setTask(t.id, { description: "" })
      v = ok(yield* page({}))
      assert.deepStrictEqual([v["total_length"], v["content"], v["next_offset"]], [0, "", null])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("the overview bounds escaped values and the total inline size", () =>
    Effect.gen(function* () {
      const details: Record<string, string> = {}
      for (let i = 0; i < 30; i++) details[`field_${i}`] = "x".repeat(900)
      let v = yield* overview(details)
      assert.isBelow((yield* toJson(v)).length, 10000)
      const lengths = v["field_lengths"]
      assert.strictEqual(typeof lengths === "object" && lengths !== null ? Object.keys(lengths).length : 0, 30)
      const omitted = v["omitted_fields"]
      assert.isAtLeast(Array.isArray(omitted) ? omitted.length : 0, 24)
      // Control characters expand sixfold in JSON; characters alone aren't an output bound.
      v = yield* overview({ description: "\u0000".repeat(900) })
      assert.isUndefined(v["description"])
    }),
  )

  it.effect("task fields use the same profile access and key resolution", () =>
    Effect.gen(function* () {
      const personal = yield* profile("personal")
      const work = yield* profile("work")
      const lab = yield* profile("lab")
      const ids: Record<string, string> = {}
      for (const [p, name, key] of [
        [personal, "own", "IA"],
        [work, "work", "IA"],
        [lab, "lab", "LAB"],
      ] as const) {
        const t = yield* task(yield* project(p, name, key), name)
        yield* setTask(t.id, { description: name })
        ids[name] = t.id
      }
      const me = yield* agentOf(personal)
      const get = (extra: Readonly<Record<string, unknown>>) => call(me, "get_task_field", { task_id: "IA-1", field: "description", ...extra })
      err(yield* get({ task_id: ids["work"] }))
      err(yield* get({ profile: "work" }))
      err(yield* get({ task_id: "work:IA-1" }))
      yield* grant(work, ["personal"])
      assert.strictEqual(ok(yield* get({}))["content"], "own")
      assert.strictEqual(ok(yield* get({ profile: "work" }))["content"], "work")
      assert.strictEqual(ok(yield* get({ task_id: "work:ia-1" }))["content"], "work")
      assert.strictEqual(ok(yield* get({ task_id: ids["work"] }))["content"], "work")
      err(yield* get({ task_id: "LAB-1" }))
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("stars and sets reminders", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const me = yield* agentOf(p)
      // Set as it's created, the reminder a delay from now (the test clock's).
      let t = ok(yield* call(me, "create_task", { title: "Later", project_id: "KIW", starred: true, remind_at: "2h", reminder: " Check CI ", start: false }))
      assert.deepStrictEqual([t["starred"], t["reminder"], t["remind_at"]], [true, "Check CI", "1970-01-01T02:00:00.000Z"])
      // An absolute time is kept in UTC, and the note stays when only the time changes.
      t = ok(yield* call(me, "update_task", { task_id: "KIW-1", remind_at: "2030-01-02T09:00:00+13:00", starred: false }))
      assert.deepStrictEqual([t["remind_at"], t["reminder"], t["starred"]], ["2030-01-01T20:00:00.000Z", "Check CI", undefined])
      err(yield* call(me, "update_task", { task_id: "KIW-1", starred: "yes" }))
      err(yield* call(me, "update_task", { task_id: "KIW-1", remind_at: 5 }))
      assert.strictEqual(err(yield* call(me, "update_task", { task_id: "KIW-1", remind_at: "soon" })), BAD_REMIND_AT)
      // Clearing the time clears the note, and a note needs a time.
      t = ok(yield* call(me, "update_task", { task_id: "KIW-1", remind_at: "" }))
      assert.isUndefined(t["remind_at"])
      const stored = yield* (yield* Tasks).get(idOf(t))
      assert.deepStrictEqual([stored.remind_at, stored.reminder], [null, null])
      assert.include(err(yield* call(me, "update_task", { task_id: "KIW-1", reminder: "Why" })), "needs remind_at")
      // A bad time doesn't leave a task behind.
      err(yield* call(me, "create_task", { title: "Bad", remind_at: "whenever", project_id: "KIW" }))
      assert.strictEqual((yield* (yield* Tasks).list({ _tag: "ByProject", project_id: kiw.id })).length, 1)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a create_task with bad marks leaves no task", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const me = yield* agentOf(p)
      for (const [args, why] of [
        [{ reminder: "Check CI" }, "needs remind_at"],
        [{ starred: "yes" }, "schema"],
        [{ remind_at: "2h", reminder: "x".repeat(501) }, "at most 500"],
        [{ remind_at: 5 }, "schema"],
        [{ remind_at: "whenever" }, "remind_at must be"],
      ] as const) {
        assert.include(err(yield* call(me, "create_task", { ...args, title: "Bad", project_id: "KIW" })), why)
        assert.strictEqual((yield* (yield* Tasks).list({ _tag: "ByProject", project_id: kiw.id })).length, 0, `${why} left a task`)
      }
      const t = ok(yield* call(me, "create_task", { title: "Good", project_id: "KIW", remind_at: "1d", reminder: "Look again", start: false }))
      assert.strictEqual(t["reminder"], "Look again")
      // A scratch task gets them too.
      const s = ok(yield* call(me, "create_task", { type: "scratch", title: "Scratch", starred: true, remind_at: "2h", reminder: "Come back to this" }))
      assert.deepStrictEqual([s["starred"], s["reminder"], s["key"]], [true, "Come back to this", "S-1"])
    }).pipe(Effect.provide(TestMcp())),
  )

  it("reads reminder times", () => {
    const now = DateTime.makeUnsafe("2026-10-26T10:00:00Z")
    const zone = DateTime.zoneMakeOffset(0)
    const when = (v: string) => reminderTime(v, now, zone)
    assert.strictEqual(when("30m"), "2026-10-26T10:30:00.000Z")
    assert.strictEqual(when("in 2 hours"), "2026-10-26T12:00:00.000Z")
    assert.strictEqual(when("1d 12h"), "2026-10-27T22:00:00.000Z")
    assert.strictEqual(when("1w"), "2026-11-02T10:00:00.000Z")
    assert.strictEqual(when("2026-12-01T09:00:00Z"), "2026-12-01T09:00:00Z")
    assert.strictEqual(when(" "), "")
    // In the host's time zone.
    assert.strictEqual(when("2026-12-01 09:30"), "2026-12-01T09:30:00.000Z")
    assert.strictEqual(when("2026-12-01T09:00"), "2026-12-01T09:00:00.000Z")
    assert.strictEqual(when("2026-12-01"), "2026-12-01T09:00:00.000Z")
    assert.strictEqual(reminderTime("2026-12-01", now, DateTime.zoneMakeOffset(13 * 3600_000)), "2026-11-30T20:00:00.000Z")
    for (const v of ["soon", "2", "h", "3 fortnights", "99999d", "tomorrow", "2026-02-30", "2026-12-01 25:00"]) assert.isNull(when(v), v)
  })

  it.effect("creates tasks on other boards under their profile", () =>
    Effect.gen(function* () {
      const personal = yield* profile("personal")
      const work = yield* profile("work")
      const kiw = yield* project(personal, "kiwicd", "KIW")
      yield* project(work, "site-deploy", "SD")
      const me = yield* agentOn(yield* task(kiw, "orchestrate"))
      assert.include(err(yield* call(me, "create_task", { title: "x", project_id: "work:SD" })), "doesn't let agents in profile personal")
      yield* grant(work, ["personal"])
      let t = ok(yield* call(me, "create_task", { title: "Follow-up", project_id: "SD", start: false }))
      assert.deepStrictEqual([t["key"], t["profile"]], ["SD-1", "work"])
      assert.strictEqual((yield* (yield* Tasks).get(idOf(t))).profile_id, work.id)
      // Without a project the caller's own is used, and a profile alone isn't enough.
      t = ok(yield* call(me, "create_task", { title: "Here", start: false }))
      assert.strictEqual(t["key"], "KIW-2")
      assert.strictEqual(err(yield* call(me, "create_task", { title: "?", profile: "work" })), "project_id is required (use list_projects)")
      // And it can be updated from there.
      t = ok(yield* call(me, "update_task", { task_id: "work:SD-1", title: "Renamed" }))
      assert.strictEqual(t["title"], "Renamed")
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("sets a pull request", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      yield* project(p, "kiwicd", "KIW")
      const me = yield* agentOf(p)
      ok(yield* call(me, "create_task", { title: "Base", project_id: "KIW", start: false }))
      const url = "https://github.com/dire-kiwi/kiwicd/pull/7"
      assert.strictEqual(ok(yield* call(me, "update_task", { task_id: "KIW-1", pr_url: ` ${url} ` }))["pr_url"], url)
      assert.include(err(yield* call(me, "update_task", { task_id: "KIW-1", pr_url: "#7" })), "pr_url must be")
      assert.isNull(ok(yield* call(me, "update_task", { task_id: "KIW-1", pr_url: "" }))["pr_url"])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("scratch tasks are made in no project unless given one", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const web = yield* project(p, "web", "WEB")
      const me = yield* agentOf(p)
      let t = ok(yield* call(me, "create_task", { title: "Try it", type: "scratch", start: false }))
      assert.deepStrictEqual([t["key"], t["type"], t["project_id"]], ["S-1", "scratch", null])
      // No new subprojects, whichever way they're asked for.
      err(yield* call(me, "create_task", { title: "x", project_id: "WEB", type: "subproject" }))
      err(yield* call(me, "create_task", { title: "x", project_id: "WEB", is_subproject: true }))
      assert.strictEqual(ok(yield* call(me, "get_task", { task_id: "s-1" }))["title"], "Try it")
      err(yield* call(me, "get_task", { task_id: "S-2" }))
      // On its profile's board with the rest.
      assert.deepStrictEqual(keys(list(yield* call(me, "list_tasks", { project_id: "all" })), "key"), ["personal:S-1"])
      // Given a project, it's in that project.
      t = ok(yield* call(me, "create_task", { title: "Ask", type: "scratch", project_id: "WEB", start: false }))
      assert.deepStrictEqual([t["key"], t["type"], t["project_id"]], ["WEB-1", "scratch", web.id])
      // An agent in a project still makes one in no project unless it says otherwise.
      const worker = yield* agentOn(yield* (yield* Tasks).get(idOf(t)))
      t = ok(yield* call(worker, "create_task", { title: "Elsewhere", type: "scratch", start: false }))
      assert.deepStrictEqual([t["key"], t["project_id"]], ["S-2", null])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("a group task creates tasks in its group's projects, and lists only those the caller can reach", () =>
    Effect.gen(function* () {
      const personal = yield* profile("personal")
      const work = yield* profile("work", ["personal"])
      const lab = yield* profile("lab")
      yield* grant(personal, ["lab"])
      const projects = yield* Projects
      const web = yield* project(personal, "web", "WEB")
      const api = yield* project(personal, "api", "API")
      yield* project(work, "sd", "SD")
      for (const x of [web, api]) yield* projects.update(x.id, { group_name: "Shop" })
      const tasks = yield* Tasks
      const planner = yield* tasks.create({ profile_id: personal.id, group: "Shop", title: "Plan checkout" }, { _tag: "User" })
      const me = yield* agentOn(planner)
      // It's in no project, so each task needs one.
      assert.include(err(yield* call(me, "create_task", { title: "x" })), "project_id is required")
      const t = ok(yield* call(me, "create_task", { title: "Cart API", project_id: "API", start: false }))
      assert.strictEqual(t["key"], "API-1")
      assert.strictEqual((yield* tasks.get(idOf(t))).created_by, planner.id)
      ok(yield* call(me, "create_task", { title: "Theirs", project_id: "work:SD", start: false }))
      const got = ok(yield* call(me, "get_task", { task_id: planner.id }))
      assert.deepStrictEqual([got["key"], got["group_task"]], ["G-1", "Shop"])
      const created = (caller: typeof me) =>
        call(caller, "get_task_field", { task_id: planner.id, field: "created_tasks", limit: TASK_FIELD_MAX_LIMIT }).pipe(
          Effect.flatMap((r) => Schema.decodeEffect(Titles)(str(ok(r), "content"))),
          Effect.orDie,
          Effect.map((all) => all.map((x) => x.title).toSorted(byText)),
        )
      assert.deepStrictEqual(yield* created(yield* agentOf(personal)), ["Cart API", "Theirs"])
      // Lab reaches personal's board but not work's.
      assert.deepStrictEqual(yield* created(yield* agentOf(lab)), ["Cart API"])
      // Nor does personal once work stops letting it in.
      yield* grant(work, [])
      assert.deepStrictEqual(yield* created(yield* agentOf(personal)), ["Cart API"])
      // Their keys name them.
      const v = ok(yield* call(me, "update_task", { task_id: "g-1", title: "Plan the checkout" }))
      assert.deepStrictEqual([v["id"], v["key"]], [planner.id, "G-1"])
      err(yield* call(me, "get_task", { task_id: "G-9" }))
      // Group tasks have no dependencies.
      assert.include(err(yield* call(me, "update_task", { task_id: planner.id, depends_on: ["API-1"] })), "only tasks in a project")
      ok(yield* call(me, "update_task", { task_id: planner.id, depends_on: [] }))
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("tasks can merge into another task", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      // Merging into a task is for tasks with worktrees, so on a repository.
      yield* (yield* Projects).create({ profile_id: p.id, name: "web", key: "WEB", repo_path: yield* gitRepo }).pipe(Effect.orDie)
      const me = yield* agentOf(p)
      const target = ok(yield* call(me, "create_task", { title: "Big", project_id: "WEB", use_worktree: true, start: false }))
      let a = ok(yield* call(me, "create_task", { title: "Part", project_id: "WEB", use_worktree: true, merges_into: "web-1", start: false }))
      assert.deepStrictEqual(a["merges_into"], { key: "WEB-1", title: "Big", status: "todo", merged: false })
      assert.strictEqual(a["start_from"], "task WEB-1")
      const big = ok(yield* call(me, "get_task", { task_id: target["key"] }))
      assert.deepStrictEqual(big["merging_into_it"], [{ key: "WEB-2", title: "Part", status: "todo", merged: false }])
      // An empty string clears it.
      a = ok(yield* call(me, "update_task", { task_id: "WEB-2", merges_into: "" }))
      assert.isUndefined(a["merges_into"])
      a = ok(yield* call(me, "update_task", { task_id: "WEB-2", merges_into: "WEB-1" }))
      assert.deepStrictEqual(a["merges_into"], { key: "WEB-1", title: "Big", status: "todo", merged: false })
      assert.include(err(yield* call(me, "update_task", { task_id: "WEB-1", merges_into: "WEB-2" })), "merges into this task already")
      // Closing the target, the agent is told the tasks merging into it wait for the user.
      const closed = ok(yield* call(me, "update_task", { task_id: "WEB-1", status: "done", resolution: "wont_fix" }))
      assert.include(String(closed["note"]), "Tasks merge into this one and aren't done: WEB-2")
      ok(yield* call(me, "update_task", { task_id: "WEB-1", status: "todo" }))
      const listed = list(yield* call(me, "list_tasks", { project_id: "WEB" }))
      assert.deepStrictEqual(
        listed.map((t) => [t["key"], at(t, "merges_into", "key") ?? null, Array.isArray(t["merging_into_it"]) ? t["merging_into_it"].length : 0]),
        [
          ["WEB-1", null, 1],
          ["WEB-2", "WEB-1", 0],
        ],
      )
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("update_task doesn't move a task its todo list holds", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const t = yield* task(yield* project(p, "kiwicd", "KIW"), "Held")
      const me = yield* agentOf(p)
      yield* setTask(t.id, { status: "in_progress", todos: '[{"text":"Add tests","status":"pending"}]' })
      for (const status of ["in_review", "done", "backlog"]) {
        const e = err(yield* call(me, "update_task", { task_id: "KIW-1", status }))
        assert.isTrue(e.includes("1 unfinished item") && e.includes("- [pending] Add tests") && e.includes("send_to_task"), e)
        assert.strictEqual((yield* (yield* Tasks).get(t.id)).status, "in_progress")
      }
      // The agent can't move it anyway.
      err(yield* call(me, "update_task", { task_id: "KIW-1", status: "in_review", todos_override: true }))
      // Other changes, and Needs attention, go through; and once the list is complete, so does the move.
      assert.strictEqual(ok(yield* call(me, "update_task", { task_id: "KIW-1", title: "Renamed" }))["title"], "Renamed")
      assert.strictEqual(ok(yield* call(me, "update_task", { task_id: "KIW-1", status: "needs_attention" }))["status"], "needs_attention")
      yield* setTask(t.id, { status: "in_progress", todos: "[]" })
      assert.strictEqual(ok(yield* call(me, "update_task", { task_id: "KIW-1", status: "in_review" }))["status"], "in_review")
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("create_task and update_task set and clear a task's model and effort", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      yield* project(p, "web", "WEB")
      const me = yield* agentOf(p)
      const tasks = yield* Tasks
      const row = (v: Readonly<Record<string, unknown>>) => Effect.map(tasks.get(idOf(v)), (t) => [t.model, t.effort])
      const t = ok(yield* call(me, "create_task", { title: "On Fable", project_id: "WEB", model: "fable", effort: "low", start: false }))
      assert.deepStrictEqual([t["model"], t["effort"]], ["fable", "low"])
      assert.deepStrictEqual(yield* row(ok(yield* call(me, "create_task", { title: "M", project_id: "WEB", model: "claude-opus-5-5", start: false }))), [
        "claude-opus-5-5",
        null,
      ])
      assert.deepStrictEqual(yield* row(ok(yield* call(me, "create_task", { title: "S", type: "scratch", model: "haiku", effort: "high", start: false }))), [
        "haiku",
        "high",
      ])
      // Left out, the defaults, and the summary doesn't mention them.
      const d = ok(yield* call(me, "create_task", { title: "D", project_id: "WEB", start: false }))
      assert.deepStrictEqual([...(yield* row(d)), "model" in d, "effort" in d], [null, null, false, false])
      // One at a time leaves the other; blank clears.
      const u = ok(yield* call(me, "update_task", { task_id: d["key"], model: "sonnet", effort: "medium" }))
      assert.deepStrictEqual([u["model"], u["effort"]], ["sonnet", "medium"])
      ok(yield* call(me, "update_task", { task_id: d["key"], effort: "xhigh" }))
      assert.deepStrictEqual(yield* row(d), ["sonnet", "xhigh"])
      ok(yield* call(me, "update_task", { task_id: d["key"], model: "" }))
      assert.deepStrictEqual(yield* row(d), [null, "xhigh"])
      ok(yield* call(me, "update_task", { task_id: d["key"], effort: "" }))
      assert.deepStrictEqual(yield* row(d), [null, null])
      // A bad one is refused, and leaves nothing behind.
      err(yield* call(me, "create_task", { title: "T", project_id: "WEB", effort: "huge", start: false }))
      err(yield* call(me, "update_task", { task_id: d["key"], effort: "huge" }))
      err(yield* call(me, "update_task", { task_id: d["key"], model: 5 }))
      assert.strictEqual((yield* tasks.list({ _tag: "ByProfile", profile_id: p.id })).filter((x) => x.title === "T").length, 0)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("another profile's tasks' models are out of reach", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const work = yield* profile("work")
      const sec = yield* project(work, "secret", "SEC")
      const theirs = yield* task(sec, "Theirs")
      const me = yield* agentOf(p)
      for (const r of [theirs.id, "SEC-1", "work:SEC-1"])
        assert.match(err(yield* call(me, "update_task", { task_id: r, model: "opus" })), /^not found: task |doesn't let agents in profile personal/)
      assert.match(
        err(yield* call(me, "create_task", { title: "Sneaky", project_id: "work:SEC", model: "opus" })),
        /^project |doesn't let agents in profile personal/,
      )
      assert.isNull((yield* (yield* Tasks).get(theirs.id)).model)
      yield* grant(work, ["personal"])
      ok(yield* call(me, "update_task", { task_id: "work:SEC-1", model: "opus" }))
      assert.strictEqual((yield* (yield* Tasks).get(theirs.id)).model, "opus")
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("sets dependencies by key", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      yield* project(p, "kiwicd", "KIW")
      yield* project(p, "other", "OT")
      const me = yield* agentOf(p)
      ok(yield* call(me, "create_task", { title: "Base", project_id: "KIW", start: false }))
      ok(yield* call(me, "create_task", { title: "Elsewhere", project_id: "OT", start: false }))
      let t = ok(yield* call(me, "create_task", { title: "After", project_id: "KIW", depends_on: ["KIW-1"], start: false }))
      assert.deepStrictEqual(t["depends_on"], [{ key: "KIW-1", title: "Base", status: "todo", merged: false }])
      assert.include(err(yield* call(me, "update_task", { task_id: "KIW-1", depends_on: ["KIW-2"] })), "already depends")
      assert.include(err(yield* call(me, "update_task", { task_id: "KIW-2", depends_on: ["OT-1"] })), "same project")
      t = ok(yield* call(me, "update_task", { task_id: "KIW-2", depends_on: [] }))
      assert.isUndefined(t["depends_on"])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("the board's server lists its tools in the old order, and a reviewer only the reviewers'", () =>
    Effect.gen(function* () {
      const servers = yield* McpServers
      const board = (yield* servers.tools("huntaway", false)).map((t) => t.name).filter((n) => !n.startsWith("test_") && n !== "wait")
      assert.deepStrictEqual(board, [
        "request_user_input",
        "finish_work",
        "track_work",
        "untrack_work",
        "list_tracked_work",
        "background_wait",
        "list_projects",
        "list_tasks",
        "get_task",
        "get_task_field",
        "create_task",
        "update_task",
        "delete_task",
        "list_pens",
        "create_pen",
        "update_pen",
        "delete_pen",
        "send_to_task",
        "get_project",
        "update_project",
        "create_project",
        // 6.5
        "list_automations",
        "create_automation",
        "update_automation",
        "delete_automation",
        "run_automation",
      ])
      // Every tool's input is a JSON Schema object: Claude Code drops the whole server's list when one isn't.
      for (const tool of yield* servers.tools("huntaway", false)) {
        assert.strictEqual(at(tool.inputSchema, "type"), "object", tool.name)
        assert.isUndefined(at(tool.inputSchema, "not"), tool.name)
      }
      const reviewers = (yield* servers.tools("huntaway", true))
        .map((t) => t.name)
        .filter((n) => !n.startsWith("test_") && n !== "wait" && n !== "submit_test_review")
      assert.deepStrictEqual(reviewers, [
        "request_user_input",
        "background_wait",
        "list_projects",
        "list_tasks",
        "get_task",
        "get_task_field",
        "get_project",
        "submit_review",
      ])
      // As the agent is shown it: names, descriptions and argument names as before.
      const create = (yield* servers.tools("huntaway", false)).find((t) => t.name === "create_task")
      assert.deepStrictEqual(Object.keys(Object(at(create?.inputSchema, "properties"))).toSorted(byText), [
        "depends_on",
        "description",
        "effort",
        "labels",
        "merges_into",
        "model",
        "pen",
        "profile",
        "project_id",
        "remind_at",
        "reminder",
        "resolution",
        "starred",
        "start",
        "start_from",
        "status",
        "subproject",
        "title",
        "type",
        "use_worktree",
      ])
      assert.deepStrictEqual(create?.inputSchema["required"], ["title"])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("agents arrange tasks in pens and list them", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      yield* project(p, "web", "WEB")
      yield* project(p, "api", "API")
      const me = yield* agentOf(p)
      const web = ok(yield* call(me, "create_task", { title: "Web thing", project_id: "WEB", start: false }))
      const api = ok(yield* call(me, "create_task", { title: "API thing", project_id: "API", start: false }))
      const scratch = ok(yield* call(me, "create_task", { title: "Notes", type: "scratch", start: false }))
      // A pen by its name, in any case; one that isn't there yet is made.
      assert.strictEqual(ok(yield* call(me, "update_task", { task_id: web["key"], pen: "Today" }))["pen"], "Today")
      assert.strictEqual(ok(yield* call(me, "update_task", { task_id: api["key"], pen: "today" }))["pen"], "Today")
      assert.strictEqual(ok(yield* call(me, "update_task", { task_id: scratch["key"], pen: "Parked" }))["pen"], "Parked")
      const pens = list(yield* call(me, "list_pens", {}))
      assert.deepStrictEqual(
        pens.map((x) => [x["name"], x["index"], Array.isArray(x["tasks"]) ? x["tasks"].map((y: unknown) => at(y, "key")).toSorted(byText) : []]),
        [
          ["Today", 0, ["API-1", "WEB-1"]],
          ["Parked", 1, ["S-1"]],
        ],
      )
      // A pen's tasks are listed from every project; "none" lists the rest.
      assert.deepStrictEqual(
        list(yield* call(me, "list_tasks", { pen: "Today" }))
          .map((x) => x["key"])
          .toSorted(byText),
        ["API-1", "WEB-1"],
      )
      assert.deepStrictEqual(list(yield* call(me, "list_tasks", { pen: "none" })), [])
      assert.strictEqual(err(yield* call(me, "list_tasks", { pen: "Nope" })), "not found: pen Nope")
      // Out of a pen; and a new task can start in one.
      assert.isUndefined(ok(yield* call(me, "update_task", { task_id: api["key"], pen: "" }))["pen"])
      assert.strictEqual(ok(yield* call(me, "create_task", { title: "Another", project_id: "WEB", pen: "Fresh", start: false }))["pen"], "Fresh")
      // Another profile's pens are out of reach.
      const work = yield* profile("work")
      assert.deepStrictEqual(list(yield* call(yield* agentOf(work), "list_pens", {})), [])
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("agents read a project's settings and prompts", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const me = yield* agentOn(yield* task(kiw, "Caller"))
      // The caller's own project by default, with every prompt the default.
      let v = ok(yield* call(me, "get_project", {}))
      assert.strictEqual(v["key"], "KIW")
      assert.deepStrictEqual(at(v, "merge_prompt", "default"), true)
      yield* (yield* Projects).update(kiw.id, { merge_prompt: "Squash-merge it." })
      v = ok(yield* call(me, "get_project", { project_id: "KIW" }))
      assert.deepStrictEqual(v["merge_prompt"], { instructions: "Squash-merge it.", default: false })
      // Without a project of its own, one must be named.
      assert.strictEqual(err(yield* call(yield* agentOf(p), "get_project", {})), "project_id is required (use list_projects)")
      const sql = yield* SqlClient.SqlClient
      assert.isAbove((yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM mcp_calls`.pipe(Effect.orDie))[0]?.n ?? 0, 0)
    }).pipe(Effect.provide(TestMcp())),
  )
})

/** The created tasks' titles, as `get_task_field` pages them. */
const Titles = Schema.fromJsonString(Schema.Array(Schema.Struct({ title: Schema.String })))
