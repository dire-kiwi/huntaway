import { Effect } from "effect"
import { NotFound, ProjectRpcs } from "@huntaway/contracts"
import type { ProfileNotFound } from "../profiles/Profiles.ts"
import { Projects } from "../projects/Projects.ts"
import type { ProjectNotFound } from "../projects/Projects.ts"

const profileNotFound = (e: ProfileNotFound) => Effect.fail(new NotFound({ what: "profile", id: e.id }))
const projectNotFound = (e: ProjectNotFound) => Effect.fail(new NotFound({ what: "project", id: e.id }))

export const ProjectHandlers = ProjectRpcs.toLayer(
  Effect.gen(function* () {
    const projects = yield* Projects
    return ProjectRpcs.of({
      "projects.list": ({ profile_id, archived }) => projects.list(profile_id, archived ?? false).pipe(Effect.catchTag("ProfileNotFound", profileNotFound)),
      "projects.get": ({ id }) => projects.get(id).pipe(Effect.catchTag("ProjectNotFound", projectNotFound)),
      "projects.create": ({ project }) => projects.create(project).pipe(Effect.catchTag("ProfileNotFound", profileNotFound)),
      "projects.update": ({ id, patch }) => projects.update(id, patch).pipe(Effect.catchTag("ProjectNotFound", projectNotFound)),
      "projects.delete": ({ id }) => projects.delete(id).pipe(Effect.catchTag("ProjectNotFound", projectNotFound)),
    })
  }),
)
