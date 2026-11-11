import {
  backgroundIdle,
  canRunAgents,
  dependencyQueued,
  documentsOnly,
  isAssistant,
  isPenThreads,
  isRoutine,
  isScratch,
  keyPrefix,
  LABELS,
  runningAgentSteers,
  stopTitle,
  taskLabels,
  type DocumentType,
} from "@huntaway/client"
import { clsx } from "clsx"
import { ChevronLeft, ChevronRight, Clock, Folder, Play, Square, Workflow as WorkflowIcon, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { boardTaskUrl, groupTaskUrl, href, profileTaskUrl, type Panel } from "../../router"
import { closeTask, closeTaskModal, navigate } from "../../state/route"
import { board, useBoard } from "../../state/board"
import { rpc } from "../../state/rpc"
import { isGroupTask, useHost, useProfileName, useProject } from "../boardHelpers"
import { useNarrow } from "../../narrow"
import { openingTab } from "./openingTab"
import { useSubagentView } from "./thread/subagentView"
import { AgentIcon } from "../ui/AgentIcon"
import { ContextPill } from "./Context"
import { TaskTypeBadge } from "./documentInfo"
import { ReminderButton, StarButton, useCanMark } from "./Reminders"
import { Button, errorText, IconButton } from "../ui"
import { Details } from "./view/details/Details"
import { PanelButtons, useWide, type Mode, type Tab } from "./view/layout"
import { TabContent } from "./view/TabContent"
import { TitleEditor } from "./view/Title"
import { ReviewDot } from "./Review"
import { ReviewThreadView } from "./view/ReviewThreadView"
import { isWorkflowTab, useWorkflowRuns, workflowRunning, workflowTab, workflowTabs } from "./Workflows"

// Step 1 (docs/plan/09-frontend.md, "Step 1 as done for task/"): what the task view has that needs a later milestone is
// left out here, each with a note: the terminal and its tools (M6), the browser pane and the desktop view (M6), the
// assistant's brief, memory, routines and action log (M6), finding a routine's thread on other hosts (M6), and the
// Agents pill (layout/AgentsPill, with the assistant's and the layout's later pieces). Subprojects are a legacy branch,
// deleted.

const isLabel = (t: Tab): t is DocumentType => LABELS.some((l) => l === t)

/** A task beside the board, taking half the width, or expanded into a dialog over it; in the narrow layout, over the whole screen. */
export function TaskPanel({ panel }: { panel: Panel }) {
  const narrow = useNarrow()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      // Leave Escape to whatever is being typed in, and to an open dialog.
      // A task dialog over the page (TaskModal) takes it first.
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest("input, textarea, select, [contenteditable]") || document.querySelector("[data-modal], [data-task-modal]")) return
      closeTask()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  // A click outside the side panel closes it (the expanded dialog has its own backdrop for that),
  // unless that would throw away something unsaved in it: fields holding one are marked `data-draft`.
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (panel.expanded || narrow) return undefined
    const inside = (e: Event) => (e.target instanceof Node ? (ref.current?.contains(e.target) ?? true) : true)
    // Pressed outside with no dialog open (a dialog's backdrop closes just the dialog) and no draft: where from.
    const press: { from: string | null } = { from: null }
    const onDown = (e: MouseEvent) => {
      const keep = document.querySelector("[data-modal], [data-task-modal]") || ref.current?.querySelector("[data-draft]")
      press.from = e.button === 0 && !inside(e) && !keep ? window.location.href : null
    }
    const onClick = (e: MouseEvent) => {
      const from = press.from
      press.from = null
      if (from === null || inside(e)) return
      // Left to what the click did: opening another task or page, or a dialog, or selecting text.
      if (window.location.href !== from || document.querySelector("[data-modal], [data-task-modal]") || !window.getSelection()?.isCollapsed) return
      closeTask()
    }
    window.addEventListener("mousedown", onDown)
    window.addEventListener("click", onClick)
    return () => {
      window.removeEventListener("mousedown", onDown)
      window.removeEventListener("click", onClick)
    }
  }, [panel.expanded, narrow])
  return (
    <>
      {panel.expanded && !narrow && <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" onMouseDown={() => closeTask()} />}
      {/* The same element either way, so expanding keeps the thread, terminals and edits as they are. */}
      <div
        ref={ref}
        className={clsx(
          "min-w-0 bg-bg",
          narrow
            ? "animate-slide-in-right absolute inset-0 z-30"
            : panel.expanded
              ? "fixed inset-3 z-40 mx-auto max-w-[1400px] overflow-hidden rounded-xl border border-line shadow-2xl shadow-black/50 md:inset-x-10 md:inset-y-8"
              : // At least 480 wide where half would be less (a tablet, a small window), leaving a strip of the board.
                "animate-slide-in-right absolute top-12 right-0 bottom-0 z-30 w-1/2 min-w-[min(100%-3rem,480px)] border-l border-line shadow-2xl shadow-black/50",
        )}
      >
        <TaskView taskId={panel.taskId} mode={panel.expanded ? "expanded" : "panel"} />
      </div>
    </>
  )
}

/**
 * Task `taskId` in a dialog over whatever page is open (`?modal=<id>`, HA-326), apart from the side panel: from a task's
 * key in a thread, or an assistant's tracked item. Escape, its backdrop and its close button close it, leaving the page
 * (and its side panel) as it was. It's marked `data-task-modal`, which the page's and the side panel's own keys and
 * clicks leave alone; not `data-modal`, which the task view inside it takes as a dialog over it (and leaves its keys to).
 */
export function TaskModal({ taskId }: { taskId: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      // Leave Escape to what's being typed in, and to a dialog or menu over this one.
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest("input, textarea, select, [contenteditable]") || document.querySelector("[data-modal]")) return
      e.preventDefault()
      closeTaskModal()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  return (
    <div data-task-modal className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && closeTaskModal()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Task"
        className="fixed inset-3 mx-auto max-w-[1400px] overflow-hidden rounded-xl border border-line bg-bg shadow-2xl shadow-black/50 narrow:inset-0 narrow:rounded-none narrow:border-0 md:inset-x-10 md:inset-y-8"
      >
        <TaskView taskId={taskId} mode="modal" />
      </div>
    </div>
  )
}

export function TaskView({ taskId, mode = "page" }: { taskId: string; mode?: Mode }) {
  const task = useBoard((s) => s.tasks[taskId])
  const loaded = useBoard((s) => s.loaded)
  const project = useProject(task?.project_id)
  const host = useHost(task?.host_id)
  const profileName = useProfileName(task)
  const agents = canRunAgents(host)
  const [rootRef, wide, measured] = useWide()
  const narrow = useNarrow()
  const canMark = useCanMark(task)
  const [markErr, setMarkErr] = useState<string | null>(null)
  const workflows = useWorkflowRuns(task)
  // The opening tab is picked when the task opens (or once it's loaded), not again as its status moves on.
  const found = !!task
  const [tab, setTab] = useState<Tab>(() => openingTab(task))
  const [shownFor, setShownFor] = useState({ taskId, found })
  if (shownFor.taskId !== taskId || shownFor.found !== found) {
    setShownFor({ taskId, found })
    setTab(openingTab(board.get().tasks[taskId]))
    if (shownFor.taskId !== taskId) setMarkErr(null)
  }
  // A subagent's thread stays shown while the task is open: closing it (or opening another) goes back to the main thread.
  useEffect(() => () => useSubagentView.getState().show(taskId, null), [taskId])
  // Wide enough for the details column: their tab is gone, and the thread shows instead. Not
  // dropped before the width is known, so a task opening on its details keeps that tab when narrow.
  if (measured && wide && tab === "details") setTab("thread")

  if (!task)
    return (
      <div className="flex h-full flex-col">
        {mode !== "page" && (
          <div className="flex h-12 shrink-0 items-center justify-end px-3">
            <PanelButtons mode={mode} />
          </div>
        )}
        <div className="p-8 text-muted">{loaded ? "Task not found." : "Loading task…"}</div>
      </div>
    )
  // A reviewer's, summarizer's or workflow step's thread has a view of its own, beside the review it's working on.
  if (task.kind === "review") return <ReviewThreadView thread={task} mode={mode} />
  // A group or scratch task works in no repository, so it has no changes of its own; nor does one
  // that makes only its documents. Each of a task's labels has a tab for its document, first.
  const group = isGroupTask(task) ? (task.group_name ?? undefined) : undefined
  const scratch = isScratch(task)
  // The profile's assistant: no repository either, and it opens on a page of its own. Its routines' threads work in
  // its workspace, with no repository.
  const assistant = isAssistant(task)
  const routine = isRoutine(task)
  // The profile's pens thread, and each pen's own: conversations in no repository, like the assistant.
  const pensThread = isPenThreads(task)
  // One in no project is on its profile's board (a scratch task can be in a project).
  const profileScratch = scratch && !task.project_id
  const labels = taskLabels(task)
  const docsOnly = documentsOnly(task)
  const tabs: Tab[] = [...labels, ...(group !== undefined || scratch || assistant || routine || pensThread || docsOnly ? ["thread"] : ["thread", "changes"])]
  // A project that uses workflows has no reviews of the board's (HA-277): a workflow's steps add their own tabs (a
  // Review one, say). Unless one of the board's is still running, from before it switched.
  const boardReviews = !project?.use_workflows || task.review?.state === "running"
  const reviews = task.kind === "task" && group === undefined && !docsOnly && !scratch && !assistant && !routine && !pensThread && boardReviews
  if (reviews) tabs.push("review")
  // Once there's a summary, or a review that passed to summarise: the tabs fit a phone's width until then.
  const summaries = reviews && (task.summaries.length > 0 || task.review?.state === "passed")
  if (summaries) tabs.push("summary")
  // A tab for each the task's workflow steps show their output in.
  if (task.kind === "task") tabs.push(...workflowTabs(workflows).map(workflowTab))
  if (!wide) tabs.push("details")
  // Until the render above drops it, a details tab while wide shows the thread beside the column.
  // A label taken off shows the thread instead; so does a tab this task hasn't got (review, summary, a workflow's).
  const shown = (wide && tab === "details") || (isLabel(tab) && !labels.includes(tab)) || !tabs.includes(tab) ? "thread" : tab
  const docShown = labels.find((l) => l === shown)
  const key = `${keyPrefix(task, project)}-${task.number}`
  const selectTab = (t: Tab) => setTab(t)
  // From another board (a group's or profile's), its own board opens with this task still beside it.
  const toProject = () => {
    if (group !== undefined) navigate(mode === "page" ? href({ name: "group", hostId: task.host_id, group }) : groupTaskUrl(task.host_id, group, task.id))
    else if (profileScratch && profileName) navigate(mode === "page" ? href({ name: "profile", profile: profileName }) : profileTaskUrl(profileName, task.id))
    else if (assistant && profileName) navigate({ name: "profile", profile: profileName })
    else if (routine && profileName) navigate({ name: "assistant", profile: profileName })
    else if (project) navigate(mode === "page" ? href({ name: "board", projectId: project.id }) : boardTaskUrl(project.id, task.id))
  }

  // Errors show under the header, with the marks'.
  const stop = () => {
    setMarkErr(null)
    rpc(task.host_id, "tasks.stop", { id: task.id }).catch((e: unknown) => setMarkErr(`Couldn't stop the agent: ${errorText(e)}`))
  }

  // Starts or stops the agent: last of the controls, or on a phone in the title row, where it isn't scrolled off with them.
  // Stopping the task also stops its review, summaries and workflows, so it can be stopped while only those run.
  const reviewing = task.review?.state === "running" || task.summaries.some((s) => s.state === "running") || workflowRunning(workflows)
  const run =
    task.running || reviewing ? (
      <Button
        size="sm"
        onClick={stop}
        title={
          backgroundIdle(task)
            ? "Stop the agent's run, and the background work it left going with it (the banner above the message field stops just that). The agent is told what stopped with your next message."
            : task.running
              ? stopTitle(task, runningAgentSteers(task))
              : "Stop the review, the summaries and the task's workflows"
        }
      >
        <Square size={11} fill="currentColor" /> {backgroundIdle(task) ? "Stop all" : "Stop"}
      </Button>
    ) : dependencyQueued(task) ? (
      <span className="flex items-center gap-1 text-[12px] text-muted" title="Its agent starts once the tasks it depends on are merged">
        <Clock size={12} /> Queued
      </span>
    ) : (
      !task.session_id &&
      agents &&
      !assistant &&
      !routine &&
      !pensThread && (
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setMarkErr(null)
            rpc(task.host_id, "tasks.send", { id: task.id, text: "" }).catch((e: unknown) => setMarkErr(`Couldn't start the agent: ${errorText(e)}`))
            setTab("thread")
          }}
        >
          <Play size={12} fill="currentColor" /> Start
        </Button>
      )
    )

  const controls = (
    <>
      {canMark && <ReminderButton task={task} onError={setMarkErr} />}
      <ContextPill task={task} />
      <div className="flex items-center gap-1 rounded-lg border border-line bg-panel p-0.5 narrow:order-first">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => selectTab(t)}
            className={clsx(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] capitalize narrow:py-1.5",
              shown === t ? "bg-raised text-fg" : "text-muted hover:text-fg",
            )}
          >
            {t === "review" && <ReviewDot task={task} />}
            {isWorkflowTab(t) ? (
              <span className="flex items-center gap-1 normal-case" title="A workflow's tab">
                <WorkflowIcon size={11} className="text-faint" />
                {t.slice(3)}
              </span>
            ) : (
              t
            )}
          </button>
        ))}
      </div>
      {!narrow && run}
    </>
  )

  const back = () =>
    project
      ? navigate({ name: "board", projectId: project.id })
      : group !== undefined
        ? navigate({ name: "group", hostId: task.host_id, group })
        : (profileScratch || assistant) && profileName
          ? navigate({ name: "profile", profile: profileName })
          : history.back()

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <header className={clsx("shrink-0 border-b border-line", mode === "page" && "drag")}>
        <div className="flex h-12 items-center gap-2 px-3">
          {(mode === "page" || narrow) && (
            <IconButton
              className="no-drag narrow:-ml-1.5"
              title="Back"
              onClick={mode === "page" ? back : mode === "modal" ? () => closeTaskModal() : () => closeTask()}
            >
              <ChevronLeft size={narrow ? 20 : 16} />
            </IconButton>
          )}
          <button className={clsx("no-drag shrink-0 text-[12.5px] text-muted hover:text-fg narrow:hidden", mode !== "page" && "pl-1")} onClick={toProject}>
            {group !== undefined ? (
              <span className="flex items-center gap-1" title="A group task: it plans the work of the group's projects">
                <Folder size={12} /> {group}
              </span>
            ) : profileScratch ? (
              <span title="A scratch task: in no project, on its profile's board">{profileName}</span>
            ) : assistant ? (
              <span title="The profile's assistant: in no project, and off the board">{profileName}</span>
            ) : routine ? (
              <span title="A routine's run of the profile's assistant: back to the assistant">{profileName}'s assistant</span>
            ) : (
              project?.name
            )}
          </button>
          <ChevronRight size={12} className="shrink-0 text-faint narrow:hidden" />
          <AgentIcon task={task} />
          <span className="-ml-1 shrink-0 font-mono text-[12px] text-faint">{key}</span>
          {scratch && (
            <span className="shrink-0 text-[11.5px]">
              <TaskTypeBadge type="scratch" />
            </span>
          )}
          <TitleEditor key={task.id} task={task} onError={setMarkErr} />
          {canMark && (
            <span className="no-drag -ml-1 shrink-0">
              <StarButton task={task} onError={setMarkErr} />
            </span>
          )}
          <div className="no-drag ml-auto flex shrink-0 items-center gap-2">
            {wide && controls}
            {narrow && run}
            {mode !== "page" && <PanelButtons mode={mode} />}
          </div>
        </div>
        {/* A phone's row scrolls sideways, with the tabs first (and Start or Stop in the row above), fading out at the edge. */}
        {!wide && (
          <div className="no-drag flex flex-wrap items-center gap-2 px-3 pb-2 narrow:flex-nowrap narrow:overflow-x-auto narrow:pr-4 narrow:[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] narrow:[scrollbar-width:none] narrow:*:shrink-0">
            {controls}
          </div>
        )}
        {markErr && (
          <div className="no-drag flex items-start gap-1 px-3 pb-2 text-[11.5px] text-red-400">
            <span className="min-w-0 flex-1">{markErr}</span>
            <IconButton className="h-5 w-5" title="Dismiss" onClick={() => setMarkErr(null)}>
              <X size={12} />
            </IconButton>
          </div>
        )}
      </header>
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1">
          <TabContent task={task} project={project} mode={mode} tab={tab} shown={shown} docShown={docShown} onShowThread={() => setTab("thread")} />
        </main>
        {/* A document, and the changes' panels, get the room. */}
        {wide && !docShown && shown !== "changes" && (
          <Details key={task.id} task={task} mode={mode} className="w-[320px] shrink-0 overflow-y-auto border-l border-line bg-panel/40" />
        )}
      </div>
    </div>
  )
}
