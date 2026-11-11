import { Schema } from "effect"
import { ProjectId } from "./ids.ts"
import { Agent } from "./task.ts"

// Skills and MCP servers kept on a host for its agents (docs/plan/inventory/02-agent-support.md, section 2.5; huntaway's
// agent/agent_tools.ts and wire/agent_tools.ts): a project's own, or global ones that each profile switches on by
// default and each project can override; git repositories whose skills are global skills (skill sources); and what a
// project's agent runs reported having, so the project can turn those off.

export const SkillId = Schema.String.pipe(Schema.brand("SkillId"))
export type SkillId = typeof SkillId.Type
export const McpServerId = Schema.String.pipe(Schema.brand("McpServerId"))
export type McpServerId = typeof McpServerId.Type
export const SkillSourceId = Schema.String.pipe(Schema.brand("SkillSourceId"))
export type SkillSourceId = typeof SkillSourceId.Type

/** A skill for one project's agents, or (`project_id` null) a global one. */
export const Skill = Schema.Struct({
  id: SkillId,
  project_id: Schema.NullOr(ProjectId),
  name: Schema.String,
  /** From the frontmatter. */
  description: Schema.String,
  /** The whole `SKILL.md`, frontmatter included. */
  content: Schema.String,
  /** A project's own skill can be switched off; global ones are switched per profile and project instead. */
  enabled: Schema.Boolean,
  /** The skill source it comes from, if it does: it isn't edited or deleted by itself then. */
  source_id: Schema.NullOr(SkillSourceId),
  created_at: Schema.String,
  updated_at: Schema.String,
})
export interface Skill extends Schema.Schema.Type<typeof Skill> {}

/** An `mcpServers` entry, as in `.mcp.json`: the fields the board reads, and any others kept as given. */
export const McpServerConfig = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.optionalKey(Schema.Literals(["stdio", "http", "sse"])),
    command: Schema.optionalKey(Schema.String),
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    url: Schema.optionalKey(Schema.String),
    headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)
export type McpServerConfig = typeof McpServerConfig.Type

/** An MCP server for one project's agents, or (`project_id` null) a global one. */
export const McpServer = Schema.Struct({
  id: McpServerId,
  project_id: Schema.NullOr(ProjectId),
  name: Schema.String,
  config: McpServerConfig,
  enabled: Schema.Boolean,
  /** Its tools run without asking (`--allowedTools mcp__<name>`). */
  auto_allow: Schema.Boolean,
  created_at: Schema.String,
  updated_at: Schema.String,
})
export interface McpServer extends Schema.Schema.Type<typeof McpServer> {}

/** A git repository the host clones, whose skills are global skills. */
export const SkillSource = Schema.Struct({
  id: SkillSourceId,
  url: Schema.String,
  /** The branch or tag cloned; null for the repository's default branch. */
  ref: Schema.NullOr(Schema.String),
  /** The folder in the repository its skills are taken from; null for the whole repository. */
  subdir: Schema.NullOr(Schema.String),
  /** The repository's name, for lists. */
  name: Schema.String,
  /** The commit the clone is at. */
  commit: Schema.NullOr(Schema.String),
  synced_at: Schema.NullOr(Schema.String),
  /** Why the last update failed, if it did: the skills from the update before stay. */
  error: Schema.NullOr(Schema.String),
  /** What in the repository was left out: skills that aren't valid, or whose name is taken. */
  notes: Schema.Array(Schema.String),
  created_at: Schema.String,
})
export interface SkillSource extends Schema.Schema.Type<typeof SkillSource> {}

/** A skill a run reported, with when. */
export const SeenSkill = Schema.Struct({ name: Schema.String, at: Schema.String })
/** A server a run reported (claude.ai connectors, a plugin's, the repository's), with when. */
export const SeenServer = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  source: Schema.optionalKey(Schema.NullOr(Schema.String)),
  at: Schema.String,
})

/** What a project's agent runs with one config had: kept 14 days after the runs stop reporting it. */
export const SeenTools = Schema.Struct({
  skills: Schema.Array(SeenSkill),
  mcp_servers: Schema.Array(SeenServer),
  /** The board's own skills the last run was given. */
  board_skills: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The last run. */
  at: Schema.String,
})
export interface SeenTools extends Schema.Schema.Type<typeof SeenTools> {}

/** On or off, by item id (unset: the default). */
export const Switches = Schema.Record(Schema.String, Schema.Boolean)

/** A project's skills and servers, the ones from elsewhere it turns off, and the host's global ones with its switches. */
export const ProjectAgentTools = Schema.Struct({
  skills: Schema.Array(Skill),
  mcp_servers: Schema.Array(McpServer),
  disabled_skills: Schema.Array(Schema.String),
  disabled_mcp_servers: Schema.Array(Schema.String),
  /** By config id ("" for the agent's default). */
  seen: Schema.Record(Schema.String, SeenTools),
  global_skills: Schema.Array(Skill),
  global_mcp_servers: Schema.Array(McpServer),
  skill_sources: Schema.Array(SkillSource),
  /** The project's profile's defaults (unset: off). */
  profile_switches: Switches,
  /** The project's overrides (unset: its profile's default). */
  project_switches: Switches,
})
export interface ProjectAgentTools extends Schema.Schema.Type<typeof ProjectAgentTools> {}

/** The host's global skills and servers, and each profile's defaults for them. */
export const GlobalAgentTools = Schema.Struct({
  skills: Schema.Array(Skill),
  mcp_servers: Schema.Array(McpServer),
  skill_sources: Schema.Array(SkillSource),
  /** Profile id → item id → on (unset: off). */
  profile_switches: Schema.Record(Schema.String, Switches),
})
export interface GlobalAgentTools extends Schema.Schema.Type<typeof GlobalAgentTools> {}

/** A source as added or updated, with its skills. */
export const SkillSourceSynced = Schema.Struct({ source: SkillSource, skills: Schema.Array(Skill) })
export interface SkillSourceSynced extends Schema.Schema.Type<typeof SkillSourceSynced> {}

/** Whose switch: a profile's default, or a project's override. */
export const SwitchScope = Schema.Literals(["profile", "project"])
export type SwitchScope = typeof SwitchScope.Type

/** A switch for a global skill or server (`item_id`), or every skill of a source (`source_id`); `enabled` null clears it. */
export const AgentToolSwitch = Schema.Struct({
  scope: SwitchScope,
  scope_id: Schema.String,
  item_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  source_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  enabled: Schema.NullOr(Schema.Boolean),
})
export interface AgentToolSwitch extends Schema.Schema.Type<typeof AgentToolSwitch> {}

/** A skill as added or changed: its whole `SKILL.md`, and (a project's own) whether it's on. */
export const SkillInput = Schema.Struct({ content: Schema.optionalKey(Schema.String), enabled: Schema.optionalKey(Schema.Boolean) })
export interface SkillInput extends Schema.Schema.Type<typeof SkillInput> {}

/** A server as added or changed. `config` is checked by the host (its `type`, `command`, `url`, `args`, `env`, `headers`). */
export const McpServerInput = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  config: Schema.optionalKey(Schema.Unknown),
  enabled: Schema.optionalKey(Schema.Boolean),
  auto_allow: Schema.optionalKey(Schema.Boolean),
})
export interface McpServerInput extends Schema.Schema.Type<typeof McpServerInput> {}

/** A project's lists of skills and servers from elsewhere that it turns off (each the whole list, when given). */
export const ProjectAgentToolsPatch = Schema.Struct({
  disabled_skills: Schema.optionalKey(Schema.Array(Schema.String)),
  disabled_mcp_servers: Schema.optionalKey(Schema.Array(Schema.String)),
})
export interface ProjectAgentToolsPatch extends Schema.Schema.Type<typeof ProjectAgentToolsPatch> {}

/** A skill a task's agent can be asked to use: `/name` for Claude Code, `$name` for Codex. */
export const TaskSkill = Schema.Struct({
  name: Schema.String,
  /** Blank when the host can't find its `SKILL.md` (skills bundled with Claude Code). */
  description: Schema.String,
})
export interface TaskSkill extends Schema.Schema.Type<typeof TaskSkill> {}

/** The skills a task's agent can be asked to use, and which agent that is. */
export const TaskSkills = Schema.Struct({ agent: Agent, skills: Schema.Array(TaskSkill) })
export interface TaskSkills extends Schema.Schema.Type<typeof TaskSkills> {}

/** The owner of a skill or server: a project, or null for the host's global ones. */
export const ToolOwner = Schema.NullOr(ProjectId)
