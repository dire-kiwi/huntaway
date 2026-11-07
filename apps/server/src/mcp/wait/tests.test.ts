// Port of server/src/mcp/wait/tests.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as db from "../../db.ts";
import type { AgentWait, Run, Task } from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as testing from "../../testing.ts";
import * as runner from "../../agent/runner.ts";
import * as api from "../../api.ts";
import * as permissions from "../permissions.ts";
import * as pr_watch from "../pr_watch.ts";
import { Target, response } from "../pr_watch.ts";
import { err_str, now, sleep } from "../../util.ts";
import {
  TICK,
  Request_default,
  is_activity,
  is_wait_tool,
  name,
  note,
  period,
  resumed,
  spawn_command,
  subagent_finished,
  wait,
  type Ended,
  type Request,
} from "../wait.ts";

/** A task whose agent is running, with another task it can watch. */
function running(): [Shared, Task, Run, Task] {
  const s = testing.state();
  const p = db.insert_profile(s.db(), "p", [], null);
  const fresh = (title: string) =>
    db.insert_task(s.db(), { profile_id: p.id, project_id: null, kind: "task", title, description: "", status: "in_progress", use_worktree: false });
  const task = fresh("planner");
  const other = fresh("other");
  const run = db.insert_run(s.db(), task.id, "prompt");
  db.run(s.db(), "UPDATE runs SET status='running' WHERE id=?1", run.id);
  s.runs.set(task.id, { run_id: run.id, cancel: null });
  const t = s.update_task(task.id, [["running", true]])!;
  return [s, t, run, other];
}

const secs = (seconds: number): Request => ({ ...Request_default(), seconds });

const reload = (s: Shared, id: string): Task => db.get_task(s.db(), id)!;

/** Run `then` once the task shows as waiting. */
function when_waiting(s: Shared, id: string, then: (s: Shared) => void | Promise<void>): Promise<void> {
  return (async () => {
    while (!reload(s, id).agent_wait) await sleep(10);
    await then(s);
  })();
}

const ended_of = async (p: Promise<[Ended, AgentWait]>) => (await p)[0];

test("waits_out_the_period_showing_as_waiting", async () => {
  const [s, task, run] = running();
  let seen: AgentWait | null = null;
  const watching = when_waiting(s, task.id, (s) => {
    seen = reload(s, task.id).agent_wait;
  });
  const started = performance.now();
  const ended = await ended_of(wait(s, run, task, "c1", { ...secs(1), reason: " waiting for CI " }));
  await watching;
  assert.deepEqual(ended, { kind: "Timeout" });
  assert.ok(performance.now() - started >= 900);
  const w = seen! as AgentWait;
  assert.deepEqual([w.reason, w.call_id, w.run_id], ["waiting for CI", "c1", run.id]);
  // Still in progress, and working again.
  const t = reload(s, task.id);
  assert.deepEqual([t.status, t.running, t.agent_wait], ["in_progress", true, null]);
});

test("ends_when_a_watched_task_changes_status", async () => {
  const [s, task, run, other] = running();
  when_waiting(s, task.id, (s) => {
    s.update_task(other.id, [["status", "in_review"]]);
  });
  const ended = await ended_of(wait(s, run, task, "c1", { ...secs(30), tasks: [{ id: other.id, key: "T-2", status: other.status }] }));
  assert.deepEqual(ended, { kind: "Tasks", tasks: [other.id] });
  assert.equal(reload(s, task.id).agent_wait, null);
});

test("ends_when_a_message_is_sent_to_the_agent", async () => {
  const [s, task, run] = running();
  // The run takes no input, so the message is queued for when it ends.
  when_waiting(s, task.id, (s) => {
    runner.send(s, task.id, "come back");
  });
  assert.deepEqual(await ended_of(wait(s, run, task, "c1", secs(30))), { kind: "Message" });
});

test("ends_when_the_run_is_stopped_or_the_task_moved", async () => {
  {
    const [s, task, run] = running();
    when_waiting(s, task.id, (s) => {
      db.run(s.db(), "UPDATE runs SET stop_requested=1 WHERE id=?1", run.id);
    });
    assert.deepEqual(await ended_of(wait(s, run, task, "c1", secs(30))), { kind: "Stopped" });
  }
  // Moved from the board or with update_task, to "Needs attention" too.
  for (const status of ["done", "needs_attention"]) {
    const [s, task, run] = running();
    move_when_waiting(s, task.id, status);
    assert.deepEqual(await ended_of(wait(s, run, task, "c1", secs(30))), { kind: "Moved", status });
  }
});

/** Move the task to `status` as the board does, once it shows as waiting. */
function move_when_waiting(s: Shared, id: string, status: string) {
  when_waiting(s, id, async (s) => {
    await api.update_task_inner(s, id, { status });
  });
}

test("a_subagents_permission_prompt_isnt_a_move", async () => {
  const [s, task, run] = running();
  const subagent = (async () => {
    while (!reload(s, task.id).agent_wait) await sleep(10);
    // The prompt moves the task to "Needs attention", and answering it (Always allow) moves it back.
    const t = reload(s, task.id);
    const asking = permissions.prompt(s, t, "call-1", "Bash", { command: "make" }, "toolu_sub");
    let request: string | undefined;
    while (!(request = db.value<string>(s.db(), "SELECT id FROM permission_requests WHERE call_id='call-1'"))) await sleep(10);
    assert.equal(reload(s, task.id).status, "needs_attention");
    await sleep(TICK * 2);
    permissions.decide(s, request, true, true, null);
    assert.equal((await asking).behavior, "allow");
    const after = reload(s, task.id);
    return [after.status, after.agent_wait !== null];
  })();
  assert.deepEqual(await ended_of(wait(s, run, task, "c1", secs(1.5))), { kind: "Timeout" });
  assert.deepEqual(await subagent, ["in_progress", true]);
});

test("its_own_threads_other_tool_calls_end_a_wait", async () => {
  const call = (n: string, parent: any) => ({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", name: n }] } });
  assert.ok(is_activity(call("Bash", null)));
  assert.ok(!is_activity(call("mcp__huntaway__wait", null)));
  // A subagent working doesn't: its agent may be waiting for it.
  assert.ok(!is_activity(call("Bash", "toolu_1")));
  assert.ok(!is_activity({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "hi" }] } }));
  const [s, task, run] = running();
  when_waiting(s, task.id, (s) => resumed(s, task.id, run.id));
  assert.deepEqual(await ended_of(wait(s, run, task, "c1", secs(30))), { kind: "Resumed" });
  assert.equal(reload(s, task.id).agent_wait, null);
});

test("a_codex_agents_own_tool_calls_end_a_wait", async () => {
  const [s, t0, run] = running();
  const task = s.update_task(t0.id, [["session_id", "main"]])!;
  when_waiting(s, task.id, (s) => {
    const started = (thread: string) => {
      const item = { type: "commandExecution", id: "e1", command: "make", status: "inProgress" };
      return `${JSON.stringify({ method: "item/started", params: { threadId: thread, turnId: "t", item } })}\n`;
    };
    const offset = (s: Shared) => db.get_run(s.db(), run.id)!.out_offset;
    // A subagent's thread working doesn't end it.
    runner.on_output(s, run.id, offset(s), started("sub"));
    assert.ok(reload(s, task.id).agent_wait);
    runner.on_output(s, run.id, offset(s), started("main"));
  });
  assert.deepEqual(await ended_of(wait(s, run, task, "c1", secs(30))), { kind: "Resumed" });
  assert.equal(reload(s, task.id).agent_wait, null);
  assert.ok(is_wait_tool("mcp__huntaway__wait") && !is_wait_tool("mcp__huntaway__wait_for") && !is_wait_tool("mcp__other__wait"));
  assert.ok(is_wait_tool("mcp__issue_agent__wait"), "runs from before the rename");
});

test("only_a_subagents_terminal_status_wakes_its_own_run", async () => {
  const [s, task, run, other] = running();
  // An Agent call needn't be the first content block.
  s.add_message(task.id, "claude", {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Starting a worker" },
        { type: "tool_use", name: "Agent", id: "child" },
      ],
    },
  });
  const other_run = db.insert_run(s.db(), other.id, "prompt");
  const stale_run = db.insert_run(s.db(), task.id, "prompt");
  const done = { type: "system", subtype: "task_notification", tool_use_id: "child", status: "completed", summary: "Ready" };
  when_waiting(s, task.id, (s) => {
    const original = reload(s, task.id).agent_wait;
    for (const event of [
      { subtype: "task_started", tool_use_id: "child" },
      { subtype: "task_progress", tool_use_id: "child", description: "Working" },
      { subtype: "task_updated", tool_use_id: "child", patch: { status: "running" } },
      { subtype: "task_notification", tool_use_id: "shell-or-internal-agent", status: "completed" },
    ]) {
      subagent_finished(s, run, event);
      assert.deepEqual(reload(s, task.id).agent_wait, original);
    }
    subagent_finished(s, stale_run, done);
    subagent_finished(s, other_run, done);
    assert.deepEqual(reload(s, task.id).agent_wait, original);
    subagent_finished(s, run, done);
    // The first completion wins even if several children finish together.
    subagent_finished(s, run, { subtype: "task_notification", tool_use_id: "child", status: "failed" });
  });
  const ended = await ended_of(wait(s, run, task, "c1", secs(30)));
  assert.deepEqual(ended, { kind: "Subagent", agent: { tool_use_id: "child", task_id: null, status: "completed", summary: "Ready" } });
  assert.equal(reload(s, task.id).agent_wait, null);
});

test("a_subagents_completion_is_kept_until_a_retried_wait_returns", async () => {
  const [s, t0, run] = running();
  s.add_message(t0.id, "claude", { type: "assistant", message: { content: [{ type: "tool_use", name: "Task", id: "child" }] } });
  s.add_message(t0.id, "claude", { type: "system", subtype: "task_started", tool_use_id: "child", task_id: "background" });
  // A stored wait from before this field existed can be resumed too.
  const w = { since: now(), until: new Date(Date.now() + 60_000).toISOString(), call_id: "c1", run_id: run.id };
  s.update_task(t0.id, [["agent_wait", w]]);
  // Claude can identify a background child by task_id instead of tool_use_id.
  subagent_finished(s, run, { subtype: "task_notification", task_id: "background", status: "completed", summary: "Report" });
  let task = reload(s, t0.id);
  assert.ok(task.agent_wait!.subagent_finished != null);
  const ended = await ended_of(wait(s, run, task, "c1", secs(30)));
  assert.deepEqual(ended, { kind: "Subagent", agent: { tool_use_id: "child", task_id: "background", status: "completed", summary: "Report" } });
  assert.equal(name(ended), "subagent_finished");
  assert.equal(note(ended, []), "A subagent finished (see subagent).");
  // A new wait doesn't replay an old completion.
  task = reload(s, t0.id);
  assert.deepEqual(await ended_of(wait(s, run, task, "c2", secs(1))), { kind: "Timeout" });
});

const period_err = (r: Request) => {
  try {
    period(r);
  } catch (e: any) {
    return e.message as string;
  }
  throw new Error("no error");
};

test("a_wait_without_tasks_or_a_command_is_short", async () => {
  const watching = () => [{ id: "t", key: "T-2", status: "todo" }];
  const command = (c: string): Request => ({ ...Request_default(), command: c });
  assert.equal(period(Request_default()), 30);
  assert.equal(period(secs(30)), 30);
  assert.equal(period(secs(0.1)), 1);
  assert.equal(period({ ...Request_default(), tasks: watching() }), 600);
  assert.equal(period({ ...secs(7200), tasks: watching() }), 3600);
  assert.equal(period(command("gh pr checks 1 --watch")), 600);
  assert.equal(period({ ...command("gh pr checks 1 --watch"), seconds: 1800 }), 1800);
  // A blank command is none.
  const err = period_err({ ...command("  "), seconds: 1800 });
  assert.ok(err.includes("30 seconds at most") && err.includes("give the pull_request") && err.includes("a command that exits"), err);
  const [s, task, run] = running();
  await assert.rejects(wait(s, run, task, "c1", secs(30.5)), (e: any) => e.message.startsWith("The wait didn't start"));
  assert.equal(reload(s, task.id).agent_wait, null);
});

/** A wait running `command` in the task's working directory (its profile's scratch folder). */
function with_command(s: Shared, task: Task, command: string, seconds: number): Request {
  mkdirSync(s.profile_scratch_dir(task.profile_id), { recursive: true });
  return { ...secs(seconds), command };
}

test("ends_when_its_command_exits", async () => {
  const [s, task, run] = running();
  const started = performance.now();
  let req = with_command(s, task, "sleep 0.3; touch here; echo ready; echo oops >&2; exit 3", 60);
  assert.deepEqual(await ended_of(wait(s, run, task, "c1", req)), { kind: "Command", code: 3, output: "ready\noops\n" });
  assert.ok(performance.now() - started >= 300);
  assert.ok(existsSync(join(s.profile_scratch_dir(task.profile_id), "here")));
  assert.equal(reload(s, task.id).agent_wait, null);

  // Only the end of a long output.
  req = with_command(s, task, "head -c 10000 /dev/zero | tr '\\0' x; echo; echo end", 60);
  const e = await ended_of(wait(s, run, task, "c2", req));
  assert.equal(e.kind, "Command");
  if (e.kind !== "Command") return;
  assert.equal(e.code, 0);
  assert.ok(e.output.startsWith("… [6005 bytes before this]\n") && e.output.endsWith("xx\nend\n"), e.output);
});

test("its_command_doesnt_run_as_another_github_account", async () => {
  // The profile picked an account gh isn't signed in to (or gh isn't installed): the command would run as gh's active
  // account, so it doesn't run at all.
  const [s, task, run] = running();
  db.update_profile(s.db(), task.profile_id, [["github_account", "not-signed-in-ia123"]]);
  const req = with_command(s, task, "touch ran", 60);
  await assert.rejects(wait(s, run, task, "c1", req), (e: any) => {
    assert.ok(err_str(e).includes("not-signed-in-ia123"), err_str(e));
    return true;
  });
  assert.ok(!existsSync(join(s.profile_scratch_dir(task.profile_id), "ran")));
  assert.equal(reload(s, task.id).agent_wait, null);
});

test("its_command_is_stopped_when_the_wait_ends_otherwise", async () => {
  const [s, task, run] = running();
  const pid_file = join(s.profile_scratch_dir(task.profile_id), "pid");
  // Something it started in the background, as well as the shell itself.
  const req = with_command(s, task, `sleep 30 & echo $! > ${pid_file}; sleep 30`, 1);
  assert.deepEqual(await ended_of(wait(s, run, task, "c1", req)), { kind: "Timeout" });
  const pid = Number(readFileSync(pid_file, "utf8").trim());
  assert.ok(await gone(pid), "the command's background process is still running");
});

/** Whether a process is running (not gone, nor a zombie waiting to be reaped). */
function alive(pid: number): boolean {
  try {
    return !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
  } catch {
    return false;
  }
}

/** Wait (a while at most) for `pid` to be gone. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (!alive(pid)) return true;
    await sleep(20);
  }
  return false;
}

test("its_command_is_stopped_when_the_server_goes_without_cleaning_up", async () => {
  const dir = testing.temp_dir();
  const log = openSync(join(dir, "log"), "w");
  const pid_file = join(dir, "pid");
  // `wait` waits for its own jobs only, not the watchdog.
  const { child, alive: alive_end } = spawn_command(`sleep 30 & echo $! > ${pid_file}; wait`, dir, log, []);
  closeSync(log);
  // (Rust checks the server's end is close-on-exec, so an exec doesn't pass it on: libuv opens it so.)
  const shell = child.pid!;
  const read_pid = () => {
    try {
      return readFileSync(pid_file, "utf8").trim();
    } catch {
      return "";
    }
  };
  while (!read_pid()) await sleep(10);
  const background = Number(read_pid());
  await sleep(200);
  assert.ok(alive(shell) && alive(background));
  // The server goes (exec, exit or crash): nothing it would run to clean up runs, but the kernel closes its files.
  child.unref();
  alive_end.destroy();
  assert.ok(await gone(shell), "the command is still running");
  assert.ok(await gone(background), "the command's background process is still running");
});

// ---------- pull requests ----------

/** A fake GitHub (see pr_watch.fake): what reads of its pull requests get, and the account and pull request of each read. */
class Github {
  pr: { ok: any } | { err: string };
  reads: Array<[string | null, string]> = [];
  constructor(pr: any) {
    this.pr = { ok: pr };
    pr_watch.fake((account, target) => {
      this.reads.push([account, target.label()]);
      if ("err" in this.pr) throw new Error(this.pr.err);
      return structuredClone(this.pr.ok);
    });
  }
  set(pr: { ok: any } | { err: string }) {
    this.pr = pr;
  }
  count() {
    return this.reads.length;
  }
  accounts() {
    return this.reads.map(([a]) => a);
  }
}

const o_r = (number: number) => new Target("github.com", "o", "r", number);

/** A wait of `seconds` on o/r#7, for all of its news. */
const on_pr = (seconds: number): Request => ({ ...secs(seconds), pull_request: { target: o_r(7), events: [...pr_watch.EVENTS] } });

function pr_events(e: Ended): string[] {
  assert.equal(e.kind, "PullRequest", JSON.stringify(e));
  return e.kind === "PullRequest" ? e.news.events : [];
}

function authors(e: Ended): string[] {
  assert.equal(e.kind, "PullRequest", JSON.stringify(e));
  return e.kind === "PullRequest" ? (e.news.comments ?? []).map((c: any) => c.author) : [];
}

/** Runs `f` with the fake GitHub removed after. */
async function faked(f: () => Promise<void>) {
  try {
    await f();
  } finally {
    pr_watch.fake(null);
  }
}

test("ends_on_news_about_its_pull_request", () =>
  faked(async () => {
    const [s, task, run] = running();
    const gh = new Github(response("me", "a1", [["test", "IN_PROGRESS", "", true]], [["01", "alice", "old"]]));
    let shown: any = null;
    when_waiting(s, task.id, (s) => {
      shown = reload(s, task.id).agent_wait?.pull_request ?? null;
      // A check fails, someone comments, and so does the agent's own account.
      gh.set({
        ok: response(
          "me",
          "a1",
          [["test", "COMPLETED", "FAILURE", true]],
          [
            ["01", "alice", "old"],
            ["02", "me", "mine"],
            ["03", "bob", "Looks off"],
          ],
        ),
      });
    });
    const [ended, w] = await wait(s, run, task, "c1", on_pr(30));
    assert.deepEqual(pr_events(ended), ["checks_failed", "comments"]);
    assert.deepEqual(authors(ended), ["bob"]);
    const news = (ended as any).news;
    assert.equal(news.checks.failed[0].url, "https://github.com/o/r/actions/runs/0");
    assert.equal(note(ended, []), "Pull request #7: checks failed (test); 1 new comment or review from bob (see pull_request).");
    // The board showed what it watched.
    assert.deepEqual([shown.url, shown.repo, shown.number, shown.news], ["https://github.com/o/r/pull/7", "o/r", 7, undefined]);
    assert.deepEqual(w.pull_request!.news, news);
    assert.equal(reload(s, task.id).agent_wait, null);
    // Read as gh's account (the profile has none).
    assert.ok(gh.accounts().every((a) => a === null) && gh.count() >= 2);

    // Told, it isn't news again.
    assert.deepEqual(await ended_of(wait(s, run, task, "c2", on_pr(0.5))), { kind: "Timeout" });
    // A review left while the agent worked between waits ends the next one straight away.
    gh.set({
      ok: response(
        "me",
        "a1",
        [["test", "COMPLETED", "FAILURE", true]],
        [
          ["01", "alice", "old"],
          ["03", "bob", "Looks off"],
          ["04", "carol", "Approve?"],
        ],
      ),
    });
    const started = performance.now();
    const e3 = await ended_of(wait(s, run, task, "c3", on_pr(30)));
    assert.deepEqual([pr_events(e3), authors(e3)], [["comments"], ["carol"]]);
    assert.ok(performance.now() - started < 5000);
    // Merged ends it whatever it waits for.
    const merged = response("me", "a1", [], []);
    merged.data.repository.pullRequest.state = "MERGED";
    gh.set({ ok: merged });
    const req = { ...secs(30), pull_request: { target: o_r(7), events: [] } };
    assert.deepEqual(pr_events(await ended_of(wait(s, run, task, "c4", req))), ["merged"]);
  }));

test("a_wait_on_checks_ends_when_its_pull_request_conflicts_and_none_will_run", () =>
  faked(async () => {
    // HA-287: HA-276 waited on PR #222's checks alone, which conflicted with master, so GitHub never ran them.
    const [s, task, run] = running();
    const conflicting = (checks: Array<[string, string, string, boolean]>) => {
      const v = response("me", "a1", checks, []);
      v.data.repository.pullRequest.mergeable = "CONFLICTING";
      return v;
    };
    const gh = new Github(conflicting([]));
    const on_checks = (seconds: number): Request => ({ ...secs(seconds), pull_request: { target: o_r(7), events: ["checks_failed", "checks_passed"] } });
    const started = performance.now();
    const ended = await ended_of(wait(s, run, task, "c1", on_checks(30)));
    assert.deepEqual(pr_events(ended), ["conflicts"]);
    assert.equal((ended as any).news.mergeable, "conflicting");
    assert.ok(performance.now() - started < 5000);
    // Still conflicting, the next wait on checks ends too.
    assert.deepEqual(pr_events(await ended_of(wait(s, run, task, "c2", on_checks(30)))), ["conflicts"]);
    // Checks that are running end it themselves.
    gh.set({ ok: conflicting([["test", "IN_PROGRESS", "", false]]) });
    assert.deepEqual(await ended_of(wait(s, run, task, "c3", on_checks(0.5))), { kind: "Timeout" });
  }));

test("a_pull_request_that_cant_be_read_doesnt_start_the_wait", () =>
  faked(async () => {
    const [s, task, run] = running();
    const gh = new Github(null);
    gh.set({ err: "Could not resolve to a Repository with the name 'o/r'." });
    await assert.rejects(wait(s, run, task, "c1", on_pr(30)), {
      message: "The wait didn't start: o/r#7 couldn't be read: Could not resolve to a Repository with the name 'o/r'.",
    });
    assert.equal(reload(s, task.id).agent_wait, null);
    // A host from the task's remote that isn't GitHub's (an SSH alias ssh doesn't know) asks for the URL.
    gh.set({ err: "gh failed: none of the git remotes configured for this repository point to a known GitHub host" });
    const target = new Target("github-work", "o", "r", 7);
    const req = { ...secs(30), pull_request: { target, events: [] } };
    await assert.rejects(wait(s, run, task, "c2", req), (e: any) => {
      assert.ok(e.message.endsWith("known GitHub host (if github-work isn't a GitHub host, give the pull request's URL)"), e.message);
      return true;
    });
  }));

test("its_pull_request_is_read_as_the_tasks_github_account_only", () =>
  faked(async () => {
    // The personal profile's agents act as one account, the work profile's as another, whose project's pull request
    // the personal one's agent asks for.
    const [s, task, run] = running();
    db.update_profile(s.db(), task.profile_id, [["github_account", "me-personal"]]);
    const work = db.insert_profile(s.db(), "work", [], null);
    db.update_profile(s.db(), work.id, [["github_account", "me-work"]]);
    const reads: Array<[string | null, string]> = [];
    pr_watch.fake((account, target) => {
      reads.push([account, target.label()]);
      if (account === "me-work") return response("me-work", "a1", [], [["01", "boss", "secret"]]);
      throw new Error("Could not resolve to a Repository with the name 'work-org/secret'.");
    });
    const target = new Target("github.com", "work-org", "secret", 7);
    const req = { ...secs(30), pull_request: { target, events: ["comments"] } };
    await assert.rejects(wait(s, run, task, "c1", req), (e: any) => {
      assert.ok(e.message.includes("couldn't be read: Could not resolve"), e.message);
      return true;
    });
    assert.deepEqual(reads, [["me-personal", "work-org/secret#7"]]);
    // Nor is one on another host than its account's asked for at all.
    db.update_profile(s.db(), task.profile_id, [["github_account", "ghe.acme.com/me"]]);
    await assert.rejects(pr_watch.request(s, task, "https://github.com/work-org/secret/pull/7", null), (e: any) => {
      assert.ok(e.message.includes("is on github.com, but this task's GitHub account ghe.acme.com/me is on ghe.acme.com"), e.message);
      return true;
    });
    assert.equal(reads.length, 1);
    // A profile whose account isn't gh's default reads as that account.
    const gh = new Github(response("me-work", "a1", [], []));
    db.update_profile(s.db(), task.profile_id, [["github_account", "me-work"]]);
    assert.deepEqual(await ended_of(wait(s, run, task, "c2", on_pr(0.3))), { kind: "Timeout" });
    assert.ok(gh.count() >= 2 && gh.accounts().every((a) => a === "me-work"), JSON.stringify(gh.accounts()));
  }));

test("a_pull_request_wait_carried_on_after_a_restart_keeps_what_was_seen", () =>
  faked(async () => {
    const [s, t0, run] = running();
    const gh = new Github(response("me", "a1", [], [["01", "alice", "old"]]));
    // A first wait sees alice's comment.
    assert.deepEqual(await ended_of(wait(s, run, t0, "c1", on_pr(0.3))), { kind: "Timeout" });
    // The server restarts during the next one, and bob comments meanwhile.
    const stored_wait = (news: any | null): AgentWait => ({
      reason: "waiting for review",
      since: now(),
      until: new Date(Date.now() + 30_000).toISOString(),
      tasks: [],
      call_id: "c2",
      run_id: run.id,
      pull_request: pr_watch.stored(on_pr(1).pull_request!, news),
    });
    let task = s.update_task(t0.id, [["agent_wait", stored_wait(null)]])!;
    gh.set({
      ok: response(
        "me",
        "a1",
        [],
        [
          ["01", "alice", "old"],
          ["02", "bob", "new"],
        ],
      ),
    });
    const started = performance.now();
    const ended = await ended_of(wait(s, run, task, "c2", secs(30)));
    assert.deepEqual(authors(ended), ["bob"]);
    assert.ok(performance.now() - started < 5000);
    // News found before a restart is returned without reading again.
    const reads = gh.count();
    const news = { events: ["closed"], number: 7 };
    task = s.update_task(t0.id, [["agent_wait", stored_wait(news)]])!;
    assert.deepEqual(await ended_of(wait(s, run, task, "c2", secs(30))), { kind: "PullRequest", news });
    assert.equal(gh.count(), reads);
  }));

test("news_that_doesnt_reach_the_agent_is_reported_again", () =>
  faked(async () => {
    const [s, t0, run] = running();
    new Github(response("me", "a1", [["test", "COMPLETED", "FAILURE", false]], []));
    // A read for the wait c1 found the failure, and then the run was stopped.
    const w = pr_watch.Watcher.new(s, t0, o_r(7));
    const news = await w.poll(s, t0.id, "c1", [...pr_watch.EVENTS]);
    assert.ok(news !== null);
    const stored_wait: AgentWait = {
      reason: null,
      since: now(),
      until: new Date(Date.now() + 30_000).toISOString(),
      tasks: [],
      call_id: "c1",
      run_id: run.id,
      pull_request: pr_watch.stored(on_pr(1).pull_request!, news),
    };
    const task = s.update_task(t0.id, [["agent_wait", stored_wait]])!;
    db.run(s.db(), "UPDATE runs SET stop_requested=1 WHERE id=?1", run.id);
    assert.deepEqual(await ended_of(wait(s, run, task, "c1", secs(30))), { kind: "Stopped" });
    // The next run's wait is told.
    const task2 = reload(s, t0.id);
    const run2 = db.insert_run(s.db(), t0.id, "prompt");
    db.run(s.db(), "UPDATE runs SET status='running' WHERE id=?1", run2.id);
    assert.deepEqual(pr_events(await ended_of(wait(s, run2, task2, "c2", on_pr(30)))), ["checks_failed"]);
    assert.deepEqual(await ended_of(wait(s, run2, task2, "c3", on_pr(0.3))), { kind: "Timeout" });
  }));

test("a_pull_request_that_stops_being_readable_ends_the_wait", () =>
  faked(async () => {
    const [s, task, run] = running();
    const gh = new Github(response("me", "a1", [], []));
    when_waiting(s, task.id, () => gh.set({ err: "HTTP 502: Bad Gateway" }));
    const ended = await ended_of(wait(s, run, task, "c1", on_pr(30)));
    assert.deepEqual(pr_events(ended), ["unreadable"]);
    assert.equal(gh.count(), 1 + pr_watch.GIVE_UP);
    assert.equal(
      note(ended, []),
      "o/r#7 couldn't be read 5 times in a row: HTTP 502: Bad Gateway. Check it yourself (pr_view), and wait on it again once it can be read.",
    );
  }));

test("a_wait_on_a_pull_request_is_watched", () => {
  assert.equal(period(on_pr(1800)), 1800);
  assert.equal(period({ ...on_pr(1), seconds: null }), 600);
});

test("a_retried_call_carries_on_with_its_deadline", async () => {
  const [s, t0, run, other] = running();
  // As if the server restarted with the call waiting since a while ago.
  const w: AgentWait = {
    reason: "r",
    since: now(),
    until: new Date(Date.now() + 300).toISOString(),
    tasks: [{ id: other.id, key: "T-2", status: "in_progress" }],
    call_id: "c1",
    run_id: run.id,
  };
  let task = s.update_task(t0.id, [["agent_wait", w]])!;
  const started = performance.now();
  assert.deepEqual(await ended_of(wait(s, run, task, "c1", secs(30))), { kind: "Timeout" });
  assert.ok(performance.now() - started < 5000);
  // The watched task changed while the server was down.
  s.update_task(other.id, [["status", "done"]]);
  task = s.update_task(t0.id, [["agent_wait", w]])!;
  assert.deepEqual(await ended_of(wait(s, run, task, "c1", secs(30))), { kind: "Tasks", tasks: [other.id] });
});
