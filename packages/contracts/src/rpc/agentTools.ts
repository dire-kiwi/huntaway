import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import {
  AgentToolSwitch,
  GlobalAgentTools,
  McpServer,
  McpServerId,
  McpServerInput,
  ProjectAgentTools,
  ProjectAgentToolsPatch,
  Skill,
  SkillId,
  SkillInput,
  SkillSourceId,
  SkillSourceSynced,
  ToolOwner,
} from "../agentTools.ts"
import { Conflict, External, Invalid, NotFound } from "../errors.ts"
import { ProjectId } from "../ids.ts"
import { Auth, RequiredScope } from "../session.ts"

/**
 * Skills and MCP servers for agents (the old `/agent-tools` and `/projects/{id}/agent-tools` routes, 125–138): the host's
 * global ones (`project_id` null) and a project's own, their switches, and skill sources. Nothing is emitted: they hold
 * from each thread's next run, and the settings read them again after a change. A name taken in its scope is
 * `Conflict` (`duplicate_name`); a clone that fails is `External` (`git`).
 */
export class AgentToolsRpcs extends RpcGroup.make(
  Rpc.make("agentTools.get", { success: GlobalAgentTools }).annotate(RequiredScope, "read"),
  Rpc.make("agentTools.project", { payload: { project_id: ProjectId }, success: ProjectAgentTools, error: NotFound }).annotate(RequiredScope, "read"),
  /** Only a new bad skill name is refused: the lists are sent whole. The board's own server can't be turned off. */
  Rpc.make("agentTools.updateProject", {
    payload: { project_id: ProjectId, patch: ProjectAgentToolsPatch },
    success: ProjectAgentTools,
    error: Schema.Union([NotFound, Invalid]),
  }).annotate(RequiredScope, "settings"),
  Rpc.make("agentTools.setSwitch", { payload: AgentToolSwitch, error: Schema.Union([NotFound, Invalid]) }).annotate(RequiredScope, "settings"),
  /** Clones the repository and adds its skills, off everywhere until switched on. */
  Rpc.make("agentTools.addSource", {
    payload: { url: Schema.String, ref: Schema.optionalKey(Schema.NullOr(Schema.String)), subdir: Schema.optionalKey(Schema.NullOr(Schema.String)) },
    success: SkillSourceSynced,
    error: Schema.Union([Invalid, Conflict, External]),
  }).annotate(RequiredScope, "settings"),
  /** Clones it again: a failure keeps the skills and says why on the source. */
  Rpc.make("agentTools.updateSource", { payload: { id: SkillSourceId }, success: SkillSourceSynced, error: Schema.Union([NotFound, External]) }).annotate(
    RequiredScope,
    "settings",
  ),
  Rpc.make("agentTools.removeSource", { payload: { id: SkillSourceId }, error: NotFound }).annotate(RequiredScope, "settings"),
  Rpc.make("agentTools.addSkill", {
    payload: { project_id: ToolOwner, skill: SkillInput },
    success: Skill,
    error: Schema.Union([NotFound, Invalid, Conflict]),
  }).annotate(RequiredScope, "settings"),
  Rpc.make("agentTools.updateSkill", {
    payload: { project_id: ToolOwner, id: SkillId, skill: SkillInput },
    success: Skill,
    error: Schema.Union([NotFound, Invalid, Conflict]),
  }).annotate(RequiredScope, "settings"),
  Rpc.make("agentTools.removeSkill", { payload: { project_id: ToolOwner, id: SkillId }, error: Schema.Union([NotFound, Invalid]) }).annotate(
    RequiredScope,
    "settings",
  ),
  Rpc.make("agentTools.addServer", {
    payload: { project_id: ToolOwner, server: McpServerInput },
    success: McpServer,
    error: Schema.Union([NotFound, Invalid, Conflict]),
  }).annotate(RequiredScope, "settings"),
  Rpc.make("agentTools.updateServer", {
    payload: { project_id: ToolOwner, id: McpServerId, server: McpServerInput },
    success: McpServer,
    error: Schema.Union([NotFound, Invalid, Conflict]),
  }).annotate(RequiredScope, "settings"),
  Rpc.make("agentTools.removeServer", { payload: { project_id: ToolOwner, id: McpServerId }, error: NotFound }).annotate(RequiredScope, "settings"),
).middleware(Auth) {}
