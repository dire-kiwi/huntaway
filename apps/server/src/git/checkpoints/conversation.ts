import type { Rewind, Task } from "@huntaway/contracts"
import type { Checkpoint } from "./model.ts"

// What a rewind does to the agent's conversation (huntaway's git/checkpoints/handlers.ts `conversation`, and
// checkpoints.ts `pending_rewind`). Pure.

/**
 * `Nothing` (there's no conversation yet), `Fresh` (the message started it: the next one starts a new one), or `Back`
 * (the next run takes it back).
 */
export type Convo = { readonly _tag: "Nothing" } | { readonly _tag: "Fresh" } | { readonly _tag: "Back"; readonly rewind: Rewind }

export type ConvoResult = { readonly ok: Convo } | { readonly err: string }

/**
 * How the agent's conversation goes back to before turn `turn` of `rows` (the task's checkpoints), or why it can't.
 * `session` is the task's session now; `firstUser` the thread's first user message (its write number).
 */
export const conversation = (
  session: string | null,
  rows: ReadonlyArray<Checkpoint>,
  turn: Checkpoint,
  codex: boolean,
  firstUser: number | null,
): ConvoResult => {
  if (session === null) return { ok: { _tag: "Nothing" } }
  if (turn.turn === null || turn.write_no === null) return { err: "the message this turn started with isn't known" }
  const [n, message] = [turn.turn, turn.write_no]
  const back = (resumeAt: string | null, beforeTurn: string | null): ConvoResult => ({
    ok: {
      _tag: "Back",
      rewind: {
        turn: n,
        message_id: message,
        session,
        ...(resumeAt === null ? {} : { resume_at: resumeAt }),
        ...(beforeTurn === null ? {} : { before_turn: beforeTurn }),
      },
    },
  })
  const changed = "the agent's conversation has changed since this message (a new session)"
  // The message started it: the next one starts a new one (with the task's description, as the first does).
  if (firstUser === message) return { ok: { _tag: "Fresh" } }
  if (codex) {
    // Codex reverts the thread to before the turn itself.
    if (turn.session !== null && turn.session === session && turn.agent_at !== null) return back(null, turn.agent_at)
    if (turn.session !== null && turn.session !== session) return { err: changed }
    return { err: "Codex didn't say which of its turns this was" }
  }
  // Claude resumes its session at the last message of the turn before, skipping turns already taken out of it.
  for (const r of rows.toReversed()) {
    if (r.kind !== "turn" || r.n >= turn.n || r.stale >= 2) continue
    if (r.session !== session) return { err: changed }
    if (r.agent_at !== null) return back(r.agent_at, null)
  }
  return { err: "the conversation from before this message wasn't recorded (it's from before checkpoints were taken)" }
}

/** The conversation rollback a run of `task` on its session makes, if there's one for it. */
export const pendingRewind = (task: Pick<Task, "rewind" | "session_id">): Rewind | null =>
  task.rewind !== null && task.session_id !== null && task.session_id === task.rewind.session ? task.rewind : null
