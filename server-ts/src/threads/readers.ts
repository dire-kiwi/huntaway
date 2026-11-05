// `huntaway threads-readers --db <file or data dir> [--json] [--task <id or key>]... [--examples <n>]`: runs each of
// threads/history.ts's readers both ways, from messages and from items, on every task of a board's database, and
// reports where they differ (step 6 of docs/threads.md). A task whose readers read items is compared as it is; any other
// is translated first (threads/write.ts's rebuild, as `huntaway threads-rebuild` would), so its items are its messages'
// translation. All of that is in one transaction that's rolled back: nothing is written. Run it on a copy of the board
// (`scripts/copy-live-board.sh`), at this build's database version.
//
// Each reader is asked what the board asks it: last_message and what the agent said since it was asked, the user's
// replies (all, and the latest few), Telegram's reply for each turn and how the latest ended, the open questions, the tool calls (and whether they changed code) since the start and since the middle
// of the thread, who wrote since each user message, whether a question's conversation moved on, the first user message
// and each turn's message, a subagent's call for each task_* message, and each tool call's name and input. Then the
// board's: pending approvals, prompt analytics for each profile, review stats' submissions, and the attachments threads
// refer to. Some messages readers read a window of the latest messages (what the agent said: the latest 50 of its
// messages; a tool call's name and input: the latest 5 that mention it), which the items readers don't: they're
// compared without it, and the answers the window changes are counted apart (`windowed`).
import * as db from "../db.ts";
import type { Conn } from "../db.ts";
import * as attachments from "../attachments.ts";
import * as analytics from "../analytics.ts";
import * as changes from "../git/changes.ts";
import * as permissions from "../mcp/permissions.ts";
import type { Shared } from "../state.ts";
import { now } from "../util.ts";
import * as history from "./history.ts";
import { open } from "./rebuild.ts";
import { rebuild } from "./write.ts";

export interface Options {
  db: string;
  json: boolean;
  tasks: string[];
  /** How many differences to list for each reader. */
  examples: number;
}

const USAGE = "Usage: huntaway threads-readers --db <file or data dir> [--json] [--task <id or key>]... [--examples <n>]";

export function parse_args(args: string[]): Options {
  const o: Options = { db: "", json: false, tasks: [], examples: 5 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const v = () => {
      const x = args[++i];
      if (x === undefined) throw new Error(`${a} needs a value`);
      return x;
    };
    if (a === "--db" || a === "--data-dir") o.db = v();
    else if (a === "--json") o.json = true;
    else if (a === "--task") o.tasks.push(v());
    else if (a === "--examples") o.examples = Number(v());
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  if (!o.db) throw new Error(`--db is needed\n${USAGE}`);
  return o;
}

/** A reader's answers on one input, from messages and from items. */
export interface Difference {
  reader: string;
  task_id: string | null;
  input: string;
  messages: unknown;
  items: unknown;
}

/** What comparing found. */
export interface Report {
  tasks: number;
  /** Tasks that were translated for it (their readers read messages). */
  translated: number;
  /** Tasks whose translation failed, with why. */
  failed: Array<{ task_id: string; error: string }>;
  /** By reader: how many inputs it was asked about, and how many gave different answers. */
  readers: Record<string, { checked: number; differ: number }>;
  differences: Difference[];
  /** Answers of the messages readers that their windows change (they're compared without them). */
  windowed: number;
  ms: number;
}

/** JSON with objects' keys sorted, to compare. */
const json = (v: unknown) => JSON.stringify(v ?? null, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));

export class Comparer {
  readers: Report["readers"] = {};
  differences: Difference[] = [];
  windowed = 0;

  check(reader: string, task_id: string | null, input: unknown, f: (from: history.Source) => unknown): void {
    const r = (this.readers[reader] ??= { checked: 0, differ: 0 });
    r.checked++;
    const [m, i] = [f("messages"), f("items")];
    if (json(m) === json(i)) return;
    r.differ++;
    this.differences.push({ reader, task_id, input: typeof input === "string" ? input : json(input), messages: m, items: i });
  }
}

/** A tool call (Claude's tool_use block and its tool_result) as what review reads of it. */
const call_summary = ([call, result]: [any, any | null]) => ({
  id: call.id,
  name: call.name,
  result: result ? (result.is_error === true ? "error" : "ok") : null,
  changes_code: changes.changes_code(call, result),
});

/** What the checkpoints and routine_call read of a turn's message. */
const turn_summary = (d: any) =>
  d === undefined
    ? "none"
    : {
        text: (typeof d?.user_text === "string" ? d.user_text : typeof d?.text === "string" ? d.text : "").trim(),
        auto: d?.auto === true,
        routine: d?.routine === true,
        review_round: Number.isInteger(d?.review_round) ? d.review_round : null,
      };

/** Compares the readers of one task, whose readers read items (it has them, or was translated). */
export function compare_task(cmp: Comparer, c: Conn, task_id: string): void {
  const max = Infinity;
  cmp.check("last_message", task_id, "", (from) => history.last_assistant_text(c, task_id, from, max));
  cmp.check("said_since_asked", task_id, "", (from) => history.said_since_asked(c, task_id, from, max));
  if (history.last_assistant_text(c, task_id, "messages") !== history.last_assistant_text(c, task_id, "messages", max)) cmp.windowed++;
  if (history.said_since_asked(c, task_id, "messages") !== history.said_since_asked(c, task_id, "messages", max)) cmp.windowed++;
  for (const limit of [null, 1, 3, 30]) cmp.check("user_replies", task_id, `limit ${limit}`, (from) => history.user_replies(c, task_id, limit, from));
  // Telegram's: each turn's reply (the latest 50 turns), and how the latest turn ended.
  const ends = db.all<{ id: number }>(
    c,
    "SELECT id FROM messages WHERE task_id=?1 AND kind='claude' AND json_extract(data,'$.type')='result' ORDER BY id DESC LIMIT 50",
    task_id,
  );
  for (const { id } of ends) {
    cmp.check("said_in_turn", task_id, id, (from) => history.said_in_turn(c, task_id, id, from, max));
    if (history.said_in_turn(c, task_id, id, "messages") !== history.said_in_turn(c, task_id, id, "messages", max)) cmp.windowed++;
  }
  cmp.check("last_turn_end", task_id, "", (from) => history.last_turn_end(c, task_id, from));

  const times = db.all<{ created_at: string }>(c, "SELECT created_at FROM messages WHERE task_id=?1 AND kind='user' ORDER BY id", task_id).map((r) => r.created_at);
  const all = db.all<{ created_at: string }>(c, "SELECT created_at FROM messages WHERE task_id=?1 ORDER BY id", task_id);
  const middle = all[Math.floor(all.length / 2)]?.created_at ?? "";
  for (const since of [null, middle]) {
    cmp.check("tool_calls_since", task_id, `since ${since}`, (from) => history.tool_calls_since(c, task_id, since, from).map(call_summary));
  }
  // Each user message's time, a moment before it, and the start.
  const at = ["", ...times.slice(-20).flatMap((t) => [t, new Date(Date.parse(t) - 1).toISOString()])];
  for (const t of at) {
    cmp.check("user_wrote_since", task_id, t, (from) => history.user_wrote_since(c, task_id, t, from));
    cmp.check("user_messaged_since", task_id, t, (from) => history.user_messaged_since(c, task_id, t, from));
  }
  const asked = db.all<{ id: number }>(c, "SELECT id FROM messages WHERE task_id=?1 AND kind IN ('question', 'permission') ORDER BY id", task_id).map((r) => r.id);
  for (const id of asked) cmp.check("moved_on", task_id, id, (from) => history.moved_on(c, task_id, id, from));
  cmp.check("open_questions", task_id, "", (from) => history.open_questions(c, task_id, from).map((q) => q.id));
  cmp.check("first_user_message", task_id, "", (from) => history.first_user_message(c, task_id, from));
  const turns = db.all<{ id: number }>(
    c,
    `SELECT message_id AS id FROM checkpoints WHERE task_id=?1 AND message_id IS NOT NULL
     UNION SELECT turn_message_id FROM runs WHERE task_id=?1 AND turn_message_id IS NOT NULL ORDER BY 1`,
    task_id,
  );
  for (const { id } of turns) cmp.check("user_message", task_id, id, (from) => turn_summary(history.user_message(c, task_id, id, from)));

  // The subagents' lifecycle messages, as the wait tool gets them.
  const jobs = db.all<{ data: string }>(
    c,
    "SELECT data FROM messages WHERE task_id=?1 AND +kind='claude' AND data LIKE '%\"subtype\":\"task\\_%' ESCAPE '\\' ORDER BY id",
    task_id,
  );
  const seen = new Set<string>();
  for (const { data } of jobs) {
    let d: any;
    try {
      d = JSON.parse(data);
    } catch {
      continue;
    }
    if (d?.type !== "system" || typeof d.subtype !== "string" || !d.subtype.startsWith("task_")) continue;
    const events = [{ tool_use_id: d.tool_use_id, task_id: d.task_id }, { task_id: d.task_id }];
    for (const e of events) {
      const key = json(e);
      if (seen.has(key)) continue;
      seen.add(key);
      cmp.check("subagent_call", task_id, e, (from) => history.subagent_call(c, task_id, e, from));
    }
  }
  // The latest tool calls, and the subagents' calls.
  const calls = db.all<{ id: string; name: string }>(
    c,
    `SELECT COALESCE(json_extract(meta, '$.call_id'), id) AS id, json_extract(data, '$.name') AS name FROM thread_items
     WHERE task_id=?1 AND type='tool_call' ORDER BY pos DESC LIMIT 50`,
    task_id,
  );
  for (const { id } of calls) {
    cmp.check("tool_use", task_id, id, (from) => history.tool_use(c, task_id, id, from, max));
    if (json(history.tool_use(c, task_id, id, "messages")) !== json(history.tool_use(c, task_id, id, "messages", max))) cmp.windowed++;
  }
  const agents = db.all<{ id: string }>(
    c,
    `SELECT COALESCE(json_extract(meta, '$.call_id'), id) AS id FROM thread_items WHERE task_id=?1 AND type='tool_call' AND json_extract(data, '$.kind')='subagent'`,
    task_id,
  );
  for (const id of [...agents.map((a) => a.id), "no-such-call"]) cmp.check("has_call", task_id, id, (from) => history.has_call(c, task_id, id, from));
}

/** Compares the readers of every task (or of `only`'s), and the board's, translating the tasks that need it first. */
export function compare(c: Conn, only: string[] = []): Report {
  const start = Date.now();
  const cmp = new Comparer();
  const out: Report = { tasks: 0, translated: 0, failed: [], readers: cmp.readers, differences: cmp.differences, windowed: 0, ms: 0 };
  const ROLL_BACK = Symbol("roll back");
  try {
    db.tx(c, () => {
      const ids = only.length ? only : db.all<{ id: string }>(c, "SELECT id FROM tasks ORDER BY created_at, id").map((r) => r.id);
      const ok: string[] = [];
      for (const id of ids) {
        if (history.source(c, id) !== "items") {
          try {
            rebuild(c, id);
            out.translated++;
          } catch (e: any) {
            out.failed.push({ task_id: id, error: e?.stack ?? String(e) });
            continue;
          }
        }
        ok.push(id);
      }
      out.tasks = ok.length;
      for (const id of ok) compare_task(cmp, c, id);
      if (!only.length) compare_board(cmp, c);
      throw ROLL_BACK;
    });
  } catch (e) {
    if (e !== ROLL_BACK) throw e;
  }
  out.windowed = cmp.windowed;
  out.ms = Date.now() - start;
  return out;
}

/** Compares the readers of every task's thread at once (every task has items now). */
function compare_board(cmp: Comparer, c: Conn): void {
  const s = { db: () => c } as unknown as Shared;
  cmp.check("pending_approvals", null, "", (from) => permissions.pending_approvals(s, true, true, true, from));
  const by_time = (a: any, b: any) => json(a) < json(b) ? -1 : json(a) > json(b) ? 1 : 0;
  for (const { id } of db.all<{ id: string }>(c, "SELECT id FROM profiles ORDER BY id")) {
    cmp.check("analytics", null, `profile ${id}`, (from) => analytics.report(c, id, "", "9999", from).events.sort(by_time));
  }
  cmp.check("submissions", null, "", (from) => history.submissions(c, from).sort(by_time));
  cmp.check("attachments.referenced", null, "", (from) => [...attachments.referenced(c, from)].sort());
}

function print(r: Report, examples: number, write: (s: string) => void): void {
  for (const f of r.failed) write(`${f.task_id}: translating failed: ${f.error}\n`);
  for (const [name, { checked, differ }] of Object.entries(r.readers).sort()) {
    write(`${name}: ${checked} checked, ${differ ? `${differ} differ` : "all the same"}\n`);
    for (const d of r.differences.filter((d) => d.reader === name).slice(0, examples)) {
      write(`  ${d.task_id ?? "board"} (${d.input}):\n    messages ${json(d.messages).slice(0, 400)}\n    items    ${json(d.items).slice(0, 400)}\n`);
    }
  }
  const differ = r.differences.length;
  write(
    `${r.tasks} tasks (${r.translated} translated for it${r.failed.length ? `, ${r.failed.length} failed` : ""}), ` +
      `${differ ? `${differ} differences` : "no differences"}; the messages readers' windows changed ${r.windowed} answers; ${(r.ms / 1000).toFixed(1)} s\n`,
  );
}

/** The command line's entry: exits 1 if a reader differs or a task couldn't be translated. */
export async function main(args: string[]): Promise<void> {
  const o = parse_args(args);
  const c = open(o.db);
  try {
    const ids = o.tasks.map((name) => {
      const r = db.one<{ id: string }>(
        c,
        "SELECT t.id FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id=?1 OR lower(p.key || '-' || t.number)=lower(?1)",
        name,
      );
      if (!r) throw new Error(`no task ${name}`);
      return r.id;
    });
    const r = compare(c, ids);
    if (o.json) process.stdout.write(JSON.stringify({ at: now(), ...r }, null, 2) + "\n");
    else print(r, o.examples, (s) => process.stdout.write(s));
    if (r.differences.length || r.failed.length) process.exitCode = 1;
  } finally {
    c.close();
  }
}

