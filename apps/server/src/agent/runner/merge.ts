// Port of server/src/agent/runner/merge.rs: the merge queue: tasks moved to "Ready for merge" merge one at a time (see
// `request_merge`).
import * as db from "../../db.ts";
import type { Project, Task } from "../../db.ts";
import type { Shared } from "../../state.ts";
import { err_str } from "../../util.ts";
import * as runs from "../runs.ts";
import * as prompts from "../prompts.ts";
import * as merge_gate from "../../review/merge_gate.ts";
import { key_prefix } from "./prompt.ts";
import { clone } from "../runner.ts";
import { send_as } from "./send.ts";

/**
 * Other tasks wait to merge while this one does, so a merge that turns out to need changes steps out of the queue to
 * make them (see Task::remerge).
 */
const STEP_OUT =
  "Tasks queued to merge after this one wait while you merge it. Bringing the branch up to date, resolving " +
  "simple conflicts, waiting for checks and re-running flaky ones are part of merging. But if the merge needs changes to this task's " +
  "work (checks that fail because of it, review comments to address, conflicts that need more than a simple resolution), step out of " +
  "the merge queue first so the next task can merge meanwhile: call `update_task` to set this task's status to `in_progress`, with " +
  "`remerge` true. Then make the changes, check them, commit and push, and end your turn without merging: the board puts the task " +
  "back at the end of the merge queue and asks you to merge again when its turn comes.";

/** Why a task whose merge waits for the user's approval needs attention. */
export const APPROVAL = "Approve or deny the merge";

/**
 * Ask the agent on a task that was moved to "Ready for merge" to merge its work. The task stays in that column while it
 * does; the agent moves it to "Done" once merged.
 */
export function request_merge(state: Shared, task: Task): Task {
  const c = state.db();
  const project = task.project_id != null ? db.get_project(c, task.project_id) : null;
  const open = task.subproject ? db.subproject_tasks(c, task.id).filter((t) => t.status !== "done" && !db.is_scratch(t)) : [];
  const base = db.task_base(state.db(), task, project);
  const stacked = stacked_merge(state, task, project, base);
  const into = base != null ? `\`${base}\`` : "the base branch";
  const what = task.branch != null ? `Merge branch \`${task.branch}\` into ${into}` : `Merge this task's work into ${into}`;
  const approved = task.merge_approval === merge_gate.APPROVED ? " The user approved the merge." : "";
  let text =
    `The user moved this task to "Ready for merge".${approved} ${what}.${stacked}\n\n${prompts.merge(project)}\n\nIf you can't merge, call \`request_user_input\` ` +
    `explaining why. Once it is merged, call \`update_task\` to set this task's status to \`done\`.\n\n${STEP_OUT}`;
  if (task.subproject) {
    const key = project?.key ?? "T";
    text +=
      " This is a subproject: its tasks were merged into its branch, so bring the branch up to date first (pull it if it's on the remote, where their pull requests were merged).";
    if (open.length) {
      const list = open.map((t) => `${key}-${t.number} (${t.title}, ${t.status.replaceAll("_", " ")})`);
      text += ` Some of its tasks aren't done yet: ${list.join("; ")}. Ask the user (with \`request_user_input\`) whether to merge without them before you merge.`;
    }
  }
  return send_as(state, task.id, text, true);
}

/**
 * What a merge request says of a task stacked on another task's or a pull request's branch (see db::StartFrom), and
 * where it merges: into that branch while the other is open, as stacked pull requests do, and once the task it's
 * stacked on is merged, into where that went instead (`base`, see db::task_base), as GitHub retargets a pull request
 * whose base branch is deleted.
 */
export function stacked_merge(state: Shared, task: Task, project: Project | null | undefined, base: string | null): string {
  const b = task.base_branch;
  if (b == null || task.branch == null) return "";
  const key = key_prefix(task, project);
  const sf = task.start_from;
  if (sf?.type === "task") {
    const other = db.get_task(state.db(), sf.task_id);
    if (!other || other.branch !== b) return "";
    const them = `${key}-${other.number}`;
    if (db.is_merged(other)) {
      const shown = base != null ? `\`${base}\`` : "its base branch";
      return (
        ` This task is stacked on ${them}, which is merged already, so merge it into ${shown} instead of ${them}'s branch \`${b}\`: ` +
        `if its pull request still targets \`${b}\`, change its base to ${shown} first, and bring the branch up to date with ` +
        `${shown} (rebasing it onto ${shown} without ${them}'s commits if they were squashed or rebased).`
      );
    }
    return (
      ` This task is stacked on ${them} ("${other.title}", ${other.status.replaceAll("_", " ")}), which isn't merged yet: merging it puts its work on ${them}'s branch ` +
      `\`${b}\`, to reach the project's base branch when ${them} is merged.`
    );
  }
  if (sf?.type === "pull_request") {
    return (
      ` This task started from pull request #${sf.number}'s branch \`${b}\`. If that pull request is merged by now, merge this one ` +
      `into where it went instead, changing this task's pull request's base first and bringing its branch up to date.`
    );
  }
  return "";
}

/**
 * The task as its agent is told of it: one stacked on a task that's merged by now (see db::task_base) is told it
 * merges, and opens its pull request, where that one went.
 */
export function as_told(state: Shared, task: Task, project: Project | null | undefined): Task {
  const t: Task = clone(task);
  if (t.start_from?.type === "task" && t.branch != null) {
    const base = db.task_base(state.db(), task, project);
    if (base !== t.base_branch) {
      t.base_branch = base;
      t.start_from = null;
    }
  }
  return t;
}

/**
 * Merges run one at a time per branch they merge into: the project's top-level tasks share one slot, and each
 * subproject's tasks share another. A task moved to "Ready for merge" waits there, in column order, while another task
 * in its slot is merging (running, or waiting on the user in "Needs attention"). Call this whenever a merge may have
 * ended or been queued: it asks the next waiting task's agent to merge wherever a slot in the project is free. A task
 * whose merge needs the user's approval first has its agent summarise it straight away, without waiting for the slot,
 * and waits for the approval out of the queue (see review/merge_gate.rs). (Synchronous, so two calls can't both take
 * a project's slot: Rust's MERGE_SLOT.)
 */
export function start_next_merge(state: Shared, project_id: string | null) {
  if (!runs.can_run_agents(state)) return;
  let lanes: Array<string | null>;
  try {
    lanes = db.merge_lanes(state.db(), project_id);
  } catch (e) {
    console.error(`checking the merge queue: ${err_str(e)}`);
    return;
  }
  for (const lane of lanes) {
    // The tasks to summarise for approval, and the next to merge if the slot is free.
    let summarise: Task[] = [];
    let next: Task | null = null;
    try {
      const c = state.db();
      const free = db.active_merge(c, project_id, lane) == null;
      for (const t of db.queued_merges(c, project_id, lane)) {
        if (merge_gate.needs_summary(c, t)) summarise.push(t);
        else if (free && next == null) next = t;
      }
    } catch (e) {
      console.error(`checking the merge queue: ${err_str(e)}`);
      continue;
    }
    for (const t of summarise) {
      // Out of the queue until the user decides (see db::queued_merges).
      try {
        state.update_task(t.id, [["merge_approval", merge_gate.PENDING]]);
      } catch (e) {
        console.error(`task ${t.id}: asking for a merge's approval: ${err_str(e)}`);
        continue;
      }
      state.add_event(t.id, "info", "The merge waits for your approval: its agent summarizes what will be merged first");
      try {
        merge_gate.request_summary(state, t);
      } catch (e) {
        const reason = `Couldn't ask for a summary of the merge: ${err_str(e)}`;
        state.add_event(t.id, "error", reason);
        try {
          state.update_task(t.id, [["status", "needs_attention"], ["attention_reason", reason]]);
        } catch {}
      }
    }
    if (!next) continue;
    try {
      request_merge(state, next);
    } catch (e) {
      // Stays merging, so the queue waits for the user to sort it out.
      const reason = `Couldn't start the merge: ${err_str(e)}`;
      state.add_event(next.id, "error", reason);
      try {
        state.update_task(next.id, [["status", "needs_attention"], ["attention_reason", reason]]);
      } catch {}
    }
  }
}

/** Start the merges that were waiting when the server stopped. */
export function start_queued_merges(state: Shared) {
  let projects: Array<string | null>;
  try {
    projects = db.projects_with_queued_merges(state.db());
  } catch (e) {
    console.error(`checking the merge queue: ${err_str(e)}`);
    return;
  }
  for (const p of projects) start_next_merge(state, p);
}
