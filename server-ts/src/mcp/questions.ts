// Port of server/src/mcp/questions.rs.
/**
 * Questions agents ask with the board's `request_user_input` (see mcp/tools.rs): the question, and the options to pick
 * from if the agent gave them, as a card in the thread (a `question` message, API 64). The agent ends its turn after
 * asking, so a question isn't waited on like a permission prompt: it stays answerable after the run ends, and answering
 * it sends the user's message that resumes the agent. A reply typed in the thread instead settles it too.
 */
import * as db from "../db.ts";
import type { Task } from "../db.ts";
import { ApiError } from "../http.ts";
import type { Shared } from "../state.ts";
import * as permissions from "./permissions.ts";
import * as merge_gate from "../review/merge_gate.ts";
import * as runner from "../agent/runner.ts";
import * as focus from "../agent/focus.ts";

/** The most options a question can have: keys 1–9 pick them. */
export const MAX_OPTIONS = 9;

/** An error for the agent (Rust's `Err(String)`). */
const fail = (m: string) => new Error(m);

/**
 * The card for `request_user_input`'s arguments, or why they're wrong (thrown): its question, options (each a label and
 * maybe a description), whether more than one can be picked, and whether a free-text answer is offered besides them (by
 * default it is).
 */
export function card(args: any): any {
  const a = args && typeof args === "object" ? args : {};
  const question = typeof a.question === "string" ? a.question.trim() : "";
  if (!question) throw fail("request_user_input needs a question");
  const options: any[] = [];
  const given = a.options;
  if (given !== undefined && given !== null) {
    if (!Array.isArray(given)) throw fail("request_user_input's options must be a list of {label, description}");
    for (const o of given) {
      // A plain string is taken as a label.
      let label: any, description: any;
      if (typeof o === "string") [label, description] = [o, null];
      else [label, description] = [o?.label, o?.description];
      label = typeof label === "string" ? label.trim() : "";
      if (!label) throw fail("each of request_user_input's options needs a label");
      if (options.some((x) => x.label === label)) throw fail(`request_user_input's options must have different labels ("${label}" is there twice)`);
      const option: any = { label };
      const d = typeof description === "string" ? description.trim() : "";
      if (d) option.description = d;
      options.push(option);
    }
  }
  if (options.length > MAX_OPTIONS) throw fail(`request_user_input takes at most ${MAX_OPTIONS} options`);
  const flag = (name: string, def: boolean): boolean => {
    const v = a[name];
    if (v === undefined || v === null) return def;
    if (typeof v === "boolean") return v;
    throw fail(`request_user_input's ${name} must be true or false`);
  };
  return { question, options, multi_select: flag("multi_select", false), allow_other: flag("allow_other", true) };
}

/**
 * Put `card` (see `card`) in `task`'s thread for MCP call `call_id`, once for the call (it's run again if it's cut short
 * by a restart).
 */
export function ask(s: Shared, task: Task, call_id: string, card: any): void {
  const asked = db.value(s.db(), "SELECT id FROM messages WHERE task_id=?1 AND kind='question' AND json_extract(data, '$.call_id')=?2", task.id, call_id);
  if (asked === undefined) {
    card = { ...card, call_id, status: "pending" };
    s.add_message(task.id, "question", card);
  }
}

/** The user's answer to a question from its card. */
export interface Answer {
  /** The options picked, by label. */
  choices?: string[];
  /** What the user typed, if the question takes a free-text answer. */
  text?: string | null;
}

/**
 * Answer the question in message `message_id` of `task_id`'s thread: the answer is sent to the agent as the user's
 * message, which carries the conversation on. Only the first answer counts: another (from another tab, say) is refused.
 * Returns the task, as sending a message does.
 */
export function answer(s: Shared, task_id: string, message_id: number, answer: Answer): Task {
  const data = db.value<string>(s.db(), "SELECT data FROM messages WHERE id=?1 AND task_id=?2 AND kind='question'", message_id, task_id);
  if (data === undefined) throw ApiError.not_found("question");
  const asked = JSON.parse(data);
  if (asked.status !== "pending") throw ApiError.conflict("this question has been answered already");
  if (permissions.moved_on(s, task_id, message_id)) {
    throw ApiError.conflict("the conversation has moved on since this was asked: reply in the thread instead");
  }
  const options: string[] = (Array.isArray(asked.options) ? asked.options : []).map((o: any) => o?.label).filter((l: any) => typeof l === "string");
  const choices: string[] = [];
  for (const raw of answer.choices ?? []) {
    const c = raw.trim();
    if (!options.includes(c)) throw ApiError.bad(`"${c}" isn't one of the question's options`);
    if (!choices.includes(c)) choices.push(c);
  }
  const typed = typeof answer.text === "string" ? answer.text.trim() : "";
  const text = typed ? typed : null;
  if (text !== null && options.length && asked.allow_other === false) {
    throw ApiError.bad("this question takes one of its options, not an answer of your own");
  }
  const picked = choices.length + (text !== null ? 1 : 0);
  if (picked === 0) throw ApiError.bad("pick an option or write an answer");
  if (picked > 1 && asked.multi_select !== true) throw ApiError.bad("this question takes one answer");
  const answered = { ...asked, status: "answered", answer: { choices, text } };
  // In one statement, so of two answers at once only one is sent.
  const taken = db.update_pending_message(s.db(), message_id, answered);
  if (!taken) throw ApiError.conflict("this question has been answered already");
  // The board's own question, whether to merge (see review/merge_gate.rs): the answer is the board's to act on.
  const merge_approval = asked.merge_approval === true;
  let task: Task;
  try {
    task = merge_approval
      ? merge_gate.decide(s, task_id, choices.includes(merge_gate.APPROVE))
      : runner.send(s, task_id, reply_text(typeof asked.question === "string" ? asked.question : "", choices, text));
  } catch (e) {
    // Answerable again (and its request in the thread kept as items, open again).
    try {
      s.emit_thread_events(taken);
      const back = db.update_message_data(s.db(), message_id, JSON.parse(data));
      if (back) s.emit_message_updated(back);
    } catch {}
    throw e;
  }
  // The user's answer is a prompt to the agent: it puts the task in "now" like a message does (not the board's own
  // merge decision).
  if (!merge_approval) task = focus.put_in_now(s, task_id) ?? task;
  emit(s, message_id, taken);
  // Any other question it was waiting on is settled by this reply.
  replied(s, task_id);
  return task;
}

/** The message that answers a question: the question, quoted, and the answer (a list for several). */
export function reply_text(question: string, choices: string[], text: string | null): string {
  const quoted = lines(question).map((l) => `> ${l}`.trimEnd());
  const answers = text !== null ? [...choices, text] : choices;
  const reply = answers.length === 1 ? answers[0] : answers.map((a) => `- ${a.replaceAll("\n", "\n  ")}`).join("\n");
  return `${quoted.join("\n")}\n\n${reply}`;
}

/** Rust's `str::lines`: split on \n (dropping a \r before it), with no last empty line. */
function lines(s: string): string[] {
  if (!s) return [];
  const out = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (s.endsWith("\n")) out.pop();
  return out;
}

/** The user replied in `task_id`'s thread: the questions it was waiting on are settled. */
export function replied(s: Shared, task_id: string): void {
  let pending: Array<{ id: number; data: string }>;
  try {
    pending = db.all(s.db(), "SELECT id, data FROM messages WHERE task_id=?1 AND kind='question' AND json_extract(data, '$.status')='pending'", task_id);
  } catch {
    return;
  }
  for (const { id, data } of pending) {
    let v: any;
    try {
      v = JSON.parse(data);
    } catch {
      v = {};
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) v = {};
    v.status = "replied";
    // Unless it's been answered since.
    let m: db.Message | null = null;
    try {
      m = db.update_pending_message(s.db(), id, v);
    } catch {}
    if (m) emit(s, id, m);
  }
}

/**
 * Tells clients message `message_id` changed: `message_updated` with it as it is now, and the thread events written
 * when it was changed to `written` (the update's Message, see db.update_message_data).
 */
export function emit(s: Shared, message_id: number, written: db.Message): void {
  s.emit_thread_events(written);
  let m: db.Message | undefined;
  try {
    const row = db.one(s.db(), "SELECT * FROM messages WHERE id=?1", message_id);
    m = row ? db.Message_from_row(row) : undefined;
  } catch {
    return;
  }
  if (m) s.emit({ type: "message_updated", task_id: m.task_id, message: m });
}
