import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Conflict, Invalid, NotFound } from "../errors.ts"
import { ProfileId, ProjectId } from "../ids.ts"
import { NewProject, Project, ProjectPatch } from "../project.ts"
import { Auth, RequiredScope } from "../session.ts"

/** Projects (the old `/profiles/{id}/projects` and `/projects/{id}`). Changes emit `project` or `project_deleted`. */
export class ProjectRpcs extends RpcGroup.make(
  /** A profile's projects; `archived: true` lists its archived ones instead. */
  Rpc.make("projects.list", {
    payload: { profile_id: ProfileId, archived: Schema.optional(Schema.Boolean) },
    success: Schema.Array(Project),
    error: NotFound,
  }).annotate(RequiredScope, "read"),
  Rpc.make("projects.get", { payload: { id: ProjectId }, success: Project, error: NotFound }).annotate(RequiredScope, "read"),
  /** A project on a folder of this host (made if missing). */
  Rpc.make("projects.create", { payload: { project: NewProject }, success: Project, error: Schema.Union([NotFound, Invalid, Conflict]) }).annotate(
    RequiredScope,
    "settings",
  ),
  Rpc.make("projects.update", {
    payload: { id: ProjectId, patch: ProjectPatch },
    success: Project,
    error: Schema.Union([NotFound, Invalid, Conflict]),
  }).annotate(RequiredScope, "settings"),
  /** Deletes the project and its tasks; its repository folder is left alone. */
  Rpc.make("projects.delete", { payload: { id: ProjectId }, error: Schema.Union([NotFound, Conflict]) }).annotate(RequiredScope, "settings"),
).middleware(Auth) {}
