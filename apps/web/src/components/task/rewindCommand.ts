// The composer's `/rewind` (HE-101), as Claude Code has it: rather than going to the agent, it lists the user's earlier
// messages to go back to before one, and the message comes back to the composer to reword and send again.
import type { Turn } from "@huntaway/contracts"

/** Whether a message is `/rewind`, which the composer runs itself. */
export const isRewindCommand = (text: string): boolean => /^\s*\/rewind\s*$/.test(text)

/**
 * The messages `/rewind` offers, newest first: each message's first turn (the agent can go on by itself after it),
 * leaving out the turns a rewind has already gone back past and those the agent started by itself.
 */
export function rewindChoices(turns: ReadonlyArray<Turn>): Turn[] {
  const seen = new Set<number>()
  const out: Turn[] = []
  for (const t of turns) {
    if (t.message_id === null || seen.has(t.message_id)) continue
    seen.add(t.message_id)
    if (!t.stale) out.push(t)
  }
  return out.toReversed()
}
