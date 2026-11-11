import type { ThreadKind } from "@huntaway/contracts"
import { lostBackground } from "../../prompts/lostBackground.ts"
import type { LostWork } from "../../prompts/lostBackground.ts"
import { planCommand } from "../../prompts/planCommand.ts"
import { startPrompt } from "../../prompts/startPrompt.ts"
import { keyPrefix } from "./context.ts"
import type { PromptContext, PromptProject } from "./context.ts"
import { projectStart } from "./project.ts"

// The prompt a run starts with (huntaway's agent/runner/prompt.ts start_prompt, agent/prompts.ts start_task, the `/plan`
// rewrite of agent/documents.ts and agent/runner/launch.ts, and agent/runner/background.ts with_note).

/**
 * What a thread of `kind` is told to do when it starts. A project's own instructions are for its code tasks, so a
 * scratch task, or one that makes only documents, gets the default; a workflow's In progress text (`workflowStart`)
 * comes first.
 */
export const startInstructions = (kind: ThreadKind, project: Pick<PromptProject, "start_prompt"> | null, workflowStart: string | null): string =>
  workflowStart ?? projectStart(kind._tag === "Code" ? project : null)

/** Whether a message starts with a command, such as a skill (`/name`, or `/plugin:name`), rather than, say, a path. */
export const isSlashCommand = (text: string): boolean => {
  if (!text.startsWith("/")) return false
  const name = text.slice(1).split(/\s/)[0] ?? ""
  return name.length > 0 && /^[A-Za-z0-9\-_:.]+$/.test(name)
}

/** `/plan [what to plan]`, a command the board handles itself: the rest of the message, if it is one; else null. */
export const planRest = (text: string): string | null => {
  const t = text.trimStart()
  if (!t.startsWith("/plan")) return null
  const rest = t.slice(5)
  return rest === "" || /^\s/u.test(rest) ? rest.trim() : null
}

/** The lasting threads (the assistant, its routines, the pens threads) are conversations: their first prompt is the message. */
const isConversation = (kind: ThreadKind) => kind._tag === "Assistant" || kind._tag === "Routine" || kind._tag === "PensRoot" || kind._tag === "Pen"

/**
 * A task's first prompt: the task, the instructions for starting (`startInstructions`), then any message it was started
 * with. A message that calls a skill (`/name …`) goes first instead, since Claude Code only expands a command at the
 * start of a prompt, and the task becomes part of its arguments.
 */
export const taskStartPrompt = (kind: ThreadKind, c: Pick<PromptContext, "task" | "project" | "workflowStart">, message: string): string => {
  const text = message.trim()
  if (isConversation(kind)) return text
  return startPrompt({
    key: `${keyPrefix(kind, c.task, c.project)}-${c.task.number}`,
    title: c.task.title,
    description: c.task.description,
    links: c.task.external_links,
    instructions: startInstructions(kind, c.project, c.workflowStart),
    text,
    command: isSlashCommand(text),
  })
}

/**
 * `prompt` with the note of the background work its session's last run stopped in front of it, or after a command
 * (Claude Code only runs a command at the start of a prompt). Only to a session that goes on: one started afresh never
 * had that work.
 */
export const withLostNote = (lost: ReadonlyArray<LostWork>, sessionGoesOn: boolean, prompt: string): string => {
  if (lost.length === 0 || !sessionGoesOn) return prompt
  const said = lostBackground(lost)
  return isSlashCommand(prompt) ? `${prompt.trimEnd()}\n\n${said.trimEnd()}` : `${said}${prompt}`
}

/** How many stopped pieces of background work the note lists, the latest. */
export const LOST_NOTE_ITEMS = 10

export interface FirstPromptFacts {
  /** The message the run is started with. */
  readonly text: string
  /** The background work its last run stopped, which it has not been told of. Empty until plan task 2.8 (`BackgroundWork`). */
  readonly lost: ReadonlyArray<LostWork>
  /** The note on what the message names (`mentionsNote`), worked out on `mentionsScanned`. */
  readonly mentions: (scanned: string) => string
}

/** What `FirstPromptFacts.mentions` reads for keys: the description with a task's first prompt, else the message. */
export const mentionsScanned = (c: Pick<PromptContext, "task">, text: string): string => (c.task.session_id === null ? `${c.task.description}\n${text}` : text)

/**
 * What a prompt run (not a `/compact`) of a thread is sent, as the launch builds it: a `/plan` message rewritten into
 * how to write the plan (when the task has the plan label, which the board gives it first), a task's first prompt
 * around it when its agent has no session yet, the lost background work's note, then the note on what its keys name.
 * The assistant's routine reports go in front (plan task 6.5).
 */
export const runPrompt = (kind: ThreadKind, c: Pick<PromptContext, "task" | "project" | "workflowStart" | "docs">, facts: FirstPromptFacts): string => {
  const isTask = c.task.kind === "task"
  const plan = isTask ? planRest(facts.text) : null
  const planFile = c.docs.find(([label]) => label === "plan")
  const text = plan !== null && planFile !== undefined ? planCommand(planFile[1], plan, true) : facts.text
  let prompt = c.task.session_id === null && isTask ? taskStartPrompt(kind, c, text) : text
  prompt = withLostNote(facts.lost.slice(-LOST_NOTE_ITEMS), c.task.session_id !== null, prompt)
  if (isTask && plan === null) {
    const note = facts.mentions(mentionsScanned(c, text))
    if (note !== "") prompt = prompt.trimEnd() + note
  }
  return prompt
}
