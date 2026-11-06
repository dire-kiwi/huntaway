import type { Agent } from "./claudeConfigs";
import { enc, type Http } from "./http";

/** A skill for one project's agents, or a global one (API 22) that profiles and projects switch on. */
export interface ProjectSkill {
  id: string;
  /** null for a global skill. */
  project_id: string | null;
  name: string;
  description: string;
  /** The whole SKILL.md, frontmatter included. */
  content: string;
  /** Only means something for a project's own skill; global ones are switched per profile and project. */
  enabled: boolean;
  /** The skill source (git repository) it comes from, for a global skill that does (API 104): not edited by itself. */
  source_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** A git repository the host clones, whose skills are global skills (API 104). */
export interface SkillSource {
  id: string;
  url: string;
  /** The branch or tag cloned; null for the default branch. */
  ref: string | null;
  /** The repository's name. */
  name: string;
  commit: string | null;
  synced_at: string | null;
  /** Why the last update failed; the skills from before stay. */
  error: string | null;
  /** What in the repository was left out. */
  notes: string[];
  created_at: string;
}

/** An `mcpServers` entry, as in `.mcp.json`. */
export interface McpServerConfig {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

/** An MCP server for one project's agents, or a global one (API 22). */
export interface ProjectMcpServer {
  id: string;
  /** null for a global server. */
  project_id: string | null;
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  /** Its tools run without asking. */
  auto_allow: boolean;
  created_at: string;
  updated_at: string;
}

/** A skill the user can call in a message to a task's agent: `/name` for Claude Code, `$name` for Codex (API 54). */
export interface TaskSkill {
  name: string;
  /** Blank when the host can't find its `SKILL.md` (skills bundled with Claude Code). */
  description: string;
}

export interface TaskSkills {
  agent: Agent;
  skills: TaskSkill[];
}

/** Skills and MCP servers a project's agent runs with one Claude config had, each with when a run last reported it. */
export interface SeenTools {
  skills: { name: string; at: string }[];
  mcp_servers: { name: string; status?: string; source?: string; at: string }[];
  /** The last run. */
  at: string;
}

export interface AgentTools {
  skills: ProjectSkill[];
  mcp_servers: ProjectMcpServer[];
  /** Skills and servers from Claude configs, plugins or the repository that the project turns off. */
  disabled_skills: string[];
  disabled_mcp_servers: string[];
  /** By Claude config id ("" for Claude's default). */
  seen: Record<string, SeenTools>;
  /** The host's global skills and servers (API 22). */
  global_skills?: ProjectSkill[];
  global_mcp_servers?: ProjectMcpServer[];
  skill_sources?: SkillSource[];
  /** Whether each global one is on by default in the project's profile, by id (unset: off). */
  profile_switches?: Record<string, boolean>;
  /** The project's overrides of those, by id (unset: the profile's default). */
  project_switches?: Record<string, boolean>;
}

/** A host's global skills and MCP servers, and each profile's defaults for them (API 22). */
export interface GlobalAgentTools {
  skills: ProjectSkill[];
  mcp_servers: ProjectMcpServer[];
  skill_sources?: SkillSource[];
  /** Profile id → item id → on (unset: off). */
  profile_switches: Record<string, Record<string, boolean>>;
}

export const agentToolsApi = ({ on }: Http) => ({
  /** The project's own skills and MCP servers, and the ones from elsewhere it turns off (API 21). */
  agentTools: (h: string, projectId: string) => on(h).get<AgentTools>(`/projects/${enc(projectId)}/agent-tools`),
  updateAgentTools: (h: string, projectId: string, b: { disabled_skills?: string[]; disabled_mcp_servers?: string[] }) =>
    on(h).patch<AgentTools>(`/projects/${enc(projectId)}/agent-tools`, b),
  createSkill: (h: string, projectId: string, b: { content: string; enabled?: boolean }) =>
    on(h).post<ProjectSkill>(`/projects/${enc(projectId)}/agent-tools/skills`, b),
  updateSkill: (h: string, projectId: string, id: string, b: { content?: string; enabled?: boolean }) =>
    on(h).patch<ProjectSkill>(`/projects/${enc(projectId)}/agent-tools/skills/${enc(id)}`, b),
  deleteSkill: (h: string, projectId: string, id: string) => on(h).del(`/projects/${enc(projectId)}/agent-tools/skills/${enc(id)}`),
  createMcpServer: (h: string, projectId: string, b: { name: string; config: McpServerConfig; enabled?: boolean; auto_allow?: boolean }) =>
    on(h).post<ProjectMcpServer>(`/projects/${enc(projectId)}/agent-tools/mcp-servers`, b),
  updateMcpServer: (h: string, projectId: string, id: string, b: { name?: string; config?: McpServerConfig; enabled?: boolean; auto_allow?: boolean }) =>
    on(h).patch<ProjectMcpServer>(`/projects/${enc(projectId)}/agent-tools/mcp-servers/${enc(id)}`, b),
  deleteMcpServer: (h: string, projectId: string, id: string) => on(h).del(`/projects/${enc(projectId)}/agent-tools/mcp-servers/${enc(id)}`),
  globalAgentTools: (h: string) => on(h).get<GlobalAgentTools>("/agent-tools"),
  createGlobalSkill: (h: string, b: { content: string }) => on(h).post<ProjectSkill>("/agent-tools/skills", b),
  updateGlobalSkill: (h: string, id: string, b: { content?: string }) => on(h).patch<ProjectSkill>(`/agent-tools/skills/${enc(id)}`, b),
  deleteGlobalSkill: (h: string, id: string) => on(h).del(`/agent-tools/skills/${enc(id)}`),
  createGlobalMcpServer: (h: string, b: { name: string; config: McpServerConfig; auto_allow?: boolean }) =>
    on(h).post<ProjectMcpServer>("/agent-tools/mcp-servers", b),
  updateGlobalMcpServer: (h: string, id: string, b: { name?: string; config?: McpServerConfig; auto_allow?: boolean }) =>
    on(h).patch<ProjectMcpServer>(`/agent-tools/mcp-servers/${enc(id)}`, b),
  deleteGlobalMcpServer: (h: string, id: string) => on(h).del(`/agent-tools/mcp-servers/${enc(id)}`),
  /** Switch a global skill or server on or off for a profile (its default) or a project; null clears it. */
  setAgentToolSwitch: (
    h: string,
    b: { scope: "profile" | "project"; scope_id: string; enabled: boolean | null } & ({ item_id: string } | { source_id: string }),
  ) => on(h).post("/agent-tools/switches", b),
  /** Clone a git repository (a URL, or `owner/repo` for GitHub) and add its skills, off until switched on (API 104). */
  addSkillSource: (h: string, b: { url: string; ref?: string }) => on(h).post<{ source: SkillSource; skills: ProjectSkill[] }>("/agent-tools/skill-sources", b),
  /** Clone it again and bring its skills up to date. */
  updateSkillSource: (h: string, id: string) => on(h).post<{ source: SkillSource; skills: ProjectSkill[] }>(`/agent-tools/skill-sources/${enc(id)}/update`, {}),
  deleteSkillSource: (h: string, id: string) => on(h).del(`/agent-tools/skill-sources/${enc(id)}`),

  /** The skills the task's agent can be asked to use, for the composer's `/` menu (API 54). */
  taskSkills: (h: string, id: string) => on(h).get<TaskSkills>(`/tasks/${enc(id)}/skills`),
});
