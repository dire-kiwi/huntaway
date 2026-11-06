import { Layers } from "lucide-react";
import { LABELS, type DocumentType, type TaskType } from "../../../api";
import type { TokenPrefix } from "../taskTokens";

/** What the new task dialog makes: code (null), a subproject or a scratch task. */
export type NewTaskType = TaskType | "subproject" | null;

/** The labels, which `/` names too: `/plan /diagram` gives a task both. */
export const LABEL_WORDS: string[] = LABELS;
export const isLabelWord = (w: string | undefined): w is DocumentType => LABEL_WORDS.includes(w ?? "");

/** "a plan and a diagram". */
export function labelList(labels: DocumentType[]) {
  const words = labels.map((l) => ({ plan: "a plan", artifact: "an artifact", diagram: "a diagram" })[l]);
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : (words[0] ?? "");
}

/** A subproject, which the new task dialog offers as a type of task in a project that uses worktrees (API 17). */
export const SUBPROJECT_TYPE = {
  id: "subproject" as const,
  label: "Subproject",
  icon: <Layers size={12} />,
  hint: "A task with its own worktree, thread and pull request, and a board of tasks that branch from its branch and merge back into it",
};

// The words `@` takes besides project keys: a group task, and a scratch task in no project. `!default` and `^default`
// leave the model and effort to the project, profile and host.
export const GROUP_WORD = "group";
export const NONE_WORD = "none";
export const DEFAULT_WORD = "default";

/** `/type` names a type by its id, and a task (code) as `task`. */
export const typeWord = (t: NewTaskType) => t ?? "task";

/** A value offered for a token as it's typed. */
export type Suggestion = { value: string; label: string; hint?: string };

/** The token prefixes, in the order the legend and the placeholder give them. */
export const TOKEN_HELP: { prefix: TokenPrefix; what: string; asks: string }[] = [
  { prefix: "/", what: "type or label", asks: "a type or label" },
  { prefix: "@", what: "where", asks: "where it goes" },
  { prefix: "!", what: "model", asks: "a model (or several, for a task each)" },
  { prefix: "^", what: "effort", asks: "effort" },
  { prefix: "#", what: "waits for", asks: "a task to wait for" },
  { prefix: "from:", what: "starts from", asks: "what its worktree starts from" },
];
