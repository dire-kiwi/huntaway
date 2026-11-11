import { Option, Schema } from "effect"
import { describe, expect, it } from "vite-plus/test"
import { TaskId } from "../../src/ids.ts"
import type { PermissionMode } from "../../src/task.ts"
import { Command } from "../../src/thread/Command.ts"
import { previewAfter } from "../../src/thread/reducer.ts"
import { type Preview, Snapshot, ThreadMessage } from "../../src/thread/Snapshot.ts"
import { Timestamp } from "../../src/time.ts"
import { fromThreadPermissionMode, type ThreadPermissionMode, toThreadPermissionMode } from "../../src/thread/Thread.ts"

// The schemas as the wire has them, the stream's fallback for a newer host's events, the preview, and the pair of
// permission-mode converters (the old live.ts, translate/convert.ts and the web's threadView.ts each had a copy).

const th = TaskId.make("th")
const decodeMessage = (input: unknown) => Option.getOrNull(Schema.decodeUnknownOption(ThreadMessage)(input))
const decodeCommand = (input: unknown) => Option.getOrNull(Schema.decodeUnknownOption(Command)(input))

describe("ThreadMessage", () => {
  it("decodes each kind of message as its own type", () => {
    const snapshot = {
      type: "snapshot",
      thread: { id: "th", harness: "codex", status: "idle", created_at: "2026-11-01T00:00:00.000Z" },
      items: [],
      requests: [],
      seq: 0,
      preview: null,
    }
    expect(decodeMessage(snapshot)).toStrictEqual(snapshot)
    const added = { type: "item.added", thread_id: "th", seq: 1, item: { id: "legacy:12", type: "user_message", text: "hi", metadata: { auto: true } } }
    expect(decodeMessage(added)).toStrictEqual(added)
    const preview = { type: "preview", thread_id: "th", seq: 1, item_id: "stream:x:1", offset: 0, text: "Hel" }
    expect(decodeMessage(preview)).toStrictEqual(preview)
  })

  it("decodes a newer host's event, or a known one it cannot read, as an unknown event", () => {
    expect(decodeMessage({ type: "turn.started", thread_id: "th", seq: 3, turn_id: "t1" })).toStrictEqual({ type: "turn.started", thread_id: "th", seq: 3 })
    expect(decodeMessage({ type: "item.added", thread_id: "th", seq: 4, item: { id: "x", type: "hologram" } })).toStrictEqual({
      type: "item.added",
      thread_id: "th",
      seq: 4,
    })
  })

  it("leaves out what the old protocol had and the board never produced", () => {
    const decoded = Option.getOrNull(
      Schema.decodeUnknownOption(Snapshot)({
        thread: { id: "th", harness: "claude", status: "idle", created_at: "2026-11-01T00:00:00Z", usage: { input_tokens: 1, output_tokens: 2 } },
        items: [
          { id: "u1", type: "user_message", text: "hi", client_id: "c1", queued: true, turn_id: "t1" },
          { id: "tr1", type: "turn_result", ok: true, usage: { input_tokens: 1, output_tokens: 2 }, session: { id: "s" }, duration_ms: 5 },
        ],
        requests: [{ id: "q1", type: "question", questions: [{ id: "a", question: "?" }], turn_id: "t1", user_messages: 1 }],
        seq: 2,
      }),
    )
    expect(decoded).toStrictEqual({
      thread: { id: "th", harness: "claude", status: "idle", created_at: "2026-11-01T00:00:00Z" },
      items: [
        { id: "u1", type: "user_message", text: "hi" },
        { id: "tr1", type: "turn_result", ok: true, duration_ms: 5 },
      ],
      requests: [{ id: "q1", type: "question", questions: [{ id: "a", question: "?" }] }],
      seq: 2,
    })
  })

  it("takes a question request with no questions for an event it cannot read", () => {
    expect(decodeMessage({ type: "request.opened", thread_id: "th", seq: 1, request: { id: "q", type: "question", questions: [] } })).toStrictEqual({
      type: "request.opened",
      thread_id: "th",
      seq: 1,
    })
  })
})

describe("Command", () => {
  it("decodes one of each command, with the thread's id or without it", () => {
    const commands = [
      { type: "send", thread_id: "th", text: "Fix the failing test" },
      { type: "send", text: "Without the thread's id" },
      { type: "interrupt", thread_id: "th" },
      { type: "respond", thread_id: "th", request_id: "p1", resolution: { outcome: "allow", always: true } },
      { type: "respond", thread_id: "th", request_id: "p2", resolution: { outcome: "deny", message: "Don't touch the lockfile." } },
      { type: "respond", thread_id: "th", request_id: "q1", resolution: { outcome: "answer", answers: { runner: ["vitest"] } } },
      { type: "set_options", thread_id: "th", model: "sonnet", effort: "high", permission_mode: "accept_edits" },
      { type: "rewind", thread_id: "th", item_id: "legacy:12", conversation: true, branch: false },
      { type: "new_session", thread_id: "th" },
      { type: "compact", thread_id: "th" },
    ]
    const decoded = commands.map(decodeCommand)
    expect(decoded).toStrictEqual(commands)
    expect([...new Set(decoded.map((c) => c?.type ?? ""))].toSorted()).toStrictEqual([
      "compact",
      "interrupt",
      "new_session",
      "respond",
      "rewind",
      "send",
      "set_options",
    ])
  })

  it("refuses a mode in Claude Code's spelling", () => {
    expect(decodeCommand({ type: "set_options", permission_mode: "acceptEdits" })).toBeNull()
  })
})

describe("permission modes", () => {
  it("go between Claude Code's spelling and the protocol's, both ways", () => {
    const pairs: ReadonlyArray<readonly [PermissionMode, ThreadPermissionMode]> = [
      ["default", "default"],
      ["acceptEdits", "accept_edits"],
      ["auto", "auto"],
      ["plan", "plan"],
      ["dontAsk", "dont_ask"],
      ["bypassPermissions", "bypass"],
    ]
    for (const [board, thread] of pairs) {
      expect(toThreadPermissionMode(board)).toBe(thread)
      expect(fromThreadPermissionMode(thread)).toBe(board)
    }
  })
})

const preview = (item_id: string, offset: number, text: string) => ({ type: "preview" as const, thread_id: th, seq: 3, item_id, offset, text })
const fold = (start: Preview | null, messages: ReadonlyArray<ThreadMessage>) => messages.reduce(previewAfter, start)
const snapshot = (p: Preview | null): ThreadMessage => ({
  type: "snapshot",
  thread: { id: th, harness: "claude", status: "running", created_at: Timestamp.make("2026-11-01T00:00:00Z") },
  items: [],
  requests: [],
  seq: 0,
  preview: p,
})

describe("previewAfter", () => {
  it("puts streamed text at its offset, skipping what it has", () => {
    expect(fold(null, [preview("s:1", 0, "Hel"), preview("s:1", 3, "lo")])).toStrictEqual({ item_id: "s:1", text: "Hello" })
    const p = { item_id: "s:1", text: "Hello" }
    expect(previewAfter(p, preview("s:1", 0, "Hel"))).toBe(p)
    expect(previewAfter(p, preview("s:1", 3, "lo, world"))).toStrictEqual({ item_id: "s:1", text: "Hello, world" })
    expect(previewAfter(p, preview("s:1", 5, ""))).toBe(p)
  })

  it("shows the rest of a reply opened mid-way, and starts again for another reply", () => {
    expect(previewAfter(null, preview("s:1", 7, "world"))).toStrictEqual({ item_id: "s:1", text: "world" })
    expect(previewAfter({ item_id: "s:1", text: "Hello" }, preview("s:2", 0, "Next"))).toStrictEqual({ item_id: "s:2", text: "Next" })
  })

  it("ends when an item is added to the main conversation, not a subagent's", () => {
    const p = { item_id: "s:1", text: "Hello" }
    expect(previewAfter(p, { type: "item.added", thread_id: th, seq: 4, item: { id: "legacy:9:0", type: "assistant_message", text: "Hello" } })).toBeNull()
    const sub = { type: "item.added" as const, thread_id: th, seq: 4, item: { id: "a", type: "assistant_message" as const, text: "x", parent_id: "toolu_1" } }
    expect(previewAfter(p, sub)).toBe(p)
    expect(previewAfter(p, { type: "item.updated", thread_id: th, seq: 5, item_id: "a", patch: { text: "y" } })).toBe(p)
  })

  it("is the snapshot's own after a snapshot", () => {
    expect(previewAfter({ item_id: "s:1", text: "old" }, snapshot(null))).toBeNull()
    expect(previewAfter(null, snapshot({ item_id: "s:2", text: "so far" }))).toStrictEqual({ item_id: "s:2", text: "so far" })
  })
})
