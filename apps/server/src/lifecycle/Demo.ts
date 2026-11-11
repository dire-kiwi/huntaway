import { DateTime, Effect, FileSystem, Layer, Option } from "effect"
import { Timestamp } from "@huntaway/contracts"
import type { Status, Todo } from "@huntaway/contracts"
import { Docs } from "../docs/Docs.ts"
import { Actor } from "../platform/Changes.ts"
import { DataDir } from "../platform/DataDir.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { Profiles } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import { Tasks } from "../tasks/Tasks.ts"

// The demo board (huntaway's demo.ts): sample data for a fresh deployment started with `--demo` (PR previews and test
// servers), so the board can be tried without setting anything up. It is seeded through the areas' own methods, as a
// user would make it. The plan, artifact and diagram tasks with their documents are left for the documents area (M6);
// the published document is the docs area's (6.3, `Docs.seedDemo`).

export const DEMO_README = "# Demo\n\nA scratch folder for the demo project that this preview creates on its first start.\n"

/** The demo project's tasks: title, description, status. */
const TASKS: ReadonlyArray<readonly [string, string, Status]> = [
  ["Try dragging this card to another column", "Cards can be dragged between columns and reordered within one.", "todo"],
  ["Edit this task's title and description", "Open the card and change it. Everything here is scratch data.", "todo"],
  ["Something being worked on", "A task with an agent at work sits here.", "in_progress"],
  ["A task waiting on an answer", "The agent asked a question and the task needs attention.", "needs_attention"],
  ["Finished work to look over", "The agent is done and the change is ready for review.", "in_review"],
  ["Merged and closed", "", "done"],
  ["An idea for later", "Backlog items come first on the board, in a column that starts collapsed.", "backlog"],
]

/** The todo list of the task at work, as its agent's latest TodoWrite left it: its card lists the first five and counts the rest. */
export const DEMO_TODOS: ReadonlyArray<Todo> = [
  { text: "Read how the board stores tasks", status: "completed" },
  { text: "Add the new column and its migration", status: "completed" },
  { text: "Show it on the task's card", status: "in_progress" },
  { text: "Push it to clients as it changes", status: "pending" },
  { text: "Add it to the demo board", status: "pending" },
  { text: "Write the tests", status: "pending" },
  { text: "Open a pull request", status: "pending" },
]

/**
 * Seeds the demo board, unless this host has profiles already (it is only for a fresh data folder): a "Default"
 * profile on the `~/.claude` config, a "Demo" project (key `DEMO`) in `<data dir>/demo` with its README, its sample
 * tasks in each column (the one at work with its todo list, and one done a week ago, so archived), and a scratch task.
 */
export const seedDemo = Effect.gen(function* () {
  const profiles = yield* Profiles
  const projects = yield* Projects
  const tasks = yield* Tasks
  const dataDir = yield* DataDir
  const fs = yield* FileSystem.FileSystem
  if ((yield* profiles.list).length > 0) return
  const made = yield* profiles.ensure("Default", "~/.claude")
  if (Option.isNone(made)) return
  const profile = made.value
  const repo = `${dataDir.root}/demo`
  yield* fs.makeDirectory(repo, { recursive: true })
  yield* fs.writeFileString(`${repo}/README.md`, DEMO_README)
  const project = yield* projects.create({ profile_id: profile.id, name: "Demo", repo_path: repo, key: "DEMO", base_branch: null, use_worktrees: false })
  const created = yield* Effect.forEach(
    TASKS,
    ([title, description, status]) => tasks.create({ project_id: project.id, title, description, status }, Actor.board),
    { concurrency: 1 },
  )
  // 6.3: the published document, by the task in review, in its project's folder.
  const reviewed = created.find((t) => t.status === "in_review")
  if (reviewed !== undefined) yield* (yield* Docs).seedDemo(profile.id, reviewed, project.name)
  const working = created.find((t) => t.status === "in_progress")
  if (working !== undefined) yield* tasks.change(working.id, () => ({ todos: DEMO_TODOS }), Actor.board)
  // Done for longer than the board keeps it in Done, so it's archived.
  const old = yield* tasks.create(
    {
      project_id: project.id,
      title: "Shipped last week",
      description: "Tasks done for two days are archived: they leave the board for the list view's Archived section.",
      status: "done",
    },
    Actor.board,
  )
  const weekAgo = Timestamp.make(DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 7 })))
  yield* tasks.change(old.id, () => ({ done_at: weekAgo }), Actor.board)
  // A scratch task, in no project, on the profile's board.
  yield* tasks.create(
    {
      profile_id: profile.id,
      title: "Try a scratch task",
      description:
        "A scratch task isn't in a project: its agent works in its own folder, with no repository. Ask it anything, or have it look across the board.",
    },
    Actor.board,
  )
  yield* Effect.logInfo(`seeded the demo project in ${repo}`)
}).pipe(Effect.orDie, Effect.withSpan("Demo.seed"))

/** Startup, after every area is built and before `Recovery`: the demo board, with `--demo`. */
export const DemoLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig
    if (config.demo) yield* seedDemo
  }),
)
