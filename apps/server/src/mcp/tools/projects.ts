import { Effect, Schema } from "effect"
import { Tool } from "effect/ai"
import type { Profile, Project } from "@huntaway/contracts"
import { projectMerge, projectReview, projectStart } from "../../agents/prompts/project.ts"
import { ProjectRepo } from "../../projects/ProjectRepo.ts"
import { makeReach } from "../resolve.ts"
import type { Reach } from "../resolve.ts"
import { ForPlanning, ForReviewers, Rerunnable, ToolError } from "../tool.ts"
import { boardTool, given, Json, PROJECT_ONE, ProfileArg } from "./common.ts"
import type { JsonObject } from "./common.ts"

// The board's project tools that read (docs/plan/inventory/03-mcp.md 2.5; the old mcp/schemas/projects.ts and
// mcp/tools/resolve.ts `project_json`, `project_settings_json`): `list_projects` and `get_project`. `update_project`
// and `create_project` ask the user first and are 3.4's.

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

  return { listProjects, getProject }
})
