// Port of server/src/review/merge_gate.rs.
/**
 * Merges that wait for the user's approval (API 92), for profiles and projects that ask for it (`merge_approval`). A
 * task moved to "Ready for merge" first has its agent summarise what it would merge, without merging, outside the
 * merge queue (see runner::start_next_merge). When that run ends, the board asks the user to approve or deny the merge
 * with a question card in the thread (a `question` message with `merge_approval`, kept with its answer). Approved, the
 * task rejoins the merge queue and its agent gets the merge prompt when its turn comes; denied, it goes back to "In
 * review". Until then, the gh server's merges (pr_merge, and `gh pr merge` or the merge API through its other tools) are
 * refused (see `blocked`, gh_mcp::merge_gate). A task's `merge_approval` is `pending` meanwhile, and `approved` after.
 */
import * as db from "../db.ts";
import type { Conn, Task } from "../db.ts";
import * as runner from "../agent/runner.ts";
import * as questions from "../mcp/questions.ts";
import { ApiError, type AppState } from "../state.ts";
import * as history from "../threads/history.ts";

export const PENDING = "pending";
export const APPROVED = "approved";

export const APPROVE = "Approve";
export const DENY = "Deny";

/** Whether `task`'s merges wait for the user's approval: its project's setting, or else its profile's. */
export function required(c: Conn, task: Task): boolean {
  const project = task.project_id != null ? db.get_project(c, task.project_id) : null;
  const on = project?.merge_approval;
  if (on != null) return on;
  return db.get_profile(c, task.profile_id)?.merge_approval ?? false;
}

export function is_pending(task: Task): boolean {
  return task.merge_approval === PENDING;
}

/**
 * A task waiting in the merge queue that has to be summarised and approved before it merges: one that joined the queue
 * (or whose project started asking) without its approval.
 */
export function needs_summary(c: Conn, task: Task): boolean {
  return task.merge_approval == null && required(c, task);
}

/**
 * Why `task`'s runs can't merge, if they can't: its merge is waiting for the user's approval, or its project asks for
 * approval and it isn't merging (a merge already under way when the setting was turned on carries on). A review thread
 * goes by its task.
 */
export function blocked(c: Conn, task: Task): string | null {
  if (task.kind === "review" && task.parent_id != null) {
    const parent = db.get_task(c, task.parent_id);
    if (!parent) return null;
    task = parent;
  }
  if (task.merge_approval === APPROVED) return null;
  if (task.merge_approval != null) {
    return (
      "Merging is disabled: the user hasn't approved this merge yet. Don't merge: summarize what will be merged and end your turn, " +
      "and the board asks the user to approve it. Once they do, you're asked to merge."
    );
  }
  if (!task.merging && required(c, task)) {
    return (
      "Merging is disabled: merges in this project need the user's approval, and it hasn't been given. The user approves a merge " +
      'after the task is moved to "Ready for merge" (with update_task, when you\'re asked to merge it) and its agent has summarized ' +
      "what will be merged."
    );
  }
  return null;
}

/** Ask `task`'s agent to summarise what its merge would bring in, without merging. */
export function request_summary(s: AppState, task: Task): Task {
  const project = task.project_id != null ? db.get_project(s.db(), task.project_id) : null;
  const base = db.task_base(s.db(), task, project);
  const into = base != null ? `\`${base}\`` : "the base branch";
  const what = task.branch != null ? `branch \`${task.branch}\` into ${into}` : `this task's work into ${into}`;
  const text =
    'The user moved this task to "Ready for merge", and approves each merge before it happens. Summarize what will be merged ' +
    `(${what}): what changes, what it fixes or adds, how it was checked, anything left out or still uncertain, and the pull ` +
    "request if it has one. If there's work the merge would include that isn't committed or pushed yet, commit and push it first, " +
    "so the summary covers what will be merged.\n\nDo not merge yet: merging is disabled until the user approves. End your turn " +
    "with the summary, and the board asks the user to approve or deny the merge. Once they approve it, you're asked to merge.";
  return runner.send_as(s, task.id, text, true);
}

/** The summary run ended: ask the user to approve the merge, with a card in the thread. */
export function ask(s: AppState, task_id: string): void {
  settle(s, task_id, "replaced");
  const card = {
    question: "Merge this task? Its agent summarized what will be merged above.",
    options: [
      { label: APPROVE, description: "Its agent merges it, once no other task in the project is merging" },
      { label: DENY, description: "It isn't merged, and goes back to In review" },
    ],
    multi_select: false,
    allow_other: false,
    merge_approval: true,
    status: "pending",
  };
  s.add_message(task_id, "question", card);
}

/**
 * Settle `task_id`'s approval cards still waiting for an answer, as `status`: the merge they asked about was left, or
 * a new card replaces them.
 */
export function settle(s: AppState, task_id: string, status: string): void {
  let pending: Array<{ id: number; data: string }>;
  try {
    pending = history.open_questions(s.db(), task_id).filter((q) => {
      try {
        return JSON.parse(q.data)?.merge_approval === true;
      } catch {
        return false;
      }
    });
  } catch {
    return;
  }
  for (const { id, data } of pending) {
    let v: any;
    try {
      v = JSON.parse(data);
    } catch {
      v = {};
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) v = {};
    v.status = status;
    let m: db.Message | null = null;
    try {
      m = db.update_pending_message(s.db(), id, v, task_id);
    } catch {}
    if (m) questions.emit(s, id, m);
  }
}

/**
 * The user's answer to an approval card: approved, the task rejoins the merge queue (and its agent is asked to merge
 * when its turn comes); denied, it goes back to "In review".
 */
export function decide(s: AppState, task_id: string, approve: boolean): Task {
  const st = { refused: null as ApiError | null };
  const still = (c: Conn): boolean => {
    const now = db.get_task(c, task_id);
    if (!now) st.refused = ApiError.not_found("task");
    else if (!is_pending(now) || !now.merging) st.refused = ApiError.conflict("the task isn't waiting for its merge to be approved any more");
    else if (now.running || db.has_active_run(c, task_id)) st.refused = ApiError.conflict("its agent is still running; approve the merge once it's done");
    else st.refused = null;
    return st.refused == null;
  };
  const fields: Array<[string, any]> = approve
    ? [
        ["merge_approval", APPROVED],
        ["status", "ready_for_merge"],
        ["attention_reason", null],
      ]
    : [
        ["merging", false],
        ["status", "in_review"],
        ["attention_reason", null],
      ];
  const updated = s.update_task_if(task_id, fields, still);
  if (st.refused) throw st.refused;
  if (!updated) throw ApiError.not_found("task");
  if (approve) s.add_event(task_id, "info", "Merge approved: it merges once no other task in the project is merging");
  else s.add_event(task_id, "info", "Merge denied: back in review");
  runner.start_next_merge(s, updated.project_id ?? null);
  return db.get_task(s.db(), task_id) ?? updated;
}
