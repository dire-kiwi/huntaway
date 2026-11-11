import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect } from "effect"
import { Atom } from "effect/reactivity"
import { type Item, type Task, TaskId, type ThreadMessage } from "@huntaway/contracts"
import {
  applyThreadMessage,
  type ComposerDraft,
  draftWithQueued,
  emptyThreadView,
  olderPage,
  PAGE_ITEMS,
  sendingAtom,
  sendMessage,
  threadAtom,
  threadPreviewAtom,
  unqueueMessage,
  WINDOW_ITEMS,
} from "../src/index.ts"
import { fakeHost } from "./fakeHost.ts"
import { fakeThread, message } from "./fakeThread.ts"
import { task } from "./fixtures.ts"
import { registryFor, until } from "./registry.ts"

const T1 = TaskId.make("task-1")

/** `n` replies, `Reply 0` first. */
const replies = (n: number, from = 0): ReadonlyArray<Item> => Array.from({ length: n }, (_, i) => message(`m${from + i}`, `Reply ${from + i}`))

/** The texts of the thread's items, in order. */
const texts = (items: ReadonlyArray<Item> | undefined): ReadonlyArray<string> => (items ?? []).map((i) => ("text" in i ? i.text : i.id))

/** A thread of `items` on a fake host, and a registry whose atoms reach it, with the thread's view mounted. */
const setup = (items: ReadonlyArray<Item> = []) =>
  Effect.gen(function* () {
    const host = yield* fakeHost("host-a")
    const thread = fakeThread(host, T1, items)
    const registry = yield* registryFor(host)
    const ref = { host_id: host.id, task_id: T1 }
    const unmount = registry.mount(threadAtom(ref))
    yield* Effect.addFinalizer(() => Effect.sync(unmount))
    return { host, thread, registry, ref }
  })

describe("threadAtom", () => {
  it.effect("shows a window of the thread's last items, then its events as they come", () =>
    Effect.gen(function* () {
      const { thread, registry, ref } = yield* setup(replies(3))
      const first = yield* until(registry, threadAtom(ref), (v) => v.snap !== null)
      expect(texts(first.snap?.items)).toEqual(["Reply 0", "Reply 1", "Reply 2"])
      expect(thread.watches).toEqual([undefined])
      yield* thread.emit({ type: "item.added", item: message("m3", "Reply 3") })
      const next = yield* until(registry, threadAtom(ref), (v) => v.snap?.items.length === 4)
      expect(texts(next.snap?.items).at(-1)).toBe("Reply 3")
      // What the event left as it was keeps its identity, so its row does not draw again.
      expect(next.snap?.items[0]).toBe(first.snap?.items[0])
      yield* thread.emit({ type: "item.updated", item_id: "m1", patch: { text: "Reply 1, edited" } })
      const edited = yield* until(registry, threadAtom(ref), (v) => v.snap?.seq === 2)
      expect(texts(edited.snap?.items)).toEqual(["Reply 0", "Reply 1, edited", "Reply 2", "Reply 3"])
    }).pipe(Effect.scoped),
  )

  it.effect("asks for a window of WINDOW_ITEMS, and loads the pages before it a page at a time", () =>
    Effect.gen(function* () {
      const { thread, registry, ref } = yield* setup(replies(WINDOW_ITEMS + PAGE_ITEMS + 100))
      const first = yield* until(registry, threadAtom(ref), (v) => v.snap !== null)
      expect(first.snap?.start).toBe(PAGE_ITEMS + 100)
      expect(first.snap?.items.length).toBe(WINDOW_ITEMS)
      const older = olderPage(ref)
      const unmount = registry.mount(older)
      yield* Effect.addFinalizer(() => Effect.sync(unmount))
      registry.set(older, undefined)
      const paged = yield* until(registry, threadAtom(ref), (v) => v.snap?.start === 100 && !v.loading)
      expect(texts(paged.snap?.items)[0]).toBe("Reply 100")
      expect(paged.snap?.items.length).toBe(WINDOW_ITEMS + PAGE_ITEMS)
      registry.set(older, undefined)
      const whole = yield* until(registry, threadAtom(ref), (v) => v.snap?.start === undefined && !v.loading)
      expect(texts(whole.snap?.items)[0]).toBe("Reply 0")
      expect(thread.pages).toEqual([PAGE_ITEMS + 100, 100])
      // There is nothing before the first item: nothing is asked.
      registry.set(older, undefined)
      yield* until(registry, older, (r) => r._tag === "Success" && !r.waiting)
      expect(thread.pages).toEqual([PAGE_ITEMS + 100, 100])
    }).pipe(Effect.scoped),
  )

  it.effect("an event for an item of a page loaded since changes it there", () =>
    Effect.gen(function* () {
      const { thread, registry, ref } = yield* setup(replies(WINDOW_ITEMS + 10))
      yield* until(registry, threadAtom(ref), (v) => v.snap !== null)
      const older = olderPage(ref)
      const unmount = registry.mount(older)
      yield* Effect.addFinalizer(() => Effect.sync(unmount))
      registry.set(older, undefined)
      yield* until(registry, threadAtom(ref), (v) => v.snap !== null && v.snap.start === undefined && v.snap.items.length === WINDOW_ITEMS + 10)
      yield* thread.emit({ type: "item.updated", item_id: "m2", patch: { text: "An old one, edited" } })
      const after = yield* until(registry, threadAtom(ref), (v) => v.snap?.seq === 1)
      expect(texts(after.snap?.items)[2]).toBe("An old one, edited")
    }).pipe(Effect.scoped),
  )

  it.effect("a dropped subscription continues from the last event it had, with what it missed", () =>
    Effect.gen(function* () {
      const { thread, registry, ref } = yield* setup(replies(2))
      yield* until(registry, threadAtom(ref), (v) => v.snap !== null)
      yield* thread.emit({ type: "item.added", item: message("m2", "Reply 2") })
      yield* until(registry, threadAtom(ref), (v) => v.snap?.seq === 1)
      yield* thread.drop
      // While it was away.
      yield* thread.emit({ type: "item.added", item: message("m3", "Reply 3") })
      const back = yield* until(registry, threadAtom(ref), (v) => v.snap?.seq === 2)
      expect(texts(back.snap?.items)).toEqual(["Reply 0", "Reply 1", "Reply 2", "Reply 3"])
      expect(thread.watches).toEqual([undefined, 1])
    }).pipe(Effect.scoped),
  )

  it.effect("counts the events of a type it does not know, and goes on", () =>
    Effect.gen(function* () {
      const { thread, registry, ref } = yield* setup(replies(1))
      yield* until(registry, threadAtom(ref), (v) => v.snap !== null)
      yield* thread.send({ type: "thread.renamed", thread_id: T1, seq: 1 })
      const counted = yield* until(registry, threadAtom(ref), (v) => v.unknown === 1)
      expect(counted.snap?.seq).toBe(1)
      yield* thread.emit({ type: "item.added", item: message("m1", "Reply 1") })
      yield* until(registry, threadAtom(ref), (v) => texts(v.snap?.items).includes("Reply 1"))
    }).pipe(Effect.scoped),
  )

  it.effect("a task its host does not have is failed, not loading for ever", () =>
    Effect.gen(function* () {
      const host = yield* fakeHost("host-a")
      fakeThread(host, T1)
      const registry = yield* registryFor(host)
      const ref = { host_id: host.id, task_id: "task-gone" }
      const unmount = registry.mount(threadAtom(ref))
      yield* Effect.addFinalizer(() => Effect.sync(unmount))
      const failed = yield* until(registry, threadAtom(ref), (v) => v.failed !== null)
      expect(failed.snap).toBeNull()
    }).pipe(Effect.scoped),
  )
})

/** Streamed text for the reply `item_id`. */
const preview = (offset: number, text: string, item_id = "stream:1"): ThreadMessage => ({ type: "preview", thread_id: T1, seq: 0, item_id, offset, text })

describe("threadPreviewAtom", () => {
  it.effect("is the reply being written, apart from the thread; it ends when the reply is saved", () =>
    Effect.gen(function* () {
      const { thread, registry, ref } = yield* setup(replies(1))
      const unmount = registry.mount(threadPreviewAtom(ref))
      yield* Effect.addFinalizer(() => Effect.sync(unmount))
      const view = yield* until(registry, threadAtom(ref), (v) => v.snap !== null)
      yield* thread.send(preview(0, "Hel"))
      yield* thread.send(preview(3, "lo"))
      // Overlapping text is skipped.
      yield* thread.send(preview(3, "lo, world"))
      yield* until(registry, threadPreviewAtom(ref), (p) => p?.text === "Hello, world")
      // A token does not change the thread.
      expect(registry.get(threadAtom(ref))).toBe(view)
      // Another reply starts afresh.
      yield* thread.send(preview(0, "Next", "stream:2"))
      yield* until(registry, threadPreviewAtom(ref), (p) => p?.text === "Next")
      yield* thread.emit({ type: "item.added", item: message("m1", "Next one") })
      yield* until(registry, threadPreviewAtom(ref), (p) => p === null)
    }).pipe(Effect.scoped),
  )
})

describe("applyThreadMessage", () => {
  it("changes nothing for an event before the first snapshot, and keeps the view for one it has", () => {
    const event: ThreadMessage = { type: "item.added", thread_id: T1, seq: 1, item: message("m0", "x") }
    expect(applyThreadMessage(emptyThreadView, event)).toBe(emptyThreadView)
  })
})

describe("sendMessage", () => {
  const sendSetup = Effect.gen(function* () {
    const { host, registry, ref } = yield* setup()
    const answer = yield* Deferred.make<Task>()
    host.on("tasks.send", () => Deferred.await(answer))
    const draft = Atom.make<ComposerDraft | null>({ text: "Fix the footer", files: [{ id: "f1", name: "a.png", path: "/x/attachments/f1/a.png" }] }).pipe(
      Atom.keepAlive,
    )
    return { host, registry, ref, answer, draft }
  })

  it.effect("takes only what was sent off the draft: what was typed meanwhile stays", () =>
    Effect.gen(function* () {
      const { host, registry, ref, answer, draft } = yield* sendSetup
      const send = sendMessage(ref)
      const sent = registry.get(draft)
      registry.set(send, { body: "Fix the footer\n\nAttached files:\n- /x/attachments/f1/a.png", sent: sent?.text ?? "", files: sent?.files ?? [], draft })
      yield* until(registry, sendingAtom(ref), (n) => n === 1)
      expect(host.calls.filter(([m]) => m === "tasks.send")).toEqual([
        ["tasks.send", { id: T1, text: "Fix the footer\n\nAttached files:\n- /x/attachments/f1/a.png" }],
      ])
      // Typed while it was sending.
      registry.set(draft, { text: "Fix the footer\n\nand the header", files: sent?.files ?? [] })
      yield* Deferred.succeed(answer, task())
      yield* until(registry, sendingAtom(ref), (n) => n === 0)
      expect(registry.get(draft)).toEqual({ text: "and the header", files: [] })
    }).pipe(Effect.scoped),
  )

  it.effect("outlives the composer that started it", () =>
    Effect.gen(function* () {
      const { registry, ref, answer, draft } = yield* sendSetup
      const send = sendMessage(ref)
      // The composer mounts the send while it is shown, and is closed before the host answers.
      const unmount = registry.mount(send)
      registry.set(send, { body: "Fix the footer", sent: "Fix the footer", files: [], draft })
      yield* until(registry, sendingAtom(ref), (n) => n === 1)
      unmount()
      yield* Deferred.succeed(answer, task())
      yield* until(registry, sendingAtom(ref), (n) => n === 0)
      expect(registry.get(draft)).toEqual({ text: "", files: [{ id: "f1", name: "a.png", path: "/x/attachments/f1/a.png" }] })
    }).pipe(Effect.scoped),
  )

  it.effect("a send the host refuses leaves the draft as it is", () =>
    Effect.gen(function* () {
      const { host, registry, ref, draft } = yield* sendSetup
      host.on("tasks.send", () => Effect.fail({ _tag: "Conflict" }))
      const send = sendMessage(ref)
      registry.set(send, { body: "Fix the footer", sent: "Fix the footer", files: [], draft })
      yield* until(registry, send, (r) => r._tag === "Failure")
      expect(registry.get(draft)?.text).toBe("Fix the footer")
      expect(registry.get(sendingAtom(ref))).toBe(0)
    }).pipe(Effect.scoped),
  )
})

describe("unqueueMessage", () => {
  it.effect("puts the queued message back in front of the draft, with its files", () =>
    Effect.gen(function* () {
      const { host, registry, ref } = yield* setup()
      host.on("tasks.dropQueued", () => Effect.succeed(task({ queued_message: "Queued one\n\nAttached files:\n- /x/attachments/f2/b.txt" })))
      const draft = Atom.make<ComposerDraft | null>({ text: "Typed", files: [] }).pipe(Atom.keepAlive)
      const unqueue = unqueueMessage(ref)
      registry.set(unqueue, draft)
      yield* until(registry, unqueue, (r) => r._tag === "Success")
      expect(registry.get(draft)).toEqual({ text: "Queued one\n\nTyped", files: [{ id: "f2", name: "b.txt", path: "/x/attachments/f2/b.txt" }] })
      expect(host.calls.filter(([m]) => m === "tasks.dropQueued")).toEqual([["tasks.dropQueued", { id: T1 }]])
    }).pipe(Effect.scoped),
  )

  it("puts nothing back when nothing was queued", () => {
    expect(draftWithQueued(null, "")).toBeNull()
    expect(draftWithQueued(null, "Queued")).toEqual({ text: "Queued", files: [] })
  })
})
