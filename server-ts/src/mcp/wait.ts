// Port of server/src/mcp/wait.rs.
//
// The `wait` tool: an agent with nothing to do until something happens (the tasks it created move on, CI finishes, a
// deploy comes up) waits in the tool call, rather than polling or ending its turn. Meanwhile its task stays in its
// column, and the board shows it as waiting rather than working (`Task.agent_wait`), with the reason the agent gave.
// This isn't `Task.waiting`, which is a task queued for its dependencies before its agent starts.
//
// The call returns at the first of:
// - the end of the wait period (`seconds`, `DEFAULT_SECS` unless given, at most `MAX_SECS`; `UNWATCHED_MAX_SECS`, by
//   default and at most, for a wait with neither `tasks` nor a `command`);
// - a change of status of one of the tasks it watches (`tasks`), or one being deleted;
// - one of its subagents completing, failing or stopping;
// - the exit of the shell command it was given (`command`), which runs in the agent's working directory while it waits:
//   that can check on anything the board can't see (CI, a deploy, a file), by blocking until it's ready or looping until
//   it is. It's approved like the agent's own Bash calls, and stopped with everything it started once the wait ends;
// - news about the pull request it was given (`pull_request`): its checks finished, someone commented or reviewed, it
//   conflicts with its base, or it was merged or closed. The server reads it from GitHub every minute or so as the
//   task's GitHub account (see mcp/pr_watch.ts);
// - a message sent to the agent (by the user or `send_to_task`), which it reads after the call;
// - the run being stopped, or the task moved to another column, from the board or with `update_task` ("Needs
//   attention" included; the board's own moves there and back for a subagent's permission prompt don't count);
// - the run carrying on with other work: another board tool call (the helper runs calls concurrently, and a subagent's
//   calls come through it too) or a tool call of the agent's own thread (Claude's stream-json or Codex's items).
//   Subagents' tool calls don't count, so an agent can wait for its subagents, and neither do permission prompts, which
//   subagents raise through the helper too (the agent's own tool calls show up before their prompts).
//
// The task shows as waiting exactly as long as the call: that ends when the call returns (whichever way, errors
// included), and failing that (the agent gave up on the call) when its turn or run ends. A server restart doesn't start
// a wait over: the helper retries the same call, which carries on with the stored wait and its deadline (running its
// command again from the start, and reading its pull request again straight away).
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import * as db from "../db.ts";
import type { AgentWait, Conn, Run, Task, WaitTask } from "../db.ts";
import type { Shared } from "../state.ts";
import * as runner from "../agent/runner.ts";
import * as runs from "../agent/runs.ts";
import * as pr_watch from "./pr_watch.ts";
import { context, err_str, new_id, now } from "../util.ts";
import * as history from "../threads/history.ts";

export const DEFAULT_SECS = 600;
export const MAX_SECS = 3600;

/**
 * The longest a wait with neither tasks to watch nor a command can be (and its default). Only a message or a subagent
 * can end one early, so agents waiting for CI or a deploy that way would sleep on long after it's ready: they wait again
 * (and check) every so often instead, or give a command that exits once it's ready.
 */
export const UNWATCHED_MAX_SECS = 30;

/** How much of the end of a command's output the tool returns (bytes). */
const OUTPUT_MAX = 4000;

/** Whether this runs under `node --test` (Rust's `cfg!(test)`). */
const TEST = process.execArgv.some((a) => a.startsWith("--test"));

/** How often (ms) a wait checks for what no task event announces (its run being stopped). */
export const TICK = TEST ? 200 : 5000;

/** Why a wait ended. */
export type Ended =
  /** The wait period is over. */
  | { kind: "Timeout" }
  /** These watched tasks (ids) changed status or were deleted. */
  | { kind: "Tasks"; tasks: string[] }
  /** A subagent finished, with its id, status and summary. */
  | { kind: "Subagent"; agent: any }
  /** A message was sent to the agent. */
  | { kind: "Message" }
  /** The run was stopped. */
  | { kind: "Stopped" }
  /** The run carried on with other work (see `resumed`), or the wait was cleared under it. */
  | { kind: "Resumed" }
  /** The task was moved to this column. */
  | { kind: "Moved"; status: string }
  /** The wait's command exited, with this code (null if a signal ended it) and the end of its output. */
  | { kind: "Command"; code: number | null; output: string }
  /** There's news about the wait's pull request (see pr_watch::compare), or it couldn't be read. */
  | { kind: "PullRequest"; news: any };

/** `Ended::name`: what the tool's `ended` says. */
export function name(e: Ended): string {
  switch (e.kind) {
    case "Timeout":
      return "timeout";
    case "Tasks":
      return "tasks_changed";
    case "Subagent":
      return "subagent_finished";
    case "Message":
      return "message";
    case "Stopped":
      return "stopped";
    case "Resumed":
      return "resumed";
    case "Moved":
      return "task_moved";
    case "Command":
      return "command_exited";
    case "PullRequest":
      return "pull_request";
  }
}

/** The wait stored for the call `call_id`, if it's that call again (retried after a restart), which carries on with it rather than starting over. */
export function resuming(task: Task, call_id: string): AgentWait | null {
  return task.agent_wait && task.agent_wait.call_id === call_id ? task.agent_wait : null;
}

/** What a `wait` call asks for. */
export interface Request {
  reason: string | null;
  seconds: number | null;
  /** The tasks to watch, with their keys and current status. */
  tasks: WaitTask[];
  /** A shell command to run while waiting (already approved), in the agent's working directory. */
  command: string | null;
  /** A pull request whose news ends the wait. */
  pull_request: pr_watch.Request | null;
}

export function Request_default(): Request {
  return { reason: null, seconds: null, tasks: [], command: null, pull_request: null };
}

/** The task events a wait looks out for, from before anything is read (a broadcast receiver). */
class TaskEvents {
  private queued: string[] = [];
  private waiter: { ids: Set<string>; wake: () => void } | null = null;
  close: () => void;
  constructor(s: Shared) {
    this.close = s.events.subscribe((ev: any) => {
      if (ev?.type !== "task" || typeof ev.task?.id !== "string") return;
      const id: string = ev.task.id;
      if (this.waiter) {
        if (this.waiter.ids.has(id)) this.waiter.wake();
      } else this.queued.push(id);
    });
  }

  /** Until a change to one of the tasks `ids`, or `ms` go by. */
  next(ids: Set<string>, ms: number): Promise<void> {
    const i = this.queued.findIndex((id) => ids.has(id));
    if (i >= 0) {
      this.queued.splice(0, i + 1);
      return Promise.resolve();
    }
    this.queued = [];
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiter = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiter = { ids, wake: done };
    });
  }
}

/**
 * Wait in the call `call_id` of `run` (on `task`) until the period is over or something happens, showing the task as
 * waiting meanwhile. A call that's `resuming` keeps the tasks, command and pull request it started with. Returns how the
 * wait ended and the wait as it was then (with the tasks it watched, and its pull request's news).
 */
export async function wait(s: Shared, run: Run, task: Task, call_id: string, req: Request): Promise<[Ended, AgentWait]> {
  // Subscribed before anything is read, so no change can slip in between.
  const events = new TaskEvents(s);
  let watcher: pr_watch.Watcher | null = null;
  try {
    let w: AgentWait;
    const stored_wait = resuming(task, call_id);
    if (stored_wait) w = structuredClone(stored_wait);
    else {
      const secs = period(req);
      // Read before the wait starts, so a pull request that can't be read doesn't start it.
      let pull_request: db.WaitPr | null = null;
      const pr = req.pull_request;
      if (pr) {
        const wt = pr_watch.Watcher.new(s, task, pr.target);
        let news: any;
        try {
          news = await wt.poll(s, task.id, call_id, pr.events);
        } catch (e) {
          wt.drop();
          // A host from the task's remote may be an SSH alias that couldn't be looked up.
          const hint = pr.target.host === "github.com" ? "" : ` (if ${pr.target.host} isn't a GitHub host, give the pull request's URL)`;
          throw new Error(`The wait didn't start: ${pr.target.label()} couldn't be read: ${err_str(e)}${hint}`);
        }
        watcher = wt;
        pull_request = pr_watch.stored(pr, news);
      }
      const until = new Date(Date.now() + Math.trunc(secs * 1000)).toISOString();
      const reason = req.reason?.trim() || null;
      const command = req.command?.trim() || null;
      w = { reason, since: now(), until, tasks: req.tasks, call_id, run_id: run.id } as AgentWait;
      if (command !== null) w.command = command;
      if (pull_request !== null) w.pull_request = pull_request;
      // Keys in the order serde writes them.
      w = order_wait(w);
      s.update_task(task.id, [["agent_wait", w]]);
    }
    let ended: Ended | null = null;
    let failure: unknown = null;
    try {
      ended = await wait_out(s, task, w, events, watcher);
    } catch (e) {
      failure = e;
    }
    // As it is now, with what came in meanwhile (a pull request's news), before it's cleared.
    let last = w;
    try {
      const t = db.get_task(s.db(), task.id);
      if (t?.agent_wait && t.agent_wait.call_id === call_id) last = t.agent_wait;
    } catch {}
    clear(s, task.id, call_id);
    if (failure !== null || ended === null) throw failure;
    // The call returns its pull request's news (whatever ended it), unless the agent won't see it.
    const pr = last.pull_request;
    if (pr && pr.news != null && ended.kind !== "Stopped" && ended.kind !== "Resumed") pr_watch.delivered(s, task.id, call_id, pr);
    return [ended, last];
  } finally {
    events.close();
    watcher?.drop();
  }
}

function order_wait(w: AgentWait): AgentWait {
  const o: any = { reason: w.reason, since: w.since, until: w.until, tasks: w.tasks };
  if (w.command !== undefined) o.command = w.command;
  o.call_id = w.call_id;
  o.run_id = w.run_id;
  if (w.moved_to !== undefined) o.moved_to = w.moved_to;
  if (w.subagent_finished !== undefined) o.subagent_finished = w.subagent_finished;
  if (w.pull_request !== undefined) o.pull_request = w.pull_request;
  return o;
}

/** How long a new wait asked for lasts (in seconds); throws why it doesn't start: see `UNWATCHED_MAX_SECS`. */
export function period(req: Request): number {
  const unwatched = req.tasks.length === 0 && !(req.command ?? "").trim() && req.pull_request === null;
  const max = unwatched ? UNWATCHED_MAX_SECS : MAX_SECS;
  const secs = req.seconds;
  if (secs !== null && secs !== undefined) {
    if (unwatched && secs > max) {
      throw new Error(
        `The wait didn't start: without a command, tasks or a pull request, a wait lasts ${max} seconds at most, because little but a ` +
          `message or a subagent can end it early, so it would carry on long after what you're waiting for is ready. Either give the ` +
          `pull_request you're waiting on (its checks, reviews or merge), a command that exits once it's ready (e.g. 'until curl -sf ` +
          `https://example.com/health; do sleep 15; done'), list the tasks you're waiting for in tasks, or wait ${max} seconds at a ` +
          `time, checking in between.`,
      );
    }
    return Math.min(Math.max(secs, 1), max);
  }
  return unwatched ? UNWATCHED_MAX_SECS : DEFAULT_SECS;
}

async function wait_out(s: Shared, task: Task, wait: AgentWait, events: TaskEvents, watcher: pr_watch.Watcher | null): Promise<Ended> {
  const parsed = Date.parse(wait.until);
  const until = Number.isNaN(parsed) ? Date.now() : parsed;
  const ids = new Set(wait.tasks.map((t) => t.id));
  ids.add(task.id);
  const abort = new AbortController();
  let command: RunningCommand | null = null;
  let own_watcher: pr_watch.Watcher | null = null;
  try {
    let cwd = "";
    let env: Array<[string, string]> = [];
    if (wait.command !== undefined && wait.command !== null) {
      // In the agent's working directory; stopped (with everything it started) if the wait ends some other way first.
      cwd = runner.work_dir(s, task);
      // gh in it acts as the task's GitHub account, as the gh tools do, and it doesn't run as another one when that
      // account isn't signed in.
      const gh = await runner.task_gh_env(s, task);
      if (gh) {
        try {
          env = gh.shell_env(s.exe, join(s.data_dir, "gh-shim"));
        } finally {
          gh.drop();
        }
      }
      command = run_command(wait.command, cwd, env);
    }
    // Reads the pull request until there's news, which it records in the wait (see `check`). A wait carried on after a
    // restart reads it straight away.
    let watch: Promise<"read"> | null = null;
    const pr = wait.pull_request;
    if (pr && pr.news == null) {
      let w: pr_watch.Watcher, delay: number;
      if (watcher) [w, delay] = [watcher, pr_watch.POLL];
      else {
        const target = pr_watch.Target.of(pr);
        if (!target) throw new Error(`the wait's pull request ${pr.url}`);
        w = own_watcher = pr_watch.Watcher.new(s, task, target);
        delay = 0;
      }
      watch = pr_watch.watch(s, task.id, wait.call_id, pr.events, w, delay, abort.signal).then(() => "read" as const);
    }
    const exited = command ? command.done.then((r) => ({ exited: r })) : null;
    for (;;) {
      const e = check(s, task.id, wait);
      if (e) return e;
      const left = until - Date.now();
      if (left <= 0) return { kind: "Timeout" };
      // Until a change to one of the tasks involved, the next tick or the deadline.
      const racing: Array<Promise<any>> = [events.next(ids, Math.min(left, TICK)).then(() => "next")];
      if (exited) racing.push(exited);
      if (watch) racing.push(watch);
      const r = await Promise.race(racing);
      if (r === "read") watch = null;
      else if (r !== "next") return { kind: "Command", code: r.exited[0], output: r.exited[1] };
    }
  } finally {
    abort.abort();
    command?.stop();
    own_watcher?.drop();
  }
}

/** A wait's command while it runs: what it ends with, and how to stop it (with everything it started). */
interface RunningCommand {
  /** Its exit code (null if a signal ended it) and the end of its output. */
  done: Promise<[number | null, string]>;
  stop: () => void;
}

/**
 * Run a wait's command with bash in `cwd`, in a process group of its own that's killed once the command exits, or by
 * `stop()` before (the wait ended some other way), so nothing it started outlives it. Its output (stdout and stderr
 * together) goes to a file rather than a pipe, so what the command leaves running can't keep it from being read.
 * Unlinked right away, it goes once it's closed.
 */
function run_command(command: string, cwd: string, env: Array<[string, string]>): RunningCommand {
  const path = join(tmpdir(), `issue-agent-wait-${new_id()}.log`);
  let fd: number;
  try {
    fd = openSync(path, "wx+");
  } catch (e) {
    throw context("creating the command's log", e);
  }
  try {
    unlinkSync(path);
  } catch {}
  let child: ChildProcess, alive: Writable;
  try {
    ({ child, alive } = spawn_command(command, cwd, fd, env));
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  const pid = child.pid;
  let exited = false;
  const kill_group = () => {
    if (pid === undefined) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  };
  const done = new Promise<[number | null, string]>((resolve, reject) => {
    child.once("error", (e) => {
      exited = true;
      alive.destroy();
      try {
        closeSync(fd);
      } catch {}
      reject(context(`running the command in ${cwd}`, e));
    });
    child.once("exit", (code) => {
      exited = true;
      // Killed after the shell exits, as the group goes with what's left in it.
      kill_group();
      alive.destroy();
      try {
        const len = fstatSync(fd).size;
        const start = Math.max(0, len - OUTPUT_MAX);
        const buf = Buffer.alloc(len - start);
        let got = 0;
        while (got < buf.length) {
          const n = readSync(fd, buf, got, buf.length - got, start + got);
          if (n <= 0) break;
          got += n;
        }
        const out = buf.subarray(0, got).toString();
        resolve([code, len > OUTPUT_MAX ? `… [${len - OUTPUT_MAX} bytes before this]\n${out}` : out]);
      } catch (e) {
        reject(context("running the command", e));
      } finally {
        try {
          closeSync(fd);
        } catch {}
      }
    });
  });
  // Raced against other ends of the wait: one that ends it first leaves this unread.
  done.catch(() => {});
  return {
    done,
    stop: () => {
      if (exited) return;
      kill_group();
      alive.destroy();
    },
  };
}

/**
 * Starts a wait's command in a process group with a watchdog: a subshell that waits on its stdin and kills the group
 * once that closes. Its other end is held by the server only (close-on-exec, as libuv opens it), so the kernel closes it
 * however the server goes (restarting with exec, exiting, crashing), none of which run the code that kills the group
 * otherwise. The command itself runs in a bash of its own (exec'd), which doesn't count the watchdog among its jobs.
 */
export const LAUNCH = `exec 3<&0 </dev/null; (read -r _ <&3; kill -KILL 0) & exec 3<&-; exec bash -c "$1"`;

/**
 * Start `command` (see LAUNCH) with its output going to the file `log` (a descriptor). Returns the child and the pipe
 * end that keeps it alive: once that's closed (`destroy()`), the watchdog kills the command's group.
 */
export function spawn_command(command: string, cwd: string, log: number, env: Array<[string, string]>): { child: ChildProcess; alive: Writable } {
  const child = spawn("bash", ["-c", LAUNCH, "issue-agent-wait", command], {
    cwd,
    env: { ...runs.agent_env(), ...Object.fromEntries(env) },
    stdio: ["pipe", log, log],
    // A process group (and session) of its own.
    detached: true,
  });
  const alive = child.stdin!;
  alive.on("error", () => {});
  return { child, alive };
}

/** Whether the wait is over, other than by its deadline. */
function check(s: Shared, task_id: string, wait: AgentWait): Ended | null {
  const run = db.get_run(s.db(), wait.run_id);
  if (!run || run.stop_requested || run.status === "exited") return { kind: "Stopped" };
  const task = db.get_task(s.db(), task_id);
  if (!task) return { kind: "Stopped" };
  // Cleared under it: the run carried on with something else (or its turn ended).
  const current = task.agent_wait && task.agent_wait.call_id === wait.call_id ? task.agent_wait : null;
  if (!current) return { kind: "Resumed" };
  // Only an explicit move counts (see AgentWait.moved_to): the board moves the task to "Needs attention" and back by
  // itself for a subagent's permission prompt.
  if (current.moved_to != null) return { kind: "Moved", status: current.moved_to };
  if (task.queued_message != null || task.steering.some((m) => m.run_id === wait.run_id)) return { kind: "Message" };
  if (current.subagent_finished != null) return { kind: "Subagent", agent: current.subagent_finished };
  const news = current.pull_request?.news;
  if (news != null) return { kind: "PullRequest", news };
  const changed: string[] = [];
  for (const w of wait.tasks) {
    const t = db.get_task(s.db(), w.id);
    if (!t || t.status !== w.status) changed.push(w.id);
  }
  return changed.length ? { kind: "Tasks", tasks: changed } : null;
}

/** The task's agent isn't waiting any more: in the call `call_id` if given, else in any. */
export function clear(s: Shared, task_id: string, call_id: string | null) {
  let waiting: AgentWait | null = null;
  try {
    waiting = db.get_task(s.db(), task_id)?.agent_wait ?? null;
  } catch {}
  if (waiting && (call_id === null || call_id === waiting.call_id)) {
    try {
      s.update_task(task_id, [["agent_wait", null]]);
    } catch (e) {
      console.error(`ERROR task=${task_id}: clearing the agent's wait: ${err_str(e)}`);
    }
  }
}

/** Run `run_id` ended: its wait is over (a later run's isn't). */
export function ended(s: Shared, task_id: string, run_id: string) {
  const its = (c: Conn) => db.get_task(c, task_id)?.agent_wait?.run_id === run_id;
  try {
    s.update_task_if(task_id, [["agent_wait", null]], its);
  } catch (e) {
    console.error(`ERROR task=${task_id}: clearing the agent's wait: ${err_str(e)}`);
  }
}

/** `run` carried on with other work (a board tool call, or a tool call of the agent's own thread): if it was waiting, it isn't any more, and its wait call returns. */
export function resumed(s: Shared, task_id: string, run_id: string) {
  let waiting: AgentWait | null = null;
  try {
    waiting = db.get_task(s.db(), task_id)?.agent_wait ?? null;
  } catch {}
  if (waiting && waiting.run_id === run_id) clear(s, task_id, waiting.call_id);
}

/**
 * A lifecycle notification from Claude or Codex. A terminal status of an Agent/Task child ends this run's wait, but
 * progress, background shell jobs and internal agents don't.
 */
export function subagent_finished(s: Shared, run: Run, event: any): void {
  let raw: any;
  if (event?.subtype === "task_notification") raw = event.status;
  else if (event?.subtype === "task_updated") raw = event.patch?.status;
  else return;
  let status: string;
  if (raw === "completed" || raw === "success") status = "completed";
  else if (raw === "failed" || raw === "error") status = "failed";
  else if (["killed", "stopped", "cancelled", "interrupted"].includes(raw)) status = "stopped";
  else return;
  // One read and write with nothing in between: another call can resume the agent or start a new wait while output
  // arrives. Don't overwrite that wait or a concurrent board move.
  const c = s.db();
  const w = db.get_task(c, run.task_id)?.agent_wait;
  if (!w || w.run_id !== run.id || w.subagent_finished != null) return;
  const id = history.subagent_call(c, run.task_id, event);
  if (id === null) return;
  w.subagent_finished = { status, summary: event.summary ?? null, task_id: event.task_id ?? null, tool_use_id: id };
  const changed = db.update_task(c, run.task_id, [["agent_wait", order_wait(w)]]);
  if (changed) s.emit_task(changed);
}

/** Whether a stream-json event from the agent is its own thread (not a subagent) calling a tool other than `wait`. */
export function is_activity(v: any): boolean {
  return (
    v?.type === "assistant" &&
    v.parent_tool_use_id == null &&
    Array.isArray(v.message?.content) &&
    v.message.content.some((b: any) => b?.type === "tool_use" && !(typeof b.name === "string" && is_wait_tool(b.name)))
  );
}

/** Whether a tool, as an agent's tool calls name it, is this one. */
export function is_wait_tool(tool: string): boolean {
  if (!tool.startsWith("mcp__") || !tool.endsWith("__wait")) return false;
  const n = tool.slice(5, tool.length - 6);
  return tool.length >= 11 && runner.is_board_server(n);
}

/** What the tool tells the agent about how its wait ended. */
export function note(e: Ended, keys: string[]): string {
  switch (e.kind) {
    case "Timeout":
      return "The wait period is over. Check on what you were waiting for, and wait again if it isn't ready yet.";
    case "Tasks":
      return `${keys.join(", ")} changed status (see tasks).`;
    case "Subagent":
      return "A subagent finished (see subagent).";
    case "Message":
      return "A message was sent to you; you'll read it once this call returns.";
    case "Stopped":
      return "The run was stopped.";
    case "Resumed":
      return "The wait ended because you carried on with other work (another tool call).";
    case "Moved":
      return `The task was moved to ${e.status} on the board.`;
    case "Command":
      return e.code !== null ? `Your command exited with code ${e.code} (see command.output).` : "Your command was ended by a signal (see command.output).";
    case "PullRequest":
      return pr_watch.note(e.news);
  }
}
