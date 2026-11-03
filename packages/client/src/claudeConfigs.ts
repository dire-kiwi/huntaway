import { enc, type Http } from "./http";

/** A Claude Code config directory (login, settings, history) on a host (API 20). Profiles and projects pick from them. */
export interface ClaudeConfig {
  /** Set by the UI from the host it was loaded from. */
  host_id: string;
  id: string;
  name: string;
  /** Passed as CLAUDE_CONFIG_DIR (CODEX_HOME for Codex); blank is the agent's default (~/.claude, ~/.codex). */
  config_dir: string;
  /** Which agent CLI runs its threads (API 25); older hosts only run Claude Code. */
  agent?: Agent;
  /** Whether the host fetches its plan's usage limits for the sidebar (API 52). Older hosts fetch every config's. */
  show_usage?: boolean;
  /** Whether the host starts its plan's next 5-hour window as soon as one ends (API 91). */
  restart_window?: boolean;
  created_at: string;
}

export const AGENTS = [
  { id: "claude", label: "Claude Code", dir: "~/.claude", env: "CLAUDE_CONFIG_DIR" },
  { id: "codex", label: "Codex", dir: "~/.codex", env: "CODEX_HOME" },
] as const;

export type Agent = (typeof AGENTS)[number]["id"];

export const agentOf = (c: Pick<ClaudeConfig, "agent"> | undefined): Agent => c?.agent ?? "claude";

export const agentInfo = (a: Agent) => AGENTS.find((x) => x.id === a)!;

/** A model a Codex config offers (API 25). */
export interface AgentModel {
  id: string;
  name: string;
  is_default: boolean;
  efforts: string[];
  default_effort: string | null;
}

/** One of a profile's Claude plan limits (API 9). */
export interface UsageLimit {
  /** `session`, `weekly`, or `weekly:<model>`. */
  id: string;
  label: string;
  /** 0–100, how much of the limit is used. */
  percent: number;
  resets_at: string | null;
}

/** A Claude login's subscription usage (API 9): per Claude config from API 20, per profile before. */
export interface Usage {
  /** Set by the UI from the host it was loaded from. */
  host_id: string;
  config_id?: string;
  profile_id?: string;
  limits: UsageLimit[];
  plan: string | null;
  updated_at: string | null;
  /** Why the last check failed; `limits` may still hold older numbers. */
  error: string | null;
  /** Until when it's out of usage: a run on it was refused for its limit, which resets then (API 81). */
  out_until?: string | null;
}

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type Effort = (typeof EFFORTS)[number];

export const MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"];

export const claudeConfigsApi = ({ on }: Http) => ({
  claudeConfigs: (h: string) => on(h).get<Omit<ClaudeConfig, "host_id">[]>("/claude-configs"),
  /** `agent` needs API 25. */
  createClaudeConfig: (h: string, b: { name: string; config_dir: string; agent?: Agent }) => on(h).post<ClaudeConfig>("/claude-configs", b),
  updateClaudeConfig: (h: string, id: string, b: { name?: string; config_dir?: string; agent?: Agent; show_usage?: boolean; restart_window?: boolean }) =>
    on(h).patch<ClaudeConfig>(`/claude-configs/${enc(id)}`, b),
  /** The models a Codex config offers (API 25); empty for Claude configs. */
  claudeConfigModels: (h: string, id: string) => on(h).get<AgentModel[]>(`/claude-configs/${enc(id)}/models`),
  deleteClaudeConfig: (h: string, id: string) => on(h).del(`/claude-configs/${enc(id)}`),
  /** Claude usage for every Claude config (API 20; every profile before) on the host (API 9). */
  usage: (h: string, refresh = false) => on(h).get<Omit<Usage, "host_id">[]>(`/usage${refresh ? "?refresh=true" : ""}`),
});
