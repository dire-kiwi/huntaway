// What a thread shows: the view's model, which itemModel.ts builds from the thread's items. A new snapshot rebuilds
// it, but the parts it leaves as they were (items, tool calls and results, subagents, a subagent's rows) stay the same
// objects, so the rows that show them don't redraw.

import type { Subagent } from "./subagentView"

export interface ToolResult {
  content: string
  isError: boolean
}

/** A tool call: its input is the agent's (`Schema.Unknown` on the wire), read through fields.ts by the rows that show it. */
export type Call = { id: string; name: string; input: unknown; result?: ToolResult | undefined }

/**
 * What a permission prompt's card reads: the board's record of the request (its `metadata`, permissions/Permissions.ts
 * on the server), or, for a request from before it, what the request says (itemModel.ts).
 */
export interface PromptData {
  readonly request_id: string
  /** pending, allowed, denied or expired (answered, for a question from before the board's record). */
  readonly status: string
  readonly tool_name: string
  /** The call it asks about, which says the subagent that asked. */
  readonly tool_use_id?: string | undefined
  /** One of the board's own approvals: `project`, `delete_task`, `automation` or `workflow`. */
  readonly kind?: string | undefined
  readonly agent?: string | undefined
  /** The tool's input (a question's questions, a plan's plan, an approval's change). */
  readonly input: unknown
  /** The approval rule that asks first (API 115). */
  readonly rule?: { readonly tool: string } | undefined
  /** When one from a routine run is denied if nobody answers it. */
  readonly expires_at?: string | undefined
  /** What the user said with their answer. */
  readonly note?: string | undefined
  /** Answered by message, after its run had ended. */
  readonly late?: true | undefined
  /** A plan sent back: what should change. */
  readonly feedback?: string | undefined
  /** The mode a plan's approval carried on in. */
  readonly mode?: string | undefined
  /** The answers given, question by question. */
  readonly answers?: ReadonlyArray<ReadonlyArray<string>> | undefined
}

/** An option of a board question. */
export interface QuestionOption {
  readonly label: string
  readonly description: string | undefined
}

/** A question asked with the board's request_user_input (or the board's own merge approval): its card. */
export interface QuestionData {
  readonly question: string
  readonly options: ReadonlyArray<QuestionOption>
  readonly multi_select: boolean
  readonly allow_other: boolean
  /** pending, answered, replied, replaced or expired. */
  readonly status: string
  readonly answer?: { readonly choices: ReadonlyArray<string>; readonly text: string | null } | undefined
  readonly merge_approval?: true | undefined
}

/** A turn's end, as Claude's result message has it. */
export interface ResultData {
  readonly subtype: string
  readonly is_error: boolean
  readonly interrupted?: true | undefined
  readonly duration_ms?: number | undefined
  readonly num_turns?: number | undefined
  readonly total_cost_usd?: number | undefined
}

/** A compaction: what started it, and the context's tokens before and after. */
export interface CompactMeta {
  readonly trigger?: string | undefined
  readonly pre_tokens?: number | undefined
  readonly post_tokens?: number | undefined
}

/** A routine's report (API 110). */
export interface ReportData {
  readonly automation?: string | undefined
  readonly task_id?: string | undefined
  readonly key?: string | undefined
  readonly outcome?: string | undefined
  readonly text?: string | undefined
}

export type Item =
  | { type: "user"; key: string; text: string; auto?: boolean | undefined; steered?: boolean | undefined }
  | { type: "event"; key: string; level: string; text: string; detail?: string | null | undefined }
  | { type: "permission"; key: string; data: PromptData }
  | { type: "question"; key: string; id: number; data: QuestionData }
  | { type: "text"; key: string; text: string }
  | { type: "thinking"; key: string; text: string }
  | { type: "tools"; key: string; calls: Call[] }
  | { type: "result"; key: string; data: ResultData }
  | { type: "compact"; key: string; meta: CompactMeta; summary?: string | undefined; result?: ResultData | undefined }
  /** A routine's report, posted in the assistant's thread (API 110). */
  | { type: "report"; key: string; data: ReportData }

export interface ThreadModel {
  items: Item[]
  results: Map<string, ToolResult>
  subagents: Map<string, Subagent>
  /** tool_use_id → the subagent that made the call, for calls made inside a subagent. */
  callParent: Map<string, string>
  /**
   * The id of the latest message sent to the agent in the main conversation (by the user, the board or another
   * agent), or 0: a question or plan from before it has been moved past, and isn't answered any more.
   */
  lastSent: number
  /** Each subagent's own items, prompts included, by its call's id. */
  childItems: Map<string, Item[]>
}

/** `next`, with the items (and tool calls) that are the same as in `prev` swapped for those in `prev`. */
export function reuseItems(next: Item[], prev: Item[]): Item[] {
  if (!prev.length) return next
  const old = new Map(prev.map((it) => [it.key, it]))
  let same = next.length === prev.length
  const out = next.map((it, i) => {
    const was = old.get(it.key)
    if (!was || was.type !== it.type) return ((same = false), it)
    if (it.type === "tools" && was.type === "tools") {
      // A group grows, and its calls get their results: keep the calls that didn't change.
      const calls = new Map(was.calls.map((c) => [c.id, c]))
      it.calls = it.calls.map((c) => {
        const o = calls.get(c.id)
        return o && shallowEqual(o, c) ? o : c
      })
      if (sameList(was.calls, it.calls)) it = was
    } else if (shallowEqual(was, it)) it = was
    if (it !== prev[i]) same = false
    return it
  })
  return same ? prev : out
}

export function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => Reflect.get(a, k) === Reflect.get(b, k))
}

const sameList = <T>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i])
