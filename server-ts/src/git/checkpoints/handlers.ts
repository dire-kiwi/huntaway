// Port of server/src/git/checkpoints/handlers.rs: the API: a task's turns, a turn's diff, and rewinding.
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as db from "../../db.ts";
import type { Task } from "../../db.ts";
import { ApiError, type Req } from "../../http.ts";
import type { AppState } from "../../state.ts";
import { err_str, now, truncate } from "../../util.ts";
import { MAX_DIFF, latest, list, queued, ref_name, ref_prefix, type Checkpoint, type Rewind } from "../checkpoints.ts";
import { brought_in, names, numstat, without } from "./changed.ts";
import { head, keep, run, run_ok, snapshot, text, worktree_top } from "./git.ts";
import { restore, unstaged, type Restored } from "./restore.ts";

/** The text a message starts with, for a turn's label. */
function message_label(data: any): string {
  const t = typeof data?.user_text === "string" ? data.user_text : typeof data?.text === "string" ? data.text : "";
  return truncate(t.trim(), 300);
}

/** Rust's `str::lines`. */
function lines(s: string): string[] {
  const ls = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (ls.length && ls[ls.length - 1] === "") ls.pop();
  return ls;
}

/** The task's first user message's id. */
function first_user_message(c: db.Conn, task_id: string): number | null {
  return db.value<number>(c, "SELECT MIN(id) FROM messages WHERE task_id=?1 AND kind='user'", task_id) ?? null;
}

/** A message's data, parsed (null if it isn't JSON), if the task has it. */
function message_data(c: db.Conn, id: number, task_id: string): any | undefined {
  const d = db.value<string>(c, "SELECT data FROM messages WHERE id=?1 AND task_id=?2", id, task_id);
  if (d === undefined) return undefined;
  try {
    return JSON.parse(d);
  } catch {
    return null;
  }
}

/**
 * `GET /tasks/{id}/turns`: the task's turns with checkpoints, oldest first, what each changed, and whether each can be
 * rewound to (and its conversation with it).
 */
export async function turns(s: AppState, r: Req): Promise<any> {
  const id = r.params.id;
  const task = db.get_task(s.db(), id);
  if (!task) throw ApiError.not_found("task");
  const top = await worktree_top(s, id);
  if (top === null) {
    const reason = task.use_worktree ? "the task's worktree isn't set up" : "the task works in its project's repository, not a worktree of its own";
    return { available: false, reason, turns: [], rewind: task.rewind ?? null };
  }
  const rows = list(s.db(), id);
  const o = await run(top, ["for-each-ref", "--format=%(refname:lstrip=-1)", ref_prefix(id)]);
  const have = new Set<number>();
  for (const l of lines(o.stdout.toString("utf8"))) {
    const t = l.trim();
    if (/^[+-]?\d+$/.test(t)) have.add(Number(t));
  }
  const messages = new Map<number, any>();
  for (const r of rows) {
    if (r.message_id === null) continue;
    const d = message_data(s.db(), r.message_id, id);
    if (d !== undefined) messages.set(r.message_id, d);
  }
  const first_user = first_user_message(s.db(), id);
  const codex = db.task_is_codex(s.db(), task);
  const running = s.is_running(id);
  const list_turns = rows
    .filter((r) => r.kind === "turn")
    .map((r) => {
      const before = r.before_n !== null && have.has(r.before_n) && rows.some((x) => x.n === r.before_n) ? r.before_n : null;
      const diff = before !== null && have.has(r.n);
      const m = r.message_id !== null ? messages.get(r.message_id) : undefined;
      const has_m = r.message_id !== null && messages.has(r.message_id);
      let files: string | null = null;
      if (running) files = "the agent is running";
      else if (r.stale > 0) files = "a rewind has gone back to before this turn";
      else if (before === null) files = "there's no checkpoint from before this turn";
      else if (r.message_id === null) files = "the message this turn started with isn't known";
      const c = conversation(task, rows, r, codex, first_user);
      const convo = "ok" in c ? { ok: true, fresh: c.ok.kind === "Fresh" } : { ok: false, reason: c.err };
      const round = m?.review_round;
      return {
        turn: r.turn,
        n: r.n,
        before_n: before,
        run_id: r.run_id,
        message_id: r.message_id,
        text: has_m ? message_label(m) : "",
        auto: has_m && m?.auto === true,
        review_round: Number.isInteger(round) && round >= 0 ? round : null,
        status: r.status,
        stale: r.stale > 0,
        at: r.created_at,
        head: r.head,
        before_head: before !== null ? (rows.find((x) => x.n === before)?.head ?? null) : null,
        stats: r.stats,
        diff,
        rewind: files === null ? { ok: true, conversation: convo } : { ok: false, reason: files },
      };
    });
  const h = await head(top);
  return { available: true, turns: list_turns, head: h, rewind: task.rewind ?? null, agent: codex ? "codex" : "claude" };
}

/** An i64 query parameter (axum's `Query`). */
function query_i64(q: Record<string, string>, key: string): number {
  const v = q[key];
  if (v === undefined) throw ApiError.bad(`Failed to deserialize query string: missing field \`${key}\``);
  if (!/^[+-]?\d+$/.test(v)) throw ApiError.bad(`Failed to deserialize query string: ${key}: invalid digit found in string`);
  return Number(v);
}

/**
 * `GET /tasks/{id}/turns/diff?from=&to=`: the changes from checkpoint `from` to `to` (a turn's, or several turns'
 * together), without the files git brought in.
 */
export async function diff(s: AppState, r: Req): Promise<any> {
  const q = { from: query_i64(r.query, "from"), to: query_i64(r.query, "to") };
  const id = r.params.id;
  const top = await worktree_top(s, id);
  if (top === null) throw ApiError.bad("the task has no worktree");
  const rows = list(s.db(), id);
  const find = (n: number) => {
    const c = rows.find((r) => r.n === n);
    if (!c) throw ApiError.not_found(`checkpoint ${n}`);
    return c;
  };
  const [from, to] = [find(q.from), find(q.to)];
  for (const c of [from, to]) {
    const o = await run(top, ["rev-parse", "-q", "--verify", `${ref_name(id, c.n)}^{commit}`]);
    if (!o.ok || text(o) !== c.sha) throw ApiError.conflict(`checkpoint ${c.n} is gone from the repository`);
  }
  const excluded = await brought_in(top, from.head, to.head, to.tree);
  const [stats, left_out] = await numstat(top, from.sha, to.sha, excluded);
  const o = await run_ok(top, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    from.sha,
    to.sha,
    "--",
  ]);
  const patch = without(o.stdout.toString("utf8"), new Set(left_out));
  const too_large = Buffer.byteLength(patch) > MAX_DIFF;
  return { patch: too_large ? "" : patch, too_large, stats, excluded: left_out };
}

/**
 * What a rewind does to the agent's conversation: `Nothing` (there's none yet), `Fresh` (the message started it: the
 * next one starts a new one), or `Back` (its next run takes it back).
 */
export type Convo = { kind: "Nothing" } | { kind: "Fresh" } | { kind: "Back"; rewind: Rewind };

/**
 * How the agent's conversation goes back to before turn `turn` of `rows` (the task's checkpoints), or why it can't.
 * `first_user` is the thread's first user message.
 */
export function conversation(task: Task, rows: Checkpoint[], turn: Checkpoint, codex: boolean, first_user: number | null): { ok: Convo } | { err: string } {
  const session = task.session_id ?? null;
  if (session === null) return { ok: { kind: "Nothing" } };
  if (turn.turn === null || turn.message_id === null) return { err: "the message this turn started with isn't known" };
  const [n, message_id] = [turn.turn, turn.message_id];
  const back = (resume_at: string | null, before_turn: string | null): { ok: Convo } => {
    const rewind: Rewind = { turn: n, message_id, session };
    if (resume_at !== null) rewind.resume_at = resume_at;
    if (before_turn !== null) rewind.before_turn = before_turn;
    return { ok: { kind: "Back", rewind } };
  };
  const changed = "the agent's conversation has changed since this message (a new session)";
  // The message started it: the next one starts a new one (with the task's description, as the first does).
  if (first_user === message_id) return { ok: { kind: "Fresh" } };
  if (codex) {
    // Codex reverts the thread to before the turn itself.
    if (turn.session !== null && turn.session === session && turn.agent_at !== null) return back(null, turn.agent_at);
    if (turn.session !== null && turn.session !== session) return { err: changed };
    return { err: "Codex didn't say which of its turns this was" };
  }
  // Claude resumes its session at the last message of the turn before, skipping turns already taken out of it.
  for (const r of [...rows].reverse().filter((r) => r.kind === "turn" && r.n < turn.n && r.stale < 2)) {
    if (r.session !== session) return { err: changed };
    if (r.agent_at !== null) return back(r.agent_at, null);
  }
  return { err: "the conversation from before this message wasn't recorded (it's from before checkpoints were taken)" };
}

export interface RewindBody {
  /** The user message to rewind to before. */
  message_id: number;
  /** Take the agent's conversation back too. */
  conversation: boolean;
  /** Move the branch back to where it was, if commits have been made since. */
  branch: boolean;
}

function rewind_body(b: any): RewindBody {
  const fail = (m: string) => new ApiError(422, `Failed to deserialize the JSON body into the target type: ${m}`);
  if (b === null || typeof b !== "object" || Array.isArray(b)) throw fail("invalid type: expected struct RewindBody");
  if (b.message_id === undefined) throw fail("missing field `message_id`");
  if (!Number.isInteger(b.message_id)) throw fail("message_id: invalid type: expected i64");
  for (const k of ["conversation", "branch"]) {
    if (b[k] !== undefined && typeof b[k] !== "boolean") throw fail(`${k}: invalid type: expected a boolean`);
  }
  return { message_id: b.message_id, conversation: b.conversation ?? false, branch: b.branch ?? false };
}

/**
 * `POST /tasks/{id}/rewind {message_id, conversation, branch}`: restore the task's files to the checkpoint from before
 * the turn `message_id` started, and optionally its branch and its agent's conversation (on its next run). Refused
 * while its agent or a review of it is running.
 */
export async function rewind(s: AppState, r: Req): Promise<any> {
  const id = r.params.id;
  const b = rewind_body(r.body);
  if (!db.get_task(s.db(), id)) throw ApiError.not_found("task");
  return await queued(s, id, (s) => rewind_now(s, id, b));
}

function busy(state: AppState, task_id: string): string | null {
  if (state.is_running(task_id)) return "The agent is running: stop it before rewinding";
  const reviews = db.review_threads(state.db(), task_id);
  if (reviews.some((r) => r.running || state.is_running(r.id))) return "A review of the task is running in its worktree: wait for it or stop it first";
  return null;
}

async function rewind_now(state: AppState, task_id: string, b: RewindBody): Promise<any> {
  const task = db.get_task(state.db(), task_id);
  if (!task) throw ApiError.not_found("task");
  const why = busy(state, task_id);
  if (why !== null) throw ApiError.conflict(why);
  const top = await worktree_top(state, task_id);
  if (top === null) throw ApiError.bad("the task has no worktree of its own to rewind");
  const git_dir = text(await run_ok(top, ["rev-parse", "--absolute-git-dir"]));
  if (["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"].some((f) => existsSync(join(git_dir, f)))) {
    throw ApiError.conflict("A merge, rebase or cherry-pick is in progress in the worktree: finish or abort it first");
  }
  const rows = list(state.db(), task_id);
  // The first turn the message started (the agent may have gone on by itself after it).
  const turn = rows.find((r) => r.kind === "turn" && r.message_id === b.message_id && r.stale === 0);
  if (!turn) throw ApiError.bad("there's no checkpoint for this message's turn (or a rewind has gone back past it)");
  const before = turn.before_n !== null ? rows.find((r) => r.n === turn.before_n) : undefined;
  if (!before) throw ApiError.conflict("there's no checkpoint from before this turn");
  const o = await run(top, ["rev-parse", "-q", "--verify", `${ref_name(task_id, before.n)}^{commit}`]);
  if (!o.ok || text(o) !== before.sha) throw ApiError.conflict("the checkpoint from before this turn is gone from the repository");
  let convo: Convo = { kind: "Nothing" };
  if (b.conversation) {
    const first_user = first_user_message(state.db(), task_id);
    const codex = db.task_is_codex(state.db(), task);
    const c = conversation(task, rows, turn, codex, first_user);
    if ("err" in c) throw ApiError.conflict(`Can't take the conversation back: ${c.err}`);
    convo = c.ok;
  }

  // The files as they are now, kept (stale) so the rewind can be undone by hand.
  const last = latest(state.db(), task_id);
  const snap = await snapshot(top, last);
  const kept = await keep(state, task_id, top, snap, (n) => ({
    n,
    kind: "rewind",
    sha: snap.sha,
    tree: snap.tree,
    head: snap.head,
    before_n: null,
    run_id: null,
    turn: null,
    message_id: null,
    status: null,
    session: task.session_id ?? null,
    agent_at: null,
    stats: null,
    stale: 1,
    created_at: now(),
  }));

  // The branch goes back once the files have: checked first, so a refusal leaves everything as it was.
  let moved: [string, string] | null = null;
  if (before.head !== null && snap.head !== null && b.branch && before.head !== snap.head) {
    const [old, cur] = [before.head, snap.head];
    const ancestor = (await run(top, ["merge-base", "--is-ancestor", old, cur])).ok;
    if (!ancestor) throw ApiError.conflict("The branch has been rewritten since (a rebase or reset), so it can't be moved back: rewind the files only");
    moved = [old, cur];
  }
  const kept_ref = ref_name(task_id, kept.n);
  const failed = (e: unknown) => ApiError.conflict(`The rewind stopped part way: ${err_str(e)}. The files as they were are kept in ${kept_ref} (${kept.sha}).`);
  let restored: Restored;
  try {
    restored = await restore(top, snap.tree, before.tree);
    const unstage = new Set(restored.changed);
    if (moved) {
      const [old, cur] = moved;
      await run_ok(top, ["reset", "-q", "--soft", old]);
      for (const p of await names(top, old, cur)) if (!restored.hidden.has(p)) unstage.add(p);
    }
    await unstaged(top, unstage);
  } catch (e) {
    throw failed(e);
  }

  const stale = convo.kind === "Nothing" ? 1 : 2;
  db.run(state.db(), "UPDATE checkpoints SET stale=MAX(stale, ?3) WHERE task_id=?1 AND n>?2 AND n<>?4", task_id, before.n, stale, kept.n);
  const n = turn.turn ?? 0;
  const said_convo =
    convo.kind === "Nothing"
      ? b.conversation
        ? "; the agent had no conversation to take back"
        : "; the agent's conversation is kept as it is"
      : convo.kind === "Fresh"
        ? "; the next message starts a new conversation"
        : "; the agent's next run goes on from before that message";
  const fields: Array<[string, any]> =
    convo.kind === "Nothing"
      ? []
      : convo.kind === "Fresh"
        ? [["session_id", null], ["rewind", null], ["context", null]]
        : [["rewind", convo.rewind]];
  state.update_task(task_id, fields);
  const branch = moved ? `; the branch is back at ${moved[0].slice(0, 8)} (from ${moved[1].slice(0, 8)})` : "";
  let detail = `The files as they were are kept in ${ref_name(task_id, kept.n)} (${kept.sha}).`;
  if (restored.skipped.length) {
    detail +=
      "\nLeft as they are (submodules and other repositories, files marked skip-worktree or assume-unchanged, and files or folders the " +
      `checkpoints don't have, such as ignored ones): ${restored.skipped.join(", ")}`;
  }
  state.add_event(
    task_id,
    "info",
    `Rewound to before turn ${n}: ${plural(restored.written, "file")} restored, ${plural(restored.removed, "file")} removed${branch}${said_convo}`,
    detail,
  );
  state.emit({ type: "checkpoints", task_id });
  const t = db.get_task(state.db(), task_id);
  // The message, for the user to edit and send again.
  const message = message_data(state.db(), b.message_id, task_id) ?? null;
  const m_text = typeof message?.user_text === "string" ? message.user_text : typeof message?.text === "string" ? message.text : null;
  return {
    message: { text: m_text, auto: message?.auto === true },
    task: t ?? null,
    written: restored.written,
    removed: restored.removed,
    skipped: restored.skipped,
    branch: moved ? { from: moved[1], to: moved[0] } : null,
    kept: ref_name(task_id, kept.n),
  };
}

function plural(n: number, what: string): string {
  return `${n} ${what}${n === 1 ? "" : "s"}`;
}

/** `DELETE /tasks/{id}/rewind`: the agent's next run keeps its conversation as it is. */
export async function cancel_rewind(s: AppState, r: Req): Promise<any> {
  const task = s.update_task(r.params.id, [["rewind", null]]);
  if (!task) throw ApiError.not_found("task");
  return task;
}
