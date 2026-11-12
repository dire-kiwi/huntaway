import { Effect } from "effect"
import { NotFound, ProjectRpcs } from "@huntaway/contracts"
import { Relocation } from "../git/Relocation.ts"
import { Prompts } from "../agents/Prompts.ts"
import { TaskBase } from "../git/TaskBase.ts"
import { Worktrees } from "../git/Worktrees.ts"
import type { ProfileNotFound } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import type { ProjectNotFound } from "../projects/Projects.ts"
import { SetupThread } from "../runs/SetupThread.ts"
import { sendRefused } from "./tasks.ts"

const profileNotFound = (e: ProfileNotFound) => Effect.fail(new NotFound({ what: "profile", id: e.id }))
const projectNotFound = (e: ProjectNotFound) => Effect.fail(new NotFound({ what: "project", id: e.id }))

export const ProjectHandlers = ProjectRpcs.toLayer(
  Effect.gen(function* () {
    const projects = yield* Projects
    const base = yield* TaskBase
    const worktrees = yield* Worktrees
    const setupThread = yield* SetupThread
    const relocation = yield* Relocation
    const prompts = yield* Prompts
    return ProjectRpcs.of({
      "projects.list": ({ profile_id, archived }) => projects.list(profile_id, archived ?? false).pipe(Effect.catchTag("ProfileNotFound", profileNotFound)),
      // Its folder is looked at again (the old server read `is_git` and `has_commits` on every read): the setup page asks
      // while its folder isn't ready, and a change reaches every board as the `project` event.
      "projects.get": ({ id }) => projects.refreshGit(id).pipe(Effect.catchTag("ProjectNotFound", projectNotFound)),
      "projects.create": ({ project }) => projects.create(project).pipe(Effect.catchTag("ProfileNotFound", profileNotFound)),
      // 6.11: a new folder moves or follows it (`Relocation`).
      "projects.update": ({ id, patch }) => relocation.update(id, patch).pipe(Effect.catchTag("ProjectNotFound", projectNotFound)),
      // Its tasks' worktrees go first (`Worktrees.deleteProject`).
      "projects.delete": ({ id }) => worktrees.deleteProject(id).pipe(Effect.catchTag("ProjectNotFound", projectNotFound)),
      "projects.systemPrompt": ({ id, options }) => prompts.preview(id, options).pipe(Effect.catchTag("ProjectNotFound", projectNotFound)),
      "projects.branches": ({ id }) =>
        projects.get(id).pipe(
          Effect.flatMap((p) => base.branches(p.repo_path)),
          Effect.catchTag("ProjectNotFound", projectNotFound),
        ),
      "projects.removeMergedWorktrees": ({ id }) => worktrees.removeMerged(id).pipe(Effect.catchTag("ProjectNotFound", projectNotFound)),
      "projects.setupThread": ({ id, message }) =>
        setupThread.start(id, message ?? "").pipe(
          Effect.catchTags({
            ProjectNotFound: projectNotFound,
            ProfileNotFound: profileNotFound,
            TaskNotFound: (e) => Effect.fail(new NotFound({ what: "task", id: e.id })),
            SendRefused: sendRefused,
          }),
        ),
    })
  }),
)
