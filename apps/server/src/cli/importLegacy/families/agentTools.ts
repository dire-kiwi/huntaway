import { Effect, Schema } from "effect"
import { McpServerConfig, ProjectId, SeenTools, SwitchScope } from "@huntaway/contracts"
import { OverridesRow, ServerRowSchema, SkillRowSchema, SourceRowSchema, SwitchRow } from "../../../agents/AgentToolsRepo.ts"
import { keyOf } from "../family.ts"
import type { Family, TableCheck } from "../family.ts"
import { Flag, orDefault, orNull, readOld } from "./common.ts"

// The agent tools' tables (docs/plan/11-migration.md, Table by table: as is): skill sources, skills, MCP servers, the
// switches of global ones per profile and project, and a project's overrides with what its runs had. The sources' files
// (`skill-sources/`) are copied with the folder.

const Strings = Schema.Array(Schema.String)

/** The old tables' rows, as they are at schema version 130 (`subdir`, `source_id` and `source_path` came late). */
export const OldSkillSource = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  git_ref: orNull(Schema.String),
  subdir: orNull(Schema.String),
  name: Schema.String,
  commit_sha: orNull(Schema.String),
  synced_at: orNull(Schema.String),
  error: orNull(Schema.String),
  notes: orDefault(Schema.String, "[]"),
  created_at: Schema.String,
})

export const OldSkill = Schema.Struct({
  id: Schema.String,
  project_id: orNull(Schema.String),
  name: Schema.String,
  content: Schema.String,
  enabled: orDefault(Flag, 1),
  source_id: orNull(Schema.String),
  source_path: orNull(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
})

export const OldMcpServer = Schema.Struct({
  id: Schema.String,
  project_id: orNull(Schema.String),
  name: Schema.String,
  config: Schema.String,
  enabled: orDefault(Flag, 1),
  auto_allow: orDefault(Flag, 0),
  created_at: Schema.String,
  updated_at: Schema.String,
})

export const OldToolSwitch = Schema.Struct({ scope: Schema.String, scope_id: Schema.String, item_id: Schema.String, enabled: Flag })

export const OldProjectAgentTools = Schema.Struct({
  project_id: Schema.String,
  disabled_skills: orDefault(Schema.String, "[]"),
  disabled_mcp_servers: orDefault(Schema.String, "[]"),
  seen: orDefault(Schema.String, "{}"),
})

const byId = keyOf("id")

const sources: TableCheck = { row: SourceRowSchema, json: { notes: Strings }, key: byId }
const skills: TableCheck = { row: SkillRowSchema, key: byId }
const servers: TableCheck = { row: ServerRowSchema, json: { config: McpServerConfig }, key: byId }
const switches: TableCheck = { row: Schema.Struct({ scope: SwitchScope, ...SwitchRow.fields }), key: keyOf("scope", "scope_id", "item_id") }
const overrides: TableCheck = {
  row: Schema.Struct({ project_id: ProjectId, ...OverridesRow.fields }),
  json: { disabled_skills: Strings, disabled_mcp_servers: Strings, seen: Schema.Record(Schema.String, SeenTools) },
  key: keyOf("project_id"),
}

export const agentTools: Family = {
  name: "agent tools",
  reads: ["skill_sources", "agent_skills", "agent_mcp_servers", "agent_tool_switches", "project_agent_tools"],
  writes: ["skill_sources", "agent_skills", "agent_mcp_servers", "agent_tool_switches", "project_agent_tools"],
  run: (io) =>
    Effect.gen(function* () {
      yield* io.write("skill_sources", sources, yield* readOld(io, "skill_sources", OldSkillSource, byId))
      yield* io.write("agent_skills", skills, yield* readOld(io, "agent_skills", OldSkill, byId))
      yield* io.write("agent_mcp_servers", servers, yield* readOld(io, "agent_mcp_servers", OldMcpServer, byId))
      yield* io.write("agent_tool_switches", switches, yield* readOld(io, "agent_tool_switches", OldToolSwitch, keyOf("scope", "scope_id", "item_id")))
      yield* io.write("project_agent_tools", overrides, yield* readOld(io, "project_agent_tools", OldProjectAgentTools, keyOf("project_id")))
    }),
}
