import { enc, type Http } from "./http";
import type { Reviewer } from "./projects";
import type { ExternalLink } from "./tasks";

/** Profiles choose reviewers and a summarizer for their projects that don't choose their own. */
export const PROFILE_REVIEWERS_API = 87;
/** Hosts from here on can have several summarizers, with skills and prompts of their own. */
export const MULTI_SUMMARIZER_API = 103;

export interface Profile {
  /** Set by the UI from the host it was loaded from. */
  host_id: string;
  id: string;
  name: string;
  /** The Claude configs its threads can use, the default first (API 20). */
  claude_config_ids?: string[];
  /** The default config's directory (before API 20, the profile's only one). */
  claude_config_dir: string;
  default_model: string | null;
  /** Other profiles (by name, `*` for all) whose agents may use this profile's board through their board tools (API 23). */
  agent_access?: string[];
  /** The GitHub account its agents' gh tools act as on this host: a login, or `HOST/LOGIN`; null is gh's active account (API 50). */
  github_account?: string | null;
  /** The folder the new project dialog's GitHub tab clones repositories into on this host; null is `~/<name>` (API 55). */
  clone_dir?: string | null;
  /** Who its Asana token is for, when it's connected to Asana on this host (API 57). Set with `asana_token`, which is never sent back. */
  asana_user?: string | null;
  /** Whether it uses Asana (API 60; missing is on): off, the board leaves Asana out and the host won't search it. The token is kept. */
  asana_enabled?: boolean;
  /** A task whose config runs out of usage waits for the limit to reset and then carries on (API 81). */
  limit_wait?: boolean;
  /** A task that hasn't started yet starts on the next of its configs with room when its own is out of usage (API 81). */
  limit_switch?: boolean;
  /** Who reviews the tasks of its projects with no reviewers of their own; empty is one reviewer with the task's config (API 87). */
  reviewers?: Reviewer[];
  /** Who summarises them, for its projects with no summarizer of their own; null is the task's config with the defaults (API 87). */
  summarizer?: Reviewer | null;
  /** Who summarises them, each in a thread of its own, for its projects with no summarizers of their own; empty is one with the task's config (API 103). */
  summarizers?: Reviewer[];
  /** A task moved to Ready for merge has its agent summarise what it would merge, and merges once you approve (API 92). */
  merge_approval?: boolean;
  /** A task needs an approving review on its pull request on GitHub to go to Ready for merge (API 95). */
  require_pr_approval?: boolean;
  /** The linked host its assistant runs on (API 111, a host id); null for this host. See assistantHome. */
  assistant_host?: string | null;
  created_at: string;
}

/** An Asana task, as a profile's Asana search finds it (API 57). */
export interface AsanaTask {
  gid: string;
  name: string;
  url: string;
  completed: boolean;
  /** Its description, as plain text. */
  notes: string;
  assignee: string | null;
  projects: string[];
  workspace: string | null;
}

export const asanaLink = (t: AsanaTask): ExternalLink => ({ provider: "asana", id: t.gid, url: t.url, title: t.name });

export const profilesApi = ({ on }: Http) => ({
  profiles: (h: string) => on(h).get<Profile[]>("/profiles"),
  /** `claude_config_dir` instead of `claude_config_ids` uses (or creates) the config with that directory. */
  createProfile: (
    h: string,
    b: {
      name: string;
      claude_config_ids?: string[];
      claude_config_dir?: string;
      default_model?: string | null;
      agent_access?: string[];
      github_account?: string | null;
      clone_dir?: string | null;
      asana_enabled?: boolean;
      limit_wait?: boolean;
      limit_switch?: boolean;
      reviewers?: Reviewer[];
      summarizer?: Reviewer | null;
      summarizers?: Reviewer[];
      merge_approval?: boolean;
      require_pr_approval?: boolean;
      assistant_host?: string | null;
    },
  ) =>
    on(h).post<Profile>("/profiles", b),
  /** `asana_token` (API 57) is checked with Asana; null disconnects it. */
  updateProfile: (h: string, id: string, b: Partial<Profile> & { asana_token?: string | null }) => on(h).patch<Profile>(`/profiles/${enc(id)}`, b),
  /** The Asana tasks the profile's token finds for `q` (words, or a task's URL), open ones first (API 57). */
  asanaTasks: (h: string, profileId: string, q: string) => on(h).get<AsanaTask[]>(`/profiles/${enc(profileId)}/asana/tasks?q=${encodeURIComponent(q)}`),
  deleteProfile: (h: string, id: string) => on(h).del(`/profiles/${enc(id)}`),
});
