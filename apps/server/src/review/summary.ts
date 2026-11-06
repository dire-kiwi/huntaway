// Port of server/src/review/summary.rs.
/**
 * Summaries of a task's changes. Once a task's review passes (see review.ts), an agent of the project's choosing (its
 * `summarizer`, or else its profile's, or the task's own config) reads the work and writes a summary of what changed for
 * the user to read before merging it. It works read-only in the task's worktree, in a thread of its own: a `review` task
 * of type `summary` whose `parent_id` is the task, so it's run like a reviewer (see agent/runner.ts) but isn't one of its
 * reviewers. Its last message is the summary, kept in the task's `summary` with the commit it describes, which the
 * task's sidebar opens on while the task waits in "In review".
 *
 * A summary in progress is stopped when the task's agent starts working again, and a new one is written when the next
 * review passes.
 *
 * (Rust's `UPDATING` lock has no counterpart: what it guards is synchronous here.)
 */
import { isDeepStrictEqual } from "node:util";
import * as db from "../db.ts";
import type { ChangeSummary, Reviewer, Task } from "../db.ts";
import * as runner from "../agent/runner.ts";
import type { Outcome } from "../agent/runner.ts";
import * as runs from "../agent/runs.ts";
import * as context from "../agent/context.ts";
import * as worktree from "../git/worktree.ts";
import * as review from "../review.ts";
import { ApiError, AsyncMutex, type AppState } from "../state.ts";
import { err_str, now } from "../util.ts";
import * as history from "../threads/history.ts";

/** The task type of a summary thread. */
export const SUMMARY = "summary";

/** Held while starting a summary, so two can't start on one task at once. */
let STARTING: AsyncMutex | null = null;

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? null) === (b ?? null);
const non_blank = (s: string | null | undefined): string | null => (s != null && s.trim() !== "" ? s : null);

/** Whether `thread` is a summary thread. */
export function is_summary(thread: Task): boolean {
  return thread.kind === "review" && thread.task_type === SUMMARY;
}

/** The task's review passed: summarise its changes in the background, if its project wants that. */
export function on_review_passed(state: AppState, task_id: string) {
  start(state, task_id, false).catch((e) => {
    console.warn(`task ${task_id}: couldn't start a summary: ${err_str(e)}`);
    state.add_event(task_id, "warn", "Couldn't summarise the changes", err_str(e));
  });
}

function skip<T>(manual: boolean, why: string): T | null {
  if (manual) throw ApiError.conflict(`Can't summarise: ${why}`);
  return null;
}

/**
 * Summarise a task's changes. `manual` (the user asked for it) summarises whatever the task's review and column, even
 * when the project doesn't summarise or this commit has a summary already, and says why when it can't. Returns the
 * task, or null when there was nothing to do.
 */
export async function start(state: AppState, task_id: string, manual: boolean): Promise<Task | null> {
  const release = await (STARTING ??= new AsyncMutex()).lock();
  try {
    return await start_locked(state, task_id, manual);
  } finally {
    release();
  }
}

/** One summarizer's part of a summary being started. */
interface Plan {
  spec: Reviewer;
  /** Whether its agent is Codex, which is asked for skills differently. */
  codex: boolean;
  config_id: string | null;
  model: string | null;
  effort: string | null;
  /** What tells its thread from the others' with the same agent (see `variant_key`). */
  variant: string;
  label: string;
}

async function start_locked(state: AppState, task_id: string, manual: boolean): Promise<Task | null> {
  const task = db.get_task(state.db(), task_id);
  if (!task) throw ApiError.not_found("task");
  const project = task.project_id != null && task.kind === "task" ? db.get_project(state.db(), task.project_id) : null;
  if (!project) return skip(manual, "only tasks in a project have their changes summarised");
  if (!manual) {
    // Only a review that has passed (and the task's agent hasn't gone back to work since).
    const passed = task.review?.state === "passed";
    if (!project.auto_summary || !passed || task.status !== "in_review") return null;
  }
  const last_run = db.latest_run(state.db(), task.id, null);
  if (state.is_running(task.id)) return skip(manual, "the agent is still working");
  if (!runs.can_run_agents(state)) return skip(manual, "this host can't run agents");
  const dir = task.worktree_state === "ready" ? (task.worktree_path ?? null) : null;
  const branch = task.branch ?? null;
  if (dir == null || branch == null) return skip(manual, "the task has no worktree branch to summarise");
  const previous = task.summaries;
  if (previous.some((s) => s.state === "running")) return skip(manual, "a summary is already being written");
  const head = await review.rev_parse(dir, "HEAD");
  if (head == null) throw ApiError.bad("couldn't read the worktree's HEAD commit");
  // What the reviewers had as its work, too.
  const [base, own_start] = await worktree.work_scope(state, dir, task, project);
  let elsewhere = false;
  if (base != null) {
    const o = await worktree.git(dir, ["merge-base", base, "HEAD"]).catch(() => null);
    elsewhere = (o && o.ok ? o.stdout.trim() : null) === head;
  }

  // Each summarizer writes in a thread of its own, kept from one summary to the next while
  // its config, model, effort, name, skills and prompt stay the same.
  const task_config = db.task_claude_config(state.db(), task);
  const key = `${project.key}-${task.number}`;
  const plans: Plan[] = [];
  for (const spec of db.summarizers_for(state.db(), project)) {
    // A summarizer whose config was deleted writes with the task's.
    const config = spec.claude_config_id != null ? (db.get_claude_config(state.db(), spec.claude_config_id) ?? task_config) : task_config;
    const config_id = config?.id ?? null;
    const model = non_blank(spec.model);
    const effort = non_blank(spec.effort);
    const variant = variant_key(spec);
    // Two the same would share a thread.
    if (plans.some((p) => same(p.config_id, config_id) && same(p.model, model) && same(p.effort, effort) && p.variant === variant)) continue;
    const label = review.label(config, model, effort);
    plans.push({ spec, codex: config != null && db.is_codex(config), config_id, model, effort, variant, label });
  }
  const threads = db.summary_threads(state.db(), task.id);
  const writing: Array<[Plan, Task]> = [];
  const summaries: ChangeSummary[] = [];
  for (const plan of plans) {
    const name = plan.spec.name?.trim();
    const title = name ? `Summary of ${key} · ${name}` : `Summary of ${key}`;
    let thread = threads.find(
      (t) => same(t.claude_config_id, plan.config_id) && same(t.model, plan.model) && same(t.effort, plan.effort) && t.description === plan.variant,
    );
    if (!thread) {
      const t = db.insert_task(state.db(), {
        profile_id: task.profile_id,
        project_id: project.id,
        kind: "review",
        title,
        description: plan.variant,
        status: "todo",
        use_worktree: false,
        model: plan.model,
        effort: plan.effort,
        claude_config_id: plan.config_id,
      });
      const updated = state.update_task(t.id, [
        ["parent_id", task.id],
        ["task_type", SUMMARY],
      ]);
      if (!updated) throw ApiError.not_found("summary thread");
      thread = updated;
    }
    // Already summarised at this commit, and not asked for again.
    if (!manual) {
      const th = thread;
      const done = previous.find((s) => s.thread_id === th.id && s.state === "done" && s.head === head);
      if (done) {
        summaries.push(structuredClone(done));
        continue;
      }
    }
    if (thread.title !== title) state.update_task(thread.id, [["title", title]]);
    if (state.is_running(thread.id)) {
      throw ApiError.conflict(`the summary thread's agent (${plan.label}) is busy; wait for it to finish or stop it`);
    }
    const after_run = db.latest_run(state.db(), thread.id, null) ?? "";
    const skills = plan.spec.skills ?? [];
    // The board's skills it names are on in its thread, whether or not they are for the project.
    db.set_thread_skills(state.db(), thread.id, skills);
    const s: ChangeSummary = { thread_id: thread.id, label: plan.label, state: "running", head, text: null, after_run, updated_at: now() };
    const nm = non_blank(plan.spec.name);
    if (nm != null) s.name = nm;
    if (skills.length) s.skills = [...skills];
    if (plan.spec.prompt != null) s.custom_prompt = true;
    summaries.push(order(s));
    writing.push([plan, thread]);
  }
  if (!writing.length) {
    // Nothing to write, but summarizers taken out or reordered since change which summaries it has.
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(summaries)), JSON.parse(JSON.stringify(previous)))) set_summaries(state, task.id, summaries);
    return null;
  }
  const commit = head.slice(0, 10);
  const last_message = elsewhere ? history.last_assistant_text(state.db(), task.id) : null;
  const texts: string[] = [];
  for (const [plan, thread] of writing) {
    texts.push(prompt(key, task, branch, base, commit, elsewhere, own_start, last_message, plan.spec, plan.codex));
    // A fresh conversation for each summary; the thread keeps every one's messages.
    state.update_task(thread.id, [["session_id", null]]);
    context.clear(state, thread.id);
  }
  // The agent may have started again meanwhile (and `supersede` found nothing to stop).
  const later = db.later_run(state.db(), task.id, last_run ?? "");
  if (later || state.is_running(task.id)) return skip(manual, "the agent is working again");
  set_summaries(state, task.id, summaries);
  const sent: Array<{ ok: Task } | { err: unknown }> = writing.map(([, thread], i) => {
    state.add_event(thread.id, "info", `Summarising commit ${commit}`);
    try {
      return { ok: runner.send_review(state, thread.id, texts[i]) };
    } catch (e) {
      return { err: e };
    }
  });
  // Those that couldn't start have failed.
  const failed: Array<[string, string]> = [];
  writing.forEach(([, t], i) => {
    const r = sent[i];
    if ("err" in r) failed.push([t.id, err_str(r.err)]);
  });
  if (failed.length) {
    for (const s of summaries) {
      const f = failed.find(([id]) => id === s.thread_id);
      if (f) {
        s.state = "failed";
        s.text = `Couldn't start the summary: ${f[1]}`;
        s.updated_at = now();
      }
    }
    set_summaries(state, task.id, summaries);
  }
  if (sent.every((r) => "err" in r)) throw (sent.find((r) => "err" in r) as { err: unknown }).err;
  state.add_event(task.id, "info", `Summarising the changes (commit ${commit})`);
  return db.get_task(state.db(), task.id);
}

/** A summary's fields in the order Rust's struct has them (so it's written as the Rust server writes it). */
function order(s: ChangeSummary): ChangeSummary {
  const o: any = { thread_id: s.thread_id, label: s.label };
  if (s.name !== undefined) o.name = s.name;
  if (s.skills !== undefined) o.skills = s.skills;
  if (s.custom_prompt !== undefined) o.custom_prompt = s.custom_prompt;
  Object.assign(o, { state: s.state, head: s.head, text: s.text });
  if (s.after_run !== undefined) o.after_run = s.after_run;
  o.updated_at = s.updated_at;
  return o;
}

/**
 * What, besides its agent, tells a summarizer's thread from another's: its name, skills and prompt as text (empty if
 * it has none, as the threads written before there could be several). serde_json's object, whose keys are sorted.
 */
export function variant_key(spec: Reviewer): string {
  const name = spec.name?.trim() ?? "";
  const prompt = spec.prompt?.trim() ?? "";
  const skills = spec.skills ?? [];
  if (name === "" && prompt === "" && !skills.length) return "";
  return JSON.stringify({ name, prompt, skills });
}

/** How the board asks for a summary to be written, unless the summarizer has a prompt of its own. */
const DEFAULT_WRITING =
  "\nThe user reads your summary before they merge the work, to see what it does without reading the whole diff. Write " +
  "it in Markdown, briefly: start with a sentence or two on what changed and why, then the main changes (grouped by " +
  "area, naming the files or modules where it helps), any decisions or behaviour changes worth knowing about, and " +
  "how to try it if that isn't obvious. Leave out what the diff makes plain at a glance, and don't review the work or " +
  "pad it out.\n";

/** How much of the agent's last message goes in the prompt. */
const LAST_MESSAGE_CHARS = 6000;

/**
 * Where the work is (on the branch, or `elsewhere` when the branch has no commits of its own and the agent's
 * `last_message` says where; `own_start` when it starts after where it left its base branch, at `base`, see
 * worktree::work_scope), and how to write the summary.
 */
export function prompt(
  key: string,
  task: Task,
  branch: string,
  base: string | null,
  commit: string,
  elsewhere: boolean,
  own_start: boolean,
  last_message: string | null,
  spec: Reviewer,
  codex: boolean,
): string {
  let p = `Summarise the changes made for task ${key}: "${task.title}".\n`;
  if (task.description.trim() !== "") p += `\nThe task's description:\n\n${task.description.trim()}\n`;
  if (!elsewhere && own_start && base != null) {
    const b = base;
    p +=
      `\nThe work is on branch \`${branch}\` (commit ${commit}), checked out in your working directory. It started from ` +
      `commit ${b}, after where it left its base branch, so its pull request's diff (if it has one) also has commits ` +
      `that aren't its own: read the branch's changes (\`git diff ${b}...HEAD\`, and \`git log ${b}..HEAD\`) rather than ` +
      `\`pr_diff\`. Read its pull request with the gh MCP server's \`pr_view\` tool (pr \`${branch}\`) only for its description.\n`;
  } else if (!elsewhere) {
    const fallback = base != null ? `the branch's changes (\`git diff ${base}...HEAD\`, and \`git log ${base}..HEAD\`)` : "the branch's commits";
    p +=
      `\nThe work is on branch \`${branch}\` (commit ${commit}), checked out in your working directory. Find its pull ` +
      `request with the gh MCP server's \`pr_view\` tool (pr \`${branch}\`) and read its changes (\`pr_diff\`). If it has no ` +
      `pull request, read ${fallback} instead.\n`;
  } else {
    p +=
      `\nThe task's branch \`${branch}\`, checked out in your working directory, has no commits of its own (it's still at ` +
      `commit ${commit}), so the agent made its changes somewhere else, such as in another repository. Find them from ` +
      `what it says it did`;
    if (task.pr_url) p += ` and from the task's pull request, ${task.pr_url}`;
    p += ".\n";
    const m = last_message?.trim();
    if (m) p += `\nThe agent's last message:\n\n${review.quote(review.cut_chars(m, LAST_MESSAGE_CHARS))}\n`;
    else p += "\nThe agent didn't leave a message saying what it did.\n";
  }
  const r = task.review?.summary?.trim();
  if (r) p += `\nIts review passed. The reviewer said:\n\n${review.quote(r)}\n`;
  const custom = spec.prompt?.trim();
  if (custom) p += `\nThe user reads your summary before they merge the work. Write it as they ask:\n\n${custom}\n`;
  else p += DEFAULT_WRITING;
  const skills = spec.skills ?? [];
  if (skills.length) {
    const named = skills.map((s) => `\`${codex ? "$" : "/"}${s}\``);
    p +=
      `\nUse ${skills.length === 1 ? "this skill" : "these skills"} while you write the summary: ${named.join(", ")}${codex ? "" : " (invoke each with the `Skill` tool)"}. ` +
      "If a skill asks for something against the rest of this message (changing files, or ending with more than the summary), follow this message instead.\n";
  }
  p +=
    "\nDon't change anything. Your last message is the summary, shown as it is on the task: end your turn with only the " +
    "summary, without a preamble.";
  return p;
}

function set_summaries(state: AppState, task_id: string, summaries: ChangeSummary[]) {
  state.update_task(task_id, [["summary", summaries.length ? summaries : null]]);
}

/** The summary `thread_id` is writing for the task, if it is. */
function in_progress(state: AppState, task_id: string, thread_id: string): ChangeSummary[] | null {
  let task: Task | null;
  try {
    task = db.get_task(state.db(), task_id);
  } catch {
    return null;
  }
  if (!task) return null;
  return task.summaries.some((s) => s.state === "running" && s.thread_id === thread_id) ? structuredClone(task.summaries) : null;
}

/** The summary thread's run `run_id` ended: its last message is the summary. */
export function finished(state: AppState, thread: Task, run_id: string, outcome: Outcome, attention: string | null | undefined) {
  const parent_id = thread.parent_id;
  if (parent_id == null) return;
  const all = in_progress(state, parent_id, thread.id);
  if (!all) return;
  const summary = all.find((s) => s.thread_id === thread.id);
  if (!summary) return;
  // From an earlier run of the thread (one stopped late, say): this summary isn't its.
  if (summary.after_run != null) {
    let after = false;
    try {
      after = db.run_after(state.db(), thread.id, run_id, summary.after_run);
    } catch {}
    if (!after) return;
  }
  const written = (): string | null => {
    try {
      // What it said after it was asked for this summary.
      const t = history.said_since_asked(state.db(), thread.id)?.trim();
      return t ? t : null;
    } catch {
      return null;
    }
  };
  const [kind, error] = review.outcome_of(outcome);
  let st: string;
  let text: string | null;
  if (kind === "cancelled") [st, text] = ["stopped", "The summary was stopped."];
  else if (kind === "failed") [st, text] = ["failed", `The summary failed: ${review.first_line(error)}`];
  else if (attention != null) [st, text] = ["failed", `The summarizer asked: ${attention}`];
  else {
    const w = written();
    [st, text] = w != null ? ["done", w] : ["failed", "The summarizer finished without writing a summary."];
  }
  summary.state = st;
  summary.text = text;
  summary.updated_at = now();
  const label = summary.label;
  try {
    set_summaries(state, parent_id, all);
  } catch (e) {
    console.error(`failed to record a summary: ${err_str(e)}`);
    return;
  }
  // With several, the event says whose it is.
  const several = all.length > 1;
  const title = (what: string) => (several ? `${what} (${label})` : what);
  if (st === "done") state.add_event(parent_id, "info", title("Changes summarised"));
  else if (st !== "stopped") state.add_event(parent_id, "warn", title("Couldn't summarise the changes"), text);
}

/** The task's agent started working again: the summaries in progress are out of date. */
export function supersede(state: AppState, task: Task) {
  stop_summary(state, task.id, "Stopped because the agent started working on the task again.");
}

/** The user stopped the task: stop its summaries too, if any are being written. Returns whether any was. */
export function stop(state: AppState, task_id: string): boolean {
  return stop_summary(state, task_id, "Stopped by the user.");
}

function stop_summary(state: AppState, task_id: string, why: string): boolean {
  let all: ChangeSummary[] = [];
  try {
    all = structuredClone(db.get_task(state.db(), task_id)?.summaries ?? []);
  } catch {}
  const running: string[] = [];
  for (const summary of all.filter((s) => s.state === "running")) {
    summary.state = "stopped";
    summary.text = why;
    summary.updated_at = now();
    running.push(summary.thread_id);
  }
  if (!running.length) return false;
  try {
    set_summaries(state, task_id, all);
  } catch (e) {
    console.warn(`failed to update a summary: ${err_str(e)}`);
  }
  for (const thread of running) runner.stop(state, thread);
  return true;
}
