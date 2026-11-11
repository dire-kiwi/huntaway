import type { Agent, AgentConfig, DocumentLabel, HostEffort, Project, Task } from "@huntaway/contracts"

// The old packages/client's smaller pure helpers and constants (attachments.ts, labels.ts, claudeConfigs.ts,
// projects.ts, thread.ts, push.ts), kept by name.

// ---- attachments ------------------------------------------------------------------------------------------------

/**
 * Files attached to a prompt are saved on the host and listed at the end of the message, so the agent reads them from
 * there (`Attached files:` then `- <path>` per file). The board splits that block back off to show the files instead.
 */
const HEADER = "Attached files:"

/** Largest file a host takes. */
export const MAX_ATTACHMENT_BYTES = 10 << 20

/** A file listed in a message: enough to fetch it again. */
export interface AttachmentRef {
  readonly id: string
  readonly name: string
  readonly path: string
}

/** `text` with the attachments listed after it. */
export function withAttachments(text: string, files: ReadonlyArray<{ readonly path: string }>): string {
  if (!files.length) return text
  const list = `${HEADER}\n${files.map((f) => `- ${f.path}`).join("\n")}`
  return text.trim() ? `${text.trimEnd()}\n\n${list}` : list
}

const LINE = /^- (.*\/attachments\/([0-9a-f]+)\/([A-Za-z0-9._-]+))$/

/** The attachment lines that follow line `start` (the header). */
function attachmentBlock(lines: ReadonlyArray<string>, start: number): Array<AttachmentRef> {
  const block: Array<AttachmentRef> = []
  for (let i = start + 1; i < lines.length; i++) {
    const m = LINE.exec(lines[i] ?? "")
    if (!m) break
    block.push({ path: m[1] ?? "", id: m[2] ?? "", name: m[3] ?? "" })
  }
  return block
}

/** Splits the attachment lists off a message. Queued messages are joined, so there may be one per message that went into it. */
export function splitAttachments(text: string): { readonly text: string; readonly files: ReadonlyArray<AttachmentRef> } {
  const lines = text.trimEnd().split("\n")
  const files: Array<AttachmentRef> = []
  const rest: Array<string> = []
  for (let i = 0; i < lines.length; i++) {
    const block = lines[i] === HEADER ? attachmentBlock(lines, i) : []
    if (!block.length) {
      rest.push(lines[i] ?? "")
      continue
    }
    files.push(...block)
    i += block.length
    // The blank line between it and the next message.
    if (lines[i + 1] === "") i++
  }
  return files.length ? { text: rest.join("\n").trimEnd(), files } : { text, files }
}

/**
 * A composer's text once `sent` (what it held when Send was pressed) has gone: what was typed after it while it was
 * sending, or all of it if what was sent was changed.
 */
export function afterSend(typed: string, sent: string): string {
  return sent && typed.startsWith(sent) ? typed.slice(sent.length).replace(/^\s+/, "") : typed
}

// ---- labels (the old `@huntaway/client/labels`, now on the package's root) -------------------------------------

/** A document label, by the old name. */
export type DocumentType = DocumentLabel

/** The labels, in the order a task shows them. */
export const LABELS: ReadonlyArray<DocumentLabel> = ["plan", "artifact", "diagram"]

/** A task's labels, in that order (none for a review thread). */
export const taskLabels = (t: Pick<Task, "kind" | "labels">): ReadonlyArray<DocumentLabel> =>
  t.kind !== "task" ? [] : LABELS.filter((l) => t.labels.includes(l))

/**
 * A task that makes only its documents, in its own folder, rather than changing code. Not a scratch task or a profile's
 * assistant, which work in a folder of their own too.
 */
export const documentsOnly = (t: Pick<Task, "kind" | "task_type" | "work_dir">): boolean =>
  t.kind === "task" && t.task_type !== "scratch" && t.task_type !== "assistant" && !!t.work_dir

// ---- agent configs ----------------------------------------------------------------------------------------------

export const AGENTS = [
  { id: "claude", label: "Claude Code", dir: "~/.claude", env: "CLAUDE_CONFIG_DIR" },
  { id: "codex", label: "Codex", dir: "~/.codex", env: "CODEX_HOME" },
] as const satisfies ReadonlyArray<{ readonly id: Agent; readonly label: string; readonly dir: string; readonly env: string }>

export const agentOf = (c: Pick<AgentConfig, "agent"> | undefined): Agent => c?.agent ?? "claude"

export const agentInfo = (a: Agent): (typeof AGENTS)[number] => (a === "codex" ? AGENTS[1] : AGENTS[0])

/** The efforts a host, profile or reviewer can default to. */
export const EFFORTS: ReadonlyArray<HostEffort> = ["low", "medium", "high", "xhigh", "max"]

export const MODEL_ALIASES: ReadonlyArray<string> = ["fable", "opus", "sonnet", "haiku"]

// ---- projects ---------------------------------------------------------------------------------------------------

/** Whether new tasks in the project get their own worktree: only once its folder is a git repository. */
export const worktreesOn = (p: Pick<Project, "use_worktrees" | "is_git">): boolean => p.use_worktrees && p.is_git

/**
 * Whether the project wants worktrees but its folder cannot have them yet (not a git repository, or one with no commit
 * to branch from), so the board shows its setup thread instead of its tasks.
 */
export const needsWorktreeSetup = (p: Pick<Project, "use_worktrees" | "is_git" | "has_commits">): boolean => p.use_worktrees && !(p.is_git && p.has_commits)

// ---- threads and notifications ----------------------------------------------------------------------------------

/** The tools whose prompts are questions for the user, not requests for permission. */
export const QUESTION_TOOLS: ReadonlyArray<string> = ["AskUserQuestion", "request_user_input"]

/**
 * Whether a question takes an answer the user types: Claude's always do, and Codex's say with `isOther`, but one with no
 * options takes nothing else.
 */
export const takesTypedAnswer = (codex: boolean, q: { readonly isOther?: boolean; readonly options: ReadonlyArray<unknown> }): boolean =>
  !codex || q.isOther !== false || !q.options.length

/** What tasks notify of, in the board's notifications and by push. */
export type NotifyEvent = "attention" | "review" | "merge" | "done"

export const NOTIFY_EVENTS: ReadonlyArray<{ readonly id: NotifyEvent; readonly label: string; readonly hint: string }> = [
  { id: "attention", label: "Needs attention", hint: "Its agent asks a question or for permission, or its run fails" },
  { id: "review", label: "Ready to review", hint: "In review, once its automatic review passes (or with none to wait for)" },
  { id: "merge", label: "Ready for merge", hint: "Moved to Ready for merge" },
  { id: "done", label: "Done", hint: "Merged, or moved to Done" },
]

/** Whose permission prompts a device gets by push: the assistant's by default (6.8). */
export const PUSH_PROMPTS: ReadonlyArray<{ readonly id: "off" | "assistant" | "all"; readonly label: string }> = [
  { id: "off", label: "None" },
  { id: "assistant", label: "The assistant's" },
  { id: "all", label: "Every task's" },
]

/** The assistant's events a device can be pushed, besides the board's (`NOTIFY_EVENTS`). */
export const ASSISTANT_PUSH_EVENTS: ReadonlyArray<{ readonly id: "replies" | "reports"; readonly label: string; readonly hint: string }> = [
  { id: "replies", label: "Assistant's replies", hint: "It finished a reply" },
  { id: "reports", label: "Routine reports", hint: "What its routines post: its first line" },
]
