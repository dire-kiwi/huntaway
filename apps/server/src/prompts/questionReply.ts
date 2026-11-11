// The user's answer to a `request_user_input` question, as their message to the agent: the question quoted, then the
// choices they picked and what they wrote (huntaway's mcp/questions.ts reply_text). Plan task 3.2 (`Questions`).

/** Rust's `str::lines`: split on \n (dropping a \r before it), with no last empty line. */
const lines = (s: string): ReadonlyArray<string> => {
  if (s === "") return []
  const out = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
  if (s.endsWith("\n")) out.pop()
  return out
}

export const questionReply = (question: string, choices: ReadonlyArray<string>, text: string | null): string => {
  const quoted = lines(question).map((l) => `> ${l}`.trimEnd())
  const answers = text !== null ? [...choices, text] : choices
  const reply = answers.length === 1 ? (answers[0] ?? "") : answers.map((a) => `- ${a.replaceAll("\n", "\n  ")}`).join("\n")
  return `${quoted.join("\n")}\n\n${reply}`
}
