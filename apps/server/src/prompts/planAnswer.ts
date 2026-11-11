// What the user's answer to a plan or a question tells the agent (huntaway's mcp/permissions.ts answer and
// late_answers): the note a denied plan's answer carries back to the agent, and the message that carries an answer
// given after the run ended. Plan task 3.3 (`Permissions`).

/** The note on a denied plan: keep planning, with the user's feedback if they gave some. */
export const keepPlanningNote = (feedback: string | null): string =>
  feedback !== null
    ? `The user wants you to keep planning rather than start on this plan. Their feedback:\n\n${feedback}`
    : "The user wants you to keep planning rather than start on this plan."

/** A plan approved after its run ended. */
export const planApprovedLate = "Your plan is approved: go ahead and implement it."

/** A plan turned down after its run ended. */
export const keepPlanningLate = (feedback: string | null): string =>
  feedback !== null ? `Keep planning: don't start on the plan yet.\n\n${feedback}` : "Keep planning: don't start on the plan yet."

/** Answers to questions given after the run ended: each question with its answers (none: `(no answer)`). */
export const lateAnswers = (answered: ReadonlyArray<{ readonly question: string; readonly answers: ReadonlyArray<string> }>): string => {
  const lines = answered.map(({ question, answers }) => (answers.length > 0 ? `- ${question}\n  ${answers.join(", ")}` : `- ${question}\n  (no answer)`))
  const what = lines.length === 1 ? "answer to the question" : "answers to the questions"
  return `My ${what} you asked:\n\n${lines.join("\n")}`
}
