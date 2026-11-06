import clsx from "clsx";
import { AlertTriangle, CheckCircle2, CircleSlash, Loader2, MessageSquareText, Play, Square, Workflow as WorkflowIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { api, hostSupports, workflowWaitingAt, type Task, type WorkflowNodeRun, type WorkflowRun } from "../../api";
import { openTask } from "../../router";
import { onWorkflowsChanged, useHost } from "../../store";
import { Button, timeAgo } from "../ui";
import { Markdown } from "./thread/Markdown";

/** The host version from which tasks have workflows (HA-173). */
export const WORKFLOWS_API = 107;

/** A task panel tab for a workflow step's output: `wf:` and the tab's name. */
export const workflowTab = (label: string) => `wf:${label}`;
export const isWorkflowTab = (t: string) => t.startsWith("wf:");

interface TaskWorkflows {
  runs: WorkflowRun[];
  workflows: { id: string; name: string; enabled: boolean }[];
}

/** Each open task's workflow runs, by `host:task`, read again when they change. */
const useRuns = create<{ byTask: Record<string, TaskWorkflows | undefined> }>(() => ({ byTask: {} }));
const loading = new Set<string>();
/** How many components show each task's runs: only those are read again on an event. */
const watching = new Map<string, number>();

function load(hostId: string, taskId: string) {
  const key = `${hostId}:${taskId}`;
  if (loading.has(key)) return;
  loading.add(key);
  api
    .taskWorkflowRuns(hostId, taskId)
    .then((d) => useRuns.setState((s) => ({ byTask: { ...s.byTask, [key]: d } })))
    .catch(() => {})
    .finally(() => loading.delete(key));
}

onWorkflowsChanged((hostId, { taskId, projectId }) => {
  for (const key of watching.keys()) {
    const [h, t] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    if (h !== hostId) continue;
    // A workflow added, changed or deleted changes the list to run by hand (and a deletion, the runs).
    if (t === taskId || projectId) load(h, t);
  }
});

/** The task's latest workflow runs and its project's workflows, or undefined until they're read (or on an older host). */
export function useWorkflowRuns(task: Task | undefined): TaskWorkflows | undefined {
  const host = useHost(task?.host_id);
  const on = !!task && task.kind === "task" && !!task.project_id && hostSupports(host, WORKFLOWS_API);
  const key = task ? `${task.host_id}:${task.id}` : "";
  useEffect(() => {
    if (!on) return;
    watching.set(key, (watching.get(key) ?? 0) + 1);
    load(task!.host_id, task!.id);
    return () => {
      const n = (watching.get(key) ?? 1) - 1;
      if (n > 0) watching.set(key, n);
      else watching.delete(key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, key]);
  return useRuns((s) => (on ? s.byTask[key] : undefined));
}

/** The tabs the task's workflow steps show their output in, in the order their workflows' graphs have them. */
export function workflowTabs(data: TaskWorkflows | undefined): string[] {
  const out: string[] = [];
  for (const r of [...(data?.runs ?? [])].reverse())
    for (const n of r.graph.nodes) {
      // A step its run skipped (e.g. the summary after a review that found issues) adds no tab.
      const state = r.nodes[n.id]?.state;
      if (n.kind === "agent" && n.tab && state && state !== "skipped" && !out.includes(n.tab)) out.push(n.tab);
    }
  return out;
}

/** Whether any of the task's workflows is running, which Stop stops too. */
export const workflowRunning = (data: TaskWorkflows | undefined) => !!data?.runs.some((r) => r.state === "running");

/** What a step's state reads as, e.g. "Running…" or "Found issues". */
function stepState(r: WorkflowNodeRun): { text: string; icon: React.ReactNode; tone: string } {
  switch (r.state) {
    case "running":
      return { text: r.verdict ? "Finishing…" : "Running…", icon: <Loader2 size={12} className="animate-spin" />, tone: "text-st-review" };
    case "done":
      if (r.port === "issues") return { text: "Found issues", icon: <AlertTriangle size={12} />, tone: "text-st-attention" };
      return { text: r.port === "pass" ? "Passed" : "Done", icon: <CheckCircle2 size={12} />, tone: "text-emerald-400" };
    case "failed":
      return { text: "Failed", icon: <AlertTriangle size={12} />, tone: "text-red-400" };
    case "stopped":
      return { text: "Stopped", icon: <CircleSlash size={12} />, tone: "text-faint" };
    case "skipped":
      return { text: "Skipped", icon: <CircleSlash size={12} />, tone: "text-faint" };
    default:
      return { text: "Waiting", icon: <CircleSlash size={12} />, tone: "text-faint" };
  }
}

/** A run's state as a line, e.g. "Running · started 3 min ago". */
function runLine(r: WorkflowRun) {
  const how = r.source === "manual" ? "run by hand" : "started";
  const state = r.state === "running" ? "Running" : r.state === "stopped" ? "Stopped" : "Finished";
  return `${state} · ${how} ${timeAgo(r.created_at)}${r.head ? ` on ${r.head.slice(0, 7)}` : ""}`;
}

/** A workflow tab: the output of each step that shows in it, from the latest run of each workflow, with how it went. */
export function WorkflowTabView({ task, label }: { task: Task; label: string }) {
  const data = useWorkflowRuns(task);
  if (!data) return <div className="text-[12.5px] text-muted">Loading…</div>;
  // Each step from its workflow's latest run that ran it (a run from one column skips the steps after another), or
  // else its latest. Runs come newest first, with earlier ones for such steps from API 123.
  const shown = new Map<string, string[]>();
  const placed = new Set<string>();
  const ran = (r: WorkflowRun, id: string) => !!r.nodes[id] && r.nodes[id].state !== "pending" && r.nodes[id].state !== "skipped";
  for (const r of data.runs) {
    for (const n of r.graph.nodes) {
      const key = `${r.workflow_id}|${n.id}`;
      if (n.kind !== "agent" || n.tab !== label || !r.nodes[n.id] || placed.has(key)) continue;
      const pick = data.runs.find((x) => x.workflow_id === r.workflow_id && ran(x, n.id)) ?? r;
      placed.add(key);
      shown.set(pick.id, [...(shown.get(pick.id) ?? []), n.id]);
    }
  }
  const runs = data.runs.filter((r) => shown.has(r.id));
  if (!runs.length) return <div className="text-[12.5px] text-muted">Nothing here yet: a workflow's steps show their output here once they run.</div>;
  return (
    <div className="space-y-5 text-[12.5px]">
      {runs.map((r) => (
        <RunBlock key={r.id} task={task} run={r} label={label} only={shown.get(r.id)!} />
      ))}
    </div>
  );
}

function RunBlock({ task, run, label, only }: { task: Task; run: WorkflowRun; label: string; only: string[] }) {
  const steps = run.graph.nodes.filter((n) => n.kind === "agent" && n.tab === label && only.includes(n.id));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-faint">
        <WorkflowIcon size={12} />
        <span className="font-medium text-muted">{run.workflow_name ?? "A deleted workflow"}</span>
        <span>· {runLine(run)}</span>
        {run.detail && run.state === "stopped" && <span>· {run.detail}</span>}
        <span className="ml-auto flex gap-1.5">
          {run.state === "running" ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api.stopWorkflowRun(task.host_id, run.id))}>
              <Square size={10} fill="currentColor" /> Stop
            </Button>
          ) : (
            run.workflow_name && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || task.running}
                title={task.running ? "Wait for the agent to finish" : "Run the workflow on this task again"}
                onClick={() => act(() => api.runWorkflow(task.host_id, run.workflow_id, task.id))}
              >
                {busy ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />} Run again
              </Button>
            )
          )}
        </span>
      </div>
      {steps.map((n) => {
        const r = run.nodes[n.id];
        if (!r) return null;
        const st = stepState(r);
        const name = n.kind === "agent" ? n.name : n.id;
        return (
          <div key={n.id} className={clsx("space-y-2", steps.length > 1 && "rounded-md border border-line p-2.5")}>
            <div className={clsx("flex items-center gap-1.5", st.tone)}>
              {st.icon}
              <span>{st.text}</span>
              <span className="font-medium text-fg">· {name}</span>
              {r.label && <span className="text-faint">· {r.label}</span>}
            </div>
            {!!r.issues?.length && r.port !== "pass" && (
              <ol className="list-decimal space-y-1.5 pl-5">
                {r.issues.map((i, k) => (
                  <li key={k}>
                    <Markdown text={i} />
                  </li>
                ))}
              </ol>
            )}
            {r.text && r.state !== "running" && r.state !== "skipped" && (
              <div className={r.state === "done" ? "text-fg" : "text-muted"}>
                <Markdown text={r.text} />
              </div>
            )}
            {r.thread_id && (
              <Button size="sm" variant="ghost" onClick={() => openTask(r.thread_id!)}>
                <MessageSquareText size={12} /> Thread
              </Button>
            )}
          </div>
        );
      })}
      {err && <div className="rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
    </div>
  );
}

/** The task's workflows in its details: how each last ran on it, and Run to run one now. */
export function WorkflowsList({ task }: { task: Task }) {
  const data = useWorkflowRuns(task);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!data?.workflows.length) return null;
  const run = async (id: string) => {
    setBusy(id);
    setErr(null);
    try {
      await api.runWorkflow(task.host_id, id, task.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-1.5 text-[12.5px]">
      {data.workflows.map((w) => {
        const last = data.runs.find((r) => r.workflow_id === w.id);
        return (
          <div key={w.id} className="flex items-center gap-2">
            <span
              className={clsx("min-w-0 flex-1 truncate", w.enabled ? "text-muted" : "text-faint")}
              title={w.enabled ? undefined : "Off: it runs only by hand"}
            >
              {w.name}
            </span>
            {last && (
              <span className="shrink-0 text-[11.5px] text-faint">
                {last.state !== "running" ? timeAgo(last.created_at) : workflowWaitingAt(last) ? "waiting for the agent" : "running"}
              </span>
            )}
            {last?.state === "running" ? (
              <Loader2 size={12} className="animate-spin text-st-review" />
            ) : (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Run ${w.name}`}
                disabled={busy === w.id || task.running}
                title={task.running ? "Wait for the agent to finish" : "Run it on this task now"}
                onClick={() => run(w.id)}
              >
                {busy === w.id ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />} Run
              </Button>
            )}
          </div>
        );
      })}
      {err && <div className="rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
    </div>
  );
}
