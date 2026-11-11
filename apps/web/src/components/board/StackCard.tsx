// The Stack card (HA-388, part of HA-386): a stack's cards gathered into one on the kanban board, drawn as a pile, with
// what the whole stack is for, what its landing waits on and what's wrong, and a bar with a part for each level. Its
// button spreads it into its levels' own cards, which each carry a tab ("2 of 3") that gathers it again. The card never
// shows task keys: it names a level by its title (a part of the bar names its task in its tooltip).
import { clsx } from "clsx"
import { CheckCheck, CircleAlert, CircleX, Ellipsis, FoldVertical, GitMerge, Layers, ListFilter, ShieldQuestionMark, UnfoldVertical } from "lucide-react"
import { useState, type FormEvent, type MouseEvent, type ReactNode } from "react"
import {
  agentWaiting,
  backgroundIdle,
  failedChecks,
  isMerged,
  keyPrefix,
  mergeAwaitsApproval,
  mergeQueued,
  STATUSES,
  type HostProject as Project,
  type HostTask as Task,
} from "@huntaway/client"
import { useNarrow, useTouch } from "../../narrow"
import { openTask, usePanel } from "../../state/route"

import { Button, Input, Modal, ModalFooter, RunningDot, STATUS_COLOR, Textarea } from "../ui"
import { landsNext, named, namesOf, openMain, stackColumn, stackedBelowId, stackRun, type MergeCheck, type Stack } from "./stacks"
import { useBoard } from "../../state/board"

/** The stack's title: its own (API 152), else its bottom task's. */
export const stackTitle = (s: Stack) => s.bottom.stack_title?.trim() || s.bottom.title

/** "Stack #12" for one on GitHub, else "Stack". */
const stackName = (s: Stack) => {
  const n = s.main.find((t) => t.github_stack != null)?.github_stack
  return n != null ? `Stack #${n}` : "Stack"
}

const statusLabel = (t: Task) => (isMerged(t) ? "merged" : t.status === "done" ? "closed" : (STATUSES.find((s) => s.id === t.status)?.label ?? t.status))

/** What the level the stack's landing waits on is doing, after "“Title” lands next: ". */
function nextWhy(t: Task): string {
  if (t.status === "ready_for_merge")
    return t.running ? "it's merging" : t.restack === "due" ? "it's being restacked" : mergeQueued(t) ? "queued to merge" : "it waits to merge"
  if (t.status === "in_review")
    return t.running
      ? "its agent is working"
      : t.review?.state === "running"
        ? "it's being reviewed"
        : t.review?.state === "passed"
          ? "it passed review"
          : t.review?.state === "issues"
            ? "its review found issues"
            : "it's in review"
  if (t.status === "in_progress")
    return agentWaiting(t) ? "its agent is waiting" : backgroundIdle(t) ? "its agent is idle" : t.running ? "its agent is working on it" : "it's in progress"
  return "it isn't started yet"
}

type Tone = "next" | "merge" | "attention" | "failed" | "faint" | "done"
const TONE: Record<Tone, string> = {
  next: "text-muted",
  merge: "text-muted",
  attention: "text-amber-200/90",
  failed: "text-red-400",
  faint: "text-faint",
  done: "text-muted",
}
interface Note {
  key: string
  tone: Tone
  icon: ReactNode
  text: ReactNode
  title?: string | undefined
  /** The level it opens. */
  opens?: Task | undefined
}

/** How many problem lines the card lists before it counts the rest. */
const MAX_PROBLEMS = 3

/** The card's lines: the stack's merge run, approvals, what's wrong, what lands next, whether it can merge, and filters. */
function stackNotes(s: Stack, all: Record<string, Task>, check: MergeCheck | null, hidden: number, narrow: boolean): Note[] {
  const notes: Note[] = []
  const open = s.tasks.filter((t) => t.status !== "done")
  const run = stackRun(s)
  if (run) {
    // Counted from the main line's statuses: the server takes `stack_run` off a run's levels, merged ones too, once the
    // run is over or a level leaves it.
    notes.push({
      key: "run",
      tone: "merge",
      icon: <GitMerge size={12} className="text-st-merge" />,
      text: `Merging the stack: ${s.main.filter(isMerged).length} of ${s.main.length} landed`,
      title: "Its levels merge bottom first, as one run of the merge queue: nothing else merges between them",
    })
  }
  const approvals = open.filter(mergeAwaitsApproval)
  if (approvals.length)
    notes.push({
      key: "approve",
      tone: "merge",
      icon: <ShieldQuestionMark size={12} className="text-st-merge" />,
      text: approvals.length === 1 && approvals[0] ? `${named(approvals[0])}: its merge needs your approval` : `${approvals.length} merges need your approval`,
      title: "Each level's merge is approved on its own, in its thread",
      opens: approvals[0],
    })
  const problems: Note[] = []
  for (const t of open) {
    if (t.status === "needs_attention")
      problems.push({
        key: `attention:${t.id}`,
        tone: "attention",
        icon: <CircleAlert size={12} className="text-st-attention" />,
        text: `${named(t)} needs your attention`,
        title: t.attention_reason ?? undefined,
        opens: t,
      })
    if (t.restack === "conflict")
      problems.push({
        key: `conflict:${t.id}`,
        tone: "attention",
        icon: <CircleAlert size={12} className="text-st-attention" />,
        text: `${named(t)}: restack conflict`,
        title: "The level below is merged, but the board couldn't restack this onto where it went: its agent is asked to",
        opens: t,
      })
    const below = stackedBelowId(t)
    const gone = below ? all[below] : undefined
    if (below && (!gone || (gone.status === "done" && !isMerged(gone))))
      problems.push({
        key: `held:${t.id}`,
        tone: "attention",
        icon: <CircleAlert size={12} className="text-st-attention" />,
        text: `${named(t)} waits for you to choose where it goes`,
        title: `The level below it was ${gone ? "closed without being merged" : "deleted"}: choose where it goes now in its sidebar`,
        opens: t,
      })
    const c = failedChecks(t)
    if (c) {
      const n = c.failed.length + c.more_failed
      problems.push({
        key: `checks:${t.id}`,
        tone: "failed",
        icon: <CircleX size={12} />,
        text: `${named(t)}: ${n} check${n === 1 ? "" : "s"} failed`,
        title: c.failed.map((f) => f.name).join(", "),
        opens: t,
      })
    }
  }
  notes.push(...problems.slice(0, problems.length > MAX_PROBLEMS ? MAX_PROBLEMS - 1 : MAX_PROBLEMS))
  if (problems.length > MAX_PROBLEMS)
    notes.push({ key: "more", tone: "attention", icon: <CircleAlert size={12} />, text: `and ${problems.length - MAX_PROBLEMS + 1} more things to see to` })
  const next = landsNext(s)
  if (!open.length)
    notes.push({
      key: "done",
      tone: "done",
      icon: <CheckCheck size={12} className="text-st-done" />,
      text: s.tasks.every(isMerged) ? "Every level has landed" : "Every level is done",
    })
  else if (next && !run && next.status !== "needs_attention" && !mergeAwaitsApproval(next))
    notes.push({
      key: "next",
      tone: "next",
      icon: <Layers size={12} style={{ color: STATUS_COLOR[next.status] }} />,
      text: (
        <>
          <span className="text-fg">{named(next)}</span> lands next: {nextWhy(next)}
        </>
      ),
      opens: next,
    })
  else if (!next && open.length)
    notes.push({ key: "next", tone: "next", icon: <Layers size={12} />, text: "Its main line has landed: the tasks beside it land on their own" })
  if (check && !run && openMain(s).length) {
    const near = ["in_review", "ready_for_merge"].includes(stackColumn(s))
    if (check.ok)
      notes.push({
        key: "merge",
        tone: "merge",
        icon: <GitMerge size={12} className="text-st-merge" />,
        text: narrow ? "Ready to merge the whole stack: Merge the stack in its menu" : "Ready to merge the whole stack: drag it to Ready for merge",
        title: "Its levels then merge bottom first, as one run of the merge queue",
      })
    else if (near && check.waiting.length)
      notes.push({
        key: "merge",
        tone: "faint",
        icon: <GitMerge size={12} />,
        text: `To merge the stack: ${namesOf(check.waiting)} ${check.waiting.length === 1 ? "isn't" : "aren't"} through review yet`,
        title: check.reason ?? undefined,
      })
  }
  if (hidden > 0)
    notes.push({
      key: "hidden",
      tone: "faint",
      icon: <ListFilter size={12} />,
      text: `${hidden} of its levels ${hidden === 1 ? "doesn't" : "don't"} match the filters`,
    })
  return notes
}

/** A part of the bar for each level, in landing order, in its status colour (pulsing while its agent works); a gap, then the tasks beside it. */
function StackBar({ stack, project }: { stack: Stack; project?: Project | undefined }) {
  const part = (t: Task) => {
    const label = `${keyPrefix(t, project)}-${t.number} ${t.title} · ${statusLabel(t)}${t.running ? ", its agent is working" : ""}${failedChecks(t) ? ", checks failed" : ""}`
    const closed = t.status === "done" && !isMerged(t)
    return (
      <button
        key={t.id}
        type="button"
        data-part={t.id}
        title={label}
        aria-label={label}
        className="-my-1 min-w-0 flex-1 rounded-full py-1 outline-none focus-visible:ring-1 focus-visible:ring-accent"
        onClick={(e) => {
          e.stopPropagation()
          openTask(t.id)
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <span
          className={clsx("block h-[6px] rounded-full", t.running && "animate-pulse-dot", failedChecks(t) && "ring-1 ring-red-400")}
          style={{
            background: closed ? "var(--color-line-strong)" : STATUS_COLOR[t.status],
            opacity: t.running ? undefined : t.status === "todo" || t.status === "backlog" ? 0.45 : 1,
          }}
        />
      </button>
    )
  }
  return (
    <div className="mt-3 flex items-center gap-[3px]" aria-label="Its levels, in landing order">
      {stack.main.map(part)}
      {stack.beside.length > 0 && (
        <>
          <span className="mx-1 h-[4px] w-[4px] shrink-0 rounded-full bg-line-strong" title="Beside the stack: they land on their own" />
          {stack.beside.map(part)}
        </>
      )}
    </div>
  )
}

/** Opens a gathered stack's menu at a right-click, or from its menu button (`button`). */
export type OnStackMenu = (e: MouseEvent, stack: Stack, button?: boolean) => void

/** A gathered stack's card on the kanban board. */
export function StackCard({
  stack,
  hidden,
  project,
  check,
  meta,
  anchor,
  onSpread,
  onMenu,
  onDragStart,
  onDragEnd,
}: {
  stack: Stack
  /** How many of its levels the filters leave out. */
  hidden: number
  project?: Project | undefined
  /** Whether it can merge as a whole, on a host that can (API 153); null on one that can't. */
  check: MergeCheck | null
  /** Its host keeps a stack's title and description (API 152). */
  meta: boolean
  /** The level whose place in the column it takes, which a task dropped above it goes before. */
  anchor: string
  onSpread: () => void
  onMenu: OnStackMenu
  onDragStart: (s: Stack) => void
  onDragEnd: () => void
}) {
  const all = useBoard((s) => s.tasks)
  const panel = usePanel()
  const narrow = useNarrow()
  const touch = useTouch()
  const open = !!panel && stack.tasks.some((t) => t.id === panel.taskId)
  const attention = stack.tasks.some((t) => t.status === "needs_attention")
  const running = stack.tasks.some((t) => t.running)
  const notes = stackNotes(stack, all, check, hidden, narrow || touch)
  const opens = landsNext(stack) ?? stack.main.at(-1) ?? stack.bottom
  const description = meta ? stack.bottom.stack_description?.trim() : null
  const draggable = !!check && openMain(stack).length > 0 && !narrow
  return (
    <div className="relative pb-3" data-stack={stack.key} data-drop-before={anchor}>
      {/* The cards under it, as the edges of a pile. */}
      <span className="absolute inset-x-4 bottom-0 h-5 rounded-b-lg border border-line-strong bg-panel-2" />
      <span className="absolute inset-x-2 bottom-[6px] h-5 rounded-b-lg border border-line-strong bg-panel-2" />
      <div
        role="button"
        tabIndex={0}
        aria-label={`Stack: ${stackTitle(stack)}`}
        aria-current={open || undefined}
        draggable={draggable}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/stack-id", stack.key)
          e.dataTransfer.effectAllowed = "move"
          onDragStart(stack)
        }}
        onDragEnd={onDragEnd}
        onClick={() => openTask(opens.id)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return
          e.preventDefault()
          openTask(opens.id)
        }}
        onContextMenu={(e) => onMenu(e, stack)}
        title={`Opens ${opens.title}`}
        className={clsx(
          "group @container relative cursor-pointer rounded-lg border bg-panel-2 p-3 transition-colors outline-none hover:bg-raised focus-visible:ring-1 focus-visible:ring-accent",
          attention ? "border-st-attention/45" : "border-accent/45",
          open && "bg-raised ring-1 ring-accent/60",
        )}
      >
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-faint">
          <Layers size={12} className="shrink-0 text-accent" />
          <span className="shrink-0 font-medium text-accent">{stackName(stack)}</span>
          <span className="truncate">
            {stack.main.length} levels{stack.beside.length > 0 && ` +${stack.beside.length} beside`}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {running && <RunningDot />}
            <button
              type="button"
              className="-my-1 flex h-6 w-6 items-center justify-center rounded-md border border-line-strong bg-raised text-muted hover:text-fg"
              title="Spread the stack: show its levels' own cards"
              aria-label="Spread the stack"
              onClick={(e) => {
                e.stopPropagation()
                onSpread()
              }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <UnfoldVertical size={13} />
            </button>
            {(narrow || touch) && (
              <button
                type="button"
                title="Stack menu"
                aria-label="Stack menu"
                aria-haspopup="menu"
                className="-my-2 -mr-2 flex h-8 w-8 items-center justify-center rounded-md text-faint hover:bg-white/5 hover:text-fg"
                onClick={(e) => {
                  e.stopPropagation()
                  onMenu(e, stack, true)
                }}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <Ellipsis size={16} />
              </button>
            )}
          </span>
        </div>
        <div className="text-[13px] leading-snug font-medium text-fg">{stackTitle(stack)}</div>
        {description && <div className="mt-1 line-clamp-3 text-[12px] leading-snug text-muted">{description}</div>}
        {notes.length > 0 && (
          <ul className="mt-2.5 space-y-1 text-[11.5px] leading-snug">
            {notes.map((n) => (
              <li key={n.key} className={clsx("flex items-start gap-1.5", TONE[n.tone])} title={n.title}>
                <span className="mt-px shrink-0">{n.icon}</span>
                {n.opens ? (
                  <button
                    type="button"
                    className="min-w-0 text-left hover:underline"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (n.opens) openTask(n.opens.id)
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    {n.text}
                  </button>
                ) : (
                  <span className="min-w-0">{n.text}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <StackBar stack={stack} project={project} />
      </div>
    </div>
  )
}

/** On a card of a spread stack: its place in the stack ("2 of 3", or "beside"), and the button that gathers it again. */
export function StackTab({ stack, task, onGather }: { stack: Stack; task: Task; onGather: () => void }) {
  const i = stack.main.indexOf(task)
  const beside = i < 0
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onGather()
      }}
      title={
        beside
          ? `Beside the stack “${stackTitle(stack)}”: it lands on its own. Gather the stack into one card`
          : `Level ${i + 1} of ${stack.main.length} of the stack “${stackTitle(stack)}”. Gather the stack into one card`
      }
      aria-label="Gather the stack"
      className="absolute top-px right-2 z-[1] flex h-[18px] items-center gap-1 rounded-full border border-accent/50 bg-[#1b1b30] px-1.5 text-[10px] font-medium text-accent hover:border-accent"
    >
      <Layers size={10} /> {beside ? "beside" : `${i + 1} of ${stack.main.length}`} <FoldVertical size={10} className="ml-0.5 text-accent/70" />
    </button>
  )
}

/** The top bar's switch that gathers or spreads every stack on the board at once. */
export function StacksSwitch({ gathered, onChange, labelled }: { gathered: boolean; onChange: (gathered: boolean) => void; labelled: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={gathered}
      aria-label="Stacks gathered"
      title={gathered ? "Stacks are gathered into one card each: spread them all into their levels' cards" : "Gather each stack into one card"}
      onClick={() => onChange(!gathered)}
      className={clsx(
        "mr-1 inline-flex h-7 items-center gap-2 rounded-md border px-2 text-xs font-medium transition-colors narrow:h-9",
        gathered ? "border-accent/40 bg-accent/[0.08] text-fg" : "border-line text-muted hover:text-fg",
      )}
    >
      <Layers size={13} className={gathered ? "text-accent" : undefined} />
      {labelled && <span className="narrow:hidden">Stacks gathered</span>}
      <span className={clsx("flex h-[14px] w-[24px] items-center rounded-full px-[2px]", gathered ? "justify-end bg-accent" : "justify-start bg-line-strong")}>
        <span className="h-[10px] w-[10px] rounded-full bg-white" />
      </span>
    </button>
  )
}

/** Edits a stack's title and description by hand (which pins them), or has the model write them again (API 152). */
export function StackEditModal({ stack, onClose }: { stack: Stack; onClose: () => void }) {
  const b = stack.bottom
  const [title, setTitle] = useState(stackTitle(stack))
  const [description, setDescription] = useState(b.stack_description ?? "")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // `tasks.updateStack` is not yet on this server (it comes with stacks, M4).
  const send = async (_body: { title?: string | undefined; description?: string | undefined; regenerate?: boolean | undefined }) => {
    setBusy(false)
    setErr("Couldn't change the stack: not yet on this server.")
  }
  const save = (e?: FormEvent) => {
    e?.preventDefault()
    if (!title.trim() || busy) return
    void send({ title: title.trim(), description: description.trim() })
  }
  return (
    <Modal title="The stack's title and description" onClose={onClose} onSubmit={save} width="max-w-lg">
      <form onSubmit={save} className="space-y-3">
        <Input autoFocus value={title} aria-label="Title" onChange={(e) => setTitle(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        <Textarea
          value={description}
          aria-label="Description"
          rows={4}
          placeholder="What the whole stack is for"
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="text-[12px] text-faint">
          {b.stack_pinned
            ? "Set by hand: they stay as they are as levels come and go, until a model writes them again."
            : "A model writes them from the levels' titles and descriptions as the stack changes. Set by hand, they stay as they are."}
        </div>
        <ModalFooter className="space-y-3">
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" className="mr-auto" disabled={busy} onClick={() => void send({ regenerate: true })}>
              Write them again
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !title.trim()}>
              Save
            </Button>
          </div>
        </ModalFooter>
      </form>
    </Modal>
  )
}
