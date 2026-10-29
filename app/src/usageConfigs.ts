import type { ClaudeConfig, Profile, Project } from "./api";

/**
 * The configs whose usage the sidebar shows for the profile named `profile`: those set to show it
 * that one of its profiles (on each host) uses, or one of their projects picks instead.
 */
export function usageConfigs(
  configs: ClaudeConfig[],
  profiles: Pick<Profile, "host_id" | "id" | "name" | "claude_config_ids">[],
  projects: Pick<Project, "host_id" | "profile_id" | "claude_config_ids">[],
  profile: string | undefined,
): ClaudeConfig[] {
  const used = new Set<string>();
  for (const p of profiles.filter((p) => p.name === profile)) {
    for (const id of p.claude_config_ids ?? []) used.add(`${p.host_id}:${id}`);
    for (const pr of projects.filter((pr) => pr.host_id === p.host_id && pr.profile_id === p.id)) {
      for (const id of pr.claude_config_ids ?? []) used.add(`${p.host_id}:${id}`);
    }
  }
  return configs.filter((c) => c.show_usage && used.has(`${c.host_id}:${c.id}`));
}
