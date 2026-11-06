// Port of server/src/db/tasks.rs: tasks: the `Task` row, and queries over tasks, their dependencies and merges.
import { ApiError } from "../http.ts";
import { ASSISTANT, ROUTINE, SCRATCH, all, get_setting, hidden, json_list, json_to_sql, one, run, tx, value, type Conn } from "../db.ts";
import { err_str, new_id, now } from "../util.ts";
import { available_configs } from "./profiles.ts";
import { get_project, list_projects, type Project } from "./projects.ts";
import {
  AgentWait_from_json,
  Context_from_json,
  ExternalLink_from_json,
  PrChecks_from_json,
  Review_from_json,
  StartFrom_from_json,
  Steer_from_json,
  json_opt,
  json_vec,
  summaries_column,
  type AgentWait,
  type ChangeSummary,
  type Context,
  type ExternalLink,
  type PrChecks,
  type Review,
  type StartFrom,
  type Steer,
} from "./task_data.ts";

/** The key scratch tasks' numbers go with (see is_scratch), which no project can have. */
export const SCRATCH_TASK_KEY = "S";
/** The key a profile's assistant's number goes with (see is_assistant), which no project can have. */
export const ASSISTANT_TASK_KEY = "A";

/** Rust's `eq_ignore_ascii_case`. */
const ascii_lower = (s: string) => s.replace(/[A-Z]/g, (ch) => ch.toLowerCase());

/** Gives each project with the key G (which group tasks' keys use, see runner::GROUP_TASK_KEY) the first of GP, GP2, GP3, … free in its profile. */
export function free_group_task_key(c: Conn): void {
  free_task_key(c, "G", "GP");
}

/**
 * Gives each project with the key `key` (which tasks in no project use) the first of `instead`, `instead`2, `instead`3,
 * … free in its profile: no project has it, now or before (a key a project had still names its tasks, see
 * Project.former_keys).
 */
export function free_task_key(c: Conn, key: string, instead: string): void {
  const clashing = all<{ id: string; profile_id: string }>(c, "SELECT id, profile_id FROM projects WHERE UPPER(TRIM(key))=?1", key);
  // Databases from before version 40 have no former keys.
  let former = true;
  try {
    c.prepare("SELECT former_keys FROM projects LIMIT 0");
  } catch {
    former = false;
  }
  for (const { id, profile_id } of clashing) {
    const taken = (k: string): boolean => {
      if (Number(value(c, "SELECT COUNT(*) FROM projects WHERE profile_id=?1 AND UPPER(key)=?2", profile_id, k)) > 0) return true;
      if (!former) return false;
      const lists = all(c, "SELECT former_keys FROM projects WHERE profile_id=?1 AND id!=?2", profile_id, id).map((r) => r.former_keys as string);
      return lists.some((l) => json_list(l).some((f) => ascii_lower(f) === ascii_lower(k)));
    };
    let n = 1;
    let k: string;
    for (;;) {
      k = n === 1 ? instead : `${instead}${n}`;
      if (!taken(k)) break;
      n++;
    }
    run(c, "UPDATE projects SET key=?2 WHERE id=?1", id, k);
  }
}

/**
 * Dependencies are between tasks in one project, so a task without one (a group task) has none; drops any it was given
 * before that was checked, and the queue they held it in.
 */
export function clear_projectless_dependencies(c: Conn): void {
  run(c, "UPDATE tasks SET depends_on='[]', waiting=0 WHERE project_id IS NULL AND (depends_on!='[]' OR waiting=1)");
}

export interface Task {
  id: string;
  profile_id: string;
  project_id: string | null;
  /** task, or review (a review thread; `parent_id` is the task it reviews). Scratch chats were `scratch` before they became scratch tasks. */
  kind: string;
  /** For a review thread, the task it reviews. For a task, the subproject it belongs to. */
  parent_id: string | null;
  /**
   * A subproject: a task with its own board of tasks, which branch from its branch and are merged back into it (see
   * worktree::setup). Only top-level tasks can be subprojects.
   */
  subproject: boolean;
  /**
   * A group task: one without a project that plans the work of a group's projects (those in its profile with this group
   * name) and creates their tasks. It shows on the group's board. Kept when the group is renamed (see rename_group_tasks).
   */
  group_name: string | null;
  /** The task whose agent created this one (with the `create_task` tool), if any. */
  created_by: string | null;
  /** What a task is, if not a code task: one of TASK_TYPES (a scratch task, see is_scratch). */
  task_type: string | null;
  /**
   * Some of LABELS: the documents its agent writes (an HTML plan or artifact, or a Mermaid diagram) besides its other
   * work, which the board keeps and shows (see agent/documents.rs).
   */
  labels: string[];
  /**
   * Where the task's agent works, if not where its kind and project say: for a scratch task made from a scratch chat,
   * the chat's folder, where its conversation is; for a task made as a plan, artifact or diagram before they were labels,
   * its own folder (relative, in the data dir; see documents::work_dir). Other scratch tasks work in their own folder too.
   */
  work_dir: string | null;
  /** When one of its documents last changed, so clients know to fetch them again. */
  document_at: string | null;
  number: number;
  title: string;
  /**
   * The title was renamed (with `update_task`), so it stays as it is. Otherwise each prompt the user sends re-titles the
   * task for what it's about by then (see title::refresh).
   */
  title_pinned: boolean;
  description: string;
  status: string;
  /** How the task ended (see RESOLUTIONS), set while it's done and only then. */
  resolution: string | null;
  /**
   * When it moved into Done, set while it's done and only then. The board archives a task that's been done for two
   * days: it leaves the kanban board for the list's Archived section.
   */
  done_at: string | null;
  position: number;
  use_worktree: boolean;
  worktree_path: string | null;
  branch: string | null;
  base_branch: string | null;
  /**
   * What its worktree starts from, when it isn't the project's base branch (API 96): picked before the worktree is
   * made, which sets `base_branch` from it (see worktree::setup).
   */
  start_from: StartFrom | null;
  worktree_state: string;
  worktree_error: string | null;
  session_id: string | null;
  running: boolean;
  /** When the agent started working, if it ever has. A queued message that carries on a run keeps the time (see runner::start). */
  run_started_at: string | null;
  /**
   * Moved to "Ready for merge" and not merged yet: the agent's work returns the task to that column, not "In progress".
   * Not running and still in that column means it's queued behind another merge in its project (see
   * runner::start_next_merge).
   */
  merging: boolean;
  /**
   * Its agent stepped out of the merge queue while merging it, to fix what the merge turned up (failing checks, review
   * comments) without holding up the tasks queued behind it. It works in "In progress" meanwhile, and rejoins the back
   * of the queue when its run ends, rather than going to "In review" (see runner::finish). Moving it to another column
   * (bar "Needs attention") drops it.
   */
  remerge: boolean;
  /**
   * Where its merge is with the user's approval, when its project asks for it (see review/merge_gate.rs): `pending`
   * while its agent summarises what it would merge and the user decides, `approved` once they have. Cleared when it
   * leaves the merge.
   */
  merge_approval: string | null;
  attention_reason: string | null;
  /** Tasks in the same project that have to be merged (done, resolution `done`) before this task's agent starts. */
  depends_on: string[];
  /**
   * In "In progress", queued: its agent was asked to start while some of `depends_on` weren't merged yet, and starts
   * once they are (see runner::start_unblocked).
   */
  waiting: boolean;
  /**
   * When the usage limit its agent last ran out of resets (UTC, RFC 3339), set as the run stops and cleared when the
   * next starts. With `waiting`, the agent carries on then (see agent/usage.rs); without, the task needs attention and
   * offers to.
   */
  limit_reset_at: string | null;
  /**
   * Its agent is waiting (in the `wait` tool) rather than working, while its run goes on and the task stays in its
   * column. Not to be confused with `waiting` (see mcp/wait.rs).
   */
  agent_wait: AgentWait | null;
  /** Sent while the agent was running; becomes the next prompt once the run ends (see runner::send). */
  queued_message: string | null;
  /**
   * The parts of `queued_message` the user sent (not other agents), for re-titling the task (see title::refresh).
   * `skip_serializing`: non-enumerable.
   */
  queued_user_text: string | null;
  /** Sent to the running agent, which hasn't taken them in yet (see runner::steer). */
  steering: Steer[];
  /** While it runs: its run takes messages while it works (see runner::can_steer), rather than queueing them for when it ends. */
  steerable: boolean;
  model: string | null;
  /** Overrides the host's default effort when set. */
  effort: string | null;
  /** Overrides the project's permission mode when set. */
  permission_mode: string | null;
  /** The Claude config it runs with, picked when it's created. Unset (or deleted since) means its project's or profile's default. */
  claude_config_id: string | null;
  auto_allow: string[];
  /** Where the task's work can be tried, e.g. its PR's preview deployment. */
  preview_url: string | null;
  /** The task's pull request. */
  pr_url: string | null;
  /** How its pull request's checks stood when the board last read them (see pr_watch::record_checks). */
  pr_checks: PrChecks | null;
  /** The tasks elsewhere (in Asana) that this one is for. */
  external_links: ExternalLink[];
  /**
   * Shared by the tasks made together from one prompt, each run by another agent (a model or config), so the board can
   * show them side by side. Unset for a task made on its own.
   */
  fanout_id: string | null;
  /** Starred: listed in the sidebar's Starred section. */
  starred: boolean;
  /**
   * When to remind the user of the task (UTC, RFC 3339): it's listed in the sidebar's Reminders section, and shows as
   * due from then on until the reminder is cleared.
   */
  remind_at: string | null;
  /** What the reminder is for, set with it. */
  reminder: string | null;
  /**
   * When the task went into "now" (UTC, RFC 3339), which the board's Now view lists; unset for the tasks in "later" (all
   * of them to begin with). It's set when the user prompts the task or moves it there, and a task with no activity for
   * the host's `now_expiry_hours` goes back (see agent/focus.rs).
   */
  now_at: string | null;
  /** The latest automatic review of the task's work. */
  review: Review | null;
  /** The first of its `summaries`, for clients from before there could be several (API 84). */
  summary: ChangeSummary | null;
  /**
   * The latest summaries of its changes, one from each summarizer, written once its review passed (API 103, see
   * review/summary.rs).
   */
  summaries: ChangeSummary[];
  /** How full its agent's context window is, as of its latest reply (see agent/context.rs). */
  context: Context | null;
  /**
   * Its thread is kept as items as well as messages (API 119: its first message was written with the host's Keep threads
   * as items setting on, see threads/write.ts), so the thread view can draw it from `/tasks/{id}/thread`.
   */
  thread_items: boolean;
  /**
   * Where its thread is written (API 122, threads/source.ts): `items`, its items are the source and no messages are
   * written for it; `messages`, its messages are (and its items too, if `thread_items`).
   */
  thread_source: "messages" | "items";
  /** The conversation rollback its next run makes, after a rewind (a checkpoints::Rewind); left out when there's none. */
  rewind?: any;
  cost_usd: number;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * A scratch task: in no project, its agent works in the task's own folder with no repository, for whatever the user
 * asks of it (planning, questions, running the board).
 */
export function is_scratch(t: Task): boolean {
  return t.kind === "task" && t.task_type === SCRATCH;
}

/**
 * A profile's assistant: its one long-lived thread in no project (see agent/assistant.ts), which works in a folder of its
 * own and never goes to review or merge.
 */
export function is_assistant(t: Task): boolean {
  return t.kind === "task" && t.task_type === ASSISTANT;
}

/**
 * A routine's run of a profile's assistant: a thread of its own under the assistant (`parent_id`), in the assistant's
 * workspace with its tools, whose last message the board posts to the assistant as a report (see
 * integrations/automations/routines.ts). Off the board.
 */
export function is_routine(t: Task): boolean {
  return t.kind === "task" && t.task_type === ROUTINE;
}

/**
 * The assistant or one of its routine threads: they work in the assistant's workspace, with its profile's tools, are
 * keyed `A-<n>`, never go to review or merge, and only their own profile's agents reach them.
 */
export function is_assistants(t: Task): boolean {
  return is_assistant(t) || is_routine(t);
}

/** The column a task sits in while its agent works. */
export function working_status(t: Task): "ready_for_merge" | "in_progress" {
  return t.merging ? "ready_for_merge" : "in_progress";
}

/** Reads a stored rewind (a checkpoints::Rewind: turn, message_id, session, and resume_at or before_turn if set). */
function rewind_column(v: string | null | undefined): any {
  return json_opt(v, (x: any) => {
    if (x === null || typeof x !== "object" || Array.isArray(x)) throw new Error("invalid type: expected struct Rewind");
    if (!Number.isInteger(x.turn) || !Number.isInteger(x.message_id) || typeof x.session !== "string") throw new Error("invalid Rewind");
    const o: any = { turn: x.turn, message_id: x.message_id, session: x.session };
    if (x.resume_at != null) {
      if (typeof x.resume_at !== "string") throw new Error("invalid Rewind");
      o.resume_at = x.resume_at;
    }
    if (x.before_turn != null) {
      if (typeof x.before_turn !== "string") throw new Error("invalid Rewind");
      o.before_turn = x.before_turn;
    }
    return o;
  });
}

export function Task_from_row(r: any): Task {
  const summaries = summaries_column(r.summary);
  const t: any = {
    id: r.id,
    profile_id: r.profile_id,
    project_id: r.project_id ?? null,
    kind: r.kind,
    parent_id: r.parent_id ?? null,
    subproject: !!r.subproject,
    group_name: r.group_name ?? null,
    created_by: r.created_by ?? null,
    task_type: r.task_type ?? null,
    labels: json_list(r.labels),
    work_dir: r.work_dir ?? null,
    document_at: r.document_at ?? null,
    number: r.number,
    title: r.title,
    title_pinned: !!r.title_pinned,
    description: r.description,
    status: r.status,
    resolution: r.resolution ?? null,
    done_at: r.done_at ?? null,
    position: r.position,
    use_worktree: !!r.use_worktree,
    worktree_path: r.worktree_path ?? null,
    branch: r.branch ?? null,
    base_branch: r.base_branch ?? null,
    start_from: json_opt(r.start_from, StartFrom_from_json),
    worktree_state: r.worktree_state,
    worktree_error: r.worktree_error ?? null,
    session_id: r.session_id ?? null,
    running: !!r.running,
    run_started_at: r.run_started_at ?? null,
    merging: !!r.merging,
    remerge: !!r.remerge,
    merge_approval: r.merge_approval ?? null,
    attention_reason: r.attention_reason ?? null,
    depends_on: json_list(r.depends_on),
    waiting: !!r.waiting,
    limit_reset_at: r.limit_reset_at ?? null,
    agent_wait: json_opt(r.agent_wait, AgentWait_from_json),
    queued_message: r.queued_message ?? null,
  };
  hidden(t, "queued_user_text", r.queued_user_text ?? null);
  Object.assign(t, {
    steering: json_vec(r.steering, Steer_from_json),
    steerable: !!r.steerable,
    model: r.model ?? null,
    effort: r.effort ?? null,
    permission_mode: r.permission_mode ?? null,
    claude_config_id: r.claude_config_id ?? null,
    auto_allow: json_list(r.auto_allow),
    preview_url: r.preview_url ?? null,
    pr_url: r.pr_url ?? null,
    pr_checks: json_opt(r.pr_checks, PrChecks_from_json),
    external_links: json_vec(r.external_links, ExternalLink_from_json),
    fanout_id: r.fanout_id ?? null,
    starred: !!r.starred,
    remind_at: r.remind_at ?? null,
    reminder: r.reminder ?? null,
    now_at: r.now_at ?? null,
    review: json_opt(r.review, Review_from_json),
    summary: summaries[0] ? structuredClone(summaries[0]) : null,
    summaries,
    context: json_opt(r.context, Context_from_json),
    thread_items: !!r.thread_items,
    thread_source: r.thread_source === "items" ? "items" : "messages",
  });
  const rewind = rewind_column(r.rewind);
  if (rewind) t.rewind = rewind;
  Object.assign(t, { cost_usd: r.cost_usd, last_activity_at: r.last_activity_at, created_at: r.created_at, updated_at: r.updated_at });
  return t;
}

/** The thread's own permission mode, else what it inherits. */
export function effective_permission_mode(t: Task, c: Conn, project: Project | null | undefined): string {
  return t.permission_mode ?? inherited_permission_mode(c, project);
}

/** The mode a thread gets when it doesn't pick one: its project's, else the host default, else `default` (Ask). */
export function inherited_permission_mode(c: Conn, project: Project | null | undefined): string {
  if (project?.permission_mode != null) return project.permission_mode;
  return get_setting(c, "default_permission_mode") ?? "default";
}

const tasks = (c: Conn, sql: string, ...ps: any[]): Task[] => all(c, sql, ...ps).map(Task_from_row);
const task = (c: Conn, sql: string, ...ps: any[]): Task | null => {
  const r = one(c, sql, ...ps);
  return r ? Task_from_row(r) : null;
};

// ---------- tasks ----------

export function get_task(c: Conn, id: string): Task | null {
  return task(c, "SELECT * FROM tasks WHERE id=?1", id);
}

export function list_tasks_for_project(c: Conn, project_id: string, kind: string): Task[] {
  return tasks(c, "SELECT * FROM tasks WHERE project_id=?1 AND kind=?2 ORDER BY position, created_at", project_id, kind);
}

/** All of a project's threads, whatever their kind. */
export function project_threads(c: Conn, project_id: string): Task[] {
  return tasks(c, "SELECT * FROM tasks WHERE project_id=?1 ORDER BY created_at", project_id);
}

/**
 * A profile's group tasks (see Task.group_name), including any whose group is gone. With `assistant`, the profile's assistant
 * too, which is off the board (the sidebar opens it).
 */
export function list_group_tasks(c: Conn, profile_id: string, assistant: boolean): Task[] {
  return tasks(
    c,
    `SELECT * FROM tasks WHERE profile_id=?1 AND project_id IS NULL AND kind='task' AND (?2 OR task_type IS NOT 'assistant') AND task_type IS NOT 'routine'
           ORDER BY position`,
    profile_id,
    assistant,
  );
}

/** The projects of a profile's group, by name (archived ones are out of it). */
export function group_projects(c: Conn, profile_id: string, group: string): Project[] {
  return list_projects(c, profile_id).filter((p) => p.group_name === group && p.archived_at == null);
}

/** Adds a group task, numbered after the profile's other group tasks (in any group), so its key (`G-<n>`) names it on the profile's board. */
export function insert_group_task(c: Conn, t: NewTask, group: string): Task {
  const created = insert_task(c, { ...t, project_id: null, kind: "task" });
  run(
    c,
    `UPDATE tasks SET group_name=?2, number=(SELECT COALESCE(MAX(number),0)+1 FROM tasks
           WHERE profile_id=?3 AND project_id IS NULL AND kind='task' AND group_name IS NOT NULL) WHERE id=?1`,
    created.id,
    group,
    created.profile_id,
  );
  return get_task(c, created.id)!;
}

/**
 * A group's tasks follow it when it's renamed: once none of the profile's projects is in the group `from` any more, its
 * tasks move to `to`. A group that's gone (`to` None) keeps them.
 */
export function rename_group_tasks(c: Conn, profile_id: string, from: string, to: string | null): string[] {
  if (to == null) return [];
  if (group_projects(c, profile_id, from).length) return [];
  return all(c, "UPDATE tasks SET group_name=?3 WHERE profile_id=?1 AND project_id IS NULL AND group_name=?2 RETURNING id", profile_id, from, to).map(
    (r) => r.id,
  );
}

/** A scratch task (in no project): numbered among its profile's, keyed `S-<n>`. */
export function insert_scratch_task(c: Conn, t: NewTask): Task {
  const created = insert_task(c, { ...t, project_id: null, kind: "task" });
  run(
    c,
    `UPDATE tasks SET task_type=?2, number=(SELECT COALESCE(MAX(number),0)+1 FROM tasks
           WHERE profile_id=?3 AND project_id IS NULL AND kind='task' AND task_type=?2) WHERE id=?1`,
    created.id,
    SCRATCH,
    created.profile_id,
  );
  return get_task(c, created.id)!;
}

/** A profile's assistant, if it has one (see is_assistant). */
export function assistant_task(c: Conn, profile_id: string): Task | null {
  return task(c, "SELECT * FROM tasks WHERE profile_id=?1 AND kind='task' AND task_type=?2", profile_id, ASSISTANT);
}

/** A profile's assistant or one of its routine threads by number (their keys are `A-<n>`). */
export function assistant_task_by_number(c: Conn, profile_id: string, number: number): Task | null {
  return task(
    c,
    "SELECT * FROM tasks WHERE profile_id=?1 AND project_id IS NULL AND kind='task' AND task_type IN (?2, ?3) AND number=?4",
    profile_id,
    ASSISTANT,
    ROUTINE,
    number,
  );
}

/**
 * Adds a routine thread under `assistant` (see is_routine), working in its workspace with its config, model, effort and
 * permission mode, and numbered after it and its other threads (`A-<n>`).
 */
export function insert_routine_task(c: Conn, assistant: Task, title: string): Task {
  return tx(c, () => {
    const created = insert_task(c, {
      profile_id: assistant.profile_id,
      project_id: null,
      kind: "task",
      title,
      description: "",
      status: "todo",
      use_worktree: false,
      model: assistant.model,
      effort: assistant.effort,
      claude_config_id: assistant.claude_config_id,
    });
    run(
      c,
      `UPDATE tasks SET task_type=?2, work_dir=?3, parent_id=?4, permission_mode=?5, title_pinned=1, number=(SELECT COALESCE(MAX(number),0)+1 FROM tasks
           WHERE profile_id=?6 AND project_id IS NULL AND kind='task' AND task_type IN (?2, ?7)) WHERE id=?1`,
      created.id,
      ROUTINE,
      assistant.work_dir,
      assistant.id,
      assistant.permission_mode,
      created.profile_id,
      ASSISTANT,
    );
    return get_task(c, created.id)!;
  });
}

/**
 * Routine threads with nothing going on since before `before`, whatever their status (done, or failed, stopped or left
 * asking): the old ones the board prunes (see routines.prune_threads). Not one whose agent is running, or waiting for its
 * usage limit to reset.
 */
export function old_routine_tasks(c: Conn, before: string): Task[] {
  return tasks(c, "SELECT * FROM tasks WHERE kind='task' AND task_type=?1 AND running=0 AND waiting=0 AND last_activity_at < ?2", ROUTINE, before);
}

/**
 * Adds a profile's assistant, keyed `A-<n>` and working in `work_dir(<its id>)` (relative to the data dir, see
 * documents::work_dir). A profile has one at most (the index tasks_one_assistant), so this fails if it has one;
 * assistant::get_or_create checks first.
 */
export function insert_assistant_task(c: Conn, t: NewTask, work_dir: (id: string) => string): Task {
  return tx(c, () => {
    const created = insert_task(c, { ...t, project_id: null, kind: "task" });
    run(
      c,
      `UPDATE tasks SET task_type=?2, work_dir=?4, number=(SELECT COALESCE(MAX(number),0)+1 FROM tasks
           WHERE profile_id=?3 AND project_id IS NULL AND kind='task' AND task_type IN (?2, ?5)) WHERE id=?1`,
      created.id,
      ASSISTANT,
      created.profile_id,
      work_dir(created.id),
      ROUTINE,
    );
    return get_task(c, created.id)!;
  });
}

/** Scratch tasks working in `dir`, which were scratch chats there (see Task.work_dir). */
export function tasks_in_work_dir(c: Conn, dir: string): Task[] {
  return tasks(c, "SELECT * FROM tasks WHERE work_dir=?1", dir);
}

/** A project's task (not a review or a subagent's thread) by number (its key is `<project key>-<n>`). */
export function task_by_number(c: Conn, project_id: string, number: number): Task | null {
  return task(c, "SELECT * FROM tasks WHERE project_id=?1 AND kind='task' AND number=?2 ORDER BY position, created_at LIMIT 1", project_id, number);
}

/** A profile's scratch task by number (its key is `S-<n>`). */
export function scratch_task_by_number(c: Conn, profile_id: string, number: number): Task | null {
  return task(c, "SELECT * FROM tasks WHERE profile_id=?1 AND project_id IS NULL AND kind='task' AND task_type=?3 AND number=?2", profile_id, number, SCRATCH);
}

/** A profile's group task by number (its key is `G-<n>`). */
export function group_task_by_number(c: Conn, profile_id: string, number: number): Task | null {
  return task(c, "SELECT * FROM tasks WHERE profile_id=?1 AND project_id IS NULL AND kind='task' AND group_name IS NOT NULL AND number=?2", profile_id, number);
}

/** The tasks a task's agent created. */
export function created_tasks(c: Conn, task_id: string): Task[] {
  return tasks(c, "SELECT * FROM tasks WHERE created_by=?1 AND kind='task' ORDER BY created_at", task_id);
}

/** The tasks stacked on task `task_id`: those that start from it (see StartFrom `task`). */
export function stacked_on(c: Conn, task_id: string): Task[] {
  return tasks(
    c,
    `SELECT * FROM tasks WHERE start_from IS NOT NULL AND json_valid(start_from)
           AND json_extract(start_from, '$.type')='task' AND json_extract(start_from, '$.task_id')=?1 ORDER BY created_at`,
    task_id,
  );
}

/** Scratch chats in no project. There are none since they became scratch tasks, but boards from before that still ask. */
export function list_profile_scratch(c: Conn, profile_id: string): Task[] {
  return tasks(c, "SELECT * FROM tasks WHERE profile_id=?1 AND project_id IS NULL AND kind='scratch' ORDER BY last_activity_at DESC", profile_id);
}

/** Every task on this host (not review threads). */
export function list_all_tasks(c: Conn): Task[] {
  return tasks(c, "SELECT * FROM tasks WHERE kind='task'");
}

/**
 * A profile's tasks, and with `assistant` its assistant (see is_assistant), which is off the board. Never its routine
 * threads (see is_routine).
 */
export function list_tasks_for_profile(c: Conn, profile_id: string, assistant: boolean): Task[] {
  return tasks(
    c,
    `SELECT * FROM tasks WHERE profile_id=?1 AND kind='task' AND (?2 OR task_type IS NOT 'assistant') AND task_type IS NOT 'routine'
           ORDER BY project_id, position`,
    profile_id,
    assistant,
  );
}

/**
 * Tasks in "In review" or "Needs attention" with a pull request, not running or merging, in projects whose merged pull
 * requests move them to Done (see review/merged.rs).
 */
export function tasks_with_open_prs(c: Conn): Task[] {
  return tasks(
    c,
    `SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.kind='task' AND t.status IN ('in_review','needs_attention') AND t.pr_url IS NOT NULL AND t.merging=0 AND t.running=0
           AND t.task_type IS NULL AND p.done_when_merged=1
         ORDER BY t.project_id, t.number`,
  );
}

/**
 * The task holding a merge slot: merging, and either running or waiting on the user. Each project has one slot for its
 * top-level tasks and one per subproject (`parent_id`), since those merge into different branches.
 */
export function active_merge(c: Conn, project_id: string | null, parent_id: string | null): Task | null {
  return task(
    c,
    `SELECT * FROM tasks WHERE project_id IS ?1 AND parent_id IS ?2 AND kind='task' AND merging=1 AND (running=1 OR status='needs_attention')
           AND merge_approval IS NOT 'pending'
         ORDER BY position LIMIT 1`,
    project_id,
    parent_id,
  );
}

/** Tasks waiting in "Ready for merge" for a merge slot, in column order (an archived project's wait until it's unarchived). */
export function queued_merges(c: Conn, project_id: string | null, parent_id: string | null): Task[] {
  return tasks(
    c,
    `SELECT * FROM tasks WHERE project_id IS ?1 AND parent_id IS ?2 AND kind='task' AND merging=1 AND running=0 AND status='ready_for_merge'
           AND merge_approval IS NOT 'pending' AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))
         ORDER BY position, created_at`,
    project_id,
    parent_id,
  );
}

/** The merge slots in a project with tasks waiting for them (by subproject, None for the top level; none in an archived project). */
export function merge_lanes(c: Conn, project_id: string | null): Array<string | null> {
  return all(
    c,
    `SELECT DISTINCT parent_id FROM tasks WHERE project_id IS ?1 AND kind='task' AND merging=1 AND running=0 AND status='ready_for_merge'
           AND merge_approval IS NOT 'pending' AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))`,
    project_id,
  ).map((r) => r.parent_id ?? null);
}

/** A task's review threads, oldest first, its summary threads (see `summary_threads`) included: they all work in its worktree. */
export function review_threads(c: Conn, task_id: string): Task[] {
  return tasks(c, "SELECT * FROM tasks WHERE parent_id=?1 AND kind='review' ORDER BY created_at, number", task_id);
}

/** The board skills (names) a review or summary thread has on top of its project's. */
export function thread_skills(c: Conn, thread_id: string): string[] {
  const v = value<string>(c, "SELECT skills FROM review_thread_skills WHERE task_id=?1", thread_id);
  return json_list(v);
}

/** Sets the board skills a review or summary thread has on top of its project's (none removes them). */
export function set_thread_skills(c: Conn, thread_id: string, skills: string[]): void {
  if (!skills.length) {
    run(c, "DELETE FROM review_thread_skills WHERE task_id=?1", thread_id);
  } else {
    run(c, "INSERT INTO review_thread_skills (task_id, skills) VALUES (?1,?2) ON CONFLICT(task_id) DO UPDATE SET skills=?2", thread_id, JSON.stringify(skills));
  }
}

/** A task's summary threads (review threads that summarise its changes, see review/summary.rs), oldest first. */
export function summary_threads(c: Conn, task_id: string): Task[] {
  return tasks(c, "SELECT * FROM tasks WHERE parent_id=?1 AND kind='review' AND task_type='summary' ORDER BY created_at, number", task_id);
}

/** The tasks made together from one prompt (`fanout_id`, see api::CreateTask) in a profile, in the order they were made. */
export function fanout_tasks(c: Conn, profile_id: string, fanout_id: string): Task[] {
  return tasks(c, "SELECT * FROM tasks WHERE profile_id=?1 AND fanout_id=?2 AND kind='task' ORDER BY created_at, number", profile_id, fanout_id);
}

/**
 * How long a task's agent has run, in seconds, over all of its runs (one still going counts up to `now`), and how many
 * runs it has had.
 */
export function run_time(c: Conn, task_id: string, now: string): [number, number] {
  const st = c.prepare(
    "SELECT COALESCE(SUM(MAX(0, julianday(COALESCE(ended_at, ?2)) - julianday(created_at))), 0) * 86400, COUNT(*) FROM runs WHERE task_id=?1",
  );
  st.setReturnArrays(true);
  const r = st.get(task_id, now) as unknown as any[];
  return [r[0], r[1]];
}

/** A subproject's tasks, in board order. */
export function subproject_tasks(c: Conn, subproject_id: string): Task[] {
  return tasks(c, "SELECT * FROM tasks WHERE parent_id=?1 AND kind='task' ORDER BY position, created_at", subproject_id);
}

/** Every subproject's id. */
export function subprojects(c: Conn): string[] {
  return all(c, "SELECT id FROM tasks WHERE subproject=1").map((r) => r.id);
}

/** The subproject a task belongs to, if any. */
export function subproject_of(c: Conn, t: Task): Task | null {
  if (t.kind !== "task" || t.parent_id == null) return null;
  const p = get_task(c, t.parent_id);
  return p && p.subproject ? p : null;
}

/**
 * The column a subproject's tasks (and its own agent) put it in, by priority: "Needs attention" if any of them is
 * waiting on the user, else "In progress" if any is being worked on, else "In review" once they're all in review or
 * merged (it stays there after the last one is merged). Tasks still to do don't count, nor do scratch tasks, which
 * aren't part of its work. None leaves it where it is: nothing has started yet, or it's being merged or is done, which
 * is up to the user.
 */
export function subproject_status(sp: Task, ts: Task[]): "needs_attention" | "in_progress" | "in_review" | null {
  if (!sp.subproject || sp.merging || ["ready_for_merge", "done"].includes(sp.status)) return null;
  const any = (st: string) => ts.some((t) => t.status === st && !is_scratch(t));
  if (sp.attention_reason != null || any("needs_attention")) return "needs_attention";
  if (sp.running || any("in_progress")) return "in_progress";
  if (["in_review", "ready_for_merge", "done"].some((st) => any(st))) return "in_review";
  return null;
}

/** Whether a task counts as merged for the tasks that depend on it. */
export function is_merged(t: Task): boolean {
  return t.status === "done" && (t.resolution == null || t.resolution === "done");
}

/** get_task, with an error as no task (Rust's `.ok().flatten()`). */
function try_get_task(c: Conn, id: string): Task | null {
  try {
    return get_task(c, id);
  } catch {
    return null;
  }
}

/**
 * The branch `task` merges into and is compared with: its base branch, else its project's. One stacked on another task
 * (see StartFrom) that's merged by now goes where that one went instead, as GitHub retargets a pull request whose base
 * branch is deleted; so does one that started from a task that was merged already, and so took that one's base branch,
 * once that goes somewhere else.
 */
export function task_base(c: Conn, t: Task, project: Project | null | undefined): string | null {
  const own = (t: Task) => {
    const b = t.base_branch ?? project?.base_branch ?? null;
    return b != null && b !== "" ? b : null;
  };
  // Each step is to a task it starts from, which can't lead back (see api::check_start_from); a few are as deep as
  // stacks go.
  for (let i = 0; i < 16; i++) {
    if (t.start_from?.type !== "task") break;
    // Its base branch came from that task as its worktree was made (its branch, or where it went), and setting one of
    // its own drops what it starts from (see api::update_task_inner), so it goes where that went, even once the board
    // has deleted that task's branch.
    const other = try_get_task(c, t.start_from.task_id);
    if (other && is_merged(other)) t = other;
    else break;
  }
  return own(t);
}

/**
 * The task whose branch `task_base` has `task` go to, when that's a task it's stacked on (directly, or by way of ones
 * merged since) that isn't merged yet.
 */
export function stacked_base(c: Conn, t: Task): Task | null {
  for (let i = 0; i < 16; i++) {
    if (t.start_from?.type !== "task") return null;
    const other = try_get_task(c, t.start_from.task_id);
    if (!other) return null;
    if (is_merged(other)) t = other;
    else return other.branch != null && other.branch === t.base_branch ? other : null;
  }
  return null;
}

/** The tasks `task` depends on that aren't merged yet, in the order it lists them. Deleted ones don't count. */
export function unmet_dependencies(c: Conn, t: Task): Task[] {
  const out: Task[] = [];
  for (const id of t.depends_on) {
    const d = get_task(c, id);
    if (d && !is_merged(d)) out.push(d);
  }
  return out;
}

/**
 * The tasks in "In review" with a pull request, in projects that watch them (see pr_watch::watch_in_review) and aren't
 * archived, with their project's `watch_pull_requests`.
 */
export function tasks_to_watch(c: Conn): Array<[Task, string]> {
  return all(
    c,
    `SELECT t.*, p.watch_pull_requests AS watch_mode FROM tasks t JOIN projects p ON p.id = t.project_id
         WHERE t.kind='task' AND t.status='in_review' AND COALESCE(t.pr_url, '') != ''
           AND p.watch_pull_requests != 'off' AND p.archived_at IS NULL`,
  ).map((r) => [Task_from_row(r), r.watch_mode]);
}

/** Whether the user (not the board or another agent) sent `task_id`'s agent a message after `since`. */
export function user_wrote_since(c: Conn, task_id: string, since: string): boolean {
  return !!value(
    c,
    // `+kind`: see db/messages.ts.
    `SELECT EXISTS (SELECT 1 FROM messages WHERE task_id=?1 AND +kind='user' AND created_at > ?2
           AND json_extract(data, '$.auto') IS NULL AND json_extract(data, '$.from_agent') IS NULL)`,
    task_id,
    since,
  );
}

/**
 * Tasks queued for their dependencies, in a project (or every project for None), but not in an archived project, whose
 * agents don't start: they keep waiting, queued message and all.
 */
export function waiting_tasks(c: Conn, project_id: string | null): Task[] {
  return tasks(
    c,
    `SELECT * FROM tasks WHERE waiting=1 AND kind='task' AND (?1 IS NULL OR project_id=?1)
           AND (project_id IS NULL OR project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))
         ORDER BY position, created_at`,
    project_id,
  );
}

/**
 * Check the dependencies asked for a task (`task_id`, None for a new one) in `project_id`: tasks (ids) in its project,
 * not itself, and not depending on it in turn. Returns them without duplicates. Rust's `Err(String)` is an
 * `ApiError.bad` thrown (every caller turns it into one).
 */
export function check_dependencies(c: Conn, task_id: string | null, project_id: string | null, ids: string[]): string[] {
  if (project_id == null && ids.length) throw ApiError.bad("only tasks in a project can have dependencies");
  const get = (id: string) => {
    try {
      return get_task(c, id);
    } catch (e) {
      throw ApiError.bad(err_str(e));
    }
  };
  const out: string[] = [];
  for (const id of ids) {
    if (out.includes(id)) continue;
    const dep = get(id);
    if (!dep) throw ApiError.bad(`no task ${id}`);
    if (dep.kind !== "task" || dep.project_id !== project_id) throw ApiError.bad(`"${dep.title}" isn't a task in the same project`);
    if (dep.id === task_id) throw ApiError.bad("a task can't depend on itself");
    // Walk what the dependency depends on, looking for the task.
    if (task_id != null) {
      const stack = [dep];
      const seen = [dep.id];
      let t;
      while ((t = stack.pop())) {
        for (const next of t.depends_on) {
          if (next === task_id) throw ApiError.bad(`"${dep.title}" already depends on this task`);
          if (!seen.includes(next)) {
            seen.push(next);
            const n = get(next);
            if (n) stack.push(n);
          }
        }
      }
    }
    out.push(dep.id);
  }
  return out;
}

/** Take a deleted task off every task that depended on it. */
export function drop_dependency(c: Conn, id: string): string[] {
  return all(
    c,
    `UPDATE tasks SET depends_on=(SELECT json_group_array(value) FROM json_each(tasks.depends_on) WHERE value != ?1)
         WHERE EXISTS (SELECT 1 FROM json_each(tasks.depends_on) WHERE value = ?1) RETURNING id`,
    id,
  ).map((r) => r.id);
}

/** Projects with tasks waiting for their merge slot. */
export function projects_with_queued_merges(c: Conn): Array<string | null> {
  return all(
    c,
    "SELECT DISTINCT project_id FROM tasks WHERE kind='task' AND merging=1 AND running=0 AND status='ready_for_merge' AND merge_approval IS NOT 'pending'",
  ).map((r) => r.project_id ?? null);
}

export interface NewTask {
  profile_id: string;
  project_id: string | null;
  kind: string;
  title: string;
  description: string;
  status: string;
  use_worktree: boolean;
  model?: string | null;
  effort?: string | null;
  /** None for the default of its project and profile. */
  claude_config_id?: string | null;
}

/** A position after every task in a column. */
export function end_position(c: Conn, project_id: string | null, status: string, kind: string): number {
  return value<number>(c, "SELECT COALESCE(MAX(position),0)+1 FROM tasks WHERE project_id IS ?1 AND status=?2 AND kind=?3", project_id, status, kind)!;
}

/** Adds a thread. In a savepoint, so one that fails doesn't use up its project's next key number (and it works within a transaction as well). */
export function insert_task(c: Conn, t: NewTask): Task {
  c.exec("SAVEPOINT insert_task");
  try {
    const created = insert_task_now(c, t);
    // As the transaction's COMMIT when there's no other: one that fails leaves the savepoint, to roll back.
    c.exec("RELEASE insert_task");
    return created;
  } catch (e) {
    try {
      c.exec("ROLLBACK TO insert_task; RELEASE insert_task");
    } catch {}
    throw e;
  }
}

function insert_task_now(c: Conn, t: NewTask): Task {
  const id = new_id();
  const ts = now();
  let number = 0;
  if (t.project_id != null && t.kind === "task") {
    const n = value<number>(c, "UPDATE projects SET next_number=next_number+1 WHERE id=?1 RETURNING next_number-1", t.project_id);
    if (n === undefined) throw new Error("Query returned no rows");
    number = n;
  }
  const position = end_position(c, t.project_id, t.status, t.kind);
  // Kept with the thread, so its session stays with the config it started in even if the profile's or project's
  // configs change later.
  let config: string | null;
  if (t.claude_config_id != null) config = t.claude_config_id;
  else {
    const project = t.project_id != null ? get_project(c, t.project_id) : null;
    config = available_configs(c, t.profile_id, project)[0]?.id ?? null;
  }
  run(
    c,
    `INSERT INTO tasks (id,profile_id,project_id,kind,number,title,description,status,position,use_worktree,model,effort,claude_config_id,last_activity_at,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14,?14)`,
    id,
    t.profile_id,
    t.project_id,
    t.kind,
    number,
    t.title,
    t.description,
    t.status,
    position,
    t.use_worktree,
    t.model,
    t.effort,
    config,
    ts,
  );
  normalize_resolution(c, id);
  return get_task(c, id)!;
}

const TASK_COLUMNS = [
  "title",
  "title_pinned",
  "description",
  "status",
  "resolution",
  "position",
  "use_worktree",
  "worktree_path",
  "branch",
  "base_branch",
  "start_from",
  "worktree_state",
  "worktree_error",
  "session_id",
  "running",
  "run_started_at",
  "merging",
  "remerge",
  "merge_approval",
  "attention_reason",
  "queued_message",
  "steering",
  "steerable",
  "depends_on",
  "waiting",
  "limit_reset_at",
  "agent_wait",
  "model",
  "effort",
  "permission_mode",
  "claude_config_id",
  "auto_allow",
  "preview_url",
  "pr_url",
  "pr_checks",
  "external_links",
  "fanout_id",
  "starred",
  "remind_at",
  "reminder",
  "now_at",
  "review",
  "summary",
  "context",
  "context_detail",
  "rewind",
  "parent_id",
  "subproject",
  "created_by",
  "task_type",
  "labels",
  "document_at",
  "work_dir",
  "cost_usd",
  "last_activity_at",
  "done_at",
];

/** Update whitelisted task columns from a list of (column, json value) pairs. */
export function update_task(c: Conn, id: string, fields: Array<[string, any]>): Task | null {
  if (fields.length) {
    const sets: string[] = [];
    const vals: any[] = [];
    for (const [col, v] of fields) {
      if (!TASK_COLUMNS.includes(col)) throw new Error(`unknown task column ${col}`);
      vals.push(json_to_sql(v));
      sets.push(`${col}=?${vals.length}`);
    }
    vals.push(now());
    sets.push(`updated_at=?${vals.length}`);
    vals.push(id);
    run(c, `UPDATE tasks SET ${sets.join(",")} WHERE id=?${vals.length}`, ...vals);
    const has = (...cols: string[]) => fields.some(([col]) => cols.includes(col));
    if (has("status", "resolution")) normalize_resolution(c, id);
    // Whoever moves it (the user, a review, a run's end), a task that stepped out of the merge queue keeps its place to
    // rejoin only while its agent works on it (see Task.remerge).
    if (has("status") && !has("remerge")) {
      run(c, "UPDATE tasks SET remerge=0 WHERE id=?1 AND remerge=1 AND status NOT IN ('in_progress','needs_attention')", id);
    }
    // A merge's approval goes with the merge, unless it stepped out to rejoin it.
    if (has("status", "merging", "remerge")) {
      run(c, "UPDATE tasks SET merge_approval=NULL WHERE id=?1 AND merge_approval IS NOT NULL AND merging=0 AND remerge=0", id);
    }
  }
  return get_task(c, id);
}

/**
 * Give a task a title written for it (see agent/title.rs), unless it's been pinned, or its title has changed from `old`
 * (if given) since. The task as it is then, if it changed.
 */
export function replace_title(c: Conn, id: string, old: string | null, title: string): Task | null {
  const n = run(c, "UPDATE tasks SET title=?3, updated_at=?4 WHERE id=?1 AND (?2 IS NULL OR title=?2) AND NOT title_pinned", id, old, title, now()).changes;
  if (n === 0) return null;
  return get_task(c, id);
}

/**
 * A done task has a resolution (`done` unless told otherwise) and the time it was done (kept while it stays done); any
 * other task has neither.
 */
function normalize_resolution(c: Conn, id: string): void {
  run(
    c,
    `UPDATE tasks SET resolution = CASE WHEN status='done' THEN COALESCE(resolution,'done') END,
           done_at = CASE WHEN status='done' THEN COALESCE(done_at,?2) END WHERE id=?1`,
    id,
    now(),
  );
}
