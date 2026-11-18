// What a session's next prompt is told of the background work the end of its last run stopped, or left running (HA-409),
// which it never heard about (huntaway's agent/runner/background.ts note). Plan task 2.5; the background work is plan task 2.8.

/** One piece of work: `shell`, `subagent` or `other`, and its command or description; `running` if it was left running (HA-409). */
export interface LostWork {
  readonly kind: string
  readonly label: string
  readonly running?: boolean | undefined
}

const lines = (lost: ReadonlyArray<LostWork>, running: boolean) =>
  lost
    .filter((l) => (l.running ?? false) === running)
    .map((l) => `- ${l.kind}: ${l.label}\n`)
    .join("")

/** Ends with a blank line, as it goes before the prompt. */
export const lostBackground = (lost: ReadonlyArray<LostWork>): string => {
  const stopped = lines(lost, false)
  const left = lines(lost, true)
  let text = ""
  if (stopped !== "") {
    text +=
      "Note: this background work of yours was stopped (by the user, or as your last run ended), so it isn't running and " +
      `won't report back. Start again what you still need, and don't tell the user it's running:\n${stopped}\n`
  }
  if (left !== "") {
    text +=
      "Note: this background work of yours was left running when your last run ended, but it's no longer one of your " +
      "background tasks: it won't report back, and your tools for those can't read or stop it. Check on it by its port, " +
      "log or process (it may have stopped since), and stop it by its process if you need to; the board stops it once " +
      `the task is done:\n${left}\n`
  }
  return text
}
