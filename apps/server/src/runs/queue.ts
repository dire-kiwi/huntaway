import type { Task } from "@huntaway/contracts"
import type { MessageSource, QueuedRow } from "../tasks/TaskRepo.ts"
import { fromAgent } from "../tasks/TaskRepo.ts"
import type { RunKind, RunPhase } from "./Run.ts"

// What happens to a message for a thread (huntaway's runner/send.ts and runner/queue.ts; inventory 01, sections 2 and
// 9): plain functions over what `Runs.send` gathers under the task's lock.

/** A message for a thread (docs/plan/07-agents.md, The run). */
export interface Outgoing {
  readonly text: string
  /** Who sent it: the user, another agent (`send_to_task`), a routine, a project automation, or the board at the user's asking. */
  readonly source: MessageSource
  /** The board sent it itself (`send_as(auto)`): never steered or queued, and it starts no run while one is going. */
  readonly auto?: boolean | undefined
  /** It sends round `n` of a review's issues back to fix (`send_fixes`). */
  readonly review_round?: number | undefined
  /** The automation run whose message it is, charged with the run that takes it in. */
  readonly automation_run_id?: string | undefined
  /** A review thread's round (`send_review`): the run is a `review` run. */
  readonly review?: boolean | undefined
}

/** `/compact [instructions]`: Claude Code summarises the conversation so far. */
export const isCompact = (text: string): boolean => {
  const t = text.trim()
  if (!t.startsWith("/compact")) return false
  const rest = t.slice("/compact".length)
  return rest === "" || /^\s/u.test(rest)
}

/** `/new [message]`: what follows it (perhaps ""), or null for any other message. */
export const newCommand = (text: string): string | null => {
  const t = text.trim()
  if (!t.startsWith("/new")) return null
  const rest = t.slice("/new".length)
  return rest === "" || /^\s/u.test(rest) ? rest.trim() : null
}

/** What a run starts with: the messages it takes from the queue and its own, as one (the old `Queued`). */
export interface Combined {
  readonly text: string
  /** Every part came from other agents (`from_agent` on its user message). */
  readonly fromAgent: boolean
  /** The user's own parts, when other agents' are with them. */
  readonly userText: string | null
  /** A routine's message: nobody is there to answer its prompts. */
  readonly routine: boolean
  /** The automation runs whose messages it carries. */
  readonly automationRuns: ReadonlyArray<string>
}

const join = (a: string, b: string) => (a.trim() === "" ? b : b.trim() === "" ? a : `${a}\n\n${b}`)

/** A message as a queue row. */
export const rowOf = (message: Outgoing): QueuedRow => ({
  text: message.text.trim(),
  source: message.source,
  automation_run_id: message.automation_run_id ?? null,
})

/** `parts` in order as one message (the old `Queued::then`): an empty part says nothing about who is there. */
export const combine = (parts: ReadonlyArray<QueuedRow>): Combined => {
  let text = ""
  let userText: string | null = null
  let all = true
  let routine: boolean | null = null
  for (const part of parts) {
    const byAgent = fromAgent(part.source, part.text)
    all = all && byAgent
    if (!byAgent) userText = userText === null ? part.text : join(userText, part.text)
    if (part.text.trim() !== "") routine = (routine ?? true) && part.source === "routine"
    text = join(text, part.text)
  }
  return {
    text,
    fromAgent: parts.length > 0 && all,
    userText,
    routine: routine ?? false,
    automationRuns: parts.flatMap((p) => (p.automation_run_id === null ? [] : [p.automation_run_id])),
  }
}

/** What a run's start does with the thread's queue: `Ahead` takes it ahead of the message; `Only` is for what is queued. */
export type Take = "No" | "Ahead" | "Only"

/** Why a message is refused. */
export type Refusal =
  /** Its project is archived: its agents would work out of sight. */
  | { readonly _tag: "Archived"; readonly project: string }
  /** It is queued to merge after another task (`activeMerge`): it can't run alongside the merge going on. */
  | { readonly _tag: "MergeQueued"; readonly after: string }
  /** This server runs no agents (`--no-agents`). */
  | { readonly _tag: "NoAgents" }
  /** A run is going and this message can't join it (the board's own). */
  | { readonly _tag: "AlreadyRunning" }
  /** `/compact` with no conversation. */
  | { readonly _tag: "NoConversation" }

/** What `Runs.send` does with a message. */
export type SendDecision =
  | { readonly _tag: "Refuse"; readonly refusal: Refusal }
  /** Nothing to send to the run going (an empty message). */
  | { readonly _tag: "Nothing" }
  /** Written to the live run's input now (or once it starts). */
  | { readonly _tag: "Steer" }
  /** Queued for when the live run ends. */
  | { readonly _tag: "Queue" }
  /** Queued, the task waiting in In progress for its dependencies to be merged. */
  | { readonly _tag: "WaitForDependencies"; readonly unmet: ReadonlyArray<string> }
  | { readonly _tag: "Start"; readonly kind: RunKind; readonly take: Take }

/** The run going on the thread, as a message for it needs to know it. */
export interface LiveRun {
  readonly kind: RunKind
  readonly phase: RunPhase
  /** Its agent still reads input (`RunDir.acceptsInput`). */
  readonly acceptsInput: boolean
  /** It may write the task's documents folder, so a `/plan` can be steered into it. */
  readonly writesDocuments: boolean
}

export interface SendFacts {
  readonly task: Pick<Task, "kind" | "merging" | "merge_approval" | "session_id" | "queued_message">
  /** The message; null to send what is queued (the old `send_queued`). */
  readonly message: Outgoing | null
  /** It is `/plan …` for a task. */
  readonly plan: boolean
  readonly project: { readonly name: string; readonly archived: boolean } | null
  /** The task its merge lane is merging now, if another (`tasks/lanes.ts` `activeMerge`, 4.7). */
  readonly activeMerge: { readonly title: string } | null
  readonly live: LiveRun | null
  /** This server runs agents. */
  readonly agents: boolean
  /** The keys of what it depends on that isn't merged. */
  readonly unmet: ReadonlyArray<string>
}

/** The old `send_message`'s cases, in its order. */
export const decideSend = (f: SendFacts): SendDecision => {
  const auto = f.message?.auto === true
  const text = f.message?.text.trim() ?? ""
  const kind: RunKind = f.message?.review === true ? "review" : "prompt"
  // Sending what's queued: it may be a `/compact`, which is queued for after the run it came in.
  const queued = !auto && text === "" ? f.task.queued_message : null
  const compact = isCompact(text) || (queued !== null && isCompact(queued))
  // Before the message is queued for later (behind dependencies, say), where nothing would send it.
  if (f.project?.archived === true) return { _tag: "Refuse", refusal: { _tag: "Archived", project: f.project.name } }
  // One waiting for the user's approval isn't in the queue yet, so it can be talked to.
  if (f.task.merging && !auto && f.task.merge_approval !== "pending" && f.activeMerge !== null) {
    return { _tag: "Refuse", refusal: { _tag: "MergeQueued", after: f.activeMerge.title } }
  }
  if (!auto && f.live !== null) {
    if (text === "") return { _tag: "Nothing" }
    const run = f.live
    // A run being prepared takes input once it starts; a `/plan` only goes to one that can write the plan.
    const steer = !isCompact(text) && !(f.plan && !run.writesDocuments) && run.kind !== "compact" && (run.phase === "preparing" || run.acceptsInput)
    return { _tag: steer ? "Steer" : "Queue" }
  }
  if (!auto && !compact && kind === "prompt" && f.task.kind === "task" && !f.task.merging && f.agents && f.unmet.length > 0) {
    return { _tag: "WaitForDependencies", unmet: f.unmet }
  }
  // A config out of usage would refuse the run: `Usage.beforeRun` holds it (plan task 2.x usage limits).
  if (!f.agents) return { _tag: "Refuse", refusal: { _tag: "NoAgents" } }
  if (compact && f.task.session_id === null) return { _tag: "Refuse", refusal: { _tag: "NoConversation" } }
  if (f.live !== null) return { _tag: "Refuse", refusal: { _tag: "AlreadyRunning" } }
  // A message left queued on a thread that isn't running goes with this one, unless this one compacts first.
  const take: Take = f.message === null ? "Only" : !auto && (!isCompact(text) || queued !== null) ? "Ahead" : "No"
  return { _tag: "Start", kind: compact ? "compact" : kind, take }
}
