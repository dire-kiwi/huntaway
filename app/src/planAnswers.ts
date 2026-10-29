/**
 * Answers to a plan's questions: the <ia-question>s (and other named form fields) its agent puts in
 * it, which the plan's frame reports (iaForm in planTheme.ts). The user's answers are kept in this
 * browser as a draft until they send them to the agent, so they last across reloads of the plan
 * (each change the agent makes reloads it) and of the board.
 */

/** A field's value, as the frame reads and restores it: what's chosen or typed, and an "Other" choice's text. */
export type PlanValue = { v: string[]; o?: string };

/** A question in the plan, as its frame reports it. */
export type PlanField = {
  name: string;
  /** The question, or "" if the plan doesn't say. */
  label: string;
  type: string;
  value: PlanValue;
  /** The answer in words: the chosen options' labels, or what's typed. Empty when it's unanswered. */
  answer: string[];
  /** Whether the user changed it (or it has a saved answer), rather than it being as the plan has it. */
  touched: boolean;
  /** Its value and answer as the plan has them, which Reset puts back. */
  initial: { value: PlanValue; answer: string[] };
};

export type PlanAnswers = Record<string, PlanValue>;

/** Limits on what a plan's frame (whose scripts the agent writes) can hand the board. */
const MAX_FIELDS = 200;
const MAX_TEXT = 20000;

const str = (x: unknown) => (typeof x === "string" ? x.slice(0, MAX_TEXT) : "");
const strs = (x: unknown) => (Array.isArray(x) ? x.slice(0, MAX_FIELDS).map(str) : []);

const answers = (x: unknown) => strs(x).filter((a) => a.trim());

function readValue(x: unknown): PlanValue {
  const o = x as { v?: unknown; o?: unknown } | null;
  const value: PlanValue = { v: strs(o?.v) };
  if (typeof o?.o === "string" && o.o) value.o = str(o.o);
  return value;
}

/** The fields in an iaForm message from a plan's frame, or null if it isn't one. */
export function readFields(data: unknown): PlanField[] | null {
  const list = (data as { iaForm?: unknown } | null)?.iaForm;
  if (!Array.isArray(list)) return null;
  return list
    .slice(0, MAX_FIELDS)
    .filter((f) => typeof f?.name === "string" && f.name)
    .map((f) => ({
      name: str(f.name),
      label: str(f.label),
      type: str(f.type),
      value: readValue(f.value),
      answer: answers(f.answer),
      touched: !!f.touched,
      initial: { value: readValue(f.initial?.value), answer: answers(f.initial?.answer) },
    }));
}

const key = (hostId: string, taskId: string) => `ia.planAnswers:${hostId}:${taskId}`;

/** The answers the user hasn't sent yet for a task's plan. */
export function loadAnswers(hostId: string, taskId: string): PlanAnswers {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key(hostId, taskId)) ?? "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).map(([name, value]) => [name, readValue(value)]));
  } catch {
    return {};
  }
}

export function saveAnswers(hostId: string, taskId: string, answers: PlanAnswers) {
  try {
    if (Object.keys(answers).length) localStorage.setItem(key(hostId, taskId), JSON.stringify(answers));
    else localStorage.removeItem(key(hostId, taskId));
  } catch {
    // Storage full or unavailable: the answers still last while the task is open.
  }
}

/** The saved answers with those of `fields` the user has touched: questions the plan no longer has keep theirs until they're sent. */
export const withTouched = (answers: PlanAnswers, fields: PlanField[]): PlanAnswers => ({
  ...answers,
  ...Object.fromEntries(fields.filter((f) => f.touched).map((f) => [f.name, f.value])),
});

/** Checkboxes the user left with none ticked: that's an answer too (none of them), unlike other empty fields. */
const noneChosen = (f: PlanField) => !f.answer.length && f.touched && f.type === "checkbox";

export const isAnswered = (f: PlanField) => f.answer.length > 0 || noneChosen(f);

export const answered = (fields: PlanField[]) => fields.filter(isAnswered).length;

/** The fields as the plan has them, as Reset leaves them (also when the plan's frame isn't there to report them). */
export const resetFields = (fields: PlanField[]): PlanField[] => fields.map((f) => ({ ...f, value: f.initial.value, answer: f.initial.answer, touched: false }));

const same = (a: PlanValue | undefined, b: PlanValue | undefined) => JSON.stringify(a) === JSON.stringify(b);

/**
 * After a send, with the saved answers as they were when it started (`before`) and as they are now (the user can go
 * on answering while it's sent, also in a view of the task opened since): the answers left to send, which are those
 * changed since it started, and the names of those it sent as they are, which are no longer the user's own.
 */
export function afterSend(before: PlanAnswers, now: PlanAnswers): { answers: PlanAnswers; sentAsIs: string[] } {
  const sentAsIs = Object.keys(now).filter((name) => name in before && same(before[name], now[name]));
  return { answers: Object.fromEntries(Object.entries(now).filter(([name]) => !sentAsIs.includes(name))), sentAsIs };
}

/** The message that sends the answers to the agent: each question with its answer, by name. */
export function answersMessage(fields: PlanField[], version?: number | null): string {
  const lines = fields.map((f) => {
    const q = f.label && f.label !== f.name ? `${f.label} (\`${f.name}\`)` : `\`${f.name}\``;
    const [first, ...rest] = f.answer;
    if (first === undefined) return `- ${q}: ${noneChosen(f) ? "(none of the choices)" : "(no answer)"}`;
    if (!rest.length && !first.includes("\n")) return `- ${q}: ${first}`;
    // Text over several lines is quoted, as Markdown.
    const item = (a: string) => (a.includes("\n") ? a.split("\n").map((l) => `  > ${l}`.trimEnd()).join("\n") : `  - ${a}`);
    return `- ${q}:\n${f.answer.map(item).join("\n")}`;
  });
  return `My answers to the questions in the plan${version ? ` (v${version})` : ""}:\n\n${lines.join("\n")}\n\nPlease update the plan with them.`;
}
