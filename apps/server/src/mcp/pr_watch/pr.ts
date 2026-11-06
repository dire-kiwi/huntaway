// Port of server/src/mcp/pr_watch/pr.rs: the pull request as a read finds it (`QUERY`, `Pr`), and what in it is news
// to the agent (`compare`, `note`).
import { BODY_MAX, LISTED, SEEN_MAX } from "../pr_watch.ts";
import { Seen_clone, Seen_default, type Seen } from "./seen.ts";

/**
 * The review threads a read gets (100 at a time, the oldest first, so that new ones on a busy pull request are on later
 * pages), with the latest comments of each.
 */
const threads = (args: string) =>
  `reviewThreads(first: 100${args}) { pageInfo { hasNextPage endCursor } nodes { path comments(last: 20) { nodes { id author { __typename login } authorAssociation body url createdAt path line originalLine } } } }`;

/** A pull request's head commit's checks (see `checks_of`), for a query whose pull request's number is `$number`. */
const CHECKS_FIELDS = `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { databaseId name status conclusion detailsUrl isRequired(pullRequestNumber: $number) checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl createdAt isRequired(pullRequestNumber: $number) }
      } } } } } }`;

/**
 * The fields of a pull request that `checks_of` reads (with `headRefOid`), for another query (see merged.rs), whose pull
 * request's number is `$number`.
 */
export const CHECKS = `headRefOid ${CHECKS_FIELDS}`;

/**
 * The query a read makes: the pull request's state, its head commit's checks, and its latest comments, reviews and
 * review comments, with who's asking (`viewer`).
 */
export const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url number title state isDraft baseRefName headRefOid mergeable mergeStateStatus reviewDecision
      ${CHECKS_FIELDS}
      comments(last: 50) { nodes { id author { __typename login } authorAssociation body url createdAt } }
      reviews(last: 50) { nodes { id author { __typename login } authorAssociation state body url submittedAt } }
      ${threads("")}
    }
  }
}`;

/** The query for the review threads after the first page's (see `Watcher.read_all`). */
export const THREADS = `query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${threads(", after: $after")}
    }
  }
}`;

export type CheckState = "Pending" | "Passed" | "Failed";

export interface Check {
  /** One run of it: a check run's id, or a status's context and time. */
  key: string;
  name: string;
  state: CheckState;
  /** How it ended (`failure`, `cancelled`…), or its status while it runs. */
  conclusion: string;
  url: string | null;
  required: boolean;
  /** The GitHub Actions job it is (a check run's id is its job's), whose log can be read. */
  job: number | null;
}

/** A comment, review or review comment. */
export interface Remark {
  id: string;
  author: string | null;
  /** Whether a GitHub App (a bot) wrote it. */
  bot: boolean;
  /** Its author's association with the repository (owner, member, collaborator, contributor, none…), as GitHub has it. */
  association: string | null;
  kind: "comment" | "review" | "review_comment";
  review_state: string | null;
  path: string | null;
  line: number | null;
  body: string;
  url: string | null;
  at: string | null;
}

/**
 * Whether its author can push to the repository (its owner, or a member or collaborator): only their comments wake an
 * agent whose task is in review (see `watch_in_review`).
 */
export function by_maintainer(r: Remark): boolean {
  return r.association === "owner" || r.association === "member" || r.association === "collaborator";
}

/** A review that only says it commented, whose comments say what it did. */
function is_bare_review(r: Remark): boolean {
  return r.kind === "review" && r.review_state === "commented" && !r.body.trim();
}

/** A pull request as a read found it. */
export interface Pr {
  viewer: string;
  url: string;
  number: number;
  title: string;
  /** open, merged or closed. */
  state: string;
  draft: boolean;
  base: string;
  head: string;
  /** mergeable, conflicting or unknown (GitHub hasn't worked it out yet). */
  mergeable: string;
  merge_state: string | null;
  review_decision: string | null;
  checks: Check[];
  remarks: Remark[];
}

const lower = (v: any): string | null => (typeof v === "string" ? v.toLowerCase() : null);
const string = (v: any): string | null => (typeof v === "string" ? v : null);
const is_object = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
const u64 = (v: any): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** The checks of a pull request read with `CHECKS`. */
export function checks_of(pr: any): Check[] {
  const checks: Check[] = [];
  const contexts = pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes;
  for (const c of Array.isArray(contexts) ? contexts : []) {
    const required = c?.isRequired === true;
    if (c?.__typename === "CheckRun") {
      const status = lower(c.status) ?? "";
      const conclusion = lower(c.conclusion) ?? "";
      const state: CheckState =
        status !== "completed"
          ? "Pending"
          : ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(conclusion)
            ? "Failed"
            : "Passed";
      let name: string = typeof c.name === "string" ? c.name : "check";
      const workflow = c.checkSuite?.workflowRun?.workflow?.name;
      if (typeof workflow === "string" && workflow) name = `${workflow} / ${name}`;
      const id = u64(c.databaseId) !== null ? String(c.databaseId) : (string(c.databaseId) ?? "");
      const job = is_object(c.checkSuite?.workflowRun) && /^\+?[0-9]+$/.test(id) ? Number(id) : null;
      checks.push({ key: `run:${id}`, name, state, conclusion: state === "Pending" ? status : conclusion, url: string(c.detailsUrl), required, job });
    } else if (c?.__typename === "StatusContext") {
      const status = lower(c.state) ?? "";
      const state: CheckState = status === "success" ? "Passed" : status === "failure" || status === "error" ? "Failed" : "Pending";
      const name = typeof c.context === "string" ? c.context : "status";
      const key = `status:${name}:${typeof c.createdAt === "string" ? c.createdAt : ""}`;
      checks.push({ key, name, state, conclusion: status, url: string(c.targetUrl), required, job: null });
    }
  }
  return checks;
}

/** A pull request from the query's response (Rust's `Pr::parse`). Throws GitHub's errors if it has none. */
export function Pr_parse(v: any): Pr {
  const pr = v?.data?.repository?.pullRequest;
  if (!is_object(pr)) {
    const errors = (Array.isArray(v?.errors) ? v.errors : []).map((e: any) => e?.message).filter((m: any) => typeof m === "string");
    throw new Error(errors.length ? errors.join("; ") : "GitHub didn't return the pull request");
  }
  const checks = checks_of(pr);
  const remarks: Remark[] = [];
  const author = (n: any) => string(n?.author?.login);
  const bot = (n: any) => n?.author?.__typename === "Bot";
  const association = (n: any) => lower(n?.authorAssociation);
  const body = (n: any) => (typeof n?.body === "string" ? n.body : "");
  const id = (n: any) => (typeof n?.id === "string" ? n.id : "");
  const nodes = (x: any): any[] => (Array.isArray(x?.nodes) ? x.nodes : []);
  for (const n of nodes(pr.comments)) {
    remarks.push({
      id: id(n),
      author: author(n),
      bot: bot(n),
      association: association(n),
      kind: "comment",
      review_state: null,
      path: null,
      line: null,
      body: body(n),
      url: string(n?.url),
      at: string(n?.createdAt),
    });
  }
  for (const n of nodes(pr.reviews)) {
    // A review being written is its author's own.
    if (n?.state === "PENDING") continue;
    remarks.push({
      id: id(n),
      author: author(n),
      bot: bot(n),
      association: association(n),
      kind: "review",
      review_state: lower(n?.state),
      path: null,
      line: null,
      body: body(n),
      url: string(n?.url),
      at: string(n?.submittedAt),
    });
  }
  for (const t of nodes(pr.reviewThreads)) {
    for (const n of nodes(t?.comments)) {
      remarks.push({
        id: id(n),
        author: author(n),
        bot: bot(n),
        association: association(n),
        kind: "review_comment",
        review_state: null,
        path: string(n?.path) ?? string(t?.path),
        line: u64(n?.line) ?? u64(n?.originalLine),
        body: body(n),
        url: string(n?.url),
        at: string(n?.createdAt),
      });
    }
  }
  const kept = remarks.filter((r) => r.id !== "");
  kept.sort((a, b) => (a.at === b.at ? 0 : a.at === null ? -1 : b.at === null ? 1 : a.at < b.at ? -1 : 1));
  return {
    viewer: typeof v?.data?.viewer?.login === "string" ? v.data.viewer.login : "",
    url: typeof pr.url === "string" ? pr.url : "",
    number: u64(pr.number) ?? 0,
    title: typeof pr.title === "string" ? pr.title : "",
    state: lower(pr.state) ?? "open",
    draft: pr.isDraft === true,
    base: typeof pr.baseRefName === "string" ? pr.baseRefName : "",
    head: typeof pr.headRefOid === "string" ? pr.headRefOid : "",
    mergeable: lower(pr.mergeable) ?? "unknown",
    merge_state: lower(pr.mergeStateStatus),
    review_decision: lower(pr.reviewDecision),
    checks,
    remarks: kept,
  };
}

function is_own(pr: Pr, r: Remark): boolean {
  return r.author !== null && pr.viewer !== "" && r.author.toLowerCase() === pr.viewer.toLowerCase();
}

/** Whether the checks that have to pass did: the required ones, or all of them if none is. */
export function passed(checks: Check[]): boolean {
  const required = checks.filter((c) => c.required);
  const gate = required.length ? required : checks;
  return gate.length > 0 && gate.every((c) => c.state === "Passed");
}

/** How `checks` stand: `none`, `failed` (any of them), `passed` (see `passed`) or `pending`. */
export function outcome(checks: Check[]): string {
  if (!checks.length) return "none";
  if (checks.some((c) => c.state === "Failed")) return "failed";
  if (passed(checks)) return "passed";
  return "pending";
}

/**
 * What's news in `pr` to an agent that was told `seen` (null for its first wait on it), of `events`: what to store as
 * seen meanwhile (its own comments, a conflict that's gone), and the news, if any, with what it will have been told once
 * it gets it.
 */
export function compare(seen: Seen | null, pr: Pr, events: string[]): [Seen, [any, Seen] | null] {
  const wants = (e: string) => events.includes(e);
  const first = seen === null;
  const quiet = seen ? Seen_clone(seen) : Seen_default();
  // Never news: the agent's own comments, those from before its first wait, and reviews that only say their comments
  // were made.
  for (const r of pr.remarks) {
    if ((first || is_own(pr, r) || is_bare_review(r)) && !quiet.remarks.includes(r.id)) quiet.remarks.push(r.id);
  }
  // Unknown while GitHub works it out (after a push): only a clean answer ends a conflict.
  const conflicting = pr.mergeable === "conflicting" ? true : pr.mergeable === "mergeable" ? false : null;
  if (conflicting === false) quiet.conflicting = false;
  // Over SEEN_MAX, the oldest ids that this read doesn't see go: one it sees would be news again.
  const visible = new Set(pr.remarks.map((r) => r.id));
  const trim = (remarks: string[]): string[] => {
    let extra = Math.max(0, remarks.length - SEEN_MAX);
    return remarks.filter((id) => {
      const drop = extra > 0 && !visible.has(id);
      if (drop) extra--;
      return !drop;
    });
  };
  quiet.remarks = trim(quiet.remarks);

  const told = Seen_clone(quiet);
  const found: string[] = [];
  // The head's checks: what the agent was told of them, if it's the head it was told about.
  const same_head = quiet.head === pr.head;
  let failed = same_head ? [...quiet.failed] : [];
  let was_passed = same_head ? quiet.passed : false;
  const new_failed = pr.checks.filter((c) => c.state === "Failed" && !failed.includes(c.key));
  let checks_news = false;
  if (wants("checks_failed") && new_failed.length) {
    found.push("checks_failed");
    failed.push(...new_failed.map((c) => c.key));
    checks_news = true;
  }
  if (wants("checks_passed") && passed(pr.checks) && !was_passed) {
    found.push("checks_passed");
    was_passed = true;
    checks_news = true;
  }
  if (checks_news) {
    told.head = pr.head;
    told.failed = failed;
    told.passed = was_passed;
  }
  const new_remarks = pr.remarks.filter((r) => !quiet.remarks.includes(r.id));
  if (wants("comments") && new_remarks.length) {
    found.push("comments");
    told.remarks.push(...new_remarks.map((r) => r.id));
    told.remarks = trim(told.remarks);
  }
  if (wants("conflicts") && conflicting === true && !quiet.conflicting) {
    found.push("conflicts");
    told.conflicting = true;
  }
  if (pr.state === "merged" || pr.state === "closed") found.push(pr.state === "merged" ? "merged" : "closed");
  if (!found.length) return [quiet, null];
  const report = summary(pr);
  report.events = found;
  if (found.includes("comments")) {
    report.comments = new_remarks.slice(0, LISTED).map(remark);
    if (new_remarks.length > LISTED) report.more_comments = new_remarks.length - LISTED;
  }
  return [quiet, [report, told]];
}

/** The pull request's state, for the agent. */
export function summary(pr: Pr): any {
  const failed = pr.checks.filter((c) => c.state === "Failed").map((c) => ({ conclusion: c.conclusion, name: c.name, required: c.required, url: c.url }));
  const pending = pr.checks.filter((c) => c.state === "Pending").map((c) => c.name);
  const passed_n = pr.checks.filter((c) => c.state === "Passed").length;
  const required = pr.checks.some((c) => c.required);
  return {
    base_branch: pr.base,
    checks: { failed, outcome: outcome(pr.checks), passed: passed_n, pending, required_checks: required },
    draft: pr.draft,
    head: pr.head,
    merge_state: pr.merge_state,
    mergeable: pr.mergeable,
    number: pr.number,
    review_decision: pr.review_decision,
    state: pr.state,
    title: pr.title,
    url: pr.url,
  };
}

/** A comment for the agent, its text trimmed. */
function remark(r: Remark): any {
  const v: any = { at: r.at, author: r.author, body: trimmed(r.body), kind: r.kind, url: r.url };
  if (r.association !== null) v.author_association = r.association;
  if (r.review_state !== null) v.review_state = r.review_state;
  if (r.path !== null) {
    v.path = r.path;
    v.line = r.line;
  }
  return v;
}

/** A comment's text without HTML comments (bots' metadata), and cut short if it's long. */
export function trimmed(body: string): string {
  let text = "";
  let rest = body;
  for (;;) {
    const i = rest.indexOf("<!--");
    if (i < 0) break;
    text += rest.slice(0, i);
    const j = rest.indexOf("-->", i);
    rest = j < 0 ? "" : rest.slice(j + 3);
  }
  text += rest;
  const chars = [...text.trim()];
  if (chars.length > BODY_MAX) return `${chars.slice(0, BODY_MAX).join("")}… [${chars.length - BODY_MAX} more characters]`;
  return chars.join("");
}

/** What the tool tells the agent about `news` (see `compare`) on its pull request. */
export function note(news: any): string {
  const n = u64(news?.number);
  const label = n !== null ? `#${n}` : "The pull request";
  const events: string[] = (Array.isArray(news?.events) ? news.events : []).filter((e: any) => typeof e === "string");
  if (events.includes("unreadable")) {
    const error = typeof news?.error === "string" ? news.error : "The pull request couldn't be read";
    return `${error}. Check it yourself (pr_view), and wait on it again once it can be read.`;
  }
  return `Pull request ${label}: ${what(news, events).join("; ")} (see pull_request).`;
}

/** What happened, for each of `events` in `news`. */
export function what(news: any, events: string[]): string[] {
  const names = (list: any) =>
    (Array.isArray(list) ? list : [])
      .map((c: any) => c?.name)
      .filter((x: any) => typeof x === "string")
      .join(", ");
  const parts: string[] = [];
  for (const e of events) {
    switch (e) {
      case "checks_failed":
        parts.push(`checks failed (${names(news?.checks?.failed)})`);
        break;
      case "checks_passed": {
        const n = Array.isArray(news?.checks?.pending) ? news.checks.pending.length : 0;
        parts.push(`all ${news?.checks?.required_checks === true ? "required " : ""}checks passed${n === 0 ? "" : ` (${n} other still running)`}`);
        break;
      }
      case "comments": {
        const list: any[] = Array.isArray(news?.comments) ? news.comments : [];
        const n = list.length + (u64(news?.more_comments) ?? 0);
        const who: string[] = [];
        for (const a of list.map((c) => c?.author).filter((a) => typeof a === "string")) if (!who.includes(a)) who.push(a);
        // Deleted users' (GitHub's "ghost") comments have no author.
        const whom = who.length ? who.join(", ") : "someone";
        parts.push(`${n} new comment${n === 1 ? "" : "s"} or review${n === 1 ? "" : "s"} from ${whom}`);
        break;
      }
      case "conflicts":
        parts.push(`it conflicts with ${typeof news?.base_branch === "string" ? news.base_branch : "its base branch"}`);
        break;
      case "merged":
        parts.push("it was merged");
        break;
      case "closed":
        parts.push("it was closed");
        break;
      default:
        parts.push(e);
    }
  }
  return parts;
}
