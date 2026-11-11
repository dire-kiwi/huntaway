import { Effect, Schema } from "effect"
import { Tool } from "effect/ai"
import { AgentConfigId, PermissionMode, Status } from "@huntaway/contracts"
import type { Profile, Project, ProjectPatch, Reviewer } from "@huntaway/contracts"
import { projectMerge, projectReview, projectStart } from "../../agents/prompts/project.ts"
import { Approvals } from "../../permissions/Approvals.ts"
import { toJson } from "../../platform/columns.ts"
import { ProjectRepo } from "../../projects/ProjectRepo.ts"
import { makeReach } from "../resolve.ts"
import type { Reach } from "../resolve.ts"
import { ApprovalKind, ForPlanning, ForReviewers, Rerunnable, ToolError } from "../tool.ts"
import { asker, boardTool, given, Json, PROJECT_ONE, ProfileArg, told } from "./common.ts"
import type { JsonObject } from "./common.ts"

// The board's project tools (docs/plan/inventory/03-mcp.md 2.5, 2.6; the old mcp/schemas/projects.ts, mcp/tools/
// projects.ts and resolve.ts `project_json`, `project_settings_json`): `list_projects`, `get_project`, and the two that
// ask the user first, through `Approvals`: `update_project` (its risky settings) and `create_project`.

export const ListProjects = Tool.make("list_projects", {
  description:
    "List projects (id, key, name, repository path, profile, host) on every board you can use: your own profile's and those of other profiles (e.g. work, personal) that let your agents in, on every linked host. Projects the user has archived are left out. Check here before creating a project: one the user names may be on another profile's board.",
  parameters: Schema.Struct({ profile: Schema.optionalKey(ProfileArg) }),
  success: Json,
})
  .annotate(Rerunnable, true)
  .annotate(ForReviewers, true)
  .annotate(ForPlanning, true)

export const GetProject = Tool.make("get_project", {
  description: "Get a project's settings, including its prompt instructions (see update_project).",
  parameters: Schema.Struct({ project_id: Schema.optionalKey(Schema.String.annotate({ description: PROJECT_ONE })), profile: Schema.optionalKey(ProfileArg) }),
  success: Json,
})
  .annotate(Rerunnable, true)
  .annotate(ForReviewers, true)
  .annotate(ForPlanning, true)

const PERMISSION_MODES = [...PermissionMode.literals, ""] as const

const copyFiles = Schema.String.annotate({
  description:
    "Needs approval. Git-ignored files copied into each new worktree from the repository folder before the setup script, as .gitignore-style patterns, one per line (.env, /config/local.json, !*.bak), like a .worktreeinclude file (which is read too). Only files git ignores are copied, and none the worktree already has.",
})
const linkFolders = Schema.String.annotate({
  description:
    "Needs approval. Git-ignored folders of the repository (paths relative to it, one per line, e.g. models/cache) symlinked into each new worktree instead of copied, so changes in them change the original",
})
const ReviewerArg = Schema.Struct({
  claude_config_id: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  skills: Schema.optionalKey(Schema.Array(Schema.String)),
})
const SummarizerArg = Schema.Struct({
  claude_config_id: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  skills: Schema.optionalKey(Schema.Array(Schema.String)),
  prompt: Schema.optionalKey(Schema.String),
})

export const UpdateProject = Tool.make("update_project", {
  description:
    "Change a project's settings; leave out the ones to keep. The prompt instructions are what the board tells agents as a task moves across the board, " +
    "and each replaces a default: start_prompt is sent to a task's agent when it starts (moving to in_progress), after the task's " +
    "title and description; review_prompt tells the reviewer what to look for when the task moves to in_review, after where its " +
    "changes are (the board adds how to report the verdict); merge_prompt tells the agent how to merge when the task moves to " +
    "ready_for_merge, after which branch to merge into which (the board adds asking the user if it can't, stepping out of the merge queue to make changes, and setting the task to " +
    "done). An empty string resets a prompt, base_branch, model or permission_mode to the default. Only change these when the user asks. " +
    "Changing permission_mode, a script, repo_path (and move_repo), use_worktrees or worktrees_root asks the user to approve the whole change first " +
    "(say why in reason): the call waits for their answer, and if they don't approve it nothing changes. A project's agent configs " +
    "can only be changed by the user.",
  parameters: Schema.Struct({
    project_id: Schema.optionalKey(Schema.String.annotate({ description: PROJECT_ONE })),
    profile: Schema.optionalKey(ProfileArg),
    name: Schema.optionalKey(Schema.String.annotate({ description: "The project's display name" })),
    key: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "The prefix of the project's task keys (e.g. ABC for ABC-12), letters and digits. Its tasks' keys change with it; the old keys still find them, and stay the project's.",
      }),
    ),
    base_branch: Schema.optionalKey(Schema.String.annotate({ description: "The branch new task branches start from and merge into" })),
    model: Schema.optionalKey(Schema.String.annotate({ description: "The model the project's agents use, over the profile's and host's default" })),
    start_prompt: Schema.optionalKey(Schema.String),
    review_prompt: Schema.optionalKey(Schema.String),
    merge_prompt: Schema.optionalKey(Schema.String),
    auto_review: Schema.optionalKey(Schema.Boolean.annotate({ description: "Review each task's changes when it moves to in_review" })),
    review_rounds: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 })).annotate({
        description: "How many times in a row a review's serious issues go back to the agent to fix before the task is left for the user",
      }),
    ),
    group_name: Schema.optionalKey(
      Schema.String.annotate({
        description: "The sidebar group the project is in, shared with the host's other projects of that group name; an empty string takes it out of its group",
      }),
    ),
    reviewers: Schema.optionalKey(
      Schema.NullOr(Schema.Array(ReviewerArg).check(Schema.isMaxLength(6))).annotate({
        description:
          "Who reviews each task, each in its own review thread; their serious issues are combined. An empty list uses the profile's reviewers (by default one reviewer with the task's own config). claude_config_id is an agent config's id (omit it for the task's config), model and effort override the defaults. prompt replaces the project's review_prompt for this reviewer (what it looks for), and skills are names of skills it uses (named in its prompt); the board's own (a project's own or global ones) among them are on in its thread whether or not they are for the project.",
      }),
    ),
    permission_mode: Schema.optionalKey(
      Schema.Literals(PERMISSION_MODES).annotate({
        description: "Needs approval. What the project's agents may do without asking the user, over the host's default",
      }),
    ),
    setup_script: Schema.optionalKey(Schema.String.annotate({ description: "Needs approval. Runs in a task's new worktree" })),
    teardown_script: Schema.optionalKey(Schema.String.annotate({ description: "Needs approval. Runs in a task's worktree before it's removed" })),
    copy_files: Schema.optionalKey(copyFiles),
    link_folders: Schema.optionalKey(linkFolders),
    status_script: Schema.optionalKey(Schema.String.annotate({ description: "Needs approval. Runs whenever one of the project's tasks changes status" })),
    status_scripts: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.String).annotate({
        description: "Needs approval. A script per status (the keys), run when a task moves into it; replaces them all, and a blank script is none",
      }),
    ),
    repo_path: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Needs approval. The project's repository folder, e.g. after the folder was moved or renamed: it must be the same repository (or, with move_repo, a path that doesn't exist yet). Task worktrees are reconnected to it.",
      }),
    ),
    move_repo: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "Needs approval. With repo_path, move the repository folder from where it is now to repo_path, rather than pointing the project at a folder that has already moved. The project's agents must not be running.",
      }),
    ),
    use_worktrees: Schema.optionalKey(Schema.Boolean.annotate({ description: "Needs approval. Whether new tasks get a git worktree of their own" })),
    worktrees_root: Schema.optionalKey(Schema.String.annotate({ description: "Needs approval. The folder tasks' worktrees go in" })),
    reason: Schema.optionalKey(Schema.String.annotate({ description: "Why you're making the change, shown to the user when it needs their approval" })),
    use_workflows: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "Whether the project's workflows take its tasks across the board instead of the board's own handling: tasks entering columns start them, and auto_review, review_rounds, reviewers, auto_summary and summarizers don't run (turning it on moves them into a workflow, unless one that's on has an in_review step already). Off, its workflows only run by hand (run_workflow).",
      }),
    ),
    auto_summary: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Once a task's review passes, have an agent summarise its changes for the user to read before merging" }),
    ),
    summarizer: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({
          claude_config_id: Schema.optionalKey(Schema.String),
          model: Schema.optionalKey(Schema.String),
          effort: Schema.optionalKey(Schema.String),
        }),
      ).annotate({
        description:
          "The one summarizer, for when there's only one: the same as summarizers with a list of one, and null the same as an empty list. Prefer summarizers.",
      }),
    ),
    summarizers: Schema.optionalKey(
      Schema.NullOr(Schema.Array(SummarizerArg)).annotate({
        description:
          "Who writes those summaries, each in a thread of its own, so which skills and prompts summarise best can be compared: claude_config_id is an agent config's id (omit it for the task's config), model and effort override the defaults; name says which is which where the summaries are shown; skills are skills it uses while writing (their names, e.g. \"summarize-changes\"); prompt replaces the board's instructions on how to write the summary. [{}] is one with the task's config and the defaults; an empty list or null uses the profile's summarizers.",
      }),
    ),
  }),
  success: Json,
}).annotate(ApprovalKind, "project")

export const CreateProject = Tool.make("create_project", {
  description:
    "Add a project (a local repository directory) to your profile's board (or, with profile, to that profile's). A missing directory is created. Only when the user asks for a new project: first check list_projects, since the project may already be on another profile's board, and if it might be on a board you can't use, ask the user instead. " +
    "It asks the user to approve the folder first (say why in reason): the call waits for their answer, and if they don't approve it nothing is added.",
  parameters: Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    repo_path: Schema.String.annotate({ description: "The folder, as an absolute path or starting with ~/" }),
    profile: Schema.optionalKey(ProfileArg),
    reason: Schema.optionalKey(Schema.String.annotate({ description: "Why you're adding it, shown to the user when they're asked to approve it" })),
  }),
  success: Json,
}).annotate(ApprovalKind, "project")

/** A reviewer or summarizer an agent gives, as a project keeps it (blank fields are tidied by `Projects`). */
const reviewer = (r: typeof SummarizerArg.Type): Reviewer => ({
  claude_config_id: r.claude_config_id === undefined ? null : AgentConfigId.make(r.claude_config_id),
  model: r.model ?? null,
  effort: r.effort ?? null,
  ...(r.name === undefined ? {} : { name: r.name }),
  ...(r.skills === undefined ? {} : { skills: r.skills }),
  ...(r.prompt === undefined ? {} : { prompt: r.prompt }),
})

const isStatus = Schema.is(Status)

/**
 * `update_project`'s arguments as a change to a project (the old `update_project`'s body): only what is given; an
 * explicit null reviewers or summarizers goes back to the profile's, and `summarizer` is a list of one.
 */
export const projectPatch = Effect.fnUntraced(function* (params: typeof UpdateProject.parametersSchema.Type) {
  const patch: { -readonly [K in keyof ProjectPatch]?: ProjectPatch[K] } = {}
  for (const k of ["name", "key", "repo_path"] as const) {
    const v = params[k]
    if (v === undefined) continue
    if (v.trim() === "") return yield* ToolError.other(`${k} can't be blank`)
    patch[k] = v
  }
  // A blank one goes back to the default.
  if (params.base_branch !== undefined) patch.base_branch = given(params.base_branch)
  if (params.model !== undefined) patch.model = given(params.model)
  if (params.permission_mode !== undefined) patch.permission_mode = params.permission_mode === "" ? null : params.permission_mode
  for (const k of ["start_prompt", "review_prompt", "merge_prompt", "setup_script", "teardown_script", "status_script", "group_name"] as const) {
    const v = params[k]
    if (v !== undefined) patch[k] = v
  }
  for (const k of ["copy_files", "link_folders", "worktrees_root"] as const) {
    const v = params[k]
    if (v !== undefined) patch[k] = v
  }
  for (const k of ["auto_review", "auto_summary", "use_workflows", "use_worktrees", "move_repo"] as const) {
    const v = params[k]
    if (v !== undefined) patch[k] = v
  }
  if (params.review_rounds !== undefined) patch.review_rounds = params.review_rounds
  if (params.reviewers !== undefined) patch.reviewers = params.reviewers === null ? [] : params.reviewers.map(reviewer)
  if (params.summarizers !== undefined) patch.summarizers = params.summarizers === null ? [] : params.summarizers.map(reviewer)
  else if (params.summarizer !== undefined) patch.summarizers = params.summarizer === null ? [] : [reviewer(params.summarizer)]
  if (params.status_scripts !== undefined) {
    const scripts: { [K in Status]?: string } = {}
    for (const [status, script] of Object.entries(params.status_scripts).toSorted(([a], [b]) => a.localeCompare(b))) {
      if (!isStatus(status)) {
        return yield* ToolError.other(
          `unknown status ${yield* toJson(status)} in status_scripts; statuses are [${(yield* Effect.forEach(Status.literals, toJson, { concurrency: 1 })).join(", ")}]`,
        )
      }
      scripts[status] = script
    }
    patch.status_scripts = scripts
  }
  if (Object.keys(patch).length === 0) return yield* ToolError.other("nothing to change")
  return patch
})

/** A project as `list_projects` gives it. */
export const projectJson = (reach: Reach, p: Project, board: Profile): JsonObject => ({
  id: p.id,
  key: p.key,
  name: p.name,
  repo_path: p.repo_path,
  profile: board.name,
  host: reach.hostName,
})

/** `get_project`: a project's settings, with each prompt's instructions in effect and whether they're the default. */
export const projectSettingsJson = (reach: Reach, p: Project, board: Profile): JsonObject => ({
  ...projectJson(reach, p, board),
  former_keys: p.former_keys,
  base_branch: p.base_branch,
  model: p.model,
  permission_mode: p.permission_mode,
  use_worktrees: p.use_worktrees,
  worktrees_root: p.worktrees_root,
  setup_script: p.setup_script,
  teardown_script: p.teardown_script,
  copy_files: p.copy_files,
  link_folders: p.link_folders,
  status_script: p.status_script,
  status_scripts: p.status_scripts,
  is_git: p.is_git,
  auto_review: p.auto_review,
  use_workflows: p.use_workflows,
  review_rounds: p.review_rounds,
  pull_requests: p.pull_requests,
  watch_pull_requests: p.watch_pull_requests,
  pr_preview_url: p.pr_preview_url,
  reviewers: p.reviewers,
  auto_summary: p.auto_summary,
  summarizers: p.summarizers,
  // What the project's empty reviewers and summarizers use.
  profile_reviewers: board.reviewers,
  profile_summarizers: board.summarizers,
  group_name: p.group_name,
  archived: p.archived_at !== null,
  start_prompt: { instructions: projectStart(p), default: p.start_prompt === null },
  review_prompt: { instructions: projectReview(p), default: p.review_prompt === null },
  merge_prompt: { instructions: projectMerge(p), default: p.merge_prompt === null },
})

/** The project tools' handlers, in the order runs are shown them. */
export const projectTools = Effect.gen(function* () {
  const reach = yield* makeReach
  const projects = yield* ProjectRepo
  const approvals = yield* Approvals

  const listProjects = boardTool(ListProjects, (params, caller) =>
    Effect.gen(function* () {
      const out: Array<JsonObject> = []
      for (const b of yield* reach.pickBoards(caller, given(params.profile))) {
        // Archived ones are off the board until the user unarchives them.
        for (const p of yield* projects.list(b.id)) if (p.archived_at === null) out.push(projectJson(reach, p, b))
      }
      return out
    }),
  )

  const getProject = boardTool(GetProject, (params, caller) =>
    Effect.gen(function* () {
      const profile = given(params.profile)
      const p = yield* reach.projectOrOwn(caller, given(params.project_id), profile)
      const board = yield* reach.profile(p.profile_id)
      if (board === null) return yield* ToolError.notFound("profile")
      return projectSettingsJson(reach, p, board)
    }),
  )

  const updateProject = boardTool(
    UpdateProject,
    (params, caller) =>
      Effect.gen(function* () {
        const profile = given(params.profile)
        // Read only when the call hasn't asked before: a retried call carries on with the approval it asked for, and
        // the project it was for, whatever has changed since.
        const request = Effect.gen(function* () {
          const patch = yield* projectPatch(params)
          return { project: yield* reach.projectOrOwn(caller, given(params.project_id), profile), patch, reason: given(params.reason) }
        })
        const p = yield* approvals.updateProject(asker(caller), request)
        const board = yield* reach.profile(p.profile_id)
        if (board === null) return yield* ToolError.notFound("profile")
        return projectSettingsJson(reach, p, board)
      }).pipe(told),
    // An explicit null reviewers or summarizers goes back to the profile's; any other null is "not given".
    { keepNulls: true, prepare: (args) => Object.fromEntries(Object.entries(args).filter(([k, v]) => v !== null || NULLABLE.has(k))) },
  )

  const createProject = boardTool(CreateProject, (params, caller) =>
    Effect.gen(function* () {
      const profile = given(params.profile)
      // Read only when the call hasn't asked before (a retried call carries on with the approval it asked for).
      const request = Effect.gen(function* () {
        const boards = yield* reach.pickBoards(caller, profile)
        const board = profile !== null ? boards[0] : boards.find((b) => b.id === caller.profile.id)
        if (board === undefined) return yield* ToolError.notFound(`profile ${caller.profile.name} on host ${reach.hostName}`)
        return { board, name: given(params.name), repo_path: params.repo_path, reason: given(params.reason) }
      })
      const p = yield* approvals.createProject(asker(caller), request)
      const board = yield* reach.profile(p.profile_id)
      if (board === null) return yield* ToolError.notFound("profile")
      return projectJson(reach, p, board)
    }).pipe(told),
  )

  return { listProjects, getProject, updateProject, createProject }
})

const NULLABLE: ReadonlySet<string> = new Set(["reviewers", "summarizer", "summarizers"])
