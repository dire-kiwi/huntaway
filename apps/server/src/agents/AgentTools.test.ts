import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { SqlClient } from "effect/sql"
import type { ProfileId, TaskId } from "@huntaway/contracts"
import { ProjectId } from "@huntaway/contracts"
import { tempDir, TestBoard } from "@huntaway/testing"
import { Actor } from "../platform/Changes.ts"
import { DataDir } from "../platform/DataDir.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { TaskDeletion } from "../runs/TaskDeletion.ts"
import { TaskRepo } from "../tasks/TaskRepo.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { AgentTools } from "./AgentTools.ts"
import { AgentToolsRepo } from "./AgentToolsRepo.ts"
import { toolPrefix } from "./claude/access.ts"

// The service's cases of huntaway's agent/agent_tools/tests.test.ts (global_ones_follow_the_profile_unless_the_project_overrides,
// leaves_out_board_skills_turned_off_since, leaves_out_board_skills_deleted_or_renamed_since,
// forgets_board_skills_deleted_or_renamed_from_runs_recorded_before, syncs_the_skills_dir,
// a_profiles_assistant_gets_the_global_tools_its_profile_switches_on), of integrations/workflows/agent_steps.test.ts
// (a step's thread turns servers off) and api/tasks.ts' deletion of a review thread's skills, on the whole board's services.

const md = (name: string, description = "d") => `---\nname: ${name}\ndescription: ${description}\n---\n`

/** A profile and a project of it. */
const board = (name = "p") =>
  Effect.gen(function* () {
    const profile = yield* (yield* Profiles).create({ name })
    const project = yield* (yield* Projects).create({
      profile_id: profile.id,
      name: `${name}-a`,
      key: name.toUpperCase().slice(0, 3),
      repo_path: `${yield* tempDir}/a`,
    })
    return { profile: profile.id, project: project.id }
  })

/** A thread row as later milestones make them (the assistant, a review thread). */
const insertTask = (fields: Record<string, string | null>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const n = (yield* sql<{ readonly n: number }>`SELECT COUNT(*) + 1 AS n FROM tasks`)[0]?.n ?? 1
    const id = `t-${fields["title"] ?? "x"}-${n}`
    yield* sql`INSERT INTO tasks ${sql.insert({ id, title: id, number: n + 100, last_activity_at: "", created_at: "", updated_at: "", ...fields })}`
    const task = yield* (yield* TaskRepo).get(id)
    if (task === null) return yield* Effect.die(`no task ${id}`)
    return task
  }).pipe(Effect.orDie)

/** The names of the skills written for a run. */
const written = (dir: string | null) =>
  dir === null
    ? Effect.succeed([])
    : Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.readDirectory(`${dir}/.claude/skills`).pipe(
          Effect.map((names) => names.toSorted()),
          Effect.orElseSucceed(() => []),
        ),
      )

describe("AgentTools", () => {
  it.effect("global ones follow the profile unless the project overrides; a project's own one takes the name while it's on", () =>
    Effect.gen(function* () {
      const tools = yield* AgentTools
      const tasks = yield* Tasks
      const repo = yield* AgentToolsRepo
      const { profile, project } = yield* board()
      const other = yield* (yield* Projects).create({ profile_id: profile, name: "b", key: "B", repo_path: `${yield* tempDir}/b` })
      const on = yield* tools.addSkill(null, { content: md("on") })
      const off = yield* tools.addSkill(null, { content: md("off") })
      yield* tools.addSkill(project, { content: md("own") })
      yield* tools.setSwitch({ scope: "profile", scope_id: profile, item_id: on.id, enabled: true })
      yield* tools.setSwitch({ scope: "project", scope_id: other.id, item_id: on.id, enabled: false })
      yield* tools.setSwitch({ scope: "project", scope_id: other.id, item_id: off.id, enabled: true })
      const a = yield* tasks.create({ project_id: project, title: "A" }, Actor.user)
      const b = yield* tasks.create({ project_id: other.id, title: "B" }, Actor.user)
      const runA = yield* tools.forRun(a)
      assert.deepStrictEqual(yield* written(runA.skills_dir), ["on", "own"])
      assert.deepStrictEqual(yield* written((yield* tools.forRun(b)).skills_dir), ["off"])
      // A project's own one takes the name while it's on, and the global one is used while it's off.
      const mine = yield* tools.addSkill(project, { content: md("on", "mine") })
      yield* tools.forRun(a)
      const fs = yield* FileSystem.FileSystem
      assert.strictEqual(yield* fs.readFileString(`${runA.skills_dir}/.claude/skills/on/SKILL.md`), md("on", "mine"))
      yield* tools.updateSkill(project, mine.id, { enabled: false })
      yield* tools.forRun(a)
      assert.strictEqual(yield* fs.readFileString(`${runA.skills_dir}/.claude/skills/on/SKILL.md`), md("on"))
      // Clearing a switch follows the profile again; deleting a global skill drops its switches.
      yield* tools.setSwitch({ scope: "project", scope_id: other.id, item_id: on.id, enabled: null })
      assert.deepStrictEqual(yield* written((yield* tools.forRun(b)).skills_dir), ["off", "on"])
      yield* tools.removeSkill(null, off.id)
      assert.isUndefined((yield* repo.switches("project", other.id))[off.id])
      // The settings see the same.
      const view = yield* tools.project(other.id)
      assert.deepStrictEqual(view.profile_switches, { [on.id]: true })
      assert.deepStrictEqual(
        view.global_skills.map((s) => s.name),
        ["on"],
      )
      assert.deepStrictEqual((yield* tools.global).profile_switches[profile], { [on.id]: true })
      // Unknown switches and scopes are refused.
      assert.strictEqual((yield* Effect.flip(tools.setSwitch({ scope: "profile", scope_id: profile, item_id: "missing", enabled: true })))._tag, "ToolNotFound")
      assert.strictEqual((yield* Effect.flip(tools.setSwitch({ scope: "profile", scope_id: "nobody", item_id: on.id, enabled: true })))._tag, "ToolNotFound")
      assert.strictEqual((yield* Effect.flip(tools.setSwitch({ scope: "profile", scope_id: profile, enabled: true })))._tag, "ToolInvalid")
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  it.effect("checks names: unique per scope, a server's config, the board's own server; others' lists keep saved bad names", () =>
    Effect.gen(function* () {
      const tools = yield* AgentTools
      const { project } = yield* board()
      yield* tools.addSkill(project, { content: md("x") })
      assert.strictEqual((yield* Effect.flip(tools.addSkill(project, { content: md("x") })))._tag, "ToolConflict")
      // Another scope may have the name.
      yield* tools.addSkill(null, { content: md("x") })
      assert.strictEqual((yield* Effect.flip(tools.addSkill(null, { content: "# no" })))._tag, "ToolInvalid")
      const server = yield* tools.addServer(project, { name: " search ", config: { url: "https://s" }, auto_allow: true })
      assert.strictEqual(server.name, "search")
      assert.strictEqual(server.config.type, "http")
      assert.strictEqual((yield* Effect.flip(tools.addServer(project, { name: "search", config: { url: "https://s" } })))._tag, "ToolConflict")
      assert.strictEqual((yield* Effect.flip(tools.addServer(project, { name: "huntaway", config: { url: "https://s" } })))._tag, "ToolInvalid")
      assert.strictEqual((yield* Effect.flip(tools.addServer(project, { name: "y", config: { type: "stdio" } })))._tag, "ToolInvalid")
      const updated = yield* tools.updateServer(project, server.id, { enabled: false })
      assert.isFalse(updated.enabled)
      assert.isTrue(updated.auto_allow)
      assert.strictEqual((yield* Effect.flip(tools.updateServer(null, server.id, { enabled: false })))._tag, "ToolNotFound")
      // A project's lists of others' skills and servers.
      const view = yield* tools.updateProject(project, { disabled_skills: [" pdf ", "pdf", "plug:x"], disabled_mcp_servers: ["claude.ai Gmail"] })
      assert.deepStrictEqual(view.disabled_skills, ["pdf", "plug:x"])
      assert.strictEqual((yield* Effect.flip(tools.updateProject(project, { disabled_skills: ["two words"] })))._tag, "ToolInvalid")
      assert.strictEqual((yield* Effect.flip(tools.updateProject(project, { disabled_mcp_servers: ["huntaway"] })))._tag, "ToolInvalid")
      assert.strictEqual((yield* Effect.flip(tools.project(ProjectId.make("missing"))))._tag, "ToolNotFound")
      yield* tools.removeServer(project, server.id)
      assert.strictEqual((yield* Effect.flip(tools.removeServer(project, server.id)))._tag, "ToolNotFound")
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  it.effect("gives a run its servers, what it may use without asking, and what the project turns off", () =>
    Effect.gen(function* () {
      const tools = yield* AgentTools
      const tasks = yield* Tasks
      const sql = yield* SqlClient.SqlClient
      const { profile, project } = yield* board()
      yield* tools.addServer(project, { name: "docs", config: { url: "https://d" } })
      yield* tools.addServer(project, { name: "search", config: { command: "s" }, auto_allow: true })
      const google = yield* tools.addServer(null, { name: "google", config: { command: "uvx" } })
      yield* tools.setSwitch({ scope: "profile", scope_id: profile, item_id: google.id, enabled: true })
      yield* tools.updateProject(project, { disabled_skills: ["pdf"], disabled_mcp_servers: ["claude.ai Gmail"] })
      // A bad name saved before names were checked is skipped.
      yield* sql`UPDATE project_agent_tools SET disabled_skills = '["pdf","two words"]' WHERE project_id = ${project}`
      const task = yield* tasks.create({ project_id: project, title: "A" }, Actor.user)
      const run = yield* tools.forRun(task)
      assert.deepStrictEqual(Object.keys(run.mcp_servers), ["docs", "search"])
      assert.deepStrictEqual(run.allowed, [toolPrefix("search")])
      assert.deepStrictEqual(run.disallowed, ["Skill(pdf)", "mcp__claude_ai_Gmail"])
      assert.isNull(run.skills_dir)
      // A workflow step's thread turns some off.
      const step = yield* insertTask({ profile_id: profile, project_id: project, kind: "review", task_type: "workflow", parent_id: task.id, title: "step" })
      yield* sql`INSERT INTO thread_tools (task_id, disabled_mcp_servers) VALUES (${step.id}, '["docs"]')`
      const stepRun = yield* tools.forRun(step)
      assert.deepStrictEqual(Object.keys(stepRun.mcp_servers), ["search"])
      assert.isTrue(stepRun.disallowed.includes("mcp__docs"))
      assert.deepStrictEqual(Object.keys((yield* tools.forRun(task)).mcp_servers), ["docs", "search"])
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  // HA-119 review: the assistant (in no project) had none of its profile's global skills and servers.
  it.effect("a profile's assistant gets the global tools its profile switches on", () =>
    Effect.gen(function* () {
      const tools = yield* AgentTools
      const tasks = yield* Tasks
      const dataDir = yield* DataDir
      const me = (yield* (yield* Profiles).create({ name: "me" })).id
      const other = (yield* (yield* Profiles).create({ name: "other" })).id
      const skill = (name: string) => tools.addSkill(null, { content: md(name, `d ${name}`) })
      const server = (name: string, auto: boolean) =>
        tools.addServer(null, { name, config: { type: "http", url: `https://${name}.example` }, auto_allow: auto })
      // `unset` has no switch, so it's off for the profile.
      const on = yield* skill("on")
      const off = yield* skill("off")
      yield* skill("unset")
      const probe = yield* server("probe", true)
      const quiet = yield* server("quiet", false)
      const set = (scopeId: ProfileId, item: string, v: boolean) => tools.setSwitch({ scope: "profile", scope_id: scopeId, item_id: item, enabled: v })
      yield* set(me, on.id, true)
      yield* set(me, off.id, false)
      yield* set(me, probe.id, true)
      yield* set(me, quiet.id, false)
      // Another profile's switches are its own.
      yield* set(other, off.id, true)
      yield* set(other, quiet.id, true)
      const mine = yield* insertTask({ profile_id: me, task_type: "assistant", title: "assistant" })
      let run = yield* tools.forRun(mine)
      assert.deepStrictEqual(Object.keys(run.mcp_servers), ["probe"])
      assert.deepStrictEqual(run.allowed, [toolPrefix("probe")])
      assert.deepStrictEqual(run.disallowed, [])
      assert.strictEqual(run.skills_dir, `${dataDir.profileDir(me)}/agent`)
      assert.deepStrictEqual(yield* written(run.skills_dir), ["on"])
      // HA-122: a routine's thread under it has the same.
      const routine = yield* insertTask({ profile_id: me, task_type: "routine", parent_id: mine.id, title: "routine" })
      const theirs = yield* tools.forRun(routine)
      assert.deepStrictEqual([Object.keys(theirs.mcp_servers), theirs.allowed, theirs.skills_dir], [["probe"], [toolPrefix("probe")], run.skills_dir])
      // A skill switched off later is taken out of its folder on the next run.
      const dir = run.skills_dir
      yield* set(me, on.id, false)
      run = yield* tools.forRun(mine)
      assert.isNull(run.skills_dir)
      assert.deepStrictEqual(yield* written(dir), [])
      yield* set(me, on.id, true)
      // A global one that's off everywhere (the item itself) isn't given either.
      yield* tools.updateSkill(null, on.id, { enabled: false })
      assert.isNull((yield* tools.forRun(mine)).skills_dir)
      yield* tools.updateSkill(null, on.id, { enabled: true })
      // The other profile's assistant has its own.
      const theirAssistant = yield* insertTask({ profile_id: other, task_type: "assistant", title: "theirs" })
      run = yield* tools.forRun(theirAssistant)
      assert.deepStrictEqual(Object.keys(run.mcp_servers), ["quiet"])
      assert.deepStrictEqual(yield* written(run.skills_dir), ["off"])
      // A scratch task in no project still gets none.
      const scratch = yield* tasks.create({ profile_id: me, title: "Ask" }, Actor.user)
      run = yield* tools.forRun(scratch)
      assert.isTrue(Object.keys(run.mcp_servers).length === 0 && run.skills_dir === null)
      // The composer's `/` menu lists the skills the assistant has, and not those that are off.
      const menu = (yield* tools.taskSkills(mine.id)).skills.map((s) => s.name)
      assert.isTrue(menu.includes("on"), String(menu))
      assert.isFalse(menu.includes("off") || menu.includes("unset"), String(menu))
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  it.effect("leaves board skills turned off, renamed or deleted since out of a task's `/` menu, and forgets them", () =>
    Effect.gen(function* () {
      const tools = yield* AgentTools
      const tasks = yield* Tasks
      const repo = yield* AgentToolsRepo
      const { profile, project } = yield* board()
      const b = (yield* (yield* Projects).create({ profile_id: profile, name: "b", key: "B", repo_path: `${yield* tempDir}/b` })).id
      const own = yield* tools.addSkill(project, { content: md("own") })
      const renamed = yield* tools.addSkill(project, { content: md("renamed") })
      const disabled = yield* tools.addSkill(project, { content: md("disabled") })
      const global = yield* tools.addSkill(null, { content: md("global") })
      yield* tools.addSkill(null, { content: md("never-on") })
      // Project b has its own skill named like the global one, which stays.
      yield* tools.addSkill(b, { content: md("global") })
      for (const p of [project, b]) yield* tools.setSwitch({ scope: "project", scope_id: p, item_id: global.id, enabled: true })
      const taskA = yield* tasks.create({ project_id: project, title: "A" }, Actor.user)
      const taskB = yield* tasks.create({ project_id: b, title: "B" }, Actor.user)
      const reported = ["own", "renamed", "disabled", "global", "external"]
      yield* tools.recordSeen(taskA.id, { skills: reported, mcp_servers: [{ name: "huntaway" }, { name: "claude.ai Gmail", status: "needs-auth" }] })
      yield* tools.recordSeen(taskB.id, { skills: reported })
      const menu = (task: TaskId) => Effect.map(tools.taskSkills(task), (t) => t.skills.map((s) => s.name))
      assert.deepStrictEqual(yield* menu(taskA.id), ["disabled", "external", "global", "own", "renamed"])
      const seen = (yield* repo.overrides(project)).seen[""]
      assert.deepStrictEqual(
        seen?.mcp_servers.map((s) => s.name),
        ["claude.ai Gmail"],
      )
      assert.deepStrictEqual(seen?.board_skills, ["disabled", "own", "renamed", "global"])
      yield* tools.updateSkill(project, disabled.id, { enabled: false })
      yield* tools.updateSkill(project, renamed.id, { content: md("new-name") })
      assert.deepStrictEqual(yield* menu(taskA.id), ["external", "global", "new-name", "own"])
      // Deleted, the disabled one too.
      yield* tools.removeSkill(project, own.id)
      yield* tools.removeSkill(project, disabled.id)
      yield* tools.removeSkill(null, global.id)
      assert.deepStrictEqual(yield* menu(taskA.id), ["external", "new-name"])
      assert.deepStrictEqual(
        (yield* repo.overrides(project)).seen[""]?.skills.map((s) => s.name),
        ["external"],
      )
      assert.deepStrictEqual(yield* menu(taskB.id), ["disabled", "external", "global", "own", "renamed"])
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  it.effect("gives a review thread its own skills in a folder of its own, removed with it", () =>
    Effect.gen(function* () {
      const tools = yield* AgentTools
      const tasks = yield* Tasks
      const fs = yield* FileSystem.FileSystem
      const sql = yield* SqlClient.SqlClient
      const { profile, project } = yield* board()
      yield* tools.addSkill(project, { content: md("own") })
      yield* tools.addSkill(null, { content: md("audit") })
      const task = yield* tasks.create({ project_id: project, title: "A" }, Actor.user)
      const review = yield* insertTask({ profile_id: profile, project_id: project, kind: "review", parent_id: task.id, title: "review" })
      yield* sql`INSERT INTO thread_tools (task_id, skills) VALUES (${review.id}, '["audit"]')`
      const run = yield* tools.forRun(review)
      assert.isTrue(run.skills_dir?.endsWith(`/agent-threads/${review.id}`), String(run.skills_dir))
      assert.deepStrictEqual(yield* written(run.skills_dir), ["audit", "own"])
      // The project's other runs don't gain it.
      assert.deepStrictEqual(yield* written((yield* tools.forRun(task)).skills_dir), ["own"])
      // What its run reports of it isn't the project's to list.
      yield* tools.recordSeen(review.id, { skills: ["audit", "own"] })
      assert.deepStrictEqual(
        (yield* (yield* AgentToolsRepo).overrides(project)).seen[""]?.skills.map((s) => s.name),
        ["own"],
      )
      yield* (yield* TaskDeletion).delete(task.id, { deleteBranch: false }, Actor.user)
      assert.isFalse(yield* fs.exists(run.skills_dir ?? ""))
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )
})
