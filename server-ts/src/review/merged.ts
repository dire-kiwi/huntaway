// Port of server/src/review/merged.rs.
/**
 * Tasks whose pull requests are merged or closed on GitHub (by the user, or by auto-merge) rather than through *Ready
 * for merge* (API 68). Every `POLL` the server reads the state of the pull requests (`pr_url`) of the tasks in *In
 * review* or *Needs attention* whose project has `done_when_merged` on (the default), with one GraphQL query per GitHub
 * account and host (and `CHUNK` pull requests), as each task's own account (see runner::github_account; gh's active
 * account when none is set), never as another.
 *
 * - Merged: the task moves to *Done* (resolution `done`), as moving it there does, says so in its thread, and its
 *   worktree is removed if nothing in it would be lost (see worktree::remove_if_merged, which says why when it's kept).
 * - Closed without being merged: a task in *In review* moves to *Needs attention* saying so; one already there (whose
 *   reason is the agent's) only gets an event.
 *
 * Each is done once per change of state: what the last read found is kept per task and pull request (`pr_states`), so
 * a task the user moves back out of *Done* stays where they put it, and a pull request that's reopened and closed again
 * is reported again. Tasks whose agent (or a reviewer) is running or that are merging are left alone, and so are a
 * subproject's tasks, which its own merge brings in, and a subproject with open tasks.
 *
 * A `wait` on the pull request (mcp/pr_watch.rs) already tells the agent it was merged, and leaves marking the task
 * done to it (and its project's instructions); if it ends its run without doing so, the task goes to *In review* and the
 * next read here moves it on.
 */
import * as db from "../db.ts";
import type { Conn, Task } from "../db.ts";
import * as runner from "../agent/runner.ts";
import * as worktree from "../git/worktree.ts";
import * as gh_mcp from "../mcp/gh_mcp.ts";
import * as pr_watch from "../mcp/pr_watch.ts";
import type { Target } from "../mcp/pr_watch.ts";
import * as terminal from "../hosts/terminal.ts";
import type { AppState } from "../state.ts";
import { err_str, now } from "../util.ts";

/** How often the pull requests are read (ms). */
export const POLL = 180_000;

/** How long after the server starts they're first read (ms). */
const FIRST = 30_000;

/** The most pull requests one query reads. */
const CHUNK = 50;

/** Starts reading the tasks' pull requests every `POLL`. */
export function start(s: AppState) {
  const failing = new Map<string, string>();
  const tick = async () => {
    try {
      await check(s, failing);
    } catch (e) {
      console.error(`reading tasks' pull requests: ${err_str(e)}`);
    }
    setTimeout(tick, POLL).unref();
  };
  setTimeout(tick, FIRST).unref();
}

/**
 * The tasks to read the pull requests of now: open in *In review* or *Needs attention* with a pull request, in a
 * project that wants it, and not being worked on or merged.
 */
function candidates(s: AppState): Array<[Task, string | null]> {
  const out = db.tasks_with_open_prs(s.db()).filter((t) => !busy(s, t) && settles_here(s.db(), t));
  // The accounts, read once per project and profile.
  const accounts = new Map<string, string | null>();
  return out.map((t) => {
    const key = `${t.profile_id}\0${t.project_id ?? ""}`;
    if (!accounts.has(key)) accounts.set(key, runner.task_github_account(s, t) ?? null);
    return [t, accounts.get(key)!] as [Task, string | null];
  });
}

/** Whether `t`'s agent or one of its reviewers is running. */
function busy(s: AppState, t: Task): boolean {
  const reviews = db.review_threads(s.db(), t.id);
  return s.is_running(t.id) || reviews.some((r) => r.running || s.is_running(r.id));
}

/**
 * Whether `t` is settled from its own pull request: not a subproject's task (which goes into its subproject's branch
 * with the subproject's own merge), nor a subproject with open tasks.
 */
function settles_here(c: Conn, t: Task): boolean {
  if (db.subproject_of(c, t) != null) return false;
  return !t.subproject || db.subproject_tasks(c, t.id).every((t) => t.status === "done" || db.is_scratch(t));
}

/**
 * Read the candidates' pull requests and act on what changed. `failing` keeps the last error of each account and host
 * (keyed by `JSON.stringify([account, host])`), so a read that keeps failing is logged once.
 */
export async function check(s: AppState, failing: Map<string, string>) {
  let tasks: Array<[Task, string | null]>;
  try {
    tasks = candidates(s);
  } catch (e) {
    console.error(`finding tasks whose pull requests to read: ${err_str(e)}`);
    return;
  }
  // By account and host, then by pull request (tasks can share one).
  const groups = new Map<string, { account: string | null; host: string; prs: Array<[Target, Task[]]> }>();
  for (const [t, account] of tasks) {
    let target: Target | null = null;
    if (t.pr_url != null) {
      try {
        target = pr_watch.Target_parse(t.pr_url, null);
      } catch {}
    }
    if (!target) continue;
    // Not as an account on another host.
    const a = account != null ? gh_mcp.Account_parse(account) : null;
    if (a && a.host !== target.host) continue;
    const key = JSON.stringify([account, target.host]);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { account, host: target.host, prs: [] }));
    const url = target.url();
    const same = g.prs.find(([p]) => p.url() === url);
    if (same) same[1].push(t);
    else g.prs.push([target, [t]]);
  }
  for (const [key, { account, host, prs }] of groups) {
    const env: pr_watch.EnvSlot = { env: null };
    for (let i = 0; i < prs.length; i += CHUNK) {
      const chunk = prs.slice(i, i + CHUNK);
      const targets = chunk.map(([t]) => t);
      let states: Array<Read | null>;
      try {
        states = await read(account, env, host, targets);
        failing.delete(key);
      } catch (e) {
        const msg = err_str(e);
        if (failing.get(key) !== msg) {
          console.warn(`reading tasks' pull requests as ${account ?? "gh's active account"} on ${host}: ${msg}`);
          failing.set(key, msg);
        }
        break;
      }
      for (let j = 0; j < chunk.length; j++) {
        const [target, list] = chunk[j];
        const r = states[j];
        if (!r) continue;
        for (const t of list) {
          // The board shows how its checks stand (see pr_watch::record_checks).
          if (r.state === "open") pr_watch.record_checks(s, t.id, target, r.head, r.checks);
          try {
            await changed(s, t, target, r.state);
          } catch (e) {
            console.error(`task ${t.id}, pr ${target.label()}: acting on its pull request's state: ${err_str(e)}`);
          }
        }
      }
    }
  }
}

/** A pull request as a read found it. */
interface Read {
  /** `open`, `merged` or `closed`. */
  state: string;
  /** Its head commit, and that commit's checks. */
  head: string;
  checks: any[];
}

/** A fake GitHub for tests: the response to a query, given the account, host and pull requests it reads. */
export type Fake = (account: string | null, host: string, targets: Target[]) => any;

let FAKE: Fake | null = null;

/** Answer reads with `f` instead of GitHub (tests), or GitHub again with null. */
export function set_fake(f: Fake | null) {
  FAKE = f;
}

/**
 * Each of `targets`' states and checks, or null for one GitHub didn't return (gone, or out of the account's reach),
 * read in one query as `account` on `host`. Throws with what went wrong.
 */
async function read(account: string | null, env: pr_watch.EnvSlot, host: string, targets: Target[]): Promise<Array<Read | null>> {
  let v: any;
  if (FAKE) {
    v = FAKE(account, host, targets);
  } else {
    const [q, vars, numbers] = query(targets);
    v = await pr_watch.graphql(account, env, host, q, vars, numbers);
  }
  return states(v, targets.length);
}

/** The query that reads `targets`' states, aliased `pr0`, `pr1`… with their variables. */
export function query(targets: Target[]): [string, Array<[string, string]>, Array<[string, number]>] {
  const params: string[] = [];
  let fields = "";
  const vars: Array<[string, string]> = [];
  const numbers: Array<[string, number]> = [];
  targets.forEach((t, i) => {
    params.push(`$o${i}: String!, $n${i}: String!, $p${i}: Int!`);
    const checks = pr_watch.CHECKS.replaceAll("$number", `$p${i}`);
    fields += `  pr${i}: repository(owner: $o${i}, name: $n${i}) { pullRequest(number: $p${i}) { state ${checks} } }\n`;
    vars.push([`o${i}`, t.owner], [`n${i}`, t.name]);
    numbers.push([`p${i}`, t.number]);
  });
  return [`query(${params.join(", ")}) {\n${fields}}`, vars, numbers];
}

/**
 * The pull requests in a response to `query` for `n` of them. GitHub answers the others when one can't be read (with
 * an error and a null for it); none at all is an error.
 */
export function states(v: any, n: number): Array<Read | null> {
  const data = v?.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    const errors = (Array.isArray(v?.errors) ? v.errors : []).map((e: any) => e?.message).filter((m: any) => typeof m === "string");
    throw new Error(errors.length ? errors.join("; ") : "GitHub didn't return the pull requests");
  }
  const one = (pr: any): Read | null => {
    if (typeof pr?.state !== "string") return null;
    return { state: pr.state.toLowerCase(), head: typeof pr.headRefOid === "string" ? pr.headRefOid : "", checks: pr_watch.checks_of(pr) };
  };
  return Array.from({ length: n }, (_, i) => one(data[`pr${i}`]?.pullRequest));
}

/** What the last read found for `t`'s pull request `url`. */
function last_state(c: Conn, task_id: string, url: string): string | null {
  return db.value<string>(c, "SELECT state FROM pr_states WHERE task_id=?1 AND pr_url=?2", task_id, url) ?? null;
}

function store_state(c: Conn, task_id: string, url: string, state: string) {
  db.run(
    c,
    `INSERT INTO pr_states (task_id, pr_url, state, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(task_id, pr_url) DO UPDATE SET state=?3, updated_at=?4`,
    task_id,
    url,
    state,
    now(),
  );
}

/**
 * Act on `t`'s pull request being in `state`, if it wasn't at the last read. The state is kept once it's been acted on
 * (or there was nothing to do), so a task that couldn't be moved (its agent started meanwhile) is tried again at the
 * next read.
 */
async function changed(s: AppState, t: Task, target: Target, state: string) {
  const url = target.url();
  const last = last_state(s.db(), t.id, url);
  if (last === state) return;
  const done = state === "merged" ? await merged(s, t, target) : state === "closed" ? closed(s, t, target) : true;
  if (done) store_state(s.db(), t.id, url, state);
}

/** Whether `t` is still as it was read for the pull request: open and idle with the same one. */
function unchanged(c: Conn, t: Task): boolean {
  const cur = db.get_task(c, t.id);
  return !!cur && ["in_review", "needs_attention"].includes(cur.status) && !cur.running && !cur.merging && (cur.pr_url ?? null) === (t.pr_url ?? null);
}

/** `t`'s pull request was merged: move it to Done and remove its worktree. False if it changed meanwhile, or its agent started. */
async function merged(s: AppState, t: Task, target: Target): Promise<boolean> {
  if (busy(s, t)) return false;
  const fields: Array<[string, any]> = [
    ["status", "done"],
    ["resolution", "done"],
    ["attention_reason", null],
    ["waiting", false],
  ];
  const done = s.update_task_if(t.id, fields, (c) => unchanged(c, t));
  if (!done) return false;
  s.add_event(t.id, "info", `PR #${target.number} was merged on GitHub, so the task is done.`, target.url());
  // As moving it to Done does (see api::update_task_inner).
  runner.start_unblocked(s, done.project_id ?? null);
  runner.start_next_merge(s, done.project_id ?? null);
  await terminal.kill_all(s, t.id);
  try {
    const r = await worktree.remove_if_merged(s, t.id, true);
    if ("Kept" in r && r.Kept !== "it has no worktree") s.add_event(t.id, "info", `The worktree was kept: ${r.Kept}.`);
  } catch (e) {
    s.add_event(t.id, "warn", "The worktree couldn't be removed", err_str(e));
  }
  return true;
}

/** `t`'s pull request was closed without being merged: flag it. False if it changed meanwhile. */
function closed(s: AppState, t: Task, target: Target): boolean {
  const text = `PR #${target.number} was closed on GitHub without being merged`;
  if (t.status === "in_review") {
    const fields: Array<[string, any]> = [
      ["status", "needs_attention"],
      ["attention_reason", text],
    ];
    const when = (c: Conn) => unchanged(c, t) && db.get_task(c, t.id)?.status === "in_review";
    if (!s.update_task_if(t.id, fields, when)) return false;
  }
  s.add_event(t.id, "warn", `${text}.`, target.url());
  return true;
}
