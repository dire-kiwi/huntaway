import { Effect, Schema } from "effect"
import { Tool } from "effect/ai"
import { segments } from "@huntaway/a2ui"
import { Threads } from "../../threads/Threads.ts"
import { ForPlanning, isLocal, Rerunnable } from "../tool.ts"
import type { McpCaller } from "../tool.ts"
import { boardTool } from "./common.ts"

// Interactive replies (HE-77, docs/plan/07-agents.md, Interactive replies): the board draws an A2UI Express block in an
// agent's reply as UI, and these two tools are what the agent learns them from. `a2ui_rules` gives the rules and the
// components (~20 KB, so a run's system prompt only points at it: `prompts/a2uiNote.ts`); `a2ui_check` checks a reply's
// blocks as the board would draw them, after the earlier blocks of the caller's thread, so an `update=true` checks too.

export const A2uiRules = Tool.make("a2ui_rules", {
  description:
    "The rules for interactive replies: the board draws an A2UI Express block (between <a2ui> and </a2ui> lines) in your reply as UI the user " +
    "can click and fill in, and sends you what they chose as a message. Returns how to write one on this board, the Express language and every " +
    "component and function you can use. Read it before you write your first block in a thread.",
  parameters: Schema.Struct({}),
  success: Schema.String,
})
  .annotate(Rerunnable, true)
  .annotate(ForPlanning, true)

export const A2uiCheck = Tool.make("a2ui_check", {
  description:
    "Check the interactive (A2UI Express) blocks of a reply before you send it, as the board will draw them, after the blocks already in your thread " +
    '(so surface("<id>", update=true) of an earlier surface checks too). Returns ok with the surfaces it draws, or the first error and which block it\'s in.',
  parameters: Schema.Struct({
    text: Schema.String.annotate({ description: "The reply as you'll send it (with its <a2ui> … </a2ui> blocks), or one block's Express alone" }),
  }),
  success: Schema.Struct({
    ok: Schema.Boolean,
    blocks: Schema.optionalKey(Schema.Finite),
    surfaces: Schema.optionalKey(Schema.Array(Schema.String)),
    block: Schema.optionalKey(Schema.Finite),
    error: Schema.optionalKey(Schema.String),
  }),
})
  .annotate(Rerunnable, true)
  .annotate(ForPlanning, true)

/**
 * What the tools run, loaded on the first call: `@a2ui/agent` (the Express parser) and `@a2ui/web_core` take some 150 ms
 * to load, which a server's start shouldn't wait for (HE-71) when most runs never call them.
 */
const loadA2ui = Effect.promise(() =>
  import("@huntaway/a2ui/express").then((m) => {
    const catalogs = m.boardCatalogs()
    return { catalogs, rules: m.rules(catalogs), check: m.check, transform: m.boardTransform }
  }),
)

/** The interactive replies' tools' handlers. */
export const a2uiTools = Effect.gen(function* () {
  const threads = yield* Threads
  const a2ui = yield* Effect.cached(loadA2ui)

  /** The closed blocks of the caller's thread's replies so far, in order (none for an agent on another host). */
  const earlierBlocks = Effect.fnUntraced(function* (caller: McpCaller) {
    if (!isLocal(caller)) return []
    const stored = yield* threads.stored(caller.task.id).pipe(Effect.orElseSucceed(() => ({ entries: [] })))
    return stored.entries.flatMap((e) =>
      // A subagent's replies (an item with a parent) aren't drawn as blocks: the board draws the main conversation's.
      e.item.type === "assistant_message" && e.item.parent_id === undefined
        ? segments(e.item.text).flatMap((s) => (s.kind === "a2ui" && s.closed ? [s.source] : []))
        : [],
    )
  })

  const a2uiRules = boardTool(A2uiRules, () => Effect.map(a2ui, (a) => a.rules))
  const a2uiCheck = boardTool(A2uiCheck, (params, caller) =>
    Effect.gen(function* () {
      const a = yield* a2ui
      return a.check(params.text, a.catalogs, yield* earlierBlocks(caller), a.transform())
    }),
  )
  return { a2uiRules, a2uiCheck }
})
