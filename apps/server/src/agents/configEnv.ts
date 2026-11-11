import type { AgentConfig } from "@huntaway/contracts"

// What a `claude` the board starts with an agent config gets (huntaway's db/profiles.ts `dir` and `api_env`): its
// config folder, and its proxy. Plain functions; the board's own model calls (`Titles`, `UsageWindow`) use them, as a
// run's launch does.

/** The config folder, with the agent's default for an empty one, `~` expanded against `home`. */
export const configDir = (config: Pick<AgentConfig, "config_dir" | "agent">, home: string): string => {
  const d = config.config_dir.trim()
  const dir = d === "" ? (config.agent === "codex" ? "~/.codex" : "~/.claude") : d
  return dir === "~" ? home : dir.startsWith("~/") ? `${home}${dir.slice(1)}` : dir
}

/** The proxy set on the config itself (`api_url`), which the board passes to its agents. */
const ownProxy = (config: Pick<AgentConfig, "api_url" | "agent">): string | null =>
  config.api_url !== null && config.agent !== "codex" && config.api_url.trim() !== "" ? config.api_url : null

/**
 * What a `claude` started with this config gets in its environment to go through its proxy: nothing without one.
 * ANTHROPIC_API_KEY is emptied, as Claude Code would send it to the proxy instead of the proxy's key were the server
 * started with one. `apiKey` is the config's key, revealed.
 */
export const apiEnv = (config: Pick<AgentConfig, "api_url" | "agent">, apiKey: string | null): ReadonlyArray<readonly [string, string]> => {
  const url = ownProxy(config)
  if (url === null) return []
  return [
    ["ANTHROPIC_BASE_URL", url.trim().replace(/\/+$/, "")],
    ["ANTHROPIC_AUTH_TOKEN", apiKey ?? ""],
    ["ANTHROPIC_API_KEY", ""],
  ]
}

/** The environment of a one-off `claude -p` with this config: its folder and its proxy. */
export const claudeCallEnv = (config: Pick<AgentConfig, "config_dir" | "agent" | "api_url">, apiKey: string | null, home: string): Record<string, string> =>
  Object.fromEntries([["CLAUDE_CONFIG_DIR", configDir(config, home)], ...apiEnv(config, apiKey)])
