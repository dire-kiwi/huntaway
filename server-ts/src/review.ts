// Port of server/src/review.rs.
/**
 * Automatic code review. When a task moves to "In review" (usually because its agent finished), each of the project's
 * reviewers reviews the branch's pull request in the task's worktree, in a review thread of its own (a `review` task
 * whose `parent_id` is the task). The task's `review` holds the latest review's state, each reviewer's part and their
 * combined outcome, which the board shows on the card. Once every reviewer has finished, the serious issues they
 * reported with `submit_review` go back to the task's agent to fix; when it finishes, the new commit is reviewed again.
 * After the project's `review_rounds` rounds of that in a row, the task is left for the user, who can give it as many
 * more (see `extend`). Only code changes are reviewed automatically: a task whose branch has no commits of its own is
 * skipped unless its agent changed code somewhere else (see `changed_elsewhere`).
 *
 * The task stays in "In review" while it's reviewed, and only goes back to "In progress" when its agent works on it
 * again (to fix the issues found, or because it was sent a message).
 *
 * The `review` folder has what follows a review: summaries of the changes, merge approvals, merged pull requests and
 * fan-outs, and the statistics kept of what reviewers report. Its modules are imported from their own files
 * (`review/summary.ts`, …), as Rust's `pub mod`s are reached by their paths.
 *
 * Rust's `UPDATING` lock (held while a review in progress changes) has no counterpart: what it guards is synchronous
 * here, so it can't interleave with anything else on the one thread.
 */
import * as db from "./db.ts";
import type { ClaudeConfig, Review, ReviewerRun, Task, UserReplies } from "./db.ts";
import * as runner from "./agent/runner.ts";
import type { Outcome } from "./agent/runner.ts";
import * as runs from "./agent/runs.ts";
import * as context from "./agent/context.ts";
import * as prompts from "./agent/prompts.ts";
import * as worktree from "./git/worktree.ts";
import * as changes from "./git/changes.ts";
import * as summary from "./review/summary.ts";
import * as stats from "./review/stats.ts";
import { ApiError, AsyncMutex, type AppState } from "./state.ts";
import { err_str, now, reached } from "./util.ts";

/** Read-only tools a reviewer may use without asking. */
export const ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Skill",
  "Agent",
  "Task",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git status:*)",
  "Bash(git merge-base:*)",
  "Bash(git rev-parse:*)",
  "Bash(gh pr view:*)",
  "Bash(gh pr diff:*)",
  "Bash(gh pr list:*)",
  "Bash(gh pr checks:*)",
];

/** Tools a reviewer never gets. */
export const DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit"];

/** Held while starting a review, so two can't start on one task at once. */
let STARTING: AsyncMutex | null = null;

/** Most reviewers a project can have. */
export const MAX_REVIEWERS = 6;

/** Two `Option<String>`s as Rust compares them (a missing field is None). */
const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? null) === (b ?? null);

/** A non-blank string, else null (`.filter(|m| !m.trim().is_empty())`). */
const non_blank = (s: string | null | undefined): string | null => (s != null && s.trim() !== "" ? s : null);

/** What `runner::Outcome` a run ended with, and its error if it failed. */
export function outcome_of(o: Outcome): ["ok" | "cancelled" | "failed", string] {
  if (o === "Ok") return ["ok", ""];
  if (o === "Cancelled") return ["cancelled", ""];
  return ["failed", o.Failed];
}

/** Rust's `str::lines`: split on `\n` (dropping a `\r` before it), without a last empty line. */
export function lines(s: string): string[] {
  if (s === "") return [];
  const out = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (s.endsWith("\n")) out.pop();
  return out;
}

/** The first line of `s` (`s.lines().next().unwrap_or("")`). */
export const first_line = (s: string) => lines(s)[0] ?? "";

/** Each line of `s` quoted, Markdown style. */
export const quote = (s: string) =>
  lines(s)
    .map((l) => `> ${l}`)
    .join("\n");

/** `s` cut to `n` characters with " [...]" after it, if it's longer. */
export function cut_chars(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length > n ? `${chars.slice(0, n).join("")} [...]` : s;
}

/** A task moved to "In review": review its work in the background, if its project wants that and this commit hasn't been reviewed yet. */
export function on_in_review(state: AppState, task: Task) {
  const id = task.id;
  start(state, id, false).catch((e) => {
    console.warn(`task ${id}: couldn't start a review: ${err_str(e)}`);
    state.add_event(id, "warn", "Couldn't start the review", err_str(e));
  });
}

/**
 * Review a task's work. `manual` (the user asked for it) reviews even when the project doesn't review automatically or
 * the commit was already reviewed, and says why when it can't. Returns the task, or null when there was nothing to do.
 */
export async function start(state: AppState, task_id: string, manual: boolean): Promise<Task | null> {
  const release = await (STARTING ??= new AsyncMutex()).lock();
  try {
    return await start_locked(state, task_id, manual);
  } finally {
    release();
  }
}

async function start_locked(state: AppState, task_id: string, manual: boolean): Promise<Task | null> {
  const task = db.get_task(state.db(), task_id);
  if (!task) throw ApiError.not_found("task");
  const project = task.project_id != null && task.kind === "task" ? db.get_project(state.db(), task.project_id) : null;
  if (!project) return skip(manual, "only tasks in a project can be reviewed");
  // What's read of the work below is what this run left, unless another starts meanwhile:
  // read before the check that none is running, so one that starts in between counts as later.
  const last_run = db.latest_run(state.db(), task.id, null);
  reached("review:last-run");
  if (state.is_running(task.id)) {
    // A task its agent moved to "In review" mid-run is reviewed when the run ends.
    return skip(manual, "the agent is still working; its changes are reviewed when it finishes");
  }
  if (!manual && !project.auto_review) return null;
  if (!runs.can_run_agents(state)) return skip(manual, "this host can't run agents");
  const dir = task.worktree_state === "ready" ? (task.worktree_path ?? null) : null;
  const branch = task.branch ?? null;
  if (dir == null || branch == null) return skip(manual, "the task has no worktree branch to review");
  const previous = task.review ?? null;
  if (previous?.state === "running") return skip(manual, "a review is already running");
  const head = await rev_parse(dir, "HEAD");
  if (head == null) throw ApiError.bad("couldn't read the worktree's HEAD commit");
  const [base, own_start] = await worktree.work_scope(state, dir, task, project);
  let elsewhere = false;
  if (base != null) {
    const o = await worktree.git(dir, ["merge-base", base, "HEAD"]).catch(() => null);
    const merge_base = o && o.ok ? o.stdout.trim() : null;
    // The agent may have made its changes somewhere else, such as in another repository.
    elsewhere = merge_base === head;
  }
  // Without commits of its own, the head doesn't change when the agent fixes the issues found
  // elsewhere, so it's reviewed again after a round of fixes (review_rounds still caps those).
  const done = elsewhere ? ["passed"] : ["passed", "issues"];
  const reviewed = previous != null && previous.head === head && done.includes(previous.state);
  if (reviewed && !manual) return null;
  if (elsewhere && !manual && !(await changed_elsewhere(state, task, dir, previous))) {
    state.add_event(
      task.id,
      "info",
      "Not reviewed: no code changes",
      "The branch has no commits of its own, and the agent didn't edit files, commit, push or open a pull request. Use Review now to review it anyway.",
    );
    return null;
  }

  // Each reviewer reviews in its own thread, kept from one review to the next.
  const specs = db.reviewers_for(state.db(), project);
  const task_config = db.task_claude_config(state.db(), task);
  const threads = db.review_threads(state.db(), task.id).filter((t) => !summary.is_summary(t));
  const key = `${project.key}-${task.number}`;
  const parts: ReviewerRun[] = [];
  // What each reviewer looks for: its own instructions, else the project's.
  const instructions: string[] = [];
  for (const spec of specs) {
    // A reviewer whose config was deleted reviews with the task's.
    const config = spec.claude_config_id != null ? (db.get_claude_config(state.db(), spec.claude_config_id) ?? task_config) : task_config;
    const config_id = config?.id ?? null;
    const model = non_blank(spec.model);
    const effort = non_blank(spec.effort);
    const lbl = label(config, model, effort);
    const found = threads.findIndex((t) => same(t.claude_config_id, config_id) && same(t.model, model) && same(t.effort, effort));
    let thread: Task;
    if (found >= 0) {
      thread = threads.splice(found, 1)[0];
    } else {
      const title = specs.length > 1 ? `Review of ${key} (${lbl})` : `Review of ${key}`;
      const t = db.insert_task(state.db(), {
        profile_id: task.profile_id,
        project_id: project.id,
        kind: "review",
        title,
        description: "",
        status: "todo",
        use_worktree: false,
        model,
        effort,
        claude_config_id: config_id,
      });
      const updated = state.update_task(t.id, [["parent_id", task.id]]);
      if (!updated) throw ApiError.not_found("review thread");
      thread = updated;
    }
    if (state.is_running(thread.id)) {
      throw ApiError.conflict(`the review thread's agent (${lbl}) is busy; wait for it to finish or stop it`);
    }
    const after_run = db.latest_run(state.db(), thread.id, null) ?? "";
    const skills = spec.skills ?? [];
    db.set_thread_skills(state.db(), thread.id, skills);
    let text = prompts.review_by(project, spec);
    if (skills.length) {
      const codex = config != null && db.is_codex(config);
      const named = skills.map((s) => `\`${codex ? "$" : "/"}${s}\``);
      text += `\n\nUse ${skills.length === 1 ? "this skill" : "these skills"} while you review: ${named.join(", ")}${codex ? "" : " (invoke each with the `Skill` tool)"}.`;
    }
    instructions.push(text);
    parts.push({ thread_id: thread.id, label: lbl, state: "running", summary: null, issues: [], after_run });
  }

  // Issues the agent was asked to fix are checked again; a review the user asked for starts
  // a fresh round of fixes.
  const fixed = previous?.state === "issues" ? [...previous.issues] : [];
  const review: Review = {
    thread_id: parts[0].thread_id,
    state: "running",
    head,
    summary: null,
    issues: [],
    fixes: manual ? 0 : (previous?.fixes ?? 0),
    extra_rounds: manual ? 0 : (previous?.extra_rounds ?? 0),
    updated_at: now(),
    started_at: now(),
    reviewers: parts.map((p) => ({ ...p, issues: [...p.issues] })),
  };
  reached("review:recording");
  // The agent may have started again while git was read: `supersede` found no review to
  // stop then, so this one would review work that's changing, or has changed since it was
  // read if that run has ended too. Once this is recorded, a run that starts has it to stop.
  const later = db.later_run(state.db(), task.id, last_run ?? "");
  if (later || state.is_running(task.id)) {
    return skip(manual, "the agent is working again; its changes are reviewed when it finishes");
  }
  set_review(state, task.id, review);
  const commit = head.slice(0, 10);
  const work: Work = elsewhere ? { kind: "elsewhere", last_message: db.last_assistant_text(state.db(), task.id) } : { kind: "branch", own_start };
  const replies = db.user_replies(state.db(), task.id, REPLIES);
  let started = 0;
  let failed: unknown = null;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const text = prompt(key, task, branch, base, commit, work, fixed, replies, instructions[i]);
    // Each review starts from a clean slate; the thread keeps every round's messages.
    state.update_task(part.thread_id, [["session_id", null]]);
    context.clear(state, part.thread_id);
    // A reviewer of a review `supersede` has stopped doesn't start, and one that starts first is stopped with it.
    if (!in_progress(state, task.id, part.thread_id)) return db.get_task(state.db(), task.id);
    state.add_event(part.thread_id, "info", `Reviewing commit ${commit}`);
    let error: unknown = null;
    let ok = false;
    try {
      runner.send_review(state, part.thread_id, text);
      ok = true;
    } catch (e) {
      error = e;
    }
    reached("review:reviewer-started");
    if (ok) {
      started += 1;
    } else {
      const why = `Couldn't start the review: ${err_str(error)}`;
      const ended = end_part(state, task.id, part.thread_id, null, (p) => {
        p.state = "failed";
        p.summary = why;
      });
      // The others have already finished.
      if (ended && started > 0) act(state, ended[0], ended[1]);
      failed ??= error;
    }
  }
  if (failed != null && started === 0) throw failed;
  const who = parts.length > 1 ? ` with ${parts.length} reviewers` : "";
  state.add_event(task.id, "info", `Reviewing the changes (commit ${commit})${who}`);
  if (["in_progress", "needs_attention"].includes(task.status) && !task.merging) {
    // A task under review sits in "In review" (e.g. one reviewed again from "Needs attention"
    // after its rounds of fixes), so the issues found can go back to its agent. Unless its
    // agent has started again since (stopping the review): its column is that run's.
    const fields: Array<[string, any]> = [
      ["status", "in_review"],
      ["attention_reason", null],
    ];
    state.update_task_if(task.id, fields, (c) => !db.later_run(c, task.id, last_run ?? ""));
  }
  return db.get_task(state.db(), task.id);
}

/** How a reviewer reads on the board: its config, model and effort. */
export function label(config: ClaudeConfig | null | undefined, model: string | null | undefined, effort: string | null | undefined): string {
  const name = config ? config.name : "Claude";
  return [name, model, effort].filter((x) => x != null).join(" · ");
}

function skip<T>(manual: boolean, why: string): T | null {
  if (manual) throw ApiError.conflict(`Can't review: ${why}`);
  return null;
}

export async function rev_parse(dir: string, rev: string): Promise<string | null> {
  const o = await worktree.git(dir, ["rev-parse", "--verify", rev]).catch(() => null);
  if (!o || !o.ok) return null;
  const s = o.stdout.trim();
  return s ? s : null;
}

/**
 * Whether the agent of a task whose branch has no commits of its own changed code anywhere since its last finished
 * review (`previous`), so there's something to review: it edited files, committed, pushed, opened a pull request or
 * wrote files from the shell (see `changes::changes_code`). Uncommitted changes in the worktree count too, and before
 * the first review, a pull request on the task.
 */
export async function changed_elsewhere(state: AppState, task: Task, dir: string, previous: Review | null): Promise<boolean> {
  const since = previous != null && ["passed", "issues"].includes(previous.state) ? previous.updated_at : null;
  if (db.tool_calls_since(state.db(), task.id, since).some(([call, result]: [any, any]) => changes.changes_code(call, result ?? null))) {
    return true;
  }
  if (since == null && task.pr_url != null && task.pr_url.trim() !== "") return true;
  const o = await worktree.git(dir, ["status", "--porcelain"]).catch(() => null);
  return !!o && o.ok && o.stdout.trim() !== "";
}

/**
 * Where the work to review is.
 * - `branch`: on the task's branch. `own_start`: it starts later than where the branch left its base branch (it started
 *   from a commit that isn't on it, say), which its pull request's diff would include.
 * - `elsewhere`: the branch has no commits: the agent's changes, if any, are somewhere else (such as in another
 *   repository), which its last message should say.
 */
export type Work = { kind: "branch"; own_start: boolean } | { kind: "elsewhere"; last_message: string | null };

/** How much of the agent's last message goes in the prompt. */
export const LAST_MESSAGE_CHARS = 6000;

/**
 * How much of each message the user sent the task's agent goes in the prompt, of what the agent said before it (its
 * end, where a question usually is), and of all of them (the latest).
 */
export const REPLY_CHARS = 2000;
export const REPLY_CONTEXT_CHARS = 1500;
export const REPLIES_CHARS = 12000;
/** How many of the user's latest messages are read for the prompt, at most (fewer fit when they're long). */
const REPLIES = 100;

/**
 * `instructions` (the project's, or the default) say what to look for; the rest locates the work, says what the user
 * decided in the task's thread (`replies`, see `db::user_replies`) and how to report the verdict.
 */
export function prompt(
  key: string,
  task: Task,
  branch: string,
  base: string | null,
  commit: string,
  work: Work,
  fixed: string[],
  replies: UserReplies,
  instructions: string,
): string {
  let p = `Review the work on task ${key}: "${task.title}".\n`;
  if (task.description.trim() !== "") p += `\nThe task's description:\n\n${task.description.trim()}\n`;
  if (work.kind === "branch" && work.own_start && base != null) {
    const b = base;
    p +=
      `\nThe work is on branch \`${branch}\` (commit ${commit}), checked out in your working directory. It started from ` +
      `commit ${b}, after where it left its base branch, so its pull request's diff (if it has one) also has commits ` +
      `that aren't its own: review the branch's changes (\`git diff ${b}...HEAD\`) rather than \`pr_diff\`. Read its pull ` +
      `request with the gh MCP server's \`pr_view\` tool (pr \`${branch}\`) only for its description and comments.\n`;
  } else if (work.kind === "branch") {
    const fallback = base != null ? `the branch's changes (\`git diff ${base}...HEAD\`)` : "the branch's commits";
    p +=
      `\nThe work is on branch \`${branch}\` (commit ${commit}), checked out in your working directory. Find its pull ` +
      `request with the gh MCP server's \`pr_view\` tool (pr \`${branch}\`) and review the pull request's changes ` +
      `(\`pr_diff\`). If it has no pull request, review ${fallback} instead.\n`;
  } else {
    p +=
      `\nThe task's branch \`${branch}\`, checked out in your working directory, has no commits of its own (it's still at ` +
      `commit ${commit}, where it started), so the agent made its changes somewhere else, such as in another ` +
      `repository, or made none. Find its changes from what it says it did`;
    if (task.pr_url) p += ` and from the task's pull request, ${task.pr_url}`;
    p +=
      ", and review them: for a pull request in another repository, the gh MCP server's `pr_view` " +
      "and `pr_diff` tools with its URL; for commits in another checkout, read its files and git history " +
      "there. If the agent didn't change anything that needs reviewing, the verdict is `pass` and the summary says so.\n";
    const m = work.last_message?.trim();
    if (m) p += `\nThe agent's last message:\n\n${quote(cut_chars(m, LAST_MESSAGE_CHARS))}\n`;
    else p += "\nThe agent didn't leave a message saying what it did.\n";
  }
  p += user_said(replies.replies, replies.earlier > 0);
  p +=
    `\n${instructions}\n\n` +
    "When you're done, call `submit_review` once. If anything must be fixed before merging (for example, a bug you confirmed), the " +
    "verdict is `needs_fixes` and each such problem goes in `serious_issues`, with where it is, what goes wrong and how " +
    "to fix it: they are sent to the task's agent to fix. Otherwise the verdict is `pass`. Put minor issues and " +
    "suggestions in the summary, and list each of them in `minor_issues` too.";
  if (fixed.length) {
    p += "\n\nThe previous review found these serious issues, and the agent was asked to fix them. Check that they're fixed:\n";
    for (const i of fixed) p += `\n- ${i}`;
  }
  return p;
}

/**
 * The prompt's part on what the user told the task's agent, so reviewers don't raise again what they've decided. The
 * latest messages, up to `REPLIES_CHARS`, after `earlier` ones left out if set.
 */
export function user_said(replies: Array<[string | null, string]>, earlier: boolean): string {
  const parts: string[] = [];
  let len = 0;
  let cut = earlier;
  for (let i = replies.length - 1; i >= 0; i--) {
    const [said, text] = replies[i];
    let part = "";
    const s = said?.trim();
    if (s) part += `The agent:\n\n${quote(clip(s, REPLY_CONTEXT_CHARS, true))}\n\n`;
    part += `The user:\n\n${quote(clip(text, REPLY_CHARS, false))}\n`;
    len += Buffer.byteLength(part);
    if (len > REPLIES_CHARS && parts.length) {
      cut = true;
      break;
    }
    parts.push(part);
  }
  if (!parts.length) return "";
  if (cut) parts.push("[Earlier messages left out.]\n");
  parts.reverse();
  return (
    "\nWhat the user told the task's agent in its thread, after what the agent said before each message. The " +
    "decisions they made there stand, such as limitations they accepted and options they turned down: don't raise " +
    `those again as serious issues, unless you find something about them the user didn't know.\n\n${parts.join("\n")}`
  );
}

/** `s`'s first `n` characters, or its last with `end`, marked where it was cut. */
function clip(s: string, n: number, end: boolean): string {
  const chars = Array.from(s);
  if (chars.length <= n) return s;
  return end ? `[...] ${chars.slice(chars.length - n).join("")}` : `${chars.slice(0, n).join("")} [...]`;
}

export function set_review(state: AppState, task_id: string, review: Review): void {
  state.update_task(task_id, [["review", review]]);
}

/** A task's review with each reviewer's part: one from before there could be several has just its one, from its own fields. */
function with_parts(r: Review): Review {
  if (!r.reviewers.length && r.thread_id !== "") {
    const part: ReviewerRun = { thread_id: r.thread_id, label: "", state: r.state, summary: r.summary, issues: [...r.issues] };
    if (r.verdict != null) part.verdict = r.verdict;
    delete r.verdict;
    r.reviewers.push(part);
  }
  return r;
}

/** The task a review thread reviews, with its review if the thread's part in it is in progress. */
function in_progress(state: AppState, parent_id: string, thread_id: string): [Task, Review] | null {
  let parent: Task | null;
  try {
    parent = db.get_task(state.db(), parent_id);
  } catch {
    return null;
  }
  if (!parent || !parent.review || parent.review.state !== "running") return null;
  const review = with_parts(structuredClone(parent.review));
  return review.reviewers.some((p) => p.thread_id === thread_id && p.state === "running") ? [parent, review] : null;
}

/**
 * Combine the reviewers' parts once none is running: the issues they all found (each with who found it, when there
 * are several), and issues if there are any, passed if they all passed, else failed (or stopped if they all were).
 */
function combine(r: Review) {
  if (r.reviewers.some((p) => p.state === "running")) {
    r.state = "running";
    return;
  }
  const several = r.reviewers.length > 1;
  r.issues = r.reviewers.flatMap((p) => p.issues.map((i) => (several ? `(${p.label}) ${i}` : i)));
  const all = (st: string) => r.reviewers.every((p) => p.state === st);
  r.state = r.issues.length ? "issues" : all("passed") ? "passed" : all("stopped") ? "stopped" : "failed";
  if (r.reviewers.length === 1) {
    r.summary = r.reviewers[0].summary;
  } else {
    const each = r.reviewers.filter((p) => p.summary != null).map((p) => `**${p.label}:** ${p.summary}`);
    r.summary = each.length ? each.join("\n\n") : null;
  }
  delete r.verdict;
  if (r.state === "passed") {
    // The next review that finds issues starts a cycle of the project's rounds, without any added to this one.
    r.fixes = 0;
    r.extra_rounds = 0;
  }
}

/** Whether run `run_id` of the part's thread is its reviewer (see ReviewerRun.after_run). */
function reviewed_by(state: AppState, part: ReviewerRun, run_id: string): boolean {
  const after = part.after_run;
  if (after == null) return true;
  try {
    return db.run_after(state.db(), part.thread_id, run_id, after);
  } catch {
    return false;
  }
}

/**
 * End a reviewer's part of the review in progress with `end`: the part of run `run_id`, if given, else the thread's.
 * Returns the review once that was the last part to finish, combined, for the caller to act on.
 */
function end_part(state: AppState, parent_id: string, thread_id: string, run_id: string | null, end: (p: ReviewerRun) => void): [Task, Review] | null {
  const found = in_progress(state, parent_id, thread_id);
  if (!found) return null;
  const [parent, review] = found;
  const part = review.reviewers.find((p) => p.thread_id === thread_id);
  if (!part) return null;
  if (run_id != null && !reviewed_by(state, part, run_id)) return null;
  end(part);
  delete part.verdict;
  if (part.state !== "issues") part.issues = [];
  combine(review);
  review.updated_at = now();
  try {
    set_review(state, parent.id, review);
  } catch (e) {
    console.error(`failed to record a review: ${err_str(e)}`);
    return null;
  }
  return review.state !== "running" ? [parent, review] : null;
}

/** `submit_review` from a reviewer: record its verdict, acted on when its run ends. */
export function submit(state: AppState, thread: Task, run_id: string, args: any): any {
  if (thread.kind !== "review") throw ApiError.bad("submit_review is only for review threads");
  const found = thread.parent_id != null ? in_progress(state, thread.parent_id, thread.id) : null;
  if (!found) throw ApiError.conflict("no review is in progress, so there's nothing to submit");
  const [parent, review] = found;
  const part = review.reviewers.find((p) => p.thread_id === thread.id);
  if (!part) throw ApiError.conflict("no review is in progress");
  // From a run of an earlier round (a call retried late, say): this round isn't its.
  if (!reviewed_by(state, part, run_id)) throw ApiError.conflict("the review this run was asked for has ended, so there's nothing to submit");
  const si = args?.serious_issues;
  const issues: string[] = Array.isArray(si)
    ? si.filter((i) => typeof i === "string").map((i: string) => i.trim()).filter((i) => i !== "")
    : typeof si === "string" && si.trim() !== ""
      ? [si.trim()]
      : [];
  const sum = args?.summary;
  part.summary = typeof sum === "string" && sum.trim() !== "" ? sum.trim() : null;
  // A reviewer that wants fixes but didn't list them separately described them in its summary.
  if (args?.verdict === "needs_fixes" && !issues.length) {
    issues.push(part.summary ?? "The reviewer asked for fixes without saying what they are; see the review thread.");
  }
  part.verdict = issues.length ? "issues" : "pass";
  const minor = stats.minor_list(args);
  // A review started before rounds were kept: its round as the backfill works them out, which
  // its other reviewers' submissions share.
  const round = review.started_at != null ? review.started_at : stats.run_round(state.db(), parent.id, run_id);
  stats.record_now(state.db(), {
    task_id: parent.id,
    thread_id: thread.id,
    round,
    run_id,
    verdict: part.verdict,
    serious: issues.length,
    minor: minor ? minor.length : 0,
    summary: part.summary,
    label: part.label,
  });
  part.issues = issues;
  review.updated_at = now();
  set_review(state, parent.id, review);
  return { ok: true, note: "Recorded. End your turn now with a short summary of the review." };
}

/** The task's agent started working again: the review in progress is out of date. The task is reviewed again when the agent finishes. */
export function supersede(state: AppState, task: Task) {
  stop_review(state, task.id, "Stopped because the agent started working on the task again.");
}

/** The user stopped the task: stop its review too, if one is in progress. Returns whether one was. */
export function stop(state: AppState, task_id: string): boolean {
  const stopped = stop_review(state, task_id, "Stopped by the user.");
  if (stopped) state.add_event(task_id, "warn", "Review stopped");
  return stopped;
}

/** Stop the task's review in progress, if there is one, saying `why`. Returns whether there was. */
function stop_review(state: AppState, task_id: string, why: string): boolean {
  let current: Review | null = null;
  try {
    current = db.get_task(state.db(), task_id)?.review ?? null;
  } catch {}
  if (!current || current.state !== "running") return false;
  const review = with_parts(structuredClone(current));
  const running = review.reviewers.filter((p) => p.state === "running").map((p) => p.thread_id);
  for (const p of review.reviewers.filter((p) => p.state === "running")) {
    p.state = "stopped";
    delete p.verdict;
    p.summary = why;
  }
  review.state = "stopped";
  delete review.verdict;
  review.issues = [];
  review.summary = why;
  review.updated_at = now();
  try {
    set_review(state, task_id, review);
  } catch (e) {
    console.warn(`failed to update a review: ${err_str(e)}`);
  }
  for (const id of running) runner.stop(state, id);
  return true;
}

/**
 * Reviewer run `run_id` ended: record its part of the review. Once they've all finished, record the outcome on the
 * task, and send serious issues to its agent.
 */
export function finished(state: AppState, thread: Task, run_id: string, outcome: Outcome, attention: string | null | undefined) {
  const parent_id = thread.parent_id;
  if (parent_id == null) return;
  const [kind, error] = outcome_of(outcome);
  const ended = end_part(state, parent_id, thread.id, run_id, (part) => {
    let st: string;
    let sum: string | null;
    if (kind === "cancelled") [st, sum] = ["stopped", "The review was stopped."];
    else if (kind === "failed") [st, sum] = ["failed", `The review failed: ${first_line(error)}`];
    else if (attention != null) [st, sum] = ["failed", `The reviewer asked: ${attention}`];
    else if (part.verdict == null) [st, sum] = ["failed", "The reviewer finished without submitting a verdict."];
    else if (part.verdict === "pass") [st, sum] = ["passed", part.summary];
    else [st, sum] = ["issues", part.summary];
    part.state = st;
    part.summary = sum;
  });
  if (ended) act(state, ended[0], ended[1]);
}

/** Every reviewer has finished: act on their combined review. */
function act(state: AppState, parent: Task, review: Review) {
  const save = (r: Review) => {
    try {
      set_review(state, parent.id, r);
    } catch (e) {
      console.error(`failed to record a review: ${err_str(e)}`);
    }
  };
  if (review.state === "passed") {
    state.add_event(parent.id, "info", "Review passed", review.summary);
    summary.on_review_passed(state, parent.id);
  } else if (review.state === "issues") {
    let rounds = 0;
    if (parent.project_id != null) {
      try {
        rounds = db.get_project(state.db(), parent.project_id)?.review_rounds ?? 0;
      } catch {}
    }
    send_issues(state, parent, review, rounds, save);
  } else {
    state.add_event(parent.id, "warn", "Review didn't finish", review.summary);
  }
}

/**
 * Ask the task's agent to fix what the review found, if it's still waiting in "In review" and hasn't had its `rounds`
 * of fixes already. Otherwise it's flagged for the user.
 */
export function send_issues(state: AppState, task: Task, review: Review, rounds: number, save: (r: Review) => void) {
  const list = listed(review);
  const what = found(review);
  if (task.status !== "in_review" || state.is_running(task.id)) {
    // The user (or the agent) has moved on; leave the findings for them.
    save(review);
    state.add_event(task.id, "warn", what, list);
    return;
  }
  if (review.fixes >= rounds + review.extra_rounds) {
    save(review);
    state.add_event(task.id, "warn", what, list);
    const reason = review.fixes === 0 ? what : review.fixes === 1 ? `${what} after a round of fixes` : `${what} after ${review.fixes} rounds of fixes`;
    try {
      state.update_task(task.id, [
        ["status", "needs_attention"],
        ["attention_reason", reason],
      ]);
    } catch (e) {
      console.error(`failed to flag a task: ${err_str(e)}`);
    }
    return;
  }
  review.fixes += 1;
  save(review);
  try {
    runner.send_fixes(state, task.id, fixes_prompt(review), review.fixes);
  } catch (e) {
    state.add_event(task.id, "error", "Couldn't send the review's issues to the agent", err_str(e));
  }
}

/** How many serious issues a review found, e.g. "The 2 reviewers found 3 serious issues". */
function found(review: Review): string {
  const n = review.issues.length;
  const issues = n === 1 ? "serious issue" : "serious issues";
  const k = review.reviewers.length;
  return k <= 1 ? `The review found ${n} ${issues}` : `The ${k} reviewers found ${n} ${issues}`;
}

/** A review's serious issues as a numbered list. */
function listed(review: Review): string {
  return review.issues.map((s, i) => `${i + 1}. ${s}`).join("\n\n");
}

/** What a review found, for the task's agent to fix. */
function fixes_prompt(review: Review): string {
  // Each reviewer reports what it found, so two may describe the same problem.
  const overlap = review.reviewers.length > 1 ? "Each issue says which reviewer found it, and some may be the same problem. " : "";
  return (
    `${found(review)} in your changes:\n\n${listed(review)}\n\n${overlap}Fix them, then commit (and push, if the branch has a pull request), and end ` +
    "with a summary of what you changed. You don't have to agree with the reviewer: if you think an issue is mistaken, or " +
    "fixing it needs a decision or information from the user, leave that issue alone and call `request_user_input` " +
    'explaining your reasoning or question, so the task moves to "Needs attention" for the user to decide.'
  );
}

/**
 * Give a task whose review still found serious issues after its rounds of fixes another `review_rounds` of them (at
 * least one): its agent is sent the issues to fix, as when it had rounds left, and the task is reviewed again when it
 * finishes (HA-106, API 93). A review the user asks for starts afresh, without them.
 */
export function extend(state: AppState, task_id: string): Task {
  const task = db.get_task(state.db(), task_id);
  if (!task) throw ApiError.not_found("task");
  const project = task.project_id != null && task.kind === "task" ? db.get_project(state.db(), task.project_id) : null;
  if (!project) throw ApiError.conflict("only tasks in a project are reviewed");
  const previous = task.review;
  if (!previous || previous.state !== "issues" || !previous.issues.length) throw ApiError.conflict("the task's latest review didn't find issues to fix");
  if (previous.fixes < project.review_rounds + previous.extra_rounds) throw ApiError.conflict("the task hasn't used up its rounds of fixes");
  if (state.is_running(task.id)) throw ApiError.conflict("the agent is working on the task; wait for it to finish or stop it");
  if (task.status === "done" || task.merging) throw ApiError.conflict("the task is done or merging; move it to another column first");
  const review = structuredClone(previous);
  review.extra_rounds += Math.max(project.review_rounds, 1);
  review.fixes += 1;
  set_review(state, task.id, review);
  const more = review.extra_rounds - previous.extra_rounds;
  try {
    const t = runner.send_fixes(state, task_id, fixes_prompt(review), review.fixes);
    const rounds = more === 1 ? "another round of fixes" : `${more} more rounds of fixes`;
    state.add_event(task_id, "info", `Given ${rounds}`);
    return t;
  } catch (e) {
    // Unless something changed it meanwhile, it's as it was, so it can be tried again.
    const current = db.get_task(state.db(), task_id)?.review;
    if (current && current.fixes === review.fixes && current.extra_rounds === review.extra_rounds && current.updated_at === review.updated_at) {
      set_review(state, task_id, previous);
    }
    throw e;
  }
}
