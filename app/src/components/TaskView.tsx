import clsx from "clsx";
import { ChevronLeft, ChevronRight, Clock, Copy, Folder, GitBranch, GitCompareArrows, Hourglass, Kanban, Layers, Loader2, Maximize2, Minimize2, Pin, Play, Square, Trash2, X } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, ApiError, canRunAgents, dependencyQueued, limitQueued, outOfUsage, documentsOnly, hostStatuses, isScratch, isSummaryThread, LABELS, LABELS_API, ownWorkDir, taskLabels, type DocumentType, hostSupports, mergeAwaitsApproval, mergeQueued, rejoinsMerge, runningAgentSteers, stopTitle, worktreesOn, type Effort, type Resolution, type Status, type Task, type TerminalTool } from "../api";
import { boardTaskUrl, closeTask, groupTaskUrl, href, navigate, openCompare, openTask, profileTaskUrl, setPanelExpanded, subprojectTaskUrl, type Panel } from "../router";
import { isGroupTask, keyPrefix, profileNameOf, taskConfig, taskKey, useAvailableConfigs, useHost, useProfileName, useProject, useStore } from "../store";
import { AgentBadge, ConfigSelect, ConfigUsageNote, configDir } from "./ClaudeConfigs";
import { COMPARE_API, harnessLabels, useConfigsOf, useFanout } from "./Fanout";
import { effortOptions, inheritedModel, useAgentModels } from "../agents";
import { useNarrow } from "../narrow";
import { resetsPhrase, resetTime } from "../usageConfigs";
import { useOpenTools } from "../terminalTools";
import { openingTab } from "../openingTab";
import { useSubagentView } from "../subagents";
import { AgentsPill } from "./AgentsPill";
import { AgentIcon } from "./AgentIcon";
import { ContextPill } from "./Context";
import { inGroupTaskGroup } from "../projectGroups";
import { GroupTaskBadge, openSubprojectBoard, SubprojectBadge, useCreatedProgress, useSubprojectProgress } from "./TaskCard";
import { documentInfo, DocumentView, LABEL_INFO, TaskTypeBadge } from "./Document";
import { ChangeSummaryView, ReviewDot, reviewParts, ReviewSummary } from "./Review";
import { Dependencies } from "./Dependencies";
import { useConfirmDone } from "./ConfirmDone";
import { ReminderButton, saveMarks, StarButton, useCanMark } from "./Reminders";
import { Thread, Markdown } from "./Thread";
import { splitAttachments } from "../attachments";
import { AttachmentList } from "./Attachments";
import { LinkedTasks, LINKS_API, usesAsana } from "./ExternalLinks";
import { ActivityTime, Ago, Button, ConfirmModal, cost, ErrorBox, errorText, IconButton, Input, PrIcon, PreviewDot, RESOLUTION_LABELS, RunningDot, showsPreview, waitTitle, StatusIcon, SUBMIT_KEYS, Textarea, Toggle, isSubmitShortcut, useDraft } from "./ui";

// xterm is large; load it with the first terminal.
const TerminalPane = lazy(() => import("./Terminal").then((m) => ({ default: m.TerminalPane })));
const ChangesView = lazy(() => import("./Changes").then((m) => ({ default: m.ChangesView })));

const NO_TOOLS: TerminalTool[] = [];

// What empty threads show. The same elements every time, so the (memoized) thread doesn't redraw for them.
const NOT_STARTED = (
  <div className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">
    No agent has worked on this yet. Press <span className="text-fg">Start</span> or send instructions below; the task description is included
    automatically.
  </div>
);
const NO_REVIEW = <div className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">No review has run yet.</div>;
const NO_SUMMARY = <div className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">No summary has been written yet.</div>;

/**
 * "thread", "changes", "review", "summary", "terminal", "details" (when too narrow for them beside the thread),
 * `tool:<id>` for a terminal tool, or for a plan, artifact or diagram task its type, for its document.
 */
type Tab = string;

const isLabel = (t: Tab): t is DocumentType => LABELS.includes(t as DocumentType);
const toolTab = (id: string) => `tool:${id}`;
/** A terminal or a terminal tool: shown expanded, without the details column. */
const isTerminalTab = (t: Tab) => t === "terminal" || t.startsWith("tool:");
/** "page": the whole screen. "panel": beside the board. "expanded": a dialog over it. */
type Mode = "page" | "panel" | "expanded";

// Below this width the details move from a column beside the thread into their own tab, and the
// header's controls into a second row.
const WIDE = 880;

/** Whether the element is at least WIDE (taken as wide until measured, but for the narrow layout), followed as it
 * resizes, and whether it has been measured. Use the returned ref on it. */
function useWide() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const narrow = useNarrow();
  useLayoutEffect(() => {
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width === null ? !narrow : width >= WIDE, width !== null] as const;
}

/** A task beside the board, taking half the width, or expanded into a dialog over it; in the narrow layout, over the whole screen. */
export function TaskPanel({ panel }: { panel: Panel }) {
  const narrow = useNarrow();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Leave Escape to whatever is being typed in, and to an open dialog.
      if ((e.target as Element).closest?.("input, textarea, select, [contenteditable]") || document.querySelector("[data-modal]")) return;
      closeTask();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // A click outside the side panel closes it (the expanded dialog has its own backdrop for that),
  // unless that would throw away something unsaved in it: fields holding one are marked `data-draft`.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (panel.expanded || narrow) return;
    const inside = (e: Event) => ref.current?.contains(e.target as Node) ?? true;
    // Pressed outside with no dialog open (a dialog's backdrop closes just the dialog) and no draft.
    let down: string | null = null;
    const onDown = (e: MouseEvent) => {
      const keep = document.querySelector("[data-modal]") || ref.current?.querySelector("[data-draft]");
      down = e.button === 0 && !inside(e) && !keep ? window.location.href : null;
    };
    const onClick = (e: MouseEvent) => {
      const from = down;
      down = null;
      if (from === null || inside(e)) return;
      // Left to what the click did: opening another task or page, or a dialog, or selecting text.
      if (window.location.href !== from || document.querySelector("[data-modal]") || !window.getSelection()?.isCollapsed) return;
      closeTask();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("click", onClick);
    };
  }, [panel.expanded, narrow]);
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
  );
}

/** Expand into a dialog or back into the side panel, and close. The narrow layout has a back button instead. */
function PanelButtons({ expanded }: { expanded: boolean }) {
  if (useNarrow()) return null;
  return (
    <div className="no-drag flex shrink-0 items-center gap-0.5">
      <IconButton title={expanded ? "Collapse into the side panel" : "Expand"} onClick={() => setPanelExpanded(!expanded)}>
        {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      </IconButton>
      <IconButton title="Close (Esc)" onClick={() => closeTask()}>
        <X size={16} />
      </IconButton>
    </div>
  );
}

export function TaskView({ taskId, mode = "page" }: { taskId: string; mode?: Mode }) {
  const task = useStore((s) => s.tasks[taskId]);
  const loaded = useStore((s) => s.loaded);
  const project = useProject(task?.project_id);
  const host = useHost(task?.host_id);
  const subproject = useSubproject(task);
  const profileName = useProfileName(task);
  const progress = useSubprojectProgress(taskId);
  const agents = canRunAgents(host);
  const settings = useStore((s) => (task ? s.hostSettings[task.host_id] : undefined));
  const tools = (hostSupports(host, 13) && settings?.terminal_tools) || NO_TOOLS;
  const openIds = useOpenTools(useShallow((s) => s.open.filter((o) => o.taskId === taskId && o.hostId === task?.host_id).map((o) => o.toolId)));
  const { openTool, closeTool } = useOpenTools.getState();
  const [rootRef, wide, measured] = useWide();
  const narrow = useNarrow();
  const canMark = useCanMark(task);
  const [markErr, setMarkErr] = useState<string | null>(null);
  useEffect(() => setMarkErr(null), [taskId]);
  // A subagent's thread stays shown while the task is open: closing it (or opening another) goes back to the main thread.
  useEffect(() => () => useSubagentView.getState().show(taskId, null), [taskId]);
  const [tab, setTab] = useState<Tab>(() => openingTab(task));
  // Terminals are mounted from their first visit on, so switching tabs keeps the connection.
  const [mounted, setMounted] = useState<Tab[]>([]);
  useEffect(() => {
    if (isTerminalTab(tab) && !mounted.includes(tab)) setMounted((m) => [...m, tab]);
  }, [tab, mounted]);
  // The opening tab is picked when the task opens (or once it's loaded), not again as its status moves on.
  const found = !!task;
  useEffect(() => {
    setTab(openingTab(useStore.getState().tasks[taskId]));
    setMounted([]);
  }, [taskId, found]);
  // Wide enough for the details column: their tab is gone, and the thread shows instead. Not
  // dropped before the width is known, so a task opening on its details keeps that tab when narrow.
  useEffect(() => {
    if (measured && wide && tab === "details") setTab("thread");
  }, [measured, wide, tab]);
  // A tool taken out of the host's settings: end what's left of it. Only against the host's
  // own current list: while it's disconnected (or doesn't report one) its tools aren't gone.
  const hostTools = hostSupports(host, 13) && host?.connected ? settings?.terminal_tools : undefined;
  useEffect(() => {
    if (!task || !Array.isArray(hostTools)) return;
    for (const id of openIds)
      if (!hostTools.some((t) => t.id === id)) {
        api.killTerminal(task.host_id, task.id, id).catch(() => {});
        closeTool({ hostId: task.host_id, taskId: task.id, toolId: id });
      }
  }, [task, hostTools, openIds, closeTool]);

  if (!task)
    return (
      <div className="flex h-full flex-col">
        {mode !== "page" && (
          <div className="flex h-12 shrink-0 items-center justify-end px-3">
            <PanelButtons expanded={mode === "expanded"} />
          </div>
        )}
        <div className="p-8 text-muted">{loaded ? "Task not found." : "Loading task…"}</div>
      </div>
    );
  if (task.kind === "review") return <ReviewThreadView thread={task} mode={mode} />;
  // A group or scratch task works in no repository, so it has no changes of its own; nor does one
  // that makes only its documents. Each of a task's labels has a tab for its document, first.
  const group = isGroupTask(task) ? task.group_name! : undefined;
  const scratch = isScratch(task);
  // One in no project is on its profile's board (a scratch task can be in a project since API 51).
  const profileScratch = scratch && !task.project_id;
  const labels = taskLabels(task);
  const docsOnly = documentsOnly(task);
  const tabs: Tab[] = [...labels, ...(group || scratch || docsOnly ? ["thread"] : ["thread", "changes"])];
  const reviews = hostSupports(host, 12) && task.kind === "task" && !group && !docsOnly && !scratch;
  if (reviews) tabs.push("review");
  // Once there's a summary, or a review that passed to summarise (API 84): the tabs fit a phone's width until then.
  const summaries = reviews && hostSupports(host, 84) && (!!task.summary || task.review?.state === "passed");
  if (summaries) tabs.push("summary");
  if (hostSupports(host, 7)) tabs.push("terminal");
  if (!wide) tabs.push("details");
  // Until the effect above drops it, a details tab while wide shows the thread beside the column.
  // A label taken off shows the thread instead.
  const shown = (wide && tab === "details") || (tab === "review" && !reviews) || (tab === "summary" && !summaries) || (isLabel(tab) && !labels.includes(tab)) ? "thread" : tab;
  const docShown = labels.find((l) => l === shown);
  const key = `${keyPrefix(task, project)}-${task.number}`;
  // Stopping the task also stops its review (API 33), so it can be stopped while only that runs.
  const reviewing = task.review?.state === "running" && hostSupports(host, 33);
  // A terminal needs the room: from the side panel it expands into the dialog.
  const selectTab = (t: Tab) => {
    if (isTerminalTab(t) && mode === "panel") setPanelExpanded(true);
    setTab(t);
  };
  const showTool = (t: TerminalTool) => {
    openTool({ hostId: task.host_id, taskId: task.id, toolId: t.id });
    selectTab(toolTab(t.id));
  };
  const endTool = (t: TerminalTool) => {
    api.killTerminal(task.host_id, task.id, t.id).catch(() => {});
    closeTool({ hostId: task.host_id, taskId: task.id, toolId: t.id });
    setMounted((m) => m.filter((x) => x !== toolTab(t.id)));
    if (tab === toolTab(t.id)) setTab("thread");
  };
  // From another board (a group's or profile's), its own board opens with this task still beside it.
  const toProject = () => {
    if (group) navigate(mode === "page" ? href({ name: "group", hostId: task.host_id, group }) : groupTaskUrl(task.host_id, group, task.id));
    else if (profileScratch && profileName) navigate(mode === "page" ? href({ name: "profile", profile: profileName }) : profileTaskUrl(profileName, task.id));
    else if (project) navigate(mode === "page" ? href({ name: "board", projectId: project.id }) : boardTaskUrl(project.id, task.id));
  };

  // Errors show under the header, with the marks'.
  const stop = () => {
    setMarkErr(null);
    api.stop(task.host_id, task.id).catch((e) => setMarkErr(`Couldn't stop the agent: ${(e as Error).message}`));
  };

  // A subproject's task: its subproject's board, with this task still beside it.
  const toSubproject = () => subproject && navigate(mode === "page" ? href({ name: "subproject", taskId: subproject.id }) : subprojectTaskUrl(subproject.id, task.id));

  // Starts or stops the agent: last of the controls, or on a phone in the title row, where it isn't scrolled off with them.
  const run =
    task.running || reviewing ? (
      <Button size="sm" onClick={stop} title={task.running ? stopTitle(task, runningAgentSteers(host, task)) : "Stop the review"}>
        <Square size={11} fill="currentColor" /> Stop
      </Button>
    ) : dependencyQueued(task) ? (
      <span className="flex items-center gap-1 text-[12px] text-muted" title="Its agent starts once the tasks it depends on are merged">
        <Clock size={12} /> Queued
      </span>
    ) : (
      !task.session_id &&
      agents && (
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setMarkErr(null);
            api.send(task.host_id, task.id, "").catch((e) => setMarkErr(`Couldn't start the agent: ${(e as Error).message}`));
            setTab("thread");
          }}
        >
          <Play size={12} fill="currentColor" /> Start
        </Button>
      )
    );

  const controls = (
    <>
      {task.subproject && (
        <Button size="sm" onClick={() => openSubprojectBoard(task)} title="The subproject's board of tasks">
          <Kanban size={13} /> Board
          {progress ? (
            <span className="text-[11px] text-faint">
              {progress.done}/{progress.total}
            </span>
          ) : null}
        </Button>
      )}
      {canMark && <ReminderButton task={task} onError={setMarkErr} />}
      <AgentsPill task={task} onReveal={() => setTab("thread")} />
      <ContextPill task={task} />
      <div className="flex items-center gap-1 rounded-lg border border-line bg-panel p-0.5 narrow:order-first">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => selectTab(t)}
            className={clsx("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] capitalize narrow:py-1.5", shown === t ? "bg-raised text-fg" : "text-muted hover:text-fg")}
          >
            {t === "review" && <ReviewDot task={task} />}
            {t}
          </button>
        ))}
      </div>
      {hostSupports(host, 7) && tools.length > 0 && (
        <div className="flex items-center gap-1 rounded-lg border border-line bg-panel p-0.5" title="Terminal tools (Settings → host)">
          {tools.map((t) => (
            <button
              key={t.id}
              onClick={() => showTool(t)}
              title={openIds.includes(t.id) ? `${t.command} (open)` : `Open ${t.command} in a terminal`}
              className={clsx(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[12px]",
                tab === toolTab(t.id) ? "bg-raised text-fg" : "text-muted hover:text-fg",
              )}
            >
              {openIds.includes(t.id) && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
              {t.name}
            </button>
          ))}
        </div>
      )}
      {!narrow && run}
    </>
  );

  // A subproject's task goes back to the subproject's board.
  const back = () =>
    subproject
      ? toSubproject()
      : project
        ? navigate({ name: "board", projectId: project.id })
        : group
          ? navigate({ name: "group", hostId: task.host_id, group })
          : profileScratch && profileName
            ? navigate({ name: "profile", profile: profileName })
            : history.back();

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <header className={clsx("shrink-0 border-b border-line", mode === "page" && "drag")}>
        <div className="flex h-12 items-center gap-2 px-3">
          {(mode === "page" || narrow) && (
            <IconButton className="no-drag narrow:-ml-1.5" title="Back" onClick={mode === "page" ? back : () => closeTask()}>
              <ChevronLeft size={narrow ? 20 : 16} />
            </IconButton>
          )}
          <button className={clsx("no-drag shrink-0 text-[12.5px] text-muted hover:text-fg narrow:hidden", mode !== "page" && "pl-1")} onClick={toProject}>
            {group ? (
              <span className="flex items-center gap-1" title="A group task: it plans the work of the group's projects">
                <Folder size={12} /> {group}
              </span>
            ) : profileScratch ? (
              <span title="A scratch task: in no project, on its profile's board">{profileName}</span>
            ) : (
              project?.name
            )}
          </button>
          <ChevronRight size={12} className="shrink-0 text-faint narrow:hidden" />
          {subproject && (
            <>
              <button
                className="no-drag flex shrink-0 items-center gap-1 font-mono text-[12px] text-faint hover:text-fg narrow:hidden"
                title={subproject.title}
                onClick={toSubproject}
              >
                <Layers size={12} className="text-accent" />
                {project?.key ?? "T"}-{subproject.number}
              </button>
              <ChevronRight size={12} className="shrink-0 text-faint narrow:hidden" />
            </>
          )}
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
            {mode !== "page" && <PanelButtons expanded={mode === "expanded"} />}
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
          {mounted.includes("terminal") && (
            <div className={clsx("h-full", tab !== "terminal" && "hidden")}>
              <Suspense fallback={null}>
                <TerminalPane task={task} active={tab === "terminal"} />
              </Suspense>
            </div>
          )}
          {tools
            .filter((t) => openIds.includes(t.id) && mounted.includes(toolTab(t.id)))
            .map((t) => (
              <div key={t.id} className={clsx("h-full", tab !== toolTab(t.id) && "hidden")}>
                <Suspense fallback={null}>
                  <TerminalPane task={task} tool={t} active={tab === toolTab(t.id)} onClose={() => endTool(t)} />
                </Suspense>
              </div>
            ))}
          {shown === "thread" ? (
            <Thread
              key={`${task.host_id}:${task.id}`}
              task={task}
              cwd={task.worktree_path ?? ownWorkDir(task) ?? project?.repo_path}
              empty={NOT_STARTED}
            />
          ) : docShown ? (
            <DocumentView key={`${task.id}:${docShown}`} task={task} label={docShown} onShowThread={() => setTab("thread")} />
          ) : tab === "changes" ? (
            <Suspense fallback={null}>
              <ChangesView task={task} />
            </Suspense>
          ) : shown === "review" ? (
            <div className="h-full overflow-y-auto">
              <div className="mx-auto max-w-3xl px-5 py-5">
                <ReviewSummary task={task} />
              </div>
            </div>
          ) : shown === "summary" ? (
            <div className="h-full overflow-y-auto">
              <div className="mx-auto max-w-3xl px-5 py-5">
                <ChangeSummaryView task={task} />
              </div>
            </div>
          ) : shown === "details" ? (
            <Details key={task.id} task={task} mode={mode} className="h-full overflow-y-auto" />
          ) : null}
        </main>
        {/* A document, and the changes' panels, get the room. */}
        {wide && !isTerminalTab(tab) && !docShown && shown !== "changes" && (
          <Details key={task.id} task={task} mode={mode} className="w-[320px] shrink-0 overflow-y-auto border-l border-line bg-panel/40" />
        )}
      </div>
    </div>
  );
}

/** The subproject a task belongs to, if any. */
function useSubproject(task: Task | undefined) {
  return useStore((s) => {
    const p = task?.kind === "task" && task.parent_id ? s.tasks[task.parent_id] : undefined;
    return p?.subproject ? p : undefined;
  });
}

/** A review thread: the reviewer's conversation, beside the review it's working on. */
function ReviewThreadView({ thread, mode }: { thread: Task; mode: Mode }) {
  const parent = useStore((s) => (thread.parent_id ? s.tasks[thread.parent_id] : undefined));
  const project = useProject(thread.project_id);
  const [rootRef, wide] = useWide();
  const key = parent && `${project?.key ?? "T"}-${parent.number}`;
  // Which of the task's reviewers this is, when it has several. A summary thread summarises its changes instead (API 84).
  const reviewer = parent?.review && reviewParts(parent.review).find((p) => p.thread_id === thread.id)?.label;
  const summary = isSummaryThread(thread);
  const back = () => (parent ? openTask(parent.id) : project ? navigate({ name: "board", projectId: project.id }) : history.back());
  const [stopErr, setStopErr] = useState<string | null>(null);
  useEffect(() => setStopErr(null), [thread.id]);
  const stop = () => {
    setStopErr(null);
    api.stop(thread.host_id, thread.id).catch((e) => setStopErr(`Couldn't stop the reviewer: ${(e as Error).message}`));
  };
  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <header className={clsx("flex h-12 shrink-0 items-center gap-2 border-b border-line px-3", mode === "page" && "drag")}>
        <IconButton className="no-drag narrow:-ml-1.5" title="Back" onClick={back}>
          <ChevronLeft size={16} />
        </IconButton>
        <button className="no-drag shrink-0 text-[12.5px] text-muted hover:text-fg narrow:hidden" onClick={() => project && navigate({ name: "board", projectId: project.id })}>
          {project?.name}
        </button>
        <ChevronRight size={12} className="shrink-0 text-faint narrow:hidden" />
        {parent && (
          <>
            <button className="no-drag shrink-0 font-mono text-[12px] text-faint hover:text-fg" onClick={back}>
              {key}
            </button>
            <ChevronRight size={12} className="shrink-0 text-faint" />
          </>
        )}
        <h1 className="min-w-0 truncate text-[13.5px] font-medium">
          {summary ? (
            "Summary"
          ) : (
            <>Review{reviewer && parent?.review?.reviewers && parent.review.reviewers.length > 1 && <span className="font-normal text-muted"> · {reviewer}</span>}</>
          )}
        </h1>
        <div className="no-drag ml-auto flex items-center gap-2">
          <AgentsPill task={thread} />
          <ContextPill task={thread} />
          {thread.running && (
            <Button size="sm" onClick={stop}>
              <Square size={11} fill="currentColor" /> Stop
            </Button>
          )}
          {mode !== "page" && <PanelButtons expanded={mode === "expanded"} />}
        </div>
      </header>
      {stopErr && (
        <div className="flex shrink-0 items-start gap-1 border-b border-line px-3 py-2 text-[11.5px] text-red-400">
          <span className="min-w-0 flex-1">{stopErr}</span>
          <IconButton className="h-5 w-5" title="Dismiss" onClick={() => setStopErr(null)}>
            <X size={12} />
          </IconButton>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1">
          <Thread
            key={`${thread.host_id}:${thread.id}`}
            task={thread}
            cwd={parent?.worktree_path ?? project?.repo_path}
            placeholder={summary ? "Ask about the changes…" : "Ask the reviewer about its findings…"}
            empty={summary ? NO_SUMMARY : NO_REVIEW}
          />
        </main>
        {parent && wide && (
          <aside className="w-[320px] shrink-0 overflow-y-auto border-l border-line bg-panel/40">
            <Section title={summary ? "Summarising" : "Reviewing"}>
              <button className="text-left text-[13px] text-fg hover:underline" onClick={back}>
                <span className="mr-1.5 font-mono text-[12px] text-faint">{key}</span>
                {parent.title}
              </button>
              {parent.branch && (
                <div className="mt-1.5 flex items-center gap-1 font-mono text-[11.5px] text-muted">
                  <GitBranch size={11} className="shrink-0" />
                  <span className="truncate">{parent.branch}</span>
                </div>
              )}
            </Section>
            {summary ? (
              <Section title="Latest summary">
                <ChangeSummaryView task={parent} />
              </Section>
            ) : (
              <Section title="Latest review">
                <ReviewSummary task={parent} threadId={thread.id} />
              </Section>
            )}
            <Section title={summary ? "Summarizer" : "Reviewer"}>
              <Row label="Cost">{cost(thread.cost_usd) ?? "—"}</Row>
              <Row label="Session">{thread.session_id ? <span className="font-mono text-[11px]">{thread.session_id}</span> : "—"}</Row>
            </Section>
          </aside>
        )}
      </div>
    </div>
  );
}

function TitleEditor({ task, onError }: { task: Task; onError: (err: string | null) => void }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(task.title);
  // Kept while it's being edited, so a title that changes meanwhile (re-titled from a message, say) doesn't
  // overwrite what's typed.
  useEffect(() => {
    if (!editing) setV(task.title);
  }, [task.title, editing]);
  if (!editing)
    return (
      <>
        <h1 onDoubleClick={() => setEditing(true)} className="no-drag min-w-0 truncate text-[13.5px] font-medium" title="Double-click to rename">
          {task.title}
        </h1>
        {task.title_pinned && (
          <button
            className="no-drag -ml-1 shrink-0 rounded p-0.5 text-faint hover:bg-raised hover:text-fg"
            title="Renamed by hand, so it keeps this title. Click to let the title follow your messages again."
            aria-label="Unpin title"
            onClick={() => {
              onError(null);
              api.updateTask(task.host_id, task.id, { title_pinned: false }).catch((e) => onError(`Couldn't unpin the title: ${errorText(e)}`));
            }}
          >
            <Pin size={12} />
          </button>
        )}
      </>
    );
  const save = () => {
    setEditing(false);
    const typed = v;
    if (!typed.trim() || typed === task.title) return;
    onError(null);
    api.updateTask(task.host_id, task.id, { title: typed.trim() }).catch((e) => {
      // Back to editing what was typed, to try again.
      setV(typed);
      setEditing(true);
      onError(`Couldn't rename the task: ${errorText(e)}`);
    });
  };
  return (
    <Input
      autoFocus
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") setEditing(false);
      }}
      className="no-drag h-7 max-w-md"
    />
  );
}

/** The task's title in its details, to rename by hand, and whether it follows the task's messages. */
function TitleSection({ task }: { task: Task }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(task.title);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Kept while it's being edited, as in the header's editor.
  useEffect(() => {
    if (!editing) setV(task.title);
  }, [task.title, editing]);
  const save = () => {
    const typed = v.trim();
    if (!typed || busy) return;
    if (typed === task.title) return setEditing(false);
    setBusy(true);
    setErr(null);
    api
      .updateTask(task.host_id, task.id, { title: typed })
      .then(() => setEditing(false))
      .catch((e) => setErr(`Couldn't rename the task: ${errorText(e)}`))
      .finally(() => setBusy(false));
  };
  const unpin = () => {
    setErr(null);
    api.updateTask(task.host_id, task.id, { title_pinned: false }).catch((e) => setErr(`Couldn't unpin the title: ${errorText(e)}`));
  };
  return (
    <Section
      title="Title"
      right={
        !editing && (
          <button className="text-[11.5px] text-faint hover:text-fg" onClick={() => (setV(task.title), setErr(null), setEditing(true))}>
            Edit
          </button>
        )
      }
    >
      {editing ? (
        <div className="space-y-2" data-draft={v !== task.title || undefined}>
          <Input
            autoFocus
            aria-label="Title"
            value={v}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.preventDefault(), save());
              if (e.key === "Escape") (e.stopPropagation(), setEditing(false));
            }}
          />
          {err && <div className="rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => (setErr(null), setEditing(false))}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={busy || !v.trim()} onClick={save}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="text-[13px] break-words text-fg">{task.title}</div>
          {task.title_pinned && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-faint">
              <Pin size={11} className="shrink-0" />
              <span className="min-w-0 flex-1">Set by hand, so it doesn't follow your messages.</span>
              <button className="shrink-0 hover:text-fg" onClick={unpin}>
                Unpin
              </button>
            </div>
          )}
          {err && <div className="mt-2 rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
        </>
      )}
    </Section>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-4">
      <div className="mb-2.5 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wide text-faint uppercase">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1 text-[12.5px]">
      <span className="w-20 shrink-0 text-faint">{label}</span>
      <span className="min-w-0 flex-1 break-words text-muted">{children}</span>
    </div>
  );
}

function Details({ task, mode, className }: { task: Task; mode: Mode; className: string }) {
  const project = useProject(task.project_id);
  // A group task has no repository, so nothing to review, merge or depend on. A plan, artifact or
  // diagram has no branch to merge either.
  const groupTask = isGroupTask(task);
  const docsOnly = documentsOnly(task);
  // A scratch task has no repository either.
  const scratch = isScratch(task);
  const hostCount = useStore((s) => s.hosts.length);
  const host = useStore((s) => s.hosts.find((h) => h.id === task.host_id));
  const asana = usesAsana(useStore((s) => s.profiles.find((p) => p.host_id === task.host_id && p.id === task.profile_id)));
  const hostEffort = useStore((s) => s.hostSettings[task.host_id]?.default_effort);
  const threadConfig = useThreadConfig(task).current;
  const models = useAgentModels(threadConfig);
  const [editingDesc, setEditingDesc] = useState(false);
  const [desc, setDesc] = useState(task.description);
  const [wtBusy, setWtBusy] = useState(false);
  // What went wrong with each part, until it's tried again.
  const [errs, setErrs] = useState<Partial<Record<"worktree" | "status" | "preview" | "pr" | "desc" | "agent", string>>>({});
  const setErr = (part: keyof typeof errs, msg: string | null) => setErrs((e) => ({ ...e, [part]: msg ?? undefined }));
  const [teardown, setTeardown] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The description as it was when editing started: if it changes meanwhile, the edit stays, and says so.
  const [descBase, setDescBase] = useState(task.description);
  useEffect(() => {
    if (!editingDesc) setDesc(task.description);
  }, [task.description, editingDesc]);
  const editDesc = () => {
    setDesc(task.description);
    setDescBase(task.description);
    setErr("desc", null);
    setEditingDesc(true);
  };
  const saveDesc = () => {
    setErr("desc", null);
    api
      .updateTask(task.host_id, task.id, { description: desc })
      .then(() => setEditingDesc(false))
      .catch((e) => setErr("desc", `Couldn't save the description: ${(e as Error).message}`));
  };

  const { confirmDone, dialog: doneDialog } = useConfirmDone();
  const setStatus = async (status: Status) => {
    setErr("status", null);
    if (status === "done" && !(await confirmDone(task))) return;
    try {
      await api.updateTask(task.host_id, task.id, { status });
      // Into "In progress" from the list, as from a drop on the board: a fresh task's agent starts (where one can run).
      if (status === "in_progress" && task.status !== "in_progress" && !task.session_id && !task.running && canRunAgents(host)) {
        await api.send(task.host_id, task.id, "");
      }
    } catch (e) {
      setErr("status", (e as Error).message);
    }
  };
  const setResolution = (resolution: Resolution) => {
    setErr("status", null);
    api.updateTask(task.host_id, task.id, { resolution }).catch((e) => setErr("status", e.message));
  };
  const run = async (fn: () => Promise<unknown>) => {
    setWtBusy(true);
    setErr("worktree", null);
    try {
      await fn();
    } catch (e) {
      setErr("worktree", (e as Error).message);
    } finally {
      setWtBusy(false);
    }
  };

  return (
    <aside className={className}>
      <Section title="Status">
        <div className="grid grid-cols-1 gap-0.5">
          {hostStatuses(host).map((s) => (
            <button
              key={s.id}
              onClick={() => setStatus(s.id)}
              className={clsx(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px]",
                task.status === s.id ? "bg-raised text-fg" : "text-muted hover:bg-white/[0.03] hover:text-fg",
              )}
            >
              <StatusIcon status={s.id} size={13} /> {s.label}
              {task.status === s.id && task.running && <RunningDot className="ml-auto" />}
            </button>
          ))}
        </div>
        {task.status === "done" && hostSupports(host, 19) && (
          <div className="mt-2 flex items-center gap-2 text-[12px]">
            <span className="text-faint">Resolution</span>
            <div className="ml-auto flex items-center rounded-md border border-line p-0.5">
              {(Object.keys(RESOLUTION_LABELS) as Resolution[]).map((r) => (
                <button
                  key={r}
                  onClick={() => setResolution(r)}
                  className={clsx(
                    "inline-flex h-6 items-center rounded px-2 text-xs font-medium transition-colors",
                    (task.resolution ?? "done") === r ? "bg-raised text-fg" : "text-muted hover:text-fg",
                  )}
                >
                  {RESOLUTION_LABELS[r]}
                </button>
              ))}
            </div>
          </div>
        )}
        {mergeQueued(task) && (
          <div className="mt-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] text-muted">
            Queued to merge. Another task in this project is merging; this one starts when it's done.
          </div>
        )}
        {mergeAwaitsApproval(task) && (
          <div className="mt-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] text-muted">
            {task.running
              ? "The merge waits for your approval. Its agent is summarizing what will be merged; then you're asked to approve or deny it in its thread."
              : "The merge waits for your approval: approve or deny it in its thread. Its agent can't merge until you approve."}
          </div>
        )}
        {rejoinsMerge(task) && (
          <div className="mt-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] text-muted">
            Stepped out of the merge queue to make changes, so the tasks behind it could merge. It rejoins the end of the queue when its
            agent is done, unless you move it to another column first.
          </div>
        )}
        {dependencyQueued(task) && (
          <div className="mt-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] text-muted">
            Queued. Its agent starts once the tasks it depends on are merged.
          </div>
        )}
        {task.attention_reason && (
          <div className="mt-2 rounded-md bg-st-attention/[0.08] px-2.5 py-2 text-[12px] text-amber-200/90">{task.attention_reason}</div>
        )}
        <UsageLimitNote task={task} onError={(e) => setErr("status", e)} />
        {task.remind_at && (
          <div className="mt-2 flex items-start gap-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] text-muted">
            <span className="min-w-0 flex-1">
              Reminder {new Date(task.remind_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
              {task.reminder && <span className="block text-fg">{task.reminder}</span>}
            </span>
            <button className="shrink-0 text-faint hover:text-fg" onClick={() => saveMarks(task, { remind_at: null }).catch((e) => setErr("status", (e as Error).message))}>
              Clear
            </button>
          </div>
        )}
        {errs.status && <div className="mt-2 rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{errs.status}</div>}
      </Section>

      <TitleSection task={task} />

      <Section
        title="Description"
        right={
          !editingDesc && (
            <button className="text-[11.5px] text-faint hover:text-fg" onClick={editDesc}>
              Edit
            </button>
          )
        }
      >
        {editingDesc ? (
          <div className="space-y-2" data-draft={desc !== task.description || undefined}>
            <Textarea
              rows={10}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              onKeyDown={(e) => {
                if (!isSubmitShortcut(e)) return;
                e.preventDefault();
                saveDesc();
              }}
              autoFocus
            />
            {task.description !== descBase && (
              <div className="text-[11.5px] text-amber-200/90">It was changed while you were editing it: saving replaces that change.</div>
            )}
            {errs.desc && <div className="rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{errs.desc}</div>}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => (setDesc(task.description), setErr("desc", null), setEditingDesc(false))}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" onClick={saveDesc}>
                Save <span className="font-normal text-white/60 touch:hidden">{SUBMIT_KEYS}</span>
              </Button>
            </div>
          </div>
        ) : task.description.trim() ? (
          <Description text={task.description} hostId={task.host_id} />
        ) : (
          <div className="text-[12.5px] text-faint">No description.</div>
        )}
      </Section>

      {/* With Asana turned off for the profile, only to show (and unlink) the links it has. */}
      {hostSupports(host, LINKS_API) && task.kind === "task" && (asana || !!task.external_links?.length) && (
        <Section title="Asana">
          <LinkedTasks task={task} canLink={asana} />
        </Section>
      )}

      {task.fanout_id && <FanoutSection task={task} />}

      {(groupTask || taskLabels(task).includes("plan")) && <CreatedTasksSection task={task} />}

      {task.kind === "task" && (hostSupports(host, LABELS_API) || taskLabels(task).length > 0) && <LabelsSection task={task} />}

      {scratch && (
        <Section title="Scratch">
          <div className="space-y-1">
            <div className="text-[12.5px] text-muted">
              {task.project_id
                ? `Its agent works in the task's own folder, with no worktree, and reads the repository${task.parent_id ? " and the subproject's worktree" : ""}.`
                : `In no project: its agent works in ${task.work_dir ? "this folder" : "the task's own folder"}, with no repository.`}
            </div>
            {task.work_dir && (
              <Row label="Folder">
                <span className="font-mono text-[11px] break-all">{task.work_dir}</span>
              </Row>
            )}
          </div>
        </Section>
      )}

      {hostSupports(host, 24) && task.kind === "task" && !groupTask && !scratch && (
        <Section title="Depends on">
          <Dependencies task={task} project={project} />
        </Section>
      )}

      {hostSupports(host, 8) && (
        <Section title="Preview" right={showsPreview(task) && <PreviewDot url={task.preview_url!} label className="text-[11.5px] text-faint" />}>
          <TextInput
            value={task.preview_url ?? null}
            placeholder="https://… (where to try this task)"
            onSave={(url) => {
              setErr("preview", null);
              api.updateTask(task.host_id, task.id, { preview_url: url || null }).catch((e) => setErr("preview", e.message));
            }}
          />
          {errs.preview && <div className="mt-2 rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{errs.preview}</div>}
        </Section>
      )}

      {hostSupports(host, 26) && task.kind === "task" && !groupTask && !docsOnly && !scratch && (
        <Section title="Pull request" right={task.pr_url && <PrIcon url={task.pr_url} label className="text-[11.5px] text-faint" />}>
          <TextInput
            value={task.pr_url ?? null}
            placeholder="https://… (found with gh once the agent opens one)"
            onSave={(url) => {
              setErr("pr", null);
              api.updateTask(task.host_id, task.id, { pr_url: url || null }).catch((e) => setErr("pr", e.message));
            }}
          />
          {errs.pr && <div className="mt-2 rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{errs.pr}</div>}
        </Section>
      )}

      {hostSupports(host, 17) && task.kind === "task" && !groupTask && !docsOnly && !scratch && <SubprojectSection task={task} />}

      {!groupTask && !docsOnly && !scratch && (
        <Section title="Worktree">
          {!task.use_worktree && task.worktree_state === "none" ? (
            <div className="space-y-2">
              <div className="text-[12.5px] text-muted">Runs directly in the project repository.</div>
              {project?.use_worktrees !== undefined && project.is_git !== false && (
                <Toggle checked={false} onChange={(v) => api.updateTask(task.host_id, task.id, { use_worktree: v }).catch((e) => setErr("worktree", e.message))} label="Use a worktree" />
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <Row label="State">
                <span
                  className={clsx(
                    task.worktree_state === "ready" && "text-emerald-300",
                    task.worktree_state === "error" && "text-red-300",
                    (task.worktree_state === "setting_up" || task.worktree_state === "tearing_down") && "text-st-progress",
                  )}
                >
                  {task.worktree_state === "none"
                    ? task.branch
                      ? "removed (set up again on the next run)"
                      : "not created (created on first run)"
                    : task.worktree_state.replace("_", " ")}
                </span>
              </Row>
              {task.branch && (
                <Row label="Branch">
                  <span className="font-mono text-[11.5px] break-all">
                    <GitBranch size={11} className="mr-1 inline align-[-1px]" />
                    {task.branch}
                  </span>
                </Row>
              )}
              {task.base_branch && (
                <Row label="Base">
                  <span className="font-mono text-[11.5px]">{task.base_branch}</span>
                </Row>
              )}
              {task.worktree_path && (
                <Row label="Path">
                  <span className="group flex items-start gap-1 font-mono text-[11px]">
                    <span className="break-all">{task.worktree_path}</span>
                    <button className="shrink-0 text-faint hover:text-fg" onClick={() => navigator.clipboard?.writeText(task.worktree_path!)} title="Copy path">
                      <Copy size={11} />
                    </button>
                  </span>
                </Row>
              )}
              {task.worktree_error && <div className="rounded bg-red-500/10 p-2 font-mono text-[11px] whitespace-pre-wrap text-red-300">{task.worktree_error}</div>}
              <div className="flex flex-wrap gap-2 pt-2">
                {task.worktree_state !== "ready" && (
                  <Button size="sm" disabled={wtBusy || task.running} onClick={() => run(() => api.setupWorktree(task.host_id, task.id))}>
                    {wtBusy ? <Loader2 size={12} className="animate-spin" /> : null} Set up
                  </Button>
                )}
                {task.worktree_state === "ready" && (
                  <Button size="sm" disabled={wtBusy || task.running} onClick={() => setTeardown(true)}>
                    Tear down…
                  </Button>
                )}
                {task.worktree_state === "none" && (
                  <Button size="sm" variant="ghost" onClick={() => api.updateTask(task.host_id, task.id, { use_worktree: false }).catch((e) => setErr("worktree", e.message))}>
                    Don't use a worktree
                  </Button>
                )}
              </div>
            </div>
          )}
          {errs.worktree && <div className="mt-2 rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{errs.worktree}</div>}
        </Section>
      )}

      <Section title="Agent">
        {hostCount > 1 && <Row label="Host">{host?.name ?? task.host_id.slice(0, 8)}</Row>}
        <Row label="Session">{task.session_id ? <span className="font-mono text-[11px]">{task.session_id}</span> : "—"}</Row>
        {task.running && task.run_started_at && (
          <Row label="Working">
            <ActivityTime task={task} />
          </Row>
        )}
        {task.running && task.agent_wait && <Row label="Waiting">{waitTitle(task.agent_wait)}</Row>}
        <Row label="Cost">{cost(task.cost_usd) ?? "—"}</Row>
        {hostSupports(host, 20) && <ConfigRow task={task} />}
        <Row label="Model">
          <TextInput
            value={task.model}
            placeholder={inheritedModel(threadConfig, models, project?.model) || "default"}
            onSave={(m) => {
              setErr("agent", null);
              api.updateTask(task.host_id, task.id, { model: m || null }).catch((e) => setErr("agent", `Couldn't change the model: ${errorText(e)}`));
            }}
          />
        </Row>
        {hostSupports(host, 14) && (
          <Row label="Effort">
            <select
              className="h-6 rounded border border-line bg-panel px-1 text-[12px] text-fg outline-none"
              value={task.effort ?? ""}
              onChange={(e) => {
                setErr("agent", null);
                api
                  .updateTask(task.host_id, task.id, { effort: (e.target.value || null) as Effort | null })
                  .catch((err) => setErr("agent", `Couldn't change the effort: ${errorText(err)}`));
              }}
            >
              <option value="">{hostEffort ? `default (${hostEffort})` : "default"}</option>
              {[...new Set([...effortOptions(threadConfig, models, task.model ?? ""), ...(task.effort ? [task.effort] : [])])].map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </Row>
        )}
        {task.auto_allow.length > 0 && <Row label="Allowed">{task.auto_allow.join(", ")}</Row>}
        <Row label="Created">
          <Ago at={task.created_at} />
        </Row>
        {errs.agent && <ErrorBox className="mt-2">{errs.agent}</ErrorBox>}
      </Section>

      <div className="px-4 py-4">
        <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
          <Trash2 size={12} /> Delete task
        </Button>
      </div>

      {teardown && <TeardownModal task={task} onClose={() => setTeardown(false)} />}
      {confirmDelete && <DeleteTaskModal task={task} mode={mode} onClose={() => setConfirmDelete(false)} />}
      {doneDialog}
    </aside>
  );
}

/**
 * A task held until its config's usage limit resets, or one whose agent ran out of usage, which can wait for the reset
 * (API 81). After the reset, sending a message carries on.
 */
function UsageLimitNote({ task, onError }: { task: Task; onError: (e: string | null) => void }) {
  const { current } = useThreadConfig(task);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const at = task.limit_reset_at;
  useEffect(() => {
    if (!at) return;
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, [at]);
  if (!at) return null;
  const name = current?.name ?? "Its config";
  const when = `${resetsPhrase(at, now)} (${resetTime(at)})`;
  if (limitQueued(task)) {
    return (
      <div className="mt-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] text-muted" data-usage-limit="waiting">
        Waiting for {name}'s usage limit to reset: it {when}. Its agent carries on then, with any message you queue.
      </div>
    );
  }
  if (!outOfUsage(task, now)) return null;
  const wait = async () => {
    setBusy(true);
    onError(null);
    try {
      await api.waitForLimit(task.host_id, task.id);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 flex items-start gap-2 rounded-md bg-white/[0.03] px-2.5 py-2 text-[12px] text-muted" data-usage-limit="out">
      <span className="min-w-0 flex-1">
        {name} is out of usage; it {when}.
        {/* Waiting in In progress would give up its merge slot, so another merge could start alongside it. */}
        {task.merging && " Its merge keeps its place in the merge queue: message its agent once it has reset to carry on."}
      </span>
      {!task.merging && (
        <Button size="sm" variant="ghost" className="-my-1 shrink-0" disabled={busy} onClick={wait} title="Wait in In progress, and carry on once the limit resets">
          Carry on then
        </Button>
      )}
    </div>
  );
}

/** The config a thread runs with (or will), and the ones it could pick. */
function useThreadConfig(task: Task) {
  const project = useProject(task.project_id);
  const available = useAvailableConfigs(task.host_id, task.profile_id, project);
  const current = useStore((s) => taskConfig(s, task));
  return { current, available };
}

/** The thread's agent config, which can change until its agent first starts. */
function ConfigRow({ task }: { task: Task }) {
  const { current, available } = useThreadConfig(task);
  const [err, setErr] = useState<string | null>(null);
  const options = current && !available.some((c) => c.id === current.id) ? [current, ...available] : available;
  const canChange = !task.session_id && !task.running && options.length > 1;
  if (!current) return task.session_id ? <Row label="Config">Claude's default config</Row> : null;
  return (
    <Row label="Config">
      {canChange ? (
        <ConfigSelect
          className="h-6 rounded border border-line bg-panel px-1 text-[12px] text-fg outline-none"
          configs={options}
          value={current.id}
          onChange={(id) => {
            setErr(null);
            api.updateTask(task.host_id, task.id, { claude_config_id: id }).catch((e) => setErr(e.message));
          }}
        />
      ) : (
        <span className="flex items-center gap-1.5" title={configDir(current)}>
          {current.name}
          <AgentBadge config={current} />
        </span>
      )}
      <ConfigUsageNote config={current} className="mt-0.5" />
      {err && <div className="text-[11.5px] text-red-400">{err}</div>}
    </Row>
  );
}

/** The tasks made from the same prompt (IA-227), with what each runs with, to compare them. */
function FanoutSection({ task }: { task: Task }) {
  const tasks = useFanout(task);
  const projects = useStore((s) => s.projects);
  const configs = useConfigsOf(tasks);
  const compares = hostSupports(useHost(task.host_id), COMPARE_API);
  if (tasks.length < 2) return null;
  const labels = harnessLabels(tasks, configs);
  return (
    <Section
      title="Same prompt"
      right={
        compares && (
          <button className="flex items-center gap-1 text-[11.5px] text-faint hover:text-fg" onClick={() => openCompare(task.id)} title="Compare their work side by side, and pick one">
            <GitCompareArrows size={12} /> Compare all {tasks.length}
          </button>
        )
      }
    >
      <div className="-mx-1 space-y-0.5">
        {tasks.map((t, i) => (
          <button
            key={t.id}
            className={clsx("flex w-full items-center gap-2 rounded px-1 py-1 text-left text-[12.5px] hover:bg-raised", t.id === task.id && "bg-raised")}
            onClick={() => openTask(t.id)}
            title={t.title}
          >
            <StatusIcon status={t.status} />
            <span className="shrink-0 font-mono text-[11px] text-faint">{taskKey(t, projects)}</span>
            <span className="min-w-0 flex-1 truncate text-fg">{labels[i]}</span>
            {t.running && (t.agent_wait ? <Hourglass size={11} className="shrink-0 text-muted" /> : <RunningDot />)}
            {cost(t.cost_usd) && <span className="shrink-0 text-[11px] text-faint">{cost(t.cost_usd)}</span>}
          </button>
        ))}
      </div>
    </Section>
  );
}

/**
 * The tasks a group task's agent created: in the group's projects, then any elsewhere. For a plan
 * (in a project), the tasks its agent broke it into.
 */
function CreatedTasksSection({ task }: { task: Task }) {
  const all = useStore((s) => s.tasks);
  const projects = useStore((s) => s.projects);
  const progress = useCreatedProgress()[task.id];
  const groupTask = isGroupTask(task);
  const [inGroup, elsewhere] = useMemo(() => {
    const created = Object.values(all)
      .filter((t) => t.kind === "task" && t.host_id === task.host_id && t.created_by === task.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const own = groupTask ? created.filter((t) => inGroupTaskGroup(t, task, projects)) : created;
    return [own, created.filter((t) => !own.includes(t))];
  }, [all, projects, task, groupTask]);
  const list = (ts: Task[]) => (
    <div className="-mx-1 space-y-0.5">
      {ts.map((t) => (
        <button key={t.id} className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-[12.5px] hover:bg-raised" onClick={() => openTask(t.id)}>
          <StatusIcon status={t.status} />
          <span className="shrink-0 font-mono text-[11px] text-faint">{taskKey(t, projects)}</span>
          <span className="min-w-0 flex-1 truncate text-fg">{t.title}</span>
          {t.running && (t.agent_wait ? <Hourglass size={11} className="shrink-0 text-muted" /> : <RunningDot />)}
        </button>
      ))}
    </div>
  );
  return (
    <Section title="Tasks" right={<span className="text-[11.5px]">{groupTask ? <GroupTaskBadge progress={progress} /> : <TaskTypeBadge type="plan" progress={progress} />}</span>}>
      {inGroup.length === 0 ? (
        <div className="text-[12.5px] text-muted">
          {groupTask ? "None yet. Its agent plans the work and creates tasks in the group's projects." : "None yet. Once you're happy with the plan, ask its agent to break it into tasks."}
        </div>
      ) : (
        list(inGroup)
      )}
      {elsewhere.length > 0 && (
        <>
          <div className="mt-2 mb-0.5 text-[11.5px] text-faint" title="Tasks its agent created outside the group's projects. They don't count towards its progress.">
            Outside the group
          </div>
          {list(elsewhere)}
        </>
      )}
    </Section>
  );
}

/** A task's labels, each a document its agent writes besides its other work, shown in a tab of the task: to add and
 *  take off (API 71), and where the agent writes them. */
function LabelsSection({ task }: { task: Task }) {
  const host = useHost(task.host_id);
  const labels = taskLabels(task);
  // On an older host they're the task's type, which stays.
  const editable = hostSupports(host, LABELS_API);
  const docsOnly = documentsOnly(task);
  const [err, setErr] = useState<string | null>(null);
  const [files, setFiles] = useState<Partial<Record<DocumentType, string>>>({});
  const shown = labels.join(",");
  useEffect(() => {
    let live = true;
    for (const l of shown ? (shown.split(",") as DocumentType[]) : [])
      api
        .document(task.host_id, task.id, l)
        .then((d) => live && d.file && setFiles((f) => ({ ...f, [l]: d.file! })))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [task.host_id, task.id, shown]);
  const toggle = (l: DocumentType) => {
    setErr(null);
    const next = labels.includes(l) ? labels.filter((x) => x !== l) : LABELS.filter((x) => x === l || labels.includes(x));
    api.updateTask(task.host_id, task.id, { labels: next }).catch((e) => setErr(`Couldn't change the labels: ${(e as Error).message}`));
  };
  const where = isGroupTask(task) ? "group's repositories" : "project's repository";
  return (
    <Section title="Labels">
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1">
          {(editable ? LABEL_INFO : LABEL_INFO.filter((i) => labels.includes(i.id))).map((i) => {
            const on = labels.includes(i.id);
            return (
              <button
                key={i.id}
                disabled={!editable}
                onClick={() => toggle(i.id)}
                aria-pressed={on}
                title={editable ? `${on ? "Take off" : "Add"} the ${i.label.toLowerCase()} label: ${i.hint}` : i.hint}
                className={clsx(
                  "flex h-6 items-center gap-1 rounded-md border px-2 text-[12px]",
                  on ? "border-accent/50 bg-accent/10 text-accent" : "border-line text-muted hover:border-line-strong hover:text-fg",
                  !editable && "cursor-default",
                )}
              >
                {i.icon} {i.label}
              </button>
            );
          })}
        </div>
        <div className="text-[12.5px] text-muted">
          {docsOnly
            ? `Rather than changing code, its agent writes ${labels.length ? "a document for each label" : "a document for each label it's given"} in the task's own folder, reading the ${where}.`
            : labels.length
              ? "Besides its other work, its agent writes a document for each label in the task's own folder, shown in a tab here."
              : "A label has its agent write a document besides its other work: a plan to agree on first, an artifact or a diagram, each shown in a tab here."}{" "}
          {labels.length > 0 && "The board keeps a version from each turn."}
          {editable && task.running && " A label changed while its agent works reaches it the next time it starts."}
        </div>
        {labels.map(
          (l) =>
            files[l] && (
              <Row key={l} label={documentInfo(l).label}>
                <span className="group flex items-start gap-1 font-mono text-[11px]">
                  <span className="break-all">{files[l]}</span>
                  <button className="shrink-0 text-faint hover:text-fg" onClick={() => navigator.clipboard?.writeText(files[l]!)} title="Copy path">
                    <Copy size={11} />
                  </button>
                </span>
              </Row>
            ),
        )}
        {err && <div className="rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
      </div>
    </Section>
  );
}

function SubprojectSection({ task }: { task: Task }) {
  const subproject = useSubproject(task);
  const progress = useSubprojectProgress(task.id);
  const project = useProject(task.project_id);
  const [err, setErr] = useState<string | null>(null);
  const set = (on: boolean) => {
    setErr(null);
    api.updateTask(task.host_id, task.id, { subproject: on }).catch((e) => setErr(e.message));
  };
  if (subproject)
    return (
      <Section title="Subproject">
        <button className="text-left text-[13px] text-fg hover:underline" onClick={() => navigate({ name: "subproject", taskId: subproject.id })}>
          <span className="mr-1.5 font-mono text-[12px] text-faint">
            {project?.key ?? "T"}-{subproject.number}
          </span>
          {subproject.title}
        </button>
        <div className="mt-1.5 text-[12px] text-muted">
          Branches from {subproject.branch ? <span className="font-mono text-[11.5px]">{subproject.branch}</span> : "the subproject's branch"} and merges back into
          it.
        </div>
      </Section>
    );
  // Only a top-level task in a project with worktrees can be one.
  if (!(project && worktreesOn(project)) && !task.subproject) return null;
  return (
    <Section title="Subproject" right={task.subproject && <SubprojectBadge progress={progress} />}>
      {task.subproject ? (
        <div className="space-y-2">
          <div className="text-[12.5px] text-muted">
            Its tasks branch from {task.branch ? <span className="font-mono text-[11.5px]">{task.branch}</span> : "its branch"} and merge back into it. The
            subproject is then merged as a whole.
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => navigate({ name: "subproject", taskId: task.id })}>
              <Kanban size={12} /> Open board
            </Button>
            {!progress?.total && (
              <Button size="sm" variant="ghost" onClick={() => set(false)}>
                Make it a plain task
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-[12.5px] text-muted">Split this task into its own board of smaller tasks, which merge into this task's branch.</div>
          <Button size="sm" onClick={() => set(true)}>
            <Layers size={12} /> Make it a subproject
          </Button>
        </div>
      )}
      {err && <div className="mt-2 rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
    </Section>
  );
}

/**
 * A field saved when it loses focus. It follows the task's value only while it's neither focused nor changed, so a
 * value the agent sets meanwhile doesn't overwrite what's being typed (and isn't written back over with the old one).
 */
function TextInput({ value, placeholder, onSave }: { value: string | null; placeholder: string; onSave: (v: string) => void }) {
  const [focused, setFocused] = useState(false);
  const { draft: v, setDraft: setV, dirty } = useDraft(value ?? "", focused);
  return (
    <Input
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (!dirty) return;
        setV(v.trim());
        onSave(v.trim());
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="h-7 text-[12px]"
    />
  );
}

function TeardownModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const [force, setForce] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  return (
    <ConfirmModal
      title="Tear down worktree"
      width="max-w-lg"
      body={
        <>
          <p>
            Runs the project's teardown script, then removes the worktree directory. The branch <span className="font-mono text-fg">{task.branch}</span> is
            kept unless you delete it, so the agent can pick up where it left off later.
          </p>
          <Toggle checked={force} onChange={setForce} label="Discard uncommitted changes" />
          <Toggle checked={deleteBranch} onChange={setDeleteBranch} label="Also delete the branch" />
        </>
      }
      action="Tear down"
      danger
      onConfirm={() => api.teardownWorktree(task.host_id, task.id, { force, delete_branch: deleteBranch })}
      onClose={onClose}
    />
  );
}

function DeleteTaskModal({ task, mode, onClose }: { task: Task; mode: Mode; onClose: () => void }) {
  const [deleteBranch, setDeleteBranch] = useState(false);
  const subproject = useSubproject(task);
  const children = useSubprojectProgress(task.id)?.total ?? 0;
  const go = async () => {
    const pid = task.project_id;
    // Gone already (deleted from another window, say) is as good as deleted.
    await api.deleteTask(task.host_id, task.id, deleteBranch).catch((e) => {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    });
    if (mode !== "page") closeTask(true);
    else if (subproject) navigate({ name: "subproject", taskId: subproject.id }, true);
    else if (pid) navigate({ name: "board", projectId: pid }, true);
    else if (isGroupTask(task)) navigate({ name: "group", hostId: task.host_id, group: task.group_name! }, true);
    else {
      const profile = profileNameOf(useStore.getState(), task);
      if (profile) navigate({ name: "profile", profile }, true);
    }
  };
  return (
    <ConfirmModal
      title="Delete task"
      width="max-w-lg"
      body={
        <>
          <p>
            This stops any running agent, deletes the thread, and removes its worktree, discarding any uncommitted changes.
            {task.subproject && children > 0 && (
              <span className="text-amber-200/90">
                {" "}
                Its {children} task{children === 1 ? "" : "s"} {children === 1 ? "is" : "are"} deleted the same way.
              </span>
            )}
          </p>
          {task.branch && (
            <Toggle
              checked={deleteBranch}
              onChange={setDeleteBranch}
              label={task.subproject && children > 0 ? `Also delete branch ${task.branch} and its tasks' branches` : `Also delete branch ${task.branch}`}
            />
          )}
        </>
      }
      action="Delete"
      danger
      onConfirm={go}
      onClose={onClose}
    />
  );
}

/** A task's description, with the files attached to it shown rather than listed. */
function Description({ text, hostId }: { text: string; hostId: string }) {
  const { text: body, files } = useMemo(() => splitAttachments(text), [text]);
  return (
    <div className="text-[12.5px]">
      <Markdown text={body} />
      <AttachmentList hostId={hostId} files={files} className={clsx(body && "mt-2")} />
    </div>
  );
}
