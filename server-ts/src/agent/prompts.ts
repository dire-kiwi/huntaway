// Port of server/src/agent/prompts.rs.
/**
 * The prompts the board sends as a task moves across it: to its agent when it starts ("In progress"), to the reviewer
 * when its work is reviewed ("In review"), and to its agent when it's merged ("Ready for merge"). A project can replace
 * each prompt's instructions in its settings (agents can too, with the `update_project` tool). The board adds what it
 * relies on around them: the task and its branch, and how to report back (`submit_review`, setting the task to done),
 * so a project's own instructions can't break the workflow.
 */
import type { Project, Reviewer, Task } from "../db.ts";
import * as documents from "./documents.ts";

export const DEFAULT_START = "Start working on this task.";

export const DEFAULT_REVIEW =
  "Look for correctness problems: bugs, crashes, data loss, security holes, a broken build or " +
  "tests, and anything that doesn't do what the task asks. Read the surrounding code where you need to. If you have a code " +
  "review skill or command (such as /code-review), use it.";

export const DEFAULT_MERGE =
  "Commit any outstanding work, then merge its pull request if it has one (e.g. with the gh tools' pr_merge), " +
  "otherwise merge the branch directly. Follow the project's own merge instructions (e.g. in CLAUDE.md) and resolve any " +
  "conflicts.";

/** The project fields holding each prompt's instructions, and their defaults. */
export const FIELDS: Array<[string, string]> = [
  ["start_prompt", DEFAULT_START],
  ["review_prompt", DEFAULT_REVIEW],
  ["merge_prompt", DEFAULT_MERGE],
];

/** `GET /default-prompts`: the instructions a project without its own uses, by field. */
export function defaults(): Record<string, string> {
  return Object.fromEntries(FIELDS);
}

function pick(own: string | null | undefined, def: string): string {
  const s = own?.trim();
  return s ? s : def;
}

/** What a task's agent is told to do when it starts, after the task's title and description. */
export function start(project: Project | null | undefined): string {
  return pick(project?.start_prompt, DEFAULT_START);
}

/**
 * What `task`'s agent is told to do when it starts. A project's own instructions are for its code tasks, so a scratch
 * task, or one that makes only documents, gets the default.
 */
export function start_task(task: Task, project: Project | null | undefined): string {
  return start(task.task_type == null && !documents.documents_only(task) ? project : null);
}

/** What the reviewer looks for, after the task and where its changes are. */
export function review(project: Project | null | undefined): string {
  return pick(project?.review_prompt, DEFAULT_REVIEW);
}

/** What the reviewer `own` looks for: its own instructions if it has some, else the project's. */
export function review_by(project: Project | null | undefined, own: Reviewer): string {
  return pick(own.prompt, review(project));
}

/** How the agent merges, after which branch to merge into which. */
export function merge(project: Project | null | undefined): string {
  return pick(project?.merge_prompt, DEFAULT_MERGE);
}
