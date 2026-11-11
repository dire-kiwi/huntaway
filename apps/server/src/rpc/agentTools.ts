import { Effect } from "effect"
import { AgentToolsRpcs, Conflict, External, Invalid, NotFound } from "@huntaway/contracts"
import { AgentTools } from "../agents/AgentTools.ts"
import type * as Tool from "../agents/AgentTools.ts"

// The agent tools' handlers (6.4): each calls one `AgentTools` method and maps its errors to the contract's.

const ToolNotFound = (e: Tool.ToolNotFound) => Effect.fail(new NotFound({ what: e.what, id: e.id }))
const ToolInvalid = (e: Tool.ToolInvalid) => Effect.fail(new Invalid({ field: e.field, reason: e.reason }))
const ToolConflict = (e: Tool.ToolConflict) => Effect.fail(new Conflict({ reason: "duplicate_name", detail: e.detail }))
const SourceFailed = (e: Tool.SourceFailed) => Effect.fail(new External({ service: "git", reason: e.reason }))

export const AgentToolsHandlers = AgentToolsRpcs.toLayer(
  Effect.gen(function* () {
    const tools = yield* AgentTools
    return AgentToolsRpcs.of({
      "agentTools.get": () => tools.global,
      "agentTools.project": ({ project_id }) => tools.project(project_id).pipe(Effect.catchTags({ ToolNotFound })),
      "agentTools.updateProject": ({ project_id, patch }) => tools.updateProject(project_id, patch).pipe(Effect.catchTags({ ToolNotFound, ToolInvalid })),
      "agentTools.setSwitch": (input) => tools.setSwitch(input).pipe(Effect.catchTags({ ToolNotFound, ToolInvalid })),
      "agentTools.addSource": (input) => tools.addSource(input).pipe(Effect.catchTags({ ToolInvalid, ToolConflict, SourceFailed })),
      "agentTools.updateSource": ({ id }) => tools.updateSource(id).pipe(Effect.catchTags({ ToolNotFound, SourceFailed })),
      "agentTools.removeSource": ({ id }) => tools.removeSource(id).pipe(Effect.catchTags({ ToolNotFound })),
      "agentTools.addSkill": ({ project_id, skill }) => tools.addSkill(project_id, skill).pipe(Effect.catchTags({ ToolNotFound, ToolInvalid, ToolConflict })),
      "agentTools.updateSkill": ({ project_id, id, skill }) =>
        tools.updateSkill(project_id, id, skill).pipe(Effect.catchTags({ ToolNotFound, ToolInvalid, ToolConflict })),
      "agentTools.removeSkill": ({ project_id, id }) => tools.removeSkill(project_id, id).pipe(Effect.catchTags({ ToolNotFound, ToolInvalid })),
      "agentTools.addServer": ({ project_id, server }) =>
        tools.addServer(project_id, server).pipe(Effect.catchTags({ ToolNotFound, ToolInvalid, ToolConflict })),
      "agentTools.updateServer": ({ project_id, id, server }) =>
        tools.updateServer(project_id, id, server).pipe(Effect.catchTags({ ToolNotFound, ToolInvalid, ToolConflict })),
      "agentTools.removeServer": ({ project_id, id }) => tools.removeServer(project_id, id).pipe(Effect.catchTags({ ToolNotFound })),
    })
  }),
)
