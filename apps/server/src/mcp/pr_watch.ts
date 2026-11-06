// Port of server/src/mcp/pr_watch.rs.
//
// A `wait` on a pull request (`pull_request`, API 62): the wait ends on news about it that the agent hasn't been told
// yet (`EVENTS`, all of them unless it picks some):
// - `checks_failed`: a check on its head commit failed (or was cancelled or timed out);
// - `checks_passed`: all of its head commit's required checks passed (all of its checks, when none is required);
// - `comments`: someone other than the agent's own GitHub account commented or reviewed;
// - `conflicts`: it started to conflict with its base branch;
// - and, whatever it picked, its being merged or closed.
//
// The server reads it with one GraphQL query every `POLL` (and one more for each page of review threads past the
// first, see `Watcher.read_all`), as the GitHub account the task's gh tools act as (its project's or profile's, see
// runner::github_account; gh's active account when neither picks one), and never as another: an account that isn't
// signed in fails the read, and one on another host than the pull request's doesn't start the wait. A read that fails
// is tried again later and later (`backoff`), and after `GIVE_UP` failures in a row the wait ends saying so
// (`unreadable`). The first read is made before the wait starts, so a pull request that can't be read (a typo, no
// access) fails the call straight away.
//
// What the agent has been told about each pull request is kept for its task (`pr_watches`), across its waits and
// server restarts: the comments and reviews seen, the head commit whose checks' outcome it was told, and whether it was
// told of a conflict. So a wait reports what happened since the last one on that pull request: a review that arrives
// while the agent works between two waits ends the second one straight away, and a restart doesn't report old comments
// again. The first wait on a pull request counts the comments it has as seen, but reports how its checks ended and a
// conflict. News counts as told once a call returns it to the agent: one that ends without reaching it (the run
// stopped, or carried on with something else) leaves it for the next wait.
//
// The board also reads the pull request of a task in "In review" while its agent is idle, in projects that ask for it,
// and sends the agent its news (see `watch_in_review`), with the same record of what it has been told.
import * as db from "../db.ts";
import type { Task, WaitPr } from "../db.ts";
import type { Shared } from "../state.ts";
import * as runner from "../agent/runner.ts";
import * as worktree from "../git/worktree.ts";
import { err_str, expand_tilde, IN_TEST } from "../util.ts";
import { Account } from "./gh_mcp.ts";

export * from "./pr_watch/read.ts";
export * from "./pr_watch/seen.ts";
export * from "./pr_watch/pr.ts";
export * from "./pr_watch/in_review.ts";
export * from "./pr_watch/failed.ts";

/** Whether this runs in tests (util.ts's IN_TEST), for shorter periods. */
export const TEST = IN_TEST;

/** What can end a wait on a pull request, besides its being merged or closed. */
export const EVENTS = ["checks_failed", "checks_passed", "comments", "conflicts"];

/** How often a pull request is read (ms). */
export const POLL = TEST ? 100 : 60_000;

/** How many failed reads in a row end the wait. */
export const GIVE_UP = 5;

/** How long a gh call may take (ms). */
export const GH_TIMEOUT = 60_000;

/** The most pages of review threads (100 each) a read goes through. */
export const THREAD_PAGES = 10;

/** The most comments a wait lists, and how much of each one's text. */
export const LISTED = 20;
export const BODY_MAX = 800;

/**
 * How many comment ids are kept as seen (the reads see the latest ones only), besides those the latest read still
 * sees, which are always kept (see `compare`).
 */
export const SEEN_MAX = 2000;

/** A pull request on a GitHub host. */
export class Target {
  host: string;
  owner: string;
  name: string;
  number: number;
  constructor(host: string, owner: string, name: string, number: number) {
    this.host = host;
    this.owner = owner;
    this.name = name;
    this.number = number;
  }

  /** `OWNER/REPO`, or `HOST/OWNER/REPO` off github.com. */
  repo(): string {
    return this.host === "github.com" ? `${this.owner}/${this.name}` : `${this.host}/${this.owner}/${this.name}`;
  }

  url(): string {
    return `https://${this.host}/${this.owner}/${this.name}/pull/${this.number}`;
  }

  /** `OWNER/REPO#N` (with the host off github.com). */
  label(): string {
    return `${this.repo()}#${this.number}`;
  }

  /** What the agent's been told about it is kept under (see `pr_watches`). */
  key(): string {
    return `${this.host}/${this.owner}/${this.name}#${this.number}`.toLowerCase();
  }

  /** The pull request a stored wait watches. */
  static of(w: WaitPr): Target | null {
    const parts = w.repo.split("/");
    if (parts.length === 2) return new Target("github.com", parts[0], parts[1], w.number);
    if (parts.length === 3) return new Target(parts[0], parts[1], parts[2], w.number);
    return null;
  }

  /**
   * The pull request a wait was given: its number (`12`, `#12`), `OWNER/REPO#12` or URL. A number is in `def` (the
   * task's repository: its host and `OWNER/REPO`), and `OWNER/REPO` on its host. Throws why it isn't one.
   */
  static parse(given: string, def: [string, string] | null): Target {
    given = given.trim();
    const number = (n: string): number | null => {
      // A whole number written as a float (`7.0`, as agents send numbers sometimes) is that number.
      const dot = n.indexOf(".");
      if (dot >= 0) {
        const zeros = n.slice(dot + 1);
        if (zeros && /^0+$/.test(zeros)) n = n.slice(0, dot);
      }
      if (!/^\+?[0-9]+$/.test(n)) return null;
      const v = Number(n.replace(/^\+/, ""));
      return Number.isSafeInteger(v) && v > 0 ? v : null;
    };
    const in_repo = (host: string, repo: string, n: number): Target | null => {
      const i = repo.indexOf("/");
      if (i < 0) return null;
      const [owner, name] = [repo.slice(0, i), repo.slice(i + 1)];
      if (!ok_name(owner) || !ok_name(name)) return null;
      return new Target(host.toLowerCase(), owner, name, n);
    };
    const rest = given.startsWith("https://") ? given.slice(8) : given.startsWith("http://") ? given.slice(7) : null;
    if (rest !== null) {
      // Its page or one of its tabs (`/files`), with or without an anchor.
      const parts = rest.split(/[#?]/)[0].split("/");
      if (parts.length >= 5 && parts[3] === "pull") {
        const n = number(parts[4]);
        if (n !== null) {
          const host = worktree.is_github_com(parts[0].toLowerCase()) ? "github.com" : parts[0];
          const t = in_repo(host, `${parts[1]}/${parts[2]}`, n);
          if (!t) throw new Error(`${given} isn't a pull request's URL`);
          return t;
        }
      }
      throw new Error(`${given} isn't a pull request's URL (https://github.com/OWNER/REPO/pull/NUMBER)`);
    }
    const no_repo = "this task's repository has no remote on GitHub to find the pull request in: give its URL (https://github.com/OWNER/REPO/pull/NUMBER)";
    const hash = given.indexOf("#");
    if (hash > 0) {
      const n = number(given.slice(hash + 1));
      if (n !== null) {
        const host = def ? def[0] : "github.com";
        const t = in_repo(host, given.slice(0, hash), n);
        if (!t) throw new Error(`${given} isn't a pull request (OWNER/REPO#NUMBER)`);
        return t;
      }
    }
    const n = number(given.replace(/^#+/, ""));
    if (n === null) throw new Error(`${given} isn't a pull request: give its number, OWNER/REPO#NUMBER or its URL`);
    if (!def) throw new Error(no_repo);
    const t = in_repo(def[0], def[1], n);
    if (!t) throw new Error(no_repo);
    return t;
  }
}

/** `Target::parse`: throws why `given` isn't a pull request. */
export function Target_parse(given: string, def: [string, string] | null): Target {
  return Target.parse(given, def);
}

/** `Target::of`. */
export function Target_of(w: WaitPr): Target | null {
  return Target.of(w);
}

/** An owner's or repository's name as GitHub has them. */
function ok_name(s: string): boolean {
  return /^[A-Za-z0-9\-_.]+$/.test(s);
}

/** What a wait's `pull_request` and `pull_request_events` ask for. */
export interface Request {
  target: Target;
  events: string[];
}

/** How the wait keeps it (Rust's `Request::stored`). */
export function stored(r: Request, news: any | null): WaitPr {
  const w: WaitPr = { url: r.target.url(), repo: r.target.repo(), number: r.target.number, events: [...r.events] };
  if (news !== null && news !== undefined) w.news = news;
  return w;
}

/**
 * The pull request `pr` (a number or a string, see `Target.parse`) that `task`'s agent asked to wait on, and `events`
 * (null for all of them, see `EVENTS`). Throws why not.
 */
export async function request(s: Shared, task: Task, pr: any, events: any): Promise<Request> {
  let evs: string[];
  if (events === null || events === undefined) evs = [...EVENTS];
  else if (Array.isArray(events)) {
    evs = [];
    for (const e of events) {
      if (typeof e === "string" && EVENTS.includes(e)) {
        if (!evs.includes(e)) evs.push(e);
      } else throw new Error(`pull_request_events takes ${EVENTS.join(", ")} (got ${JSON.stringify(e)})`);
    }
  } else throw new Error(`pull_request_events must be a list of ${EVENTS.join(", ")}`);
  let given: string;
  if (typeof pr === "number") given = String(pr);
  else if (typeof pr === "string") given = pr;
  else throw new Error("pull_request must be a pull request's number or URL");
  const def = await task_repo(s, task);
  const target = Target.parse(given, def);
  let account: string | null;
  try {
    account = runner.task_github_account(s, task);
  } catch (e) {
    throw new Error(err_str(e));
  }
  const a = account ? Account.parse(account) : null;
  if (a && a.host !== target.host) {
    // Its host came from the task's remote, which may name it in a way that isn't GitHub's.
    if (!given.trim().startsWith("http")) {
      throw new Error(
        `this task's repository is pushed to ${target.host}, but its GitHub account ${a} is on ${a.host}: give the pull request's URL (https://${a.host}/OWNER/REPO/pull/NUMBER)`,
      );
    }
    throw new Error(`${target.label()} is on ${target.host}, but this task's GitHub account ${a} is on ${a.host}, so it can't be read`);
  }
  return { target, events: evs };
}

/** The host and `OWNER/REPO` of the repository `task`'s branch is pushed to, if it has one. */
async function task_repo(s: Shared, task: Task): Promise<[string, string] | null> {
  if (!task.project_id) return null;
  let project;
  try {
    project = db.get_project(s.db(), task.project_id);
  } catch {
    return null;
  }
  if (!project) return null;
  const base = await worktree.remote_base(s, task, project);
  const found = await worktree.push_repo(expand_tilde(project.repo_path), base ?? null);
  if (!found) return null;
  const [host, repo] = found;
  return [worktree.is_github_com(host) ? "github.com" : host, repo];
}

// ---------- a fake GitHub, for tests ----------

type Fake = (account: string | null, target: Target, after: string | null) => any;

/**
 * A fake GitHub for tests: what each query gets, given the account it's read as and the cursor a query for more review
 * threads gives. It returns the response, or throws (an `Error` or a string) for a failed read.
 */
let FAKE: Fake | null = null;

/** The fake's answer to a query, or undefined without one. */
export function fake_answer(account: string | null, target: Target, after: string | null): { ok: any } | { err: string } | undefined {
  if (!FAKE) return undefined;
  try {
    return { ok: FAKE(account, target, after) };
  } catch (e) {
    return { err: typeof e === "string" ? e : err_str(e) };
  }
}

/**
 * Answer reads with `f` (given the account and the pull request) rather than GitHub. `f` returns the response, or
 * throws (an Error or a string) for a read that fails. `null` removes the fake.
 */
export function fake(f: ((account: string | null, target: Target) => any) | null) {
  FAKE = f ? (account, target) => f(account, target) : null;
}

/** As `fake`, given the cursor of each query for more review threads too. */
export function fake_pages(f: Fake | null) {
  FAKE = f;
}

/**
 * A query's response for tests: a pull request `number` in `o/r`, open and mergeable, with `checks` (`[name, state,
 * conclusion, required]`), `comments` (`[id, author, body]`), read as `viewer`.
 */
export function response(viewer: string, head: string, checks: Array<[string, string, string, boolean]>, comments: Array<[string, string, string]>): any {
  const contexts = checks.map(([name, status, conclusion, required], i) => ({
    __typename: "CheckRun",
    databaseId: `${head}${i}`,
    name,
    status,
    conclusion: conclusion === "" ? null : conclusion,
    detailsUrl: `https://github.com/o/r/actions/runs/${i}`,
    isRequired: required,
  }));
  const cs = comments.map(([id, author, body]) => ({
    id,
    author: { login: author },
    body,
    url: `https://github.com/o/r/pull/7#${id}`,
    createdAt: `2026-10-31T00:00:${id}Z`,
  }));
  return {
    data: {
      viewer: { login: viewer },
      repository: {
        pullRequest: {
          url: "https://github.com/o/r/pull/7", number: 7, title: "A change", state: "OPEN", isDraft: false, baseRefName: "main",
          headRefOid: head, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null,
          commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] },
          comments: { nodes: cs }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
        },
      },
    },
  };
}
