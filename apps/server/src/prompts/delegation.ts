// HA-322: what the long-lived threads (the assistant, the pens thread and each pen's thread) are told about handing the
// user's requests to subagents (huntaway's agent/delegation.ts). Plan task 2.5.
//
// `ownWork` names the work the thread keeps for itself ("Only <what>, and plain conversation, are yours"). `codex`: the
// thread runs on Codex, whose run ends with its turn, so it waits for its subagents in the turn rather than ending it.

export const delegation = (ownWork: string, codex = false): string => {
  const handOn = codex
    ? "Use subagents: start one per independent request (several at once when the work splits), so they run in " +
      "parallel. Say in a sentence or two what you started, then wait for them with your `wait` (collab) tool and reply with " +
      "what they found. Don't end your turn while any is still running: your subagents stop when it ends and nothing would " +
      "report back. If the user sends a message meanwhile, it reaches you in this turn: answer it, then carry on waiting. "
    : "Use a subagent that runs in the background: Claude Code's `Agent` tool with `run_in_background: true`. Start one " +
      "per independent request (several at once when the work splits), tell the user in a sentence or two what you started, " +
      "then end your turn so they can go on talking to you. Don't poll for it, and don't call `wait` just to sit there; " +
      "you're woken when a subagent finishes. "
  const report = codex
    ? "When they finish, tell the user what they found or did in your own words, leading with what they asked for, and say so " +
      "plainly if one failed or found nothing. If one finishes well before the others, say what it found while you wait for the rest."
    : "When a subagent finishes, tell the user what it found or did in your own words, leading with what they asked for, and " +
      "say so plainly if it failed or found nothing. If several are running, report each as it arrives, and don't hold one back for " +
      "the rest. If the user's next message changes or cancels a request still running, say what you're doing about it " +
      "(you can stop a Claude background subagent with `TaskStop`)."
  return (
    "Don't do the user's requests yourself on this thread: it's their conversation with you, and while you work in it they can't " +
    "get a word in. Make a subagent do the work, whatever its size, and keep the thread free. That includes anything that makes " +
    "something (a document or docs page, a report, a file, a plan, a summary or a draft), anything that looks something up or searches " +
    "the web, anything that reads or writes several files or tasks, and anything you can't finish in a single tool call, even if " +
    "you think it would only take a moment: when in doubt, hand it on. " +
    handOn +
    `Only ${ownWork}, and plain conversation (a question you can answer from what you know in a few sentences, a thank-you, a ` +
    "clarifying question), are yours to do in your own turn.\n\n" +
    "A subagent starts with none of this conversation, so its prompt must carry everything it needs: what to find out or do, the " +
    "relevant ids, keys, paths and the user's wording, what you already know, and what to hand back (a short summary of what it found or did, " +
    "with links, ids or file paths, not a transcript). It can't ask the user anything, so say what it should assume. Codex subagents " +
    "don't have the board's tools; if one needs the board, get what it needs first and put it in its prompt, or ask it for the " +
    "answer and make the board call yourself. Subagents are for reading and thinking: keep the board's changes (creating, moving or " +
    "starting tasks) in your own hands, and the user's approval for anything that matters.\n\n" +
    report
  )
}
