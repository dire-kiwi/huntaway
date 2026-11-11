import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { SqlClient } from "effect/sql"
import type { Approval, PermissionAnswer, ProjectId, RequestId } from "@huntaway/contracts"
import { TestMcp, TestMcpOver } from "@huntaway/testing"
import type { FakeAgent } from "@huntaway/testing"
import { AutomationRepo } from "../../automations/AutomationRepo.ts"
import { Automations } from "../../automations/Automations.ts"
import { hookPath } from "../../automations/model.ts"
import { Permissions } from "../../permissions/Permissions.ts"
import { HostSettings } from "../../settings/HostSettings.ts"
import { TaskRepo } from "../../tasks/TaskRepo.ts"
import { agentOf, agentOn, at, call, err, grant, ok, profile, project, setTask, task } from "./tests/board.ts"

// The automation tools (the old mcp/tools/automations.test.ts) as an agent calls them through `ToolCalls`, the user
// answering through `Permissions`. A restart is the board's MCP area built again over the same board (`TestMcpOver`).
//
// Dropped, with why:
// - "An agent on another host has no thread here to ask in" and "Older hosts aren't sent automation calls": linked
//   hosts are M7's; every call here comes from a run with a thread;
// - "Only UIs that know automations are shown it" (`pending_approvals(s, true, false)`): every client of this server
//   knows them (no host versions).

/** The approval call `id` is waiting on, as the board lists it, once it is being waited on. */
const asked = (id: string) =>
  Effect.gen(function* () {
    const permissions = yield* Permissions
    const request = yield* permissions.asking(id)
    const found = (yield* permissions.approvals).find((a) => a.request_id === request)
    return found === undefined ? assert.fail(`no approval ${request}`) : found
  })

const answer = (request: RequestId, allow: boolean, extra: Partial<PermissionAnswer> = {}) =>
  Effect.flatMap(Permissions, (p) => p.answer(request, { decision: allow ? "allow" : "deny", ...extra }, "user")).pipe(Effect.orDie)

/** Call `id` of `agent`, answered `allow` by the user once it asks: what it gave, and what it asked. */
const answered = (agent: FakeAgent, tool: string, args: unknown, id: string, allow: boolean, extra: Partial<PermissionAnswer> = {}) =>
  Effect.gen(function* () {
    const running = yield* Effect.forkChild(call(agent, tool, args, id))
    const approval = yield* asked(id)
    yield* answer(approval.request_id, allow, extra)
    return { result: yield* Fiber.join(running), approval }
  })

const input = (a: Approval): unknown => a.input

/** The first of a list in a result. */
const first = (v: unknown, key: string): unknown => {
  const l = at(v, key)
  return Array.isArray(l) ? (l as ReadonlyArray<unknown>)[0] : undefined
}

const pendingApprovals = Effect.map(
  Effect.flatMap(Permissions, (p) => p.approvals),
  (all) => all.filter((a) => a.status === "pending").length,
)

const automationsOf = (projectId: ProjectId) => Effect.flatMap(AutomationRepo, (r) => r.list(projectId))

const webhookArgs = (name: string) => ({
  name,
  trigger: { kind: "webhook", filters: [{ path: "event", op: "equals", value: "issues" }] },
  action: { kind: "create_task", title: "Triage: {{body.issue.title}}", description: "Look at {{body.issue.html_url}}", start: true },
  generate_secret: true,
  reason: "Triage new issues",
})

const nudge = (t: string) => ({
  name: "Nudge",
  trigger: { kind: "daily", time: "9:00", weekdays: ["fri", "mon"] },
  action: { kind: "send_to_task", task_id: t, message: "Anything new?" },
})

/** The board's server stops while call `id` asks the user: the call is left executing, its approval pending. */
const cutShort = (agent: FakeAgent, tool: string, args: unknown, id: string) =>
  Effect.gen(function* () {
    yield* Effect.forkChild(call(agent, tool, args, id))
    return (yield* asked(id)).request_id
  }).pipe(Effect.provide(TestMcpOver()))

describe("automation tools", () => {
  it.effect("agents create automations only once the user approves", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const oth = yield* project(p, "other", "OTH")
      // Even a thread that may do anything without asking asks first.
      const caller = yield* task(kiw, "Caller")
      yield* setTask(caller.id, { permission_mode: "bypassPermissions" })
      const me = yield* agentOn(caller)
      const elsewhere = yield* task(oth, "Elsewhere")

      // Denied: nothing is made.
      let { result, approval } = yield* answered(me, "create_automation", webhookArgs("Triage"), "c1", false)
      assert.include(err(result), `didn't approve creating the automation "Triage", so nothing was created`)
      assert.lengthOf(yield* automationsOf(kiw.id), 0)
      // The approval shows what would run, and who asked.
      assert.deepStrictEqual([approval.kind, approval.tool_name], ["automation", "create_automation"])
      const shown = input(approval)
      assert.deepStrictEqual([at(shown, "op"), at(shown, "project", "key"), at(shown, "task", "key")], ["create", "KIW", "KIW-1"])
      assert.strictEqual(at(shown, "reason"), "Triage new issues")
      assert.deepStrictEqual([at(shown, "automation", "name"), at(shown, "automation", "enabled"), at(shown, "automation", "signed")], ["Triage", true, true])
      assert.strictEqual(at(shown, "automation", "trigger", "kind"), "webhook")
      assert.deepStrictEqual(
        [at(shown, "automation", "action", "title"), at(shown, "automation", "action", "start"), at(shown, "automation", "action", "status")],
        ["Triage: {{body.issue.title}}", true, "todo"],
      )
      assert.strictEqual((yield* (yield* TaskRepo).get(caller.id))?.attention_reason, "Approve an automation?")

      // Approved: it's made as it was shown, with a new secret that's returned once.
      ;({ result } = yield* answered(me, "create_automation", webhookArgs("Triage"), "c2", true))
      const made = ok(result)
      assert.isUndefined(made["approval_note"])
      const [stored] = yield* automationsOf(kiw.id)
      assert.deepStrictEqual([stored?.name, stored?.enabled], ["Triage", true])
      assert.strictEqual(stored?.secret, made["secret"])
      assert.isTrue(typeof made["secret"] === "string" && made["secret"].length > 20)
      assert.strictEqual(made["hook_path"], stored === undefined ? "" : hookPath(stored))
      assert.isString(made["webhook_note"])
      // With the host's public address, the full URL.
      yield* (yield* HostSettings).update({ public_url: "https://board.example.com" }).pipe(Effect.orDie)
      const listed = ok(yield* call(me, "list_automations", {}, "c3"))
      assert.strictEqual(at(first(listed, "automations"), "webhook_url"), `https://board.example.com${stored === undefined ? "" : hookPath(stored)}`)
      assert.isUndefined(at(first(listed, "automations"), "secret"))

      // A message goes to a task named by key, and only one of the project's own.
      assert.include(err(yield* call(me, "create_automation", nudge(elsewhere.key), "c4")), "only send messages to tasks in its own project")
      assert.include(err(yield* call(me, "create_automation", nudge("KIW-99"), "c5")), "not found")
      // Bad settings are refused before the user is asked.
      assert.include(err(yield* call(me, "create_automation", { ...nudge("KIW-1"), trigger: { kind: "interval", every_minutes: 1 } }, "c6")), "every_minutes")
      assert.include(err(yield* call(me, "create_automation", { ...nudge("KIW-1"), generate_secret: true }, "c7")), "only a webhook")
      assert.strictEqual(yield* pendingApprovals, 0)
      ;({ approval } = yield* answered(me, "create_automation", nudge("KIW-1"), "c8", true))
      const view = at(input(approval), "automation")
      assert.deepStrictEqual([at(view, "target", "key"), at(view, "target", "title")], ["KIW-1", "Caller"])
      assert.deepStrictEqual(at(view, "trigger"), { kind: "daily", time: "09:00", weekdays: ["mon", "fri"] })
      assert.strictEqual(at(view, "action", "task_id"), caller.id)
      assert.lengthOf(yield* automationsOf(kiw.id), 2)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("agents change, run and delete automations", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const caller = yield* task(kiw, "Caller")
      const me = yield* agentOn(caller)
      const automations = yield* Automations
      const body = {
        name: "Weekly",
        trigger: { kind: "interval" as const, every_minutes: 60 },
        action: { kind: "create_task" as const, title: "Update deps {{date}}" },
      }
      const a = yield* automations.create({ _tag: "Project", id: kiw.id }, body)
      const get = Effect.map(
        Effect.flatMap(AutomationRepo, (r) => r.get(a.id)),
        (x) => x ?? assert.fail("gone"),
      )

      // Turning it off or renaming it isn't asked about.
      const res = ok(yield* call(me, "update_automation", { automation_id: "weekly", enabled: false, name: "Weekly deps" }, "c1"))
      assert.deepStrictEqual([res["enabled"], res["name"]], [false, "Weekly deps"])
      assert.strictEqual(yield* pendingApprovals, 0)
      assert.include(err(yield* call(me, "update_automation", { automation_id: a.id, enabled: false }, "c2")), "nothing to change")
      // Turning it on is.
      let { result, approval } = yield* answered(me, "update_automation", { automation_id: a.id, enabled: true }, "c3", false)
      assert.include(err(result), `didn't approve changing the automation "Weekly deps"`)
      assert.isFalse((yield* get).enabled)
      assert.deepStrictEqual(at(input(approval), "changes"), ["enabled"])
      // So is a new action; only what it changes is changed, though the user renames it meanwhile.
      const change = { automation_id: a.id, name: "Weekly deps", action: { kind: "create_task", title: "Bump deps", status: "backlog" } }
      const running = yield* Effect.forkChild(call(me, "update_automation", change, "c4"))
      approval = yield* asked("c4")
      yield* automations.update(a.id, { name: "Deps" })
      yield* answer(approval.request_id, true)
      ok(yield* Fiber.join(running))
      const shown = input(approval)
      assert.deepStrictEqual([at(shown, "op"), at(shown, "changes")], ["update", ["action"]])
      assert.deepStrictEqual([at(shown, "before", "action", "title"), at(shown, "automation", "action", "title")], ["Update deps {{date}}", "Bump deps"])
      assert.strictEqual(at(shown, "automation", "action", "status"), "backlog")
      const now = yield* get
      assert.strictEqual(now.name, "Deps")
      assert.isTrue(now.action.kind === "create_task" && now.action.title === "Bump deps" && now.action.status === "backlog")

      // Run now makes its task.
      const ran = ok(yield* call(me, "run_automation", { automation_id: "Deps" }, "c5"))
      assert.strictEqual(ran["status"], "ok", String(ran["detail"]))
      assert.strictEqual((yield* (yield* TaskRepo).get(String(ran["task_id"])))?.title, "Bump deps")

      // Deleted by the user while an agent asks to change it: the question goes, and the call says so.
      const changing = yield* Effect.forkChild(call(me, "update_automation", { automation_id: a.id, trigger: { kind: "interval", every_minutes: 30 } }, "c6"))
      yield* asked("c6")
      yield* automations.delete(a.id)
      assert.include(err(yield* Fiber.join(changing)), "was deleted meanwhile")
      assert.strictEqual(yield* pendingApprovals, 0)

      // Deleting one is asked about too.
      const b = yield* automations.create({ _tag: "Project", id: kiw.id }, body)
      ;({ result, approval } = yield* answered(me, "delete_automation", { automation_id: b.id, reason: "Not needed" }, "c7", false))
      assert.include(err(result), `didn't approve deleting the automation "Weekly"`)
      assert.deepStrictEqual([at(input(approval), "op"), at(input(approval), "reason")], ["delete", "Not needed"])
      assert.lengthOf(yield* automationsOf(kiw.id), 1)
      assert.strictEqual((yield* (yield* TaskRepo).get(caller.id))?.attention_reason, "Delete an automation?")
      ;({ result } = yield* answered(me, "delete_automation", { automation_id: "Weekly" }, "c8", true))
      assert.strictEqual(ok(result)["deleted"], true)
      assert.lengthOf(yield* automationsOf(kiw.id), 0)
    }).pipe(Effect.provide(TestMcp())),
  )

  // HA-403: the user picks the model and effort of an automation's tasks as they approve it.
  it.effect("the user picks an automation's model and effort as they approve it", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const caller = yield* task(kiw, "Caller")
      const me = yield* agentOn(caller)
      const args = { name: "Release", trigger: { kind: "interval", every_minutes: 60 }, action: { kind: "create_task", title: "Release", effort: "low" } }

      // Created: with the model picked, and the effort the agent asked for, as a field left out stays.
      let { result } = yield* answered(me, "create_automation", args, "c1", true, { automation: { model: " opus " } })
      const made = ok(result)
      assert.deepStrictEqual([at(made, "action", "model"), at(made, "action", "effort")], ["opus", "low"])
      // The agent is told the user picked them, so it doesn't put them back.
      assert.include(made["approval_note"], "model opus, effort low")
      const id = String(made["id"])

      // Changed: an approval that left the action alone changes it now, and says so.
      let approval: Approval
      ;({ approval } = yield* answered(me, "update_automation", { automation_id: id, trigger: { kind: "interval", every_minutes: 30 } }, "c2", true, {
        automation: { model: null, effort: "high" },
      }))
      const b = (yield* (yield* AutomationRepo).get(id)) ?? assert.fail("gone")
      assert.isTrue(b.trigger.kind === "interval" && b.trigger.every_minutes === 30)
      assert.isTrue(b.action.kind === "create_task" && b.action.model === null && b.action.effort === "high" && b.action.title === "Release")
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{ readonly input: string }>`SELECT input FROM permission_requests WHERE id = ${approval.request_id}`.pipe(Effect.orDie)
      assert.include(rows[0]?.input ?? "", `"changes":["action","trigger"]`)

      // An effort that isn't one, or a model for an automation that makes no tasks, is refused, and it's still asked.
      const pending = yield* Effect.forkChild(call(me, "update_automation", { automation_id: id, trigger: { kind: "interval", every_minutes: 45 } }, "c3"))
      const q = yield* asked("c3")
      const refused = yield* Effect.flip(
        Effect.flatMap(Permissions, (perm) => perm.answer(q.request_id, { decision: "allow", automation: { effort: "turbo" } }, "user")),
      )
      assert.include(at(refused, "reason"), "effort must be one of")
      yield* answer(q.request_id, false)
      err(yield* Fiber.join(pending))
      const message = { name: "Nudge", trigger: { kind: "interval", every_minutes: 60 }, action: { kind: "send_to_task", task_id: caller.key, message: "Hi" } }
      const nudging = yield* Effect.forkChild(call(me, "create_automation", message, "c4"))
      const n = yield* asked("c4")
      const wrong = yield* Effect.flip(
        Effect.flatMap(Permissions, (perm) => perm.answer(n.request_id, { decision: "allow", automation: { model: "opus" } }, "user")),
      )
      assert.include(at(wrong, "reason"), "only for approving an automation that creates tasks")
      yield* answer(n.request_id, false)
      ;({ result } = { result: yield* Fiber.join(nudging) })
      err(result)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("agents only reach automations on boards they can use", () =>
    Effect.gen(function* () {
      const mine = yield* profile("personal")
      const work = yield* profile("work")
      const kiw = yield* project(mine, "kiwicd", "KIW")
      const sec = yield* project(work, "secret", "SEC")
      const body = { name: "Nightly", trigger: { kind: "daily" as const, time: "02:00" }, action: { kind: "create_task" as const, title: "Nightly" } }
      const theirs = yield* (yield* Automations).create({ _tag: "Project", id: sec.id }, body)
      const me = yield* agentOn(yield* task(kiw, "Caller"))
      // Not found here, as if it weren't there (so linked hosts are asked instead).
      const notFound = (tool: string, args: unknown) =>
        Effect.gen(function* () {
          const r = yield* call(me, tool, args)
          assert.strictEqual(r._tag, "Err", tool)
        })
      yield* notFound("list_automations", { project_id: "SEC" })
      yield* notFound("list_automations", { project_id: "work:SEC" })
      yield* notFound("create_automation", { project_id: "SEC", name: "x", trigger: body.trigger, action: body.action })
      for (const tool of ["update_automation", "delete_automation", "run_automation"]) {
        yield* notFound(tool, { automation_id: theirs.id, ...(tool === "update_automation" ? { enabled: false } : {}) })
      }
      assert.isTrue((yield* (yield* AutomationRepo).get(theirs.id))?.enabled)
      assert.lengthOf(yield* (yield* AutomationRepo).runs(theirs.id, 10), 0)
      assert.strictEqual(yield* pendingApprovals, 0)
      // A task of theirs can't be messaged from an automation here, by id either.
      const hidden = yield* task(sec, "Hidden")
      const msg = { name: "x", trigger: body.trigger, action: { kind: "send_to_task", task_id: hidden.id, message: "hi" } }
      assert.include(err(yield* call(me, "create_automation", msg)), `task ${hidden.id} not found in KIW`)
      // Once their board lets this profile's agents in, its automations are there to use.
      yield* grant(work, ["personal"])
      assert.strictEqual(at(first(ok(yield* call(me, "list_automations", { project_id: "SEC" })), "automations"), "id"), theirs.id)
      // And a message still only goes to a task in the automation's own project.
      assert.include(err(yield* call(me, "create_automation", msg)), "its own project")
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("an automation approval cut short by a restart is still waited for", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const me = yield* agentOn(yield* task(kiw, "Caller"))
      const asks = Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM permission_requests WHERE kind = 'automation'`.pipe(Effect.orDie),
      ).pipe(Effect.map((rows) => rows[0]?.n ?? 0))
      // The server restarts while the user is asked; retried (even with other arguments), the call waits for the same
      // answer and makes what it asked about, once.
      yield* cutShort(me, "create_automation", webhookArgs("Triage"), "c1")
      const { result } = yield* answered(me, "create_automation", webhookArgs("Other"), "c1", true).pipe(Effect.provide(TestMcpOver()))
      assert.strictEqual(ok(result)["name"], "Triage")
      assert.deepStrictEqual([yield* asks, (yield* automationsOf(kiw.id)).length], [1, 1])
      // Denied before the retry: nothing is made.
      const second = yield* cutShort(me, "create_automation", webhookArgs("Second"), "c2")
      yield* answer(second, false)
      assert.include(err(yield* call(me, "create_automation", webhookArgs("Second"), "c2").pipe(Effect.provide(TestMcpOver()))), "didn't approve")
      assert.lengthOf(yield* automationsOf(kiw.id), 1)
      // Approved before the retry: it may have been made as the server stopped, so it isn't made again.
      const third = yield* cutShort(me, "create_automation", webhookArgs("Third"), "c3")
      yield* answer(third, true)
      assert.include(err(yield* call(me, "create_automation", webhookArgs("Third"), "c3").pipe(Effect.provide(TestMcpOver()))), "interrupted")
      assert.lengthOf(yield* automationsOf(kiw.id), 1)
      assert.strictEqual(yield* asks, 3)
    }).pipe(Effect.provide(TestMcp())),
  )

  it.effect("the assistant sets up routines once the user approves", () =>
    Effect.gen(function* () {
      const p = yield* profile("personal")
      const kiw = yield* project(p, "kiwicd", "KIW")
      const mine = yield* agentOf(p)
      const remind = {
        name: "Call Sam",
        trigger: { kind: "at", at: "2030-01-01T09:00:00Z" },
        action: { kind: "message_assistant", mode: "thread", message: "Remind the user to call Sam." },
        reason: "The user asked to be reminded",
      }
      const { result, approval } = yield* answered(mine, "create_automation", remind, "c1", true)
      const made = ok(result)
      // The approval names the profile, not a project.
      assert.deepStrictEqual([at(input(approval), "profile", "id"), at(input(approval), "project") ?? null], [p.id, null])
      assert.strictEqual(at(input(approval), "automation", "action", "kind"), "message_assistant")
      assert.deepStrictEqual([made["profile_id"], made["project_id"]], [p.id, null])
      // The assistant lists its routines without saying so; a project's agent asks for them.
      assert.strictEqual(at(first(ok(yield* call(mine, "list_automations", {}, "c2")), "routines"), "name"), "Call Sam")
      const worker = yield* agentOn(yield* task(kiw, "Worker"))
      assert.deepStrictEqual(at(ok(yield* call(worker, "list_automations", {}, "c3")), "automations"), [])
      assert.strictEqual(at(first(ok(yield* call(worker, "list_automations", { routines: true }, "c3b")), "routines"), "name"), "Call Sam")
      // Changing what it does asks; by name among the routines.
      const changed = yield* answered(mine, "update_automation", { automation_id: "call sam", precheck: "test -f flag", budget_usd: 0.5 }, "c4", true)
      assert.strictEqual(ok(changed.result)["precheck"], "test -f flag")
      assert.deepStrictEqual(at(input(changed.approval), "changes"), ["budget_usd", "precheck"])
      // A routine can't make tasks.
      const bad = { name: "x", routines: true, trigger: { kind: "interval", every_minutes: 60 }, action: { kind: "create_task", title: "x" } }
      assert.include(err(yield* call(mine, "create_automation", bad, "c5")), "only message the assistant")

      // Another profile's agents can't reach it, even with access to this board.
      const work = yield* profile("work")
      yield* grant(p, ["work"])
      const theirs = yield* agentOf(work)
      const id = String(made["id"])
      assert.strictEqual(err(yield* call(theirs, "run_automation", { automation_id: id })), `automation ${id}`)
      assert.include(err(yield* call(theirs, "list_automations", { routines: true, profile: "personal" })), "its own profile")
    }).pipe(Effect.provide(TestMcp())),
  )
})
