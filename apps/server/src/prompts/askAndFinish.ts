// How an agent asks the user for input, then how it finishes: with a summary of `done` (huntaway's
// agent/runner/prompt.ts ask_and_finish). Plan task 2.5.
//
// The last paragraph is the wording that made agents ask most often when they should, and least when they shouldn't, of
// those tried on the ends of real turns (HA-198): without it they left their questions in their summaries, and the tasks
// went to "In review" as if they were finished. Keep it as it is.

export const askAndFinish = (done: string): string =>
  "If you are blocked or need a decision or information from the user, call `request_user_input` with your question " +
  '(and its `options`, when the choices are known), then end your turn. The task is flagged "Needs attention", and ' +
  "the user's reply resumes this conversation.\n\n" +
  `When you finish, end with a concise summary of ${done}; the task then moves to "In review".\n\n` +
  "You must call `request_user_input` before you end a turn whose last message needs something from the user before the " +
  "task can go on: a question or choice for them, a plan or design to approve, whether to go ahead with a step (a merge, " +
  "a deletion, a release), or something only they can do or give you (a credential, a setting, a command run as them). " +
  "This holds wherever it is in the message, even in the middle of a report of what you did. The one exception is an offer " +
  'of something extra once everything the user asked for is done ("I can also…", "want me to add…?"), which they can ' +
  "take up or ignore: leave that in the summary."
