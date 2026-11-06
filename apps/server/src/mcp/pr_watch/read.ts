// Port of server/src/mcp/pr_watch/read.rs: reading a pull request as a task's GitHub account (`Watcher`, `graphql`),
// and polling it for a wait (`watch`) until there's news.
import * as db from "../../db.ts";
import type { Task, WaitPr } from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as runner from "../../agent/runner.ts";
import { err_str, now } from "../../util.ts";
import { account_env, command_output, gh_program, io_error, type CmdOutput, type GhEnv } from "../gh_mcp.ts";
import { GH_TIMEOUT, GIVE_UP, POLL, THREAD_PAGES, Target, fake_answer } from "../pr_watch.ts";
import { Pr_parse, QUERY, THREADS, compare, summary, type Check, type Pr } from "./pr.ts";
import { load, store, Row_default, type Row } from "./seen.ts";
import { failed_logs, record_checks } from "./failed.ts";

/** Where gh's environment for an account is kept between calls (Rust's `&mut Option<GhEnv>`). */
export interface EnvSlot {
  env: GhEnv | null;
}

/** Reads one pull request for a task, as its GitHub account. */
export class Watcher implements EnvSlot {
  target: Target;
  account: string | null;
  /** gh's environment for the account, kept between reads (and made again after one fails). */
  env: GhEnv | null;
  constructor(target: Target, account: string | null, env: GhEnv | null = null) {
    this.target = target;
    this.account = account;
    this.env = env;
  }

  /** Rust's `Watcher::new`. Throws if the task's GitHub account can't be worked out. */
  static new(s: Shared, task: Task, target: Target): Watcher {
    return new Watcher(target, runner.task_github_account(s, task));
  }

  /** Remove gh's environment (Rust drops it with the watcher). */
  drop() {
    this.env?.drop();
    this.env = null;
  }

  /** The pull request as GitHub has it now. Throws why it couldn't be read. */
  async read(): Promise<Pr> {
    return Pr_parse(await this.read_all());
  }

  /** The query's response, with the review threads past its first page (`THREAD_PAGES` at most). */
  private async read_all(): Promise<any> {
    const v = await this.query(QUERY, null);
    for (let i = 1; i < THREAD_PAGES; i++) {
      const threads = v?.data?.repository?.pullRequest?.reviewThreads;
      const after = threads?.pageInfo?.hasNextPage === true && typeof threads?.pageInfo?.endCursor === "string" ? threads.pageInfo.endCursor : null;
      if (after === null) break;
      const page = await this.query(THREADS, after);
      const more = page?.data?.repository?.pullRequest?.reviewThreads;
      if (!Array.isArray(more?.nodes)) {
        let why = "GitHub didn't return the pull request's review threads";
        try {
          Pr_parse(page);
        } catch (e) {
          why = err_str(e);
        }
        throw new Error(why);
      }
      if (Array.isArray(threads.nodes)) threads.nodes.push(...more.nodes);
      threads.pageInfo = more.pageInfo ?? null;
    }
    return v;
  }

  /** A GraphQL query's response: `query`, for the pull request's threads `after` a cursor if given. */
  private async query(query: string, after: string | null): Promise<any> {
    const f = fake_answer(this.account, this.target, after);
    if (f !== undefined) {
      if ("err" in f) throw new Error(f.err);
      return structuredClone(f.ok);
    }
    const t = this.target;
    const vars: Array<[string, string]> = [
      ["owner", t.owner],
      ["name", t.name],
    ];
    if (after !== null) vars.push(["after", after]);
    return graphql(this.account, this, t.host, query, vars, [["number", t.number]]);
  }

  /**
   * Read the pull request and see what's news to the agent of `task_id` since it was last told (`events` only, see
   * `compare`). What isn't news (its own comments, a conflict that's gone) is stored as seen now; news, for the call
   * `call_id` to report, is stored apart until it does (see `delivered`). Returns the news, if any. A read that `signal`
   * aborted meanwhile stores nothing (Rust drops the future).
   */
  async poll(s: Shared, task_id: string, call_id: string, events: string[], signal?: AbortSignal): Promise<any | null> {
    const pr = await this.read();
    if (signal?.aborted) return null;
    if (pr.state === "open") record_checks(s, task_id, this.target, pr.head, pr.checks);
    const key = this.target.key();
    const c = s.db();
    let row: Row | null;
    try {
      row = load(c, task_id, key);
    } catch (e) {
      throw new Error(err_str(e));
    }
    const first = row === null;
    const r = row ?? Row_default();
    const [quiet, news] = compare(first ? null : r.seen, pr, events);
    if (news) r.pending = { call_id, told: news[1] };
    else delete r.pending;
    r.seen = quiet;
    r.last = summary(pr);
    r.polled_at = now();
    try {
      store(c, task_id, key, r);
    } catch (e) {
      throw new Error(err_str(e));
    }
    return news ? news[0] : null;
  }

  /**
   * The ends of the logs of `checks`' failed steps, by index, for those that are GitHub Actions jobs (`LOGS_MAX` of
   * them at most), read with `gh run view --log-failed` as the task's GitHub account: null for the others, an error for
   * one that couldn't be read.
   */
  failed_logs(checks: Check[]): Promise<Array<LogResult | null>> {
    return failed_logs(this, checks);
  }
}

/** A log's end, or why it couldn't be read (Rust's `Result<String, String>`). */
export type LogResult = { ok: string } | { err: string };

/** `Watcher::new`. */
export function Watcher_new(s: Shared, task: Task, target: Target): Watcher {
  return Watcher.new(s, task, target);
}

/**
 * Run the GraphQL `query` on `host` with string `vars` and number `numbers`, as `account` (gh's active account when
 * null, see Watcher). `slot` keeps gh's environment for the account between calls; it's made when missing, and dropped
 * when a call fails so the next one makes it again. Throws why it failed.
 */
export async function graphql(
  account: string | null,
  slot: EnvSlot,
  host: string,
  query: string,
  vars: Array<[string, string]>,
  numbers: Array<[string, number]>,
): Promise<any> {
  try {
    return await graphql_once(account, slot, host, query, vars, numbers);
  } catch (e) {
    slot.env?.drop();
    slot.env = null;
    throw e;
  }
}

async function graphql_once(
  account: string | null,
  slot: EnvSlot,
  host: string,
  query: string,
  vars: Array<[string, string]>,
  numbers: Array<[string, number]>,
): Promise<any> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of vars) args.push("-f", `${k}=${v}`);
  for (const [k, n] of numbers) args.push("-F", `${k}=${n}`);
  if (host !== "github.com") args.push("--hostname", host);
  const out = await gh(account, slot, args);
  // gh prints GraphQL errors' response too, and exits with 1.
  let v: any;
  try {
    v = JSON.parse(out.stdout.toString());
  } catch {}
  if (v !== null && typeof v === "object" && !Array.isArray(v)) return v;
  throw new Error(gh_error(out));
}

/** Run gh with `args` as `account` (gh's active account when null), making its environment in `slot` if it's missing. */
export async function gh(account: string | null, slot: EnvSlot, args: string[]): Promise<CmdOutput> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (account !== null) {
    if (slot.env === null) {
      try {
        slot.env = await account_env(account);
      } catch (e) {
        throw new Error(err_str(e));
      }
    }
    if (slot.env === null) throw new Error(`${account} isn't a GitHub account`);
    try {
      slot.env.check(args, null);
    } catch (e) {
      throw new Error(err_str(e));
    }
    slot.env.apply(env);
  } else {
    delete env.GH_REPO;
  }
  Object.assign(env, { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" });
  let out: CmdOutput;
  try {
    out = await command_output(gh_program(), args, { env, timeout: GH_TIMEOUT });
  } catch (e) {
    throw new Error(`couldn't run gh: ${io_error(e)}`);
  }
  if (out.timed_out) throw new Error(`gh timed out after ${GH_TIMEOUT / 1000} seconds`);
  return out;
}

export function gh_error(out: CmdOutput): string {
  let err = out.stderr.toString().trim();
  while (err.startsWith("gh: ")) err = err.slice(4);
  return `gh failed: ${err}`;
}

/** A sleep that `signal` cuts short. */
function sleep_unless(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Poll `w` for the wait `call_id` of `task_id` (after `delay`, then every `POLL`) until there's news, which it records
 * in the wait, or it has failed `GIVE_UP` times in a row. `signal` stops it (Rust drops the future), without recording
 * anything.
 */
export async function watch(s: Shared, task_id: string, call_id: string, events: string[], w: Watcher, delay: number, signal?: AbortSignal): Promise<void> {
  let failures = 0;
  for (;;) {
    await sleep_unless(delay, signal);
    if (signal?.aborted) return;
    let news: any | null;
    try {
      news = await w.poll(s, task_id, call_id, events, signal);
    } catch (e) {
      if (signal?.aborted) return;
      failures++;
      const msg = err_str(e);
      console.warn(`WARN task=${task_id} pr=${w.target.label()} failures=${failures}: reading a pull request: ${msg}`);
      if (failures >= GIVE_UP) {
        return record(s, task_id, call_id, {
          error: `${w.target.label()} couldn't be read ${GIVE_UP} times in a row: ${msg}`,
          events: ["unreadable"],
          number: w.target.number,
          url: w.target.url(),
        });
      }
      delay = backoff(failures);
      continue;
    }
    if (signal?.aborted) return;
    if (news !== null) return record(s, task_id, call_id, news);
    failures = 0;
    delay = POLL;
  }
}

/** How long (ms) to wait before reading again after `failures` failed reads in a row. */
export function backoff(failures: number): number {
  return Math.min(POLL * 2 ** Math.min(failures, 4), POLL * 10);
}

/** Keep `news` in the wait `call_id` (if it's still waiting), which ends it. */
function record(s: Shared, task_id: string, call_id: string, news: any) {
  try {
    // One read and write with nothing in between, as for a subagent's completion (see mcp/wait.ts).
    const c = s.db();
    const w = db.get_task(c, task_id)?.agent_wait;
    if (!w || w.call_id !== call_id) return;
    const pr = w.pull_request;
    if (!pr || pr.news != null) return;
    pr.news = news;
    const t = db.update_task(c, task_id, [["agent_wait", w]]);
    if (t) s.emit_task(t);
  } catch (e) {
    console.error(`ERROR task=${task_id}: recording a pull request's news: ${err_str(e)}`);
  }
}

/** The news that the wait `call_id` on `w` found has reached the agent: it's been told. */
export function delivered(s: Shared, task_id: string, call_id: string, w: WaitPr) {
  const target = Target.of(w);
  if (!target) return;
  told(s, task_id, target.key(), call_id, () => {});
}

/**
 * The news that `call_id` found about the pull request `key` has reached `task_id`'s agent, if it's still the news kept
 * for it: it's been told. `also` changes the row with it.
 */
export function told(s: Shared, task_id: string, key: string, call_id: string, also: (row: Row) => void) {
  try {
    const c = s.db();
    const row = load(c, task_id, key);
    if (!row) return;
    const p = row.pending;
    if (p && p.call_id === call_id) {
      delete row.pending;
      row.seen = p.told;
      also(row);
      store(c, task_id, key, row);
    }
  } catch (e) {
    console.error(`ERROR task=${task_id}: recording what the agent was told about a pull request: ${err_str(e)}`);
  }
}

/** What the last read of `w` for `task_id` found, for a wait that ended otherwise. */
export function last(s: Shared, task_id: string, w: WaitPr): any | null {
  const target = Target.of(w);
  if (!target) return null;
  let row: Row | null = null;
  try {
    row = load(s.db(), task_id, target.key());
  } catch {}
  if (!row) return null;
  const l = row.last !== null && typeof row.last === "object" ? { ...row.last } : {};
  l.read_at = row.polled_at;
  return l;
}
