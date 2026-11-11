import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  backgroundIdle,
  dependencyQueued,
  isAssistant,
  isPenThreads,
  limitQueued,
  runningAgentSteers,
  sendingAtom,
  sendMessage,
  splitAttachments,
  stopTitle,
  unqueueMessage,
  withAttachments,
  type HostTask as Task,
} from "@huntaway/client"
import { clsx } from "clsx"
import { Cause } from "effect"
import { ArrowUp, Clock, Loader2, MessageSquare, Square, X } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useTouch } from "../../../narrow"
import type { RewindResult } from "@huntaway/contracts"
import { composerDraftAtom, composerDraftKey, composerUnsavedAtom } from "../../../state/drafts"
import { registry } from "../../../state/registry"
import { rpc } from "../../../state/rpc"
import { errorText } from "../../ui"
import { lineRange, removeComments, useReview, withComments, type LineComment } from "../../changes/lineComments"
import { AttachButton, AttachmentList, DraftAttachments, useAttachmentDraft } from "../Attachments"
import { RewindNote } from "../Rewind"
import { RefChips, RefMenu, useRefCompletion, useRefMentions } from "../RefCompletion"
import { SkillHint, SkillMenu, useSkillMenu } from "../SkillMenu"
import { ModeSelect, useModeControl } from "./ModeSelect"
import { ModelEffort } from "./ModelEffort"
import { threadRef } from "./threadView"

// Step 1 (docs/plan/09-frontend.md): what the old composer kept in module-level maps (the sends in flight and their
// listeners, the drafts the browser couldn't keep, the composers to fill) is @huntaway/client's `sendMessage` and the
// draft atom in state/drafts.ts, so a send outlives the composer that started it and takes only what it sent off the
// draft. The Changes tab's line comments go with the next message, and come off its review once it has gone (4.2).

/** The diff's comments waiting to go with the next message: each one's file and lines, and its note. */
function ComposerComments({ task, comments }: { task: Task; comments: ReadonlyArray<LineComment> }) {
  return (
    <div className="border-b border-line px-4 py-2" data-comments>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-faint">
        <MessageSquare size={11} className="text-accent" />
        {comments.length === 1 ? "A comment" : `${comments.length} comments`} on the diff, sent with this message
      </div>
      <div className="flex flex-wrap gap-1.5">
        {comments.map((c) => (
          <span
            key={c.id}
            title={`${c.path}, ${lineRange(c)} (${c.source})\n\n${c.note}`}
            className="flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-line-strong bg-raised py-0.5 pr-0.5 pl-2 text-[11.5px]"
          >
            <span className="shrink-0 font-mono text-muted">
              {c.path.split("/").pop()}:{c.start === c.end ? c.start : `${c.start}–${c.end}`}
            </span>
            <span className="max-w-[28ch] min-w-0 truncate text-fg">{c.note}</span>
            <button
              onClick={() => removeComments(task.host_id, task.id, [c.id])}
              title="Remove the comment"
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-faint hover:bg-white/10 hover:text-fg"
            >
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
    </div>
  )
}

function QueuedMessage({ text, hostId }: { text: string; hostId: string }) {
  const { text: body, files } = splitAttachments(text)
  return (
    <>
      {body && <div className="line-clamp-4 text-[13px] whitespace-pre-wrap text-muted">{body}</div>}
      <AttachmentList hostId={hostId} files={files} className="mt-1" />
    </>
  )
}

/** The message field as tall as its text, up to 260 pixels. */
function fitText(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = "0px"
  el.style.height = `${Math.min(el.scrollHeight, 260)}px`
}

/** The failure of a send or an unqueue, to show; null while there is none. */
function failureOf(result: { readonly _tag: string; readonly cause?: Cause.Cause<unknown> }): string | null {
  return result._tag === "Failure" && result.cause ? errorText(Cause.squash(result.cause)) : null
}

/**
 * After a rewind that took the conversation back: the message rewound to goes into the task's composer (ahead of what's
 * there), to edit and send again. Not the board's own messages (a review's issues, say).
 */
export function rewound(task: Task, r: RewindResult, conversation: boolean) {
  if (!conversation || r.message.auto || !r.message.text?.trim()) return
  const { text, files } = splitAttachments(r.message.text.trim())
  const atom = composerDraftAtom(composerDraftKey(task))
  const d = registry.get(atom)
  registry.set(atom, { text: d?.text.trim() ? `${text}\n\n${d.text}` : text, files: [...files, ...(d?.files ?? [])] })
}

/** `onSend` is called as a message starts to send: a tab other than the thread goes to the thread with it (HA-334). */
export function Composer({ task, placeholder, onSend }: { task: Task; placeholder?: string | undefined; onSend?: (() => void) | undefined }) {
  const draftKey = composerDraftKey(task)
  const draftAtom = composerDraftAtom(draftKey)
  const ref = threadRef(task)
  const [draft, setDraft] = useAtom(draftAtom)
  const text = draft?.text ?? ""
  const setText = (change: string | ((cur: string) => string)) =>
    setDraft((d) => ({ text: typeof change === "function" ? change(d?.text ?? "") : change, files: d?.files ?? [] }))
  const unsaved = useAtomValue(composerUnsavedAtom(draftKey))
  const busy = useAtomValue(sendingAtom(ref)) > 0
  const send$ = useAtomSet(sendMessage(ref))
  const sendErr = failureOf(useAtomValue(sendMessage(ref)))
  const unqueue$ = useAtomSet(unqueueMessage(ref))
  const unqueueErr = failureOf(useAtomValue(unqueueMessage(ref)))
  const [err, setErr] = useState<string | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  // Set by Escape, so the next Shift+Tab leaves the field rather than cycling the permission mode.
  const tabLeaves = useRef(false)
  const modeControl = useModeControl(task)
  // Every host on this server queues messages while the agent is running.
  const canQueue = true
  // A message goes to the running agent straight away, if its run takes them.
  const canSteer = runningAgentSteers(task)
  // On a touch screen's keyboard Enter starts a new line, and the send button sends (as Ctrl/Cmd+Enter does).
  const touch = useTouch()
  const enter = touch ? "" : " (Enter)"
  const blocked = task.running && !canQueue
  // Idle with only background work left (a dev server, HA-405): a message reaches the agent at once, and the banner
  // above has the background work's Stop, so the composer is as it is between runs.
  const working = task.running && !backgroundIdle(task)
  const attach = useAttachmentDraft(task.host_id, draftAtom)
  const skills = useSkillMenu(task, text, setText)
  // `@` lists projects and tasks to put the key of (HA-303). The caret is null while the field isn't focused.
  const [caret, setCaret] = useState<number | null>(null)
  const caretTo = useRef<number | null>(null)
  const refs = useRefCompletion({
    text,
    caret,
    owner: task,
    apply: (next, at) => {
      setText(next)
      setCaret(at)
      caretTo.current = at
    },
  })
  // The keys in it that name a project or task, listed with their names (HA-400).
  const mentions = useRefMentions(text, task)
  // Comments on lines of the diff (the Changes tab's), which go with the message.
  const { comments } = useReview(task.host_id, task.id)
  // After the text with a picked key in it is drawn: the caret after the key.
  useLayoutEffect(() => {
    if (caretTo.current == null) return
    textarea.current?.setSelectionRange(caretTo.current, caretTo.current)
    caretTo.current = null
  })

  // As tall as its text, each time the text changes.
  const fitted = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (fitted.current === text) return
    fitted.current = text
    fitText(textarea.current)
  }, [text])
  // And when it gets wider or narrower, which wraps the text again (a phone turned round, say).
  useEffect(() => {
    const el = textarea.current
    if (!el) return undefined
    const seen = { width: el.clientWidth }
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === seen.width) return
      seen.width = el.clientWidth
      fitText(el)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const send = () => {
    const files = attach.files
    const body = withAttachments(withComments(text, comments), files)
    if (blocked || busy || attach.uploading) return
    if (!body && (task.session_id || task.running)) return
    setErr(null)
    const ids = comments.map((c) => c.id)
    send$({ body, sent: text, files, draft: draftAtom, onSent: () => removeComments(task.host_id, task.id, ids) })
    // The thread's composer shows the send under way, and the send takes what it sent off the draft once it's gone.
    onSend?.()
  }

  /** Take the queued message back into the composer to edit it. */
  const unqueue = () => {
    setErr(null)
    unqueue$(draftAtom)
    textarea.current?.focus()
  }

  const shownErr = err ?? sendErr ?? unqueueErr ?? modeControl.err
  // The assistant has nothing to start on but the user's message.
  const canStartEmpty = task.kind === "task" && !task.session_id && !task.running && !isAssistant(task) && !isPenThreads(task)
  return (
    <div className="shrink-0 px-5 pb-4 narrow:px-2 narrow:pb-2">
      <div className="mx-auto w-full max-w-3xl">
        <RewindNote task={task} />
        {shownErr && <div className="mb-2 text-xs text-red-400">{shownErr}</div>}
        {unsaved && (
          <div className="mb-2 text-xs text-amber-400">
            This browser couldn't save the draft (its storage may be full), so it's only kept until the page is closed or reloaded.
          </div>
        )}
        <div
          {...attach.dropProps}
          // Keeps the side panel open on a click outside it (see TaskPanel).
          data-draft={text.trim() !== "" || attach.items.length > 0 || undefined}
          className={clsx("rounded-2xl border border-line-strong bg-panel-2 focus-within:border-accent/50", attach.dragging && "border-accent! bg-accent/5")}
        >
          {task.steering.map((s) => (
            <div key={s.id} className="flex items-start gap-2 border-b border-line py-2 pr-2 pl-4">
              <Loader2 size={12} className="mt-1 shrink-0 animate-spin text-faint" />
              <div className="min-w-0 flex-1">
                <QueuedMessage text={s.text} hostId={task.host_id} />
                <div className="mt-0.5 text-[11px] text-faint">
                  {s.from_agent ? "From another agent: " : "Sent: "}the agent reads it once it finishes its current step
                </div>
              </div>
            </div>
          ))}
          {task.queued_message && (
            <div className="flex items-start gap-2 border-b border-line py-2 pr-2 pl-4">
              <Clock size={12} className="mt-1 shrink-0 text-faint" />
              <div className="min-w-0 flex-1">
                <QueuedMessage text={task.queued_message} hostId={task.host_id} />
                <div className="mt-0.5 text-[11px] text-faint">
                  {task.running
                    ? "Queued: sends when the agent finishes, or press Stop to send it now"
                    : dependencyQueued(task)
                      ? "Queued: sends when the agent starts, once the tasks it depends on are merged"
                      : limitQueued(task)
                        ? "Queued: sends when the agent carries on, once its usage limit resets"
                        : "Queued: sends with the next message"}
                </div>
              </div>
              <button
                onClick={unqueue}
                title="Unqueue and edit"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-white/5 hover:text-fg"
              >
                <X size={13} />
              </button>
            </div>
          )}
          {comments.length > 0 && <ComposerComments task={task} comments={comments} />}
          <SkillMenu menu={skills} />
          {skills.hint && <SkillHint item={skills.hint} />}

          <textarea
            ref={textarea}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setCaret(e.target.selectionStart)
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onFocus={(e) => setCaret(e.currentTarget.selectionStart)}
            onBlur={() => setCaret(null)}
            onPaste={attach.onPaste}
            onKeyDown={(e) => {
              if (skills.onKeyDown(e)) return
              // While the `@` list is open, Enter and Tab pick from it rather than send.
              if (refs.onKeyDown(e)) return
              // Shift+Tab cycles the permission mode; after Escape it moves focus out of the field, as it does elsewhere.
              const leaving = tabLeaves.current
              tabLeaves.current = e.key === "Escape" || (leaving && e.key === "Shift")
              if (e.key === "Tab" && e.shiftKey && !leaving) {
                e.preventDefault()
                modeControl.cycle()
                return
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (!touch || e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                send()
              }
            }}
            rows={1}
            placeholder={
              comments.length > 0 && !blocked
                ? `Add a message to the comment${comments.length === 1 ? "" : "s"}, or press Enter to send ${comments.length === 1 ? "it" : "them"}…`
                : working
                  ? canQueue
                    ? task.queued_message
                      ? "Add to the queued message…"
                      : canSteer
                        ? "Message the agent: it reads it after its current step…"
                        : "Queue a message for when the agent finishes…"
                    : "Agent is working…"
                  : dependencyQueued(task) || limitQueued(task)
                    ? "Queue a message for when its agent starts…"
                    : (placeholder ?? (canStartEmpty ? "Add extra instructions, or press Enter to start" : "Reply to the agent…"))
            }
            className="block max-h-[260px] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[13.5px] text-fg placeholder:text-faint outline-none"
          />
          <RefMenu refs={refs} input={textarea} />
          <RefChips mentions={mentions} className="px-4 pt-1 pb-2" />
          <DraftAttachments draft={attach} hostId={task.host_id} className="px-4 pt-1 pb-2" />
          <div className="flex items-center gap-2 px-3 pb-2">
            <ModeSelect control={modeControl} running={task.running} />
            <ModelEffort task={task} />
            <span className="min-w-0 truncate text-[11px] text-faint narrow:hidden" title={task.session_id ?? undefined}>
              {task.session_id ? `session ${task.session_id.slice(0, 8)}` : "new session"}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <AttachButton draft={attach} />
              {working && canQueue && (text.trim() || attach.items.length > 0 || comments.length > 0) && (
                <button
                  onClick={send}
                  disabled={busy || attach.uploading}
                  title={(canSteer && !task.queued_message ? "Send to the agent now" : "Queue") + enter}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-strong text-white hover:bg-accent disabled:bg-white/10 disabled:text-faint narrow:h-9 narrow:w-9"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={15} />}
                </button>
              )}
              {working ? (
                <button
                  onClick={() => {
                    setErr(null)
                    rpc(task.host_id, "tasks.stop", { id: task.id }).catch((e: unknown) => setErr(`Couldn't stop the agent: ${errorText(e)}`))
                  }}
                  title={stopTitle(task, canSteer)}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-fg hover:bg-white/15 narrow:h-9 narrow:w-9"
                >
                  <Square size={11} fill="currentColor" />
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={busy || attach.uploading || (!text.trim() && !attach.items.length && !comments.length && !canStartEmpty)}

                  title={`Send${enter}`}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-strong text-white hover:bg-accent disabled:bg-white/10 disabled:text-faint narrow:h-9 narrow:w-9"
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={15} />}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
