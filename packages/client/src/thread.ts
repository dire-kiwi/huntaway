import { enc, type Http } from "./http";
import type { PermissionMode, Task } from "./tasks";

export interface ContextSummary {
  /** Tokens in the context window as of the agent's latest reply. */
  tokens: number;
  /** The model's context window, once known. */
  max_tokens: number | null;
  /** Where Claude Code compacts the session by itself, if it does. */
  compact_at: number | null;
  model: string | null;
  updated_at: string;
  /** When the breakdown (`api.context`) was taken, if there is one. */
  detail_at: string | null;
}

/** A row of Claude Code's `/context` breakdown. */
export interface ContextCategory {
  id: string;
  name: string;
  tokens: number;
  /** used, deferred (listed, loaded on demand), buffer (kept free for compacting) or free. */
  kind?: "used" | "deferred" | "buffer" | "free";
  isDeferred?: boolean;
}

/** Claude Code's answer to `get_context_usage`: what `/context` shows. */
export interface ContextDetail {
  categories: ContextCategory[];
  totalTokens: number;
  maxTokens: number;
  model?: string;
  autoCompactThreshold?: number;
  isAutoCompactEnabled?: boolean;
  memoryFiles?: { path: string; type: string; tokens: number }[];
  mcpTools?: { name: string; serverName: string; tokens: number; isLoaded?: boolean }[];
  agents?: { agentType: string; source: string; tokens: number }[];
  skills?: { totalSkills: number; includedSkills: number; tokens: number; skillFrontmatter?: { name: string; source: string; tokens: number }[] };
  messageBreakdown?: {
    toolCallTokens: number;
    toolResultTokens: number;
    attachmentTokens: number;
    assistantMessageTokens: number;
    userMessageTokens: number;
    toolCallsByType?: { name: string; callTokens: number; resultTokens: number }[];
    attachmentsByType?: { name: string; tokens: number }[];
  };
}

export interface Message {
  id: number;
  task_id: string;
  /** `question`: one asked with request_user_input (API 64). */
  kind: "user" | "claude" | "event" | "permission" | "question";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  created_at: string;
}

/** One page of a thread (API 56): see `api.messagePage`. */
export interface MessagePage {
  messages: Message[];
  /** There are older messages than these (after `after`, if given). */
  more: boolean;
  /** For the latest page (no `before` or `after`): what lists the subagents started before it, cut down (db::subagent_messages on the server). */
  subagents: Message[];
}

/** A conversation rollback waiting for a task's next run (API 70): it goes on from before turn `turn`. */
export interface PendingRewind {
  turn: number;
  message_id: number;
  session: string;
}

/** What a turn changed, without the files git brought in by a merge, pull or rebase (API 70). */
export interface TurnStats {
  files: number;
  additions: number;
  deletions: number;
  /** The files left out (the first 200), and how many. */
  excluded: string[];
  excluded_count: number;
}

/** One of the agent's turns with a checkpoint after it (API 70). */
export interface Turn {
  /** Its number among the task's turns. */
  turn: number;
  /** Its checkpoint, and the one it started from (null when there's none, as for a turn from before checkpoints). */
  n: number;
  before_n: number | null;
  run_id: string | null;
  /** The user message it started with, and its text. */
  message_id: number | null;
  text: string;
  auto: boolean;
  /** Set for a round of fixes a review sent back. */
  review_round: number | null;
  /** done, stopped or failed */
  status: string | null;
  /** A rewind has gone back to before it. */
  stale: boolean;
  /** When it ended. */
  at: string;
  /** HEAD after it, and before it. */
  head: string | null;
  before_head: string | null;
  stats: TurnStats | null;
  /** Both of its checkpoints are there to diff. */
  diff: boolean;
  /** Whether the task can be rewound to before it, and its agent's conversation with it (`fresh`: it starts over). */
  rewind: { ok: true; conversation: { ok: true; fresh: boolean } | { ok: false; reason: string } } | { ok: false; reason: string };
}

export interface TurnsResult {
  available: boolean;
  reason?: string;
  turns: Turn[];
  head?: string | null;
  rewind?: PendingRewind | null;
  agent?: "claude" | "codex";
}

export interface TurnDiff {
  patch: string;
  too_large: boolean;
  stats: TurnStats;
  excluded: string[];
}

export interface RewindResult {
  task: Task;
  written: number;
  removed: number;
  /** Files left as they were: submodules, and ones marked skip-worktree or assume-unchanged. */
  skipped: string[];
  branch: { from: string; to: string } | null;
  /** The ref the replaced files are kept in. */
  kept: string;
  /** The message rewound to, to edit and send again. */
  message: { text: string | null; auto: boolean };
}

/** What the user answered a question or plan prompt with, besides allowing or denying it (API 64). */
export type PermissionReply = { answers?: string[][]; mode?: PermissionMode; feedback?: string };

export const threadApi = ({ on }: Http) => ({
  messages: (h: string, id: string) => on(h).get<Message[]>(`/tasks/${enc(id)}/messages`),
  /**
   * The latest messages with ids between `after` and `before` (API 56): with a `limit`, that many of the
   * main conversation's, with the subagents' own messages among them.
   */
  messagePage: (h: string, id: string, q: { before?: number; after?: number; limit?: number }) =>
    on(h).get<MessagePage>(`/tasks/${enc(id)}/messages?${new URLSearchParams(Object.entries(q).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))}`),
  send: (h: string, id: string, text: string) => on(h).post<Task>(`/tasks/${enc(id)}/messages`, { text }),
  stop: (h: string, id: string) => on(h).post(`/tasks/${enc(id)}/stop`),
  /** The task's turns with checkpoints, and the changes between two checkpoints (API 70). */
  turns: (h: string, id: string) => on(h).get<TurnsResult>(`/tasks/${enc(id)}/turns`),
  turnDiff: (h: string, id: string, from: number, to: number) => on(h).get<TurnDiff>(`/tasks/${enc(id)}/turns/diff?from=${from}&to=${to}`),
  /** Restores the files to before the turn `message_id` started, and optionally the branch and the agent's conversation. */
  rewind: (h: string, id: string, b: { message_id: number; conversation: boolean; branch: boolean }) => on(h).post<RewindResult>(`/tasks/${enc(id)}/rewind`, b),
  cancelRewind: (h: string, id: string) => on(h).del<Task>(`/tasks/${enc(id)}/rewind`),
  /** How full the agent's context is, with the latest breakdown (API 40). */
  context: (h: string, id: string) => on(h).get<{ context: ContextSummary | null; detail: ContextDetail | null }>(`/tasks/${enc(id)}/context`),
  /** With `reply` (API 64): a question's answers, by question (each a list of picked labels and typed text); the
   *  mode an approved plan carries on in; or the feedback a plan's sent back with. */
  resolvePermission: (h: string, id: string, decision: "allow" | "allow_always" | "deny", message?: string, reply?: PermissionReply) =>
    on(h).post(`/permissions/${enc(id)}`, { decision, message, ...reply }),
  /** Answer a question an agent asked with request_user_input, from its card (API 64): sent as the user's message. */
  answerQuestion: (h: string, taskId: string, messageId: number, answer: { choices: string[]; text: string | null }) =>
    on(h).post<Task>(`/tasks/${enc(taskId)}/questions/${messageId}`, answer),
});
