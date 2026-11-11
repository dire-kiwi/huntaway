// What a session's next prompt is told of the background work the end of its last run stopped, which it never heard
// about (huntaway's agent/runner/background.ts note). Plan task 2.5; the background work is plan task 2.8.

/** One stopped piece of work: `shell`, `subagent` or `other`, and its command or description. */
export interface LostWork {
  readonly kind: string
  readonly label: string
}

/** Ends with a blank line, as it goes before the prompt. */
export const lostBackground = (lost: ReadonlyArray<LostWork>): string =>
  "Note: this background work of yours was stopped (by the user, or as your last run ended), so it isn't running and " +
  "won't report back. Start again what you still need, and don't tell the user it's running:\n" +
  `${lost.map((l) => `- ${l.kind}: ${l.label}`).join("\n")}\n\n`
