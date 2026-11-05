import { enc, type Http } from "./http";

export interface DiffResult {
  available: boolean;
  reason?: string;
  dir?: string;
  base?: string | null;
  merge_base?: string | null;
  commits?: string;
  stat?: string;
  patch?: string;
  untracked?: string[];
  /** Set when the task has no worktree (API 81): the diff is of the commits on this branch of its. */
  branch?: string;
}

/** A file with changes, as in `git status --short`: its index (`x`) and working tree (`y`) state (API 62). */
export interface GitFile {
  path: string;
  /** Where a renamed or copied file came from. */
  orig_path: string | null;
  /** `M`, `A`, `D`, `R`, `C`, `T`, a space for none, `?` for untracked, `U` (and `AA`, `DD`) for a conflict. */
  x: string;
  y: string;
}

export interface GitCommit {
  sha: string;
  subject: string;
  author: string;
  /** Unix seconds. */
  time: number;
  /** Made on the task's branch (after where it left its base), as opposed to before it. */
  on_branch: boolean;
  /** Not on the branch's upstream yet. */
  unpushed: boolean;
}

export interface GitStash {
  index: number;
  sha: string;
  subject: string;
  time: number;
}

/** The Changes tab's view of a task's repository (API 62). */
export interface GitStatus {
  available: boolean;
  reason?: string;
  /** The top of the working tree. */
  dir?: string;
  /** Where the project's folder is in it (`web/`) when it's only part of the repository: the files and commits are its own (API 77). */
  folder?: string | null;
  /** Null before the first commit. */
  head?: string | null;
  /** Null when detached. */
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  base?: string | null;
  merge_base?: string | null;
  /** What the repository is in the middle of: `merging`, `rebasing`, `cherry-picking` or `reverting`. */
  state?: string | null;
  files?: GitFile[];
  /** There were more files than were listed. */
  truncated?: boolean;
  commits?: GitCommit[];
  stashes?: GitStash[];
}

export interface GitCommitShown {
  sha: string;
  author: string;
  email: string;
  time: number;
  message: string;
  patch: string;
}

export const gitApi = ({ on }: Http) => ({
  diff: (h: string, id: string) => on(h).get<DiffResult>(`/tasks/${enc(id)}/diff`),
  /**
   * The Changes tab's git (API 62): the status, a file's unstaged or staged diff, and a commit's or stash's. A diff that
   * isn't UTF-8 comes as a `preview` with `not_utf8` and no `patch`, as lines patched from it would be written back wrong.
   */
  gitStatus: (h: string, id: string) => on(h).get<GitStatus>(`/tasks/${enc(id)}/git`),
  gitDiff: (h: string, id: string, path: string, q: { staged?: boolean; untracked?: boolean }) =>
    on(h).get<{ patch: string; too_large?: boolean; not_utf8?: boolean; preview?: string }>(`/tasks/${enc(id)}/git/diff?${new URLSearchParams({ path, staged: String(!!q.staged), untracked: String(!!q.untracked) })}`),
  gitShow: (h: string, id: string, rev: string) => on(h).get<GitCommitShown>(`/tasks/${enc(id)}/git/show?rev=${enc(rev)}`),
  gitShowStash: (h: string, id: string, sha: string) => on(h).get<{ patch: string }>(`/tasks/${enc(id)}/git/show?rev=${enc(sha)}&stash=true`),
  /** Stages or unstages the files as they are, or with no paths everything. */
  gitStage: (h: string, id: string, paths: string[]) => on(h).post(`/tasks/${enc(id)}/git/stage`, { paths }),
  gitUnstage: (h: string, id: string, paths: string[]) => on(h).post(`/tasks/${enc(id)}/git/unstage`, { paths }),
  /** Throws away the files' unstaged changes, or with `staged` all of them; untracked files are deleted. */
  gitDiscard: (h: string, id: string, paths: string[], staged: boolean) => on(h).post(`/tasks/${enc(id)}/git/discard`, { paths, staged }),
  /** Applies a patch of chosen lines (changes.ts linesPatch) to the index, or the working tree. */
  gitApply: (h: string, id: string, patch: string, b: { cached: boolean; reverse: boolean }) => on(h).post(`/tasks/${enc(id)}/git/apply`, { patch, ...b }),
  gitCommit: (h: string, id: string, b: { message: string; amend?: boolean; reword?: boolean }) => on(h).post<{ head: string }>(`/tasks/${enc(id)}/git/commit`, b),
  gitStash: (h: string, id: string, b: { action: "push"; mode: "all" | "staged" | "unstaged"; message: string } | { action: "apply" | "pop" | "drop"; index: number; sha: string }) =>
    on(h).post<{ output: string }>(`/tasks/${enc(id)}/git/stash`, b),
  gitReset: (h: string, id: string, rev: string, mode: "soft" | "mixed" | "hard") => on(h).post(`/tasks/${enc(id)}/git/reset`, { rev, mode }),
});
