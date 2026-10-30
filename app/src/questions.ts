// What the question and plan cards (components/Questions.tsx) read from a permission prompt's data:
// AskUserQuestion's (or Codex's) questions and the answers given, and a plan's title.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export type AskedOption = { label: string; description?: string; preview?: string };

/** A question as AskUserQuestion asks it, with Codex's `isOther` (whether it takes an answer of the user's own) and `isSecret`. */
export type AskedQuestion = { question: string; header?: string; options: AskedOption[]; multiSelect?: boolean; isOther?: boolean; isSecret?: boolean };

const str = (x: unknown) => (typeof x === "string" ? x : "");

/** The tools whose prompts are questions for the user, not requests for permission (server: permissions::is_question). */
export const QUESTION_TOOLS = ["AskUserQuestion", "request_user_input"];

/** The questions of a question prompt's data, in a shape the cards can trust whatever the agent sent. */
export function questionsOf(data: Any): AskedQuestion[] {
  const list = data?.input?.questions;
  if (!Array.isArray(list)) return [];
  return list
    .filter((q) => q && typeof q === "object")
    .map((q) => ({
      question: str(q.question) || "(no question)",
      header: str(q.header) || undefined,
      options: (Array.isArray(q.options) ? q.options : [])
        .map((o: Any) =>
          typeof o === "string" ? { label: o } : { label: str(o?.label), description: str(o?.description) || undefined, preview: str(o?.preview) || undefined },
        )
        .filter((o: AskedOption) => o.label),
      multiSelect: q.multiSelect === true,
      isOther: typeof q.isOther === "boolean" ? q.isOther : undefined,
      isSecret: q.isSecret === true,
    }));
}

/** The answers the user gave, question by question, once they have (API 64); undefined before, or from older hosts. */
export function askedAnswers(data: Any): string[][] | undefined {
  const a = data?.answers;
  return Array.isArray(a) ? a.map((x: unknown) => (Array.isArray(x) ? x.map(str).filter(Boolean) : [])) : undefined;
}

/** Each question with its answer, for a message. */
export function answersList(questions: AskedQuestion[], answers: string[][]): string {
  return questions.map((q, i) => `- ${q.question}\n  ${answers[i]?.length ? answers[i].join(", ") : "(no answer)"}`).join("\n");
}

/**
 * How a host that can't give AskUserQuestion the user's answers (before API 64) still gets them to the agent: the
 * question is declined with them as its message.
 */
export function declinedWithAnswers(questions: AskedQuestion[], answers: string[][]): string {
  const why = "The user answered your questions in the board, which couldn't pass the answers to this tool (so it shows as declined).";
  return `${why} Carry on with these answers:\n\n${answersList(questions, answers)}`;
}

/** A plan's title: its first line if that's a heading, without a leading "Plan:". */
export function planTitle(plan: string): string {
  const first = plan.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (!first.startsWith("#")) return "";
  return first.replace(/^#+\s*/, "").replace(/^Plan:\s*/i, "").trim();
}

/** A plan without its title (shown above it, see planTitle). */
export function withoutTitle(plan: string): string {
  const lines = plan.split("\n");
  const i = lines.findIndex((l) => l.trim());
  return i >= 0 && planTitle(plan) ? lines.slice(i + 1).join("\n").replace(/^\s*\n/, "") : plan;
}
