import clsx from "clsx";
import { ChevronLeft, ChevronRight, Clock, Folder, Kanban, Layers, Play, Square, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, canRunAgents, dependencyQueued, documentsOnly, hasApprovalRules, hasBrief, hasMemory, hasRoutines, isAssistant, isRoutine, isScratch, LABELS, taskLabels, type DocumentType, hostSupports, runningAgentSteers, stopTitle, type TerminalTool } from "../../api";
import { boardTaskUrl, closeTask, groupTaskUrl, href, navigate, profileTaskUrl, setPanelExpanded, subprojectTaskUrl, type Panel } from "../../router";
import { isGroupTask, keyPrefix, useHost, useProfileName, useProject, useStore } from "../../store";
import { useNarrow } from "../../narrow";
import { useOpenTools } from "../../terminalTools";
import { openingTab } from "./openingTab";
import { useSubagentView } from "../../subagents";
import { AgentsPill } from "../layout/AgentsPill";
import { AgentIcon } from "../ui/AgentIcon";
import { ContextPill } from "./Context";
import { openSubprojectBoard, useSubprojectProgress } from "../board/TaskCard";
import { TaskTypeBadge } from "./Document";
import { ReviewDot } from "./Review";
import { ReminderButton, StarButton, useCanMark } from "./Reminders";
import { Button, IconButton } from "../ui";
import { Details } from "./view/details/Details";
import { useSubproject } from "./view/hooks";
import { PanelButtons, useWide, type Mode, type Tab } from "./view/layout";
import { ReviewThreadView } from "./view/ReviewThreadView";
import { TabContent } from "./view/TabContent";
import { TitleEditor } from "./view/Title";

// xterm is large; load it with the first terminal.
const TerminalPane = lazy(() => import("./Terminal").then((m) => ({ default: m.TerminalPane })));

const NO_TOOLS: TerminalTool[] = [];

const isLabel = (t: Tab): t is DocumentType => LABELS.includes(t as DocumentType);
const toolTab = (id: string) => `tool:${id}`;
/** A terminal or a terminal tool: shown expanded, without the details column. */
const isTerminalTab = (t: Tab) => t === "terminal" || t.startsWith("tool:");

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
  // A thread off every list the board loads (a routine's run of the assistant, API 101) is fetched by itself, from the
  // hosts that have them, when it's opened by its link.
  const [seeking, setSeeking] = useState(false);
  useEffect(() => {
    if (found || !loaded) return;
    const hosts = useStore.getState().hosts.filter((h) => h.connected && hasRoutines(h));
    if (!hosts.length) return;
    let live = true;
    setSeeking(true);
    Promise.allSettled(
      hosts.map((h) => api.task(h.id, taskId).then((d) => live && d.task && useStore.getState().upsertTask({ ...d.task, host_id: h.id }))),
    ).then(() => live && setSeeking(false));
    return () => {
      live = false;
    };
  }, [taskId, found, loaded]);
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
        <div className="p-8 text-muted">{loaded && !seeking ? "Task not found." : "Loading task…"}</div>
      </div>
    );
  if (task.kind === "review") return <ReviewThreadView thread={task} mode={mode} />;
  // A group or scratch task works in no repository, so it has no changes of its own; nor does one
  // that makes only its documents. Each of a task's labels has a tab for its document, first.
  const group = isGroupTask(task) ? task.group_name! : undefined;
  const scratch = isScratch(task);
  // The profile's assistant: no repository either, and it opens on a page of its own. Its routines' threads work in
  // its workspace, with no repository.
  const assistant = isAssistant(task);
  const routine = isRoutine(task);
  // One in no project is on its profile's board (a scratch task can be in a project since API 51).
  const profileScratch = scratch && !task.project_id;
  const labels = taskLabels(task);
  const docsOnly = documentsOnly(task);
  const tabs: Tab[] = [...labels, ...(group || scratch || assistant || routine || docsOnly ? ["thread"] : ["thread", "changes"])];
  // The assistant's morning brief (API 103), its memory files (API 99), and its routines (API 101).
  if (assistant && hasBrief(host)) tabs.push("brief");
  if (assistant && hasMemory(host)) tabs.push("memory");
  if (assistant && hasRoutines(host)) tabs.push("routines");
  const reviews = hostSupports(host, 12) && task.kind === "task" && !group && !docsOnly && !scratch && !assistant && !routine;
  if (reviews) tabs.push("review");
  // Once there's a summary, or a review that passed to summarise (API 84): the tabs fit a phone's width until then.
  const summaries = reviews && hostSupports(host, 84) && (!!task.summary || task.review?.state === "passed");
  if (summaries) tabs.push("summary");
  // The assistant's action log (API 102): what its approval rules asked about or blocked.
  if (assistant && hasApprovalRules(host)) tabs.push("actions");
  if (hostSupports(host, 7)) tabs.push("terminal");
  if (!wide) tabs.push("details");
  // Until the effect above drops it, a details tab while wide shows the thread beside the column.
  // A label taken off shows the thread instead.
  const shown = (wide && tab === "details") || (tab === "memory" && !tabs.includes("memory")) || (tab === "brief" && !tabs.includes("brief")) || (tab === "review" && !reviews) || (tab === "summary" && !summaries) || (isLabel(tab) && !labels.includes(tab)) ? "thread" : tab;
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
    else if (assistant && profileName) navigate({ name: "profile", profile: profileName });
    else if (routine && profileName) navigate({ name: "assistant", profile: profileName });
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
      agents &&
      !assistant &&
      !routine && (
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
          : (profileScratch || assistant) && profileName
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
            ) : assistant ? (
              <span title="The profile's assistant: in no project, and off the board">{profileName}</span>
            ) : routine ? (
              <span title="A routine's run of the profile's assistant: back to the assistant">{profileName}'s assistant</span>
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
          <TabContent task={task} project={project} mode={mode} tab={tab} shown={shown} docShown={docShown} onShowThread={() => setTab("thread")} />
        </main>
        {/* A document, and the changes' panels, get the room. */}
        {wide && !isTerminalTab(tab) && !docShown && shown !== "changes" && shown !== "memory" && shown !== "brief" && (
          <Details key={task.id} task={task} mode={mode} className="w-[320px] shrink-0 overflow-y-auto border-l border-line bg-panel/40" />
        )}
      </div>
    </div>
  );
}
