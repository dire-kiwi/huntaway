import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { TaskId } from "@huntaway/contracts"
import { gitRepo, tempDir, TestBoard } from "@huntaway/testing"
import { DataDir } from "../platform/DataDir.ts"
import { Actor } from "../platform/Changes.ts"
import { AgentConfigs } from "../profiles/AgentConfigs.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { HostSettings } from "../settings/HostSettings.ts"
import { Pens } from "../tasks/Pens.ts"
import { Tasks } from "../tasks/Tasks.ts"
import { Prompts } from "./Prompts.ts"

// The `Prompts` service on the whole board's services: the facts it gathers for the builders (huntaway's
// agent/runner/prompt.test.ts previews_what_a_new_thread_in_a_project_is_told, and the launch's prompt).

/** A profile, another that lets its agents in, and a project on a git repository. */
const board = Effect.gen(function* () {
  const profiles = yield* Profiles
  const projects = yield* Projects
  const me = yield* profiles.create({ name: "me" })
  yield* profiles.create({ name: "work", agent_access: ["me"] })
  const repo = yield* gitRepo
  const project = yield* projects.create({ profile_id: me.id, name: "Web", key: "WEB", repo_path: repo })
  return { me, project }
})

describe("Prompts", () => {
  it.effect("tells a task's run what the builders say of it, with its profile's boards", () =>
    Effect.gen(function* () {
      const prompts = yield* Prompts
      const tasks = yield* Tasks
      const dataDir = yield* DataDir
      const { project } = yield* board
      const task = yield* tasks.create({ project_id: project.id, title: "Fix it", description: "It's broken.", labels: ["plan"] }, Actor.user)
      const text = yield* prompts.system(task.id, { codex: false, permission_mode: "default" })
      assert.isTrue(
        text.startsWith(`You are an agent working on task WEB-1 ("Fix it") on the Huntaway board. Project: Web (repository ${project.repo_path}).`),
        text,
      )
      assert.isTrue(text.includes(`a plan (HTML) to ${dataDir.documents(task.id)}/plan.html`), text)
      assert.isTrue(text.endsWith('\n\nYour profile on the board is "me". Your board tools also reach these profiles\' boards: work.'), text)
      // Codex in plan mode is told so.
      assert.isTrue((yield* prompts.system(task.id, { codex: true, permission_mode: "plan" })).includes("You are in plan mode"))
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  it.effect("starts a task with its first prompt, and says what the keys in it name", () =>
    Effect.gen(function* () {
      const prompts = yield* Prompts
      const tasks = yield* Tasks
      const projects = yield* Projects
      const { me, project } = yield* board
      const other = yield* tasks.create({ project_id: project.id, title: "Fix the board" }, Actor.user)
      const dir = yield* tempDir
      const api = yield* projects.create({ profile_id: me.id, name: "Api", key: "API", repo_path: `${dir}/api` })
      const task = yield* tasks.create({ project_id: project.id, title: "Fix it", description: "Like API." }, Actor.user)
      const text = yield* prompts.start(task.id, "See WEB-1 and WEB-9.")
      assert.strictEqual(
        text,
        "# WEB-2: Fix it\n\nLike API.\n\n---\n\nStart working on this task.\n\nSee WEB-1 and WEB-9.\n\n[Mentions, from the board:\n" +
          `- API: project "Api" (repository ${api.repo_path})\n` +
          `- WEB-1: task "${other.title}" in project "Web" (todo)]`,
      )
      // A scratch task in no project is keyed `S-`.
      const scratch = yield* tasks.create({ profile_id: me.id, title: "Ask" }, Actor.user)
      assert.isTrue((yield* prompts.start(scratch.id, "")).startsWith("# S-1: Ask\n"))
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  it.effect("previews what a new thread in a project is told", () =>
    Effect.gen(function* () {
      const prompts = yield* Prompts
      const tasks = yield* Tasks
      const settings = yield* HostSettings
      const { project } = yield* board

      // A task as the project's new ones are, numbered as its next, in a worktree where setup would put it.
      let preview = yield* prompts.preview(project.id, {})
      assert.deepStrictEqual([preview.runtime, preview.permission_mode], ["claude", "default"])
      assert.isTrue(preview.text.startsWith('You are an agent working on task WEB-1 ("Task title") on the Huntaway board.'), preview.text)
      assert.isTrue(
        preview.text.includes(`worktree at ${project.worktrees_root}/1-task-title on branch \`ia/web-1-task-title\` (branched from \`main\`)`),
        preview.text,
      )
      assert.isTrue(preview.text.endsWith("Your board tools also reach these profiles' boards: work."), preview.text)
      // Making it doesn't make a task, or take the number.
      assert.strictEqual((yield* prompts.preview(project.id, {})).text, preview.text)
      assert.deepStrictEqual(yield* tasks.list({ _tag: "ByProject", project_id: project.id }), [])

      // The options a new thread is made with.
      preview = yield* prompts.preview(project.id, { labels: ["diagram", "plan"] })
      assert.isTrue(preview.text.includes("This task has the labels plan, diagram on the board") && preview.text.includes("<task id>/plan.html"), preview.text)
      preview = yield* prompts.preview(project.id, { worktree: false })
      assert.isTrue(!preview.text.includes("worktree") && !preview.text.includes("open a pull request"), preview.text)
      preview = yield* prompts.preview(project.id, { type: "scratch" })
      assert.isTrue(preview.text.includes("This scratch task is in the project Web") && !preview.text.includes("worktree at"), preview.text)
      preview = yield* prompts.preview(project.id, { runtime: "codex", permission_mode: "plan" })
      assert.isTrue(preview.runtime === "codex" && preview.permission_mode === "plan" && preview.text.includes("You are in plan mode"), preview.text)
      preview = yield* prompts.preview(project.id, { permission_mode: "plan" })
      assert.isTrue(!preview.text.includes("You are in plan mode"), `Claude Code tells Claude itself: ${preview.text}`)
      // A thread inherits the host's mode, when the project has none.
      yield* settings.update({ default_permission_mode: "plan" })
      preview = yield* prompts.preview(project.id, { runtime: "codex" })
      assert.isTrue(preview.permission_mode === "plan" && preview.text.includes("You are in plan mode"), preview.text)
      preview = yield* prompts.preview(project.id, { runtime: "codex", permission_mode: "default" })
      assert.isTrue(preview.permission_mode === "default" && !preview.text.includes("You are in plan mode"), preview.text)
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  it.effect("tells a pen's thread of its pen as it is now", () =>
    Effect.gen(function* () {
      const prompts = yield* Prompts
      const tasks = yield* Tasks
      const pens = yield* Pens
      const sql = yield* SqlClient.SqlClient
      const { me, project } = yield* board
      const today = yield* pens.create({ profile_id: me.id, name: "Today" })
      const task = yield* tasks.create({ project_id: project.id, title: "Fix it" }, Actor.user)
      yield* tasks.update(task.id, { pen: "Today" }, Actor.user)
      // A pen's own thread, as a later milestone makes it.
      yield* sql`INSERT INTO tasks ${sql.insert({ id: "pen-thread", profile_id: me.id, task_type: "pen", pen_id: today.id, title: "Pen: Today", number: 1, last_activity_at: "", created_at: "", updated_at: "" })}`.pipe(
        Effect.orDie,
      )
      const text = yield* prompts.system(TaskId.make("pen-thread"), { codex: false, permission_mode: "default" })
      assert.isTrue(text.startsWith("You look after one pen of this Huntaway profile, in thread S-1 (id pen-thread)"), text)
      assert.isTrue(
        text.endsWith(
          `\n\nYour pen, as it was when this run started: "Today" (id ${today.id}), with this task (key, status, project, title):\n- WEB-1 [todo] (Web) Fix it`,
        ),
        text,
      )
      yield* pens.delete(today.id, Actor.user)
      assert.isTrue(
        (yield* prompts.system(TaskId.make("pen-thread"), { codex: false, permission_mode: "default" })).endsWith(
          "\n\nYour pen has been deleted: tell the user, and don't make tasks in a pen for it.",
        ),
      )
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )

  it.effect("previews on the agent the project's first config runs", () =>
    Effect.gen(function* () {
      const prompts = yield* Prompts
      const configs = yield* AgentConfigs
      const profiles = yield* Profiles
      const { me, project } = yield* board
      const codex = yield* configs.create({ name: "Codex", agent: "codex" })
      yield* profiles.update(me.id, { claude_config_ids: [codex.id] })
      assert.strictEqual((yield* prompts.preview(project.id, {})).runtime, "codex")
      assert.strictEqual((yield* prompts.preview(project.id, { runtime: "claude" })).runtime, "claude")
    }).pipe(Effect.scoped, Effect.provide(TestBoard())),
  )
})
