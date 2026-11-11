import { Effect } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { type Task, TaskId } from "@huntaway/contracts"
import { afterSend, type AttachmentRef, splitAttachments } from "../logic/misc.ts"
import { callRpc, type CallError } from "../rpc.ts"
import type { ThreadRef } from "./thread.ts"

// What a task's composer sends (inventory 10, section 14): a send outlives the composer that started it (another tab
// or card can be open by the time the host answers), and only what was sent comes off the draft, so text typed and
// files added meanwhile stay. The old composer kept its sends in module-level maps with listeners; here they are atoms
// kept for the page's life, and the draft is an atom the composer edits, so whichever composer shows it sees the change.

/** What has been written to a task's agent and not sent: what a composer edits, kept in the browser's storage by the app. */
export interface ComposerDraft {
  readonly text: string
  readonly files: ReadonlyArray<AttachmentRef>
}

/** A message for a task's thread, from its composer. */
export interface SendMessage {
  /** What goes to the agent: the text with its line comments and attachments. */
  readonly body: string
  /** The text as typed, which comes off the draft once it has gone. */
  readonly sent: string
  /** The files attached, which come off the draft once it has gone. */
  readonly files: ReadonlyArray<AttachmentRef>
  /** The draft it was written in. */
  readonly draft: Atom.Writable<ComposerDraft | null>
}

const refKey = (ref: ThreadRef): string => `${ref.host_id}\u0000${ref.task_id}`

const parseKey = (key: string): ThreadRef => {
  const [host_id = "", task_id = ""] = key.split("\u0000")
  return { host_id, task_id }
}

/** The draft after the message that took `sent` and `files` from it went: what was typed or added meanwhile stays. */
export const draftAfterSend = (draft: ComposerDraft, sent: string, files: ReadonlyArray<AttachmentRef>): ComposerDraft | null => {
  const next = { text: afterSend(draft.text, sent), files: draft.files.filter((f) => !files.some((x) => x.id === f.id)) }
  return next.text.trim() === "" && next.files.length === 0 ? null : next
}

/** The draft with a message that was queued put back in front of what it has, to edit and send again. */
export const draftWithQueued = (draft: ComposerDraft | null, queued: string): ComposerDraft | null => {
  const { text, files } = splitAttachments(queued.trim())
  if (text === "" && files.length === 0) return draft
  const own = draft?.text ?? ""
  return { text: own.trim() ? (text ? `${text}\n\n${own}` : own) : text, files: [...files, ...(draft?.files ?? [])] }
}

const inFlightByKey = Atom.family((_key: string) => Atom.make(0).pipe(Atom.keepAlive))

/** How many of a task's messages are being sent now: its composers show the send under way while there are any. */
export const sendingAtom = (ref: ThreadRef): Atom.Atom<number> => inFlightByKey(refKey(ref))

const sendByKey = Atom.family((key: string) => {
  const ref = parseKey(key)
  const count = inFlightByKey(key)
  return Atom.fn<SendMessage>()(
    Effect.fnUntraced(function* (message) {
      // Through the registry, not the function's context: reading the draft there would make it run again as it changes.
      const registry = yield* AtomRegistry.AtomRegistry
      registry.update(count, (n) => n + 1)
      const task = yield* callRpc(ref.host_id, "tasks.send", { id: TaskId.make(ref.task_id), text: message.body }).pipe(
        Effect.ensuring(Effect.sync(() => registry.update(count, (n) => Math.max(0, n - 1)))),
      )
      const draft = registry.get(message.draft)
      if (draft !== null) registry.set(message.draft, draftAfterSend(draft, message.sent, message.files))
      return task
    }),
    { concurrent: true },
  ).pipe(Atom.keepAlive)
})

/**
 * Sends a message to a task's agent (`tasks.send`): it starts a run, steers the running one, or is queued. Kept for the
 * page's life, so a send outlives the composer that started it; once it has gone, what it took is removed from its
 * draft (`draftAfterSend`). Sends of one task run side by side. A failure is the result's, for the composer to show.
 */
export const sendMessage = (ref: ThreadRef): Atom.AtomResultFn<SendMessage, Task, CallError<"tasks.send">> => sendByKey(refKey(ref))

const dropByKey = Atom.family((key: string) => {
  const ref = parseKey(key)
  return Atom.fn<Atom.Writable<ComposerDraft | null>>()(
    Effect.fnUntraced(function* (draft) {
      const registry = yield* AtomRegistry.AtomRegistry
      const task = yield* callRpc(ref.host_id, "tasks.dropQueued", { id: TaskId.make(ref.task_id) })
      registry.set(draft, draftWithQueued(registry.get(draft), task.queued_message ?? ""))
      return task
    }),
  ).pipe(Atom.keepAlive)
})

/**
 * Takes back what is queued for a task's next run (`tasks.dropQueued`) and puts it in front of `draft`, to edit and
 * send again (the composer's "Unqueue and edit").
 */
export const unqueueMessage = (ref: ThreadRef): Atom.AtomResultFn<Atom.Writable<ComposerDraft | null>, Task, CallError<"tasks.dropQueued">> =>
  dropByKey(refKey(ref))
