import type { DocumentFile } from "../../prompts/documentGuide.ts"
import type { Github } from "../../prompts/codeTask.ts"
import { keyLetter } from "@huntaway/contracts"
import type { Profile, Project, Task, ThreadKind } from "@huntaway/contracts"

// The facts the prompt builders read (huntaway's agent/runner/prompt.ts system_prompt's arguments and `Told`), as one
// plain object, so the builders are tested without a layer. `Prompts` gathers it from the services; the fields that
// belong to later areas hold what the old code gave with that feature off until their plan task fills them.

/** The thread, as its agent is told of it. */
export type PromptTask = Pick<
  Task,
  | "id"
  | "kind"
  | "number"
  | "title"
  | "description"
  | "work_dir"
  | "parent_id"
  | "group_name"
  | "worktree_path"
  | "branch"
  | "base_branch"
  | "start_from"
  | "merges_into"
  | "github_stack"
  | "external_links"
  | "session_id"
>

export type PromptProject = Pick<Project, "id" | "name" | "key" | "repo_path" | "base_branch" | "pull_requests" | "start_prompt">

export interface PromptContext {
  readonly task: PromptTask
  readonly project: PromptProject | null
  /** A thread under a task: the task, with its worktree when that is ready (`worktree_state`). */
  readonly parent: (Pick<Task, "number" | "title" | "worktree_path" | "branch"> & { readonly worktree_ready: boolean }) | null
  /** A group task's group's projects (not archived). */
  readonly group: ReadonlyArray<Pick<Project, "id" | "name" | "key" | "repo_path">>
  /** The documents its labels ask for, by label, in the task's own folder. Empty for a thread that is not a task. */
  readonly docs: ReadonlyArray<DocumentFile>
  /** The task it merges into (`merges_into`), while that one is not done. */
  readonly target: { readonly number: number; readonly title: string; readonly branch: string | null } | null
  /** It runs on Codex rather than Claude Code. */
  readonly codex: boolean
  /** It is in plan mode, which a Codex run is told (Claude Code tells Claude itself). */
  readonly plan: boolean
  /** The run's own profile, and every profile on the host. */
  readonly profile: Pick<Profile, "id" | "name">
  readonly profiles: ReadonlyArray<Pick<Profile, "id" | "name" | "agent_access">>
  /** The GitHub account its gh tools act as: the project's, or else its profile's. */
  readonly githubAccount: string | null
  /** For a pen's own thread, its pen as it is now (`penBrief`); "" for any other. */
  readonly pen: string
  /** Where a task with its own branch opens its pull request, if its repository is on GitHub. null until plan task 4.4 (`Gh`) reads the remotes. */
  readonly github: Github | null
  /** It has the board's gh server. false until plan task 4.4 adds the server (and 6.4 the project's switch for it). */
  readonly ghTools: boolean
  /** The project's workflow opens the pull request once the work is done. false until plan task 6.6 (`WorkflowEngine`). */
  readonly boardPr: boolean
  /** The workflow's In progress text, in place of the start prompt. null until plan task 6.6. */
  readonly workflowStart: string | null
  /** It has the board's docs server (6.3). */
  readonly docsTools: boolean
  /** It has the desktop server: the host's name, whose desktop it is (6.10). */
  readonly desktopHost: string | null
  /** Its temp folder, its `$TMPDIR`. null until plan task 2.8 (`TaskTmp`). */
  readonly tmp: string | null
  /** For the assistant and its routines, its memory as its files say now, last. "" until plan task 6.7 (`Memory`). */
  readonly memory: string
}

/**
 * What goes before a thread's number in the key its prompts give it (huntaway's agent/runner/prompt.ts key_prefix): its
 * project's key, else `G` for a task of a group (a document task made in a group too, which `keyLetter` takes for `T`),
 * else the letter for its kind.
 */
export const keyPrefix = (kind: ThreadKind, task: Pick<Task, "group_name">, project: Pick<Project, "key"> | null): string =>
  project === null && task.group_name !== null ? "G" : keyLetter(kind, project?.key ?? null)
