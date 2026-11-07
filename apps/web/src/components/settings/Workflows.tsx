import clsx from "clsx";
import {
  ArrowRightLeft,
  Bot,
  Braces,
  ClipboardList,
  Columns3,
  Flag,
  GitFork,
  GitPullRequest,
  Play,
  Plus,
  Rows3,
  ScrollText,
  Send,
  ToggleLeft,
  Trash2,
  Type,
  Unplug,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  api,
  COLUMN_WORKFLOWS_API,
  hostStatuses,
  hostSupports,
  LABELS,
  STATUSES,
  WORKFLOW_CHECKS,
  isDataNode,
  workflowDataInputs,
  workflowDataOutputs,
  workflowPorts,
  workflowWaits,
  workflowWire,
  type Project,
  type Status,
  type Workflow,
  type WorkflowCheck,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeKindName,
} from "../../api";
import { onWorkflowsChanged, useAvailableConfigs, useHost } from "../../store";
import type { Reviewer } from "../../api";
import { ReviewerRow } from "../task/Reviewers";
import { Button, Field, Input, Modal, Textarea, Toggle, useConfirm } from "../ui";
import { GuideLink } from "./Guide";

/** The project settings' Workflows tab: the project's workflows, each a graph of steps that runs on its tasks (API 107). */
export function ProjectWorkflows({ project }: { project: Project }) {
  const hostId = project.host_id;
  const [list, setList] = useState<Workflow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ workflow: Workflow | null; name: string; graph: WorkflowGraph } | null>(null);
  const reload = useCallback(
    () =>
      api.workflows(hostId, project.id).then(
        (r) => {
          setList(r.workflows);
          setErr(null);
        },
        (e) => setErr((e as Error).message),
      ),
    [hostId, project.id],
  );
  useEffect(() => {
    reload();
    return onWorkflowsChanged((h, { projectId }) => {
      if (h === hostId && projectId === project.id) reload();
    });
  }, [reload, hostId, project.id]);
  const confirm = useConfirm();
  const host = useHost(hostId);
  const columns = hostSupports(host, COLUMN_WORKFLOWS_API);
  const presets = PRESETS.filter((p) => !p.api || hostSupports(host, p.api));
  // A host from before column nodes has a start on a column, and moves.
  const presetGraph = (p: (typeof PRESETS)[number]) => (columns ? p.graph(project) : legacyGraph(p.graph(project)));
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    }
    await reload();
  };
  return (
    <div className="space-y-3" data-testid="workflows">
      {columns ? (
        <p className="text-[12.5px] text-muted">
          A workflow is a task's way across the board. Each <i>column</i> step is a column: when a task enters it, its agent is sent the column's prompt (in In
          progress, that's what the agent starts with), and once that work is done the steps after it run. Those can be checks, agents that read the work in
          threads of their own (or process what the steps before them wrote, with a skill, in a fresh context), pull requests, messages to the task's agent, and
          the next column, which moves the task there. The prompt tells the agent what the board does when it's done. The review and summary in the Review tab
          can be set up as one: start from <i>Review and summarise</i>, or <i>From the Review tab</i> for its reviewers and summarizers, and turn them off
          there. <GuideLink page="workflows">Workflows</GuideLink> in the guide explains each node, its inputs and outputs.
        </p>
      ) : (
        <p className="text-[12.5px] text-muted">
          A workflow starts when a task enters a column, or when you run it from the task. It runs its steps in order: checks, agents that read the work in
          threads of their own and write their output to a tab of the task, messages to the task's agent, and moves to another column.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <Button
            key={p.name}
            size="sm"
            title={p.hint}
            onClick={() => setEditing({ workflow: null, name: p.name === "Blank" ? "" : (p.title ?? p.name), graph: presetGraph(p) })}
          >
            <Plus size={13} /> {p.name === "Blank" ? "New workflow" : p.name}
          </Button>
        ))}
      </div>
      {list && list.length > 0 && (
        <div className="divide-y divide-line/70 rounded-md border border-line/70">
          {list.map((w) => (
            <div key={w.id} className="flex items-center gap-3 px-3 py-2">
              <Toggle checked={w.enabled} onChange={(enabled) => act(() => api.updateWorkflow(hostId, w.id, { enabled }))} label="" />
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing({ workflow: w, name: w.name, graph: w.graph })}>
                <div className={clsx("flex items-center gap-1.5 text-[13px]", !w.enabled && "text-faint")}>
                  <WorkflowIcon size={13} className="shrink-0 text-muted" />
                  <span className="truncate font-medium">{w.name}</span>
                </div>
                <div className="truncate text-[11.5px] text-faint">{graphText(w.graph)}</div>
              </button>
              <Button size="sm" variant="ghost" onClick={() => setEditing({ workflow: w, name: w.name, graph: w.graph })}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title="Delete"
                onClick={() =>
                  confirm.ask({
                    title: `Delete workflow ${w.name}`,
                    body: `Delete the workflow "${w.name}"? Its runs stop, and their output goes from the tasks' tabs.`,
                    action: "Delete workflow",
                    danger: true,
                    onConfirm: () => api.deleteWorkflow(hostId, w.id).then(reload),
                  })
                }
              >
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
        </div>
      )}
      {list && !list.length && <div className="text-[12px] text-faint">No workflows yet.</div>}
      {err && <div className="text-xs text-red-400">{err}</div>}
      {confirm.dialog}
      {editing && (
        <WorkflowEditor
          project={project}
          workflow={editing.workflow}
          initialName={editing.name}
          initialGraph={editing.graph}
          onSaved={reload}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

const statusLabel = (s: string | null | undefined) => STATUSES.find((x) => x.id === s)?.label ?? s ?? "?";

const CHECK_LABELS: Record<WorkflowCheck, string> = {
  changed: "The work changed since its last run",
  has_commits: "The task has commits of its own",
  has_pr: "The task has a pull request",
  task_type: "The task is of a type",
  label: "The task has a label",
};

/** What a workflow does, in a line: its columns (or its start) and steps. */
export function graphText(g: WorkflowGraph) {
  const cols = g.nodes.flatMap((n) => (n.kind === "column" ? [statusLabel(n.status)] : []));
  const t = g.nodes.find((n) => n.kind === "trigger");
  const when = cols.length ? cols.join(" → ") : t?.kind === "trigger" ? triggerText(t) : "Run by hand";
  const steps = g.nodes.flatMap((n) => (n.kind === "agent" ? [n.name] : n.kind === "open_pr" ? ["pull request"] : []));
  return [when, steps.length ? steps.join(", ") : "no agent steps"].join(" · ");
}

/** When a workflow starts. */
function triggerText(t: Extract<WorkflowNode, { kind: "trigger" }>) {
  if (t.on === "status") return `When a task moves to ${statusLabel(t.status)}`;
  return "When run by hand";
}

/** What a column node's `done` waits for. */
function columnText(n: Extract<WorkflowNode, { kind: "column" }>) {
  if (n.status === "ready_for_merge") return n.prompt.trim() ? "Its merge instructions · done once merged" : "Done once merged";
  if (!workflowWaits(n)) return "When a task moves here";
  const until = n.done_when === "finish" ? "until the agent says so" : "until the agent's done";
  return n.prompt.trim() ? `${firstLine(n.prompt)} · ${until}` : `The start prompt · ${until}`;
}

const firstLine = (s: string) => s.trim().split("\n")[0];

/**
 * What the board adds to a column's prompt: how the agent says it's done, and what the board does then (the steps
 * after its done, up to the columns they move the task to), as the host words it (integrations/workflows/engine.ts).
 */
export function doneNote(g: WorkflowGraph, id: string) {
  const node = g.nodes.find((n) => n.id === id);
  if (!node || node.kind !== "column") return "";
  const then: string[] = [];
  const seen = new Set([id]);
  const flow = g.edges.filter((e) => e.input == null);
  let next = flow.filter((e) => e.from === id && e.port === "done").map((e) => e.to);
  while (next.length) {
    const later: string[] = [];
    for (const to of next) {
      if (seen.has(to)) continue;
      seen.add(to);
      const n = g.nodes.find((x) => x.id === to);
      if (!n) continue;
      if (n.kind === "column") {
        then.push(`moves the task to ${statusLabel(n.status)}`);
        continue;
      }
      if (n.kind === "open_pr") then.push("pushes your branch and opens its pull request (so don't open one yourself)");
      else if (n.kind === "agent") then.push(n.output === "verdict" ? `has "${n.name}" review your work` : `has "${n.name}" read your work`);
      else if (n.kind === "send_to_task") then.push("sends you what it found to fix");
      // What happens when it goes well: not after a failure, or a send out of rounds.
      later.push(...flow.filter((e) => e.from === to && e.port !== "failed" && e.port !== "exhausted").map((e) => e.to));
    }
    next = later;
  }
  const list = then.filter((x, i) => then.indexOf(x) === i);
  const finish = node.done_when === "finish";
  if (!list.length && !finish) return "";
  let p = finish
    ? "When the work you were asked for here is complete, call `finish_work`, then end your turn with a summary of what you did. A turn that ends without it leaves the task in Needs attention."
    : "When you're done, end your turn with a summary of what you did.";
  if (list.length) p += ` The board then ${list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`}.`;
  return p;
}

/**
 * A graph of column nodes as a host from before them takes it: a column nothing goes into is a start on it, any other
 * a move to it.
 */
function legacyGraph(g: WorkflowGraph): WorkflowGraph {
  const into = new Set(g.edges.map((e) => e.to));
  const columns = new Set(g.nodes.filter((n) => n.kind === "column").map((n) => n.id));
  return {
    nodes: g.nodes.map((n): WorkflowNode => {
      if (n.kind !== "column") return n;
      const { id, x, y, join } = n;
      return into.has(id)
        ? { id, x, y, ...(join ? { join } : {}), kind: "set_status", status: n.status }
        : { id, x, y, kind: "trigger", on: "status", status: n.status };
    }),
    edges: g.edges.map((e) => (columns.has(e.from) && e.port === "done" ? { ...e, port: "out" } : e)),
  };
}

/** A node's title on the canvas. */
export function nodeTitle(n: WorkflowNode) {
  switch (n.kind) {
    case "trigger":
      return "Start";
    case "condition":
      return "Check";
    case "agent":
      return n.name || "Agent";
    case "send_to_task":
      return "Send to the task's agent";
    case "set_status":
      return "Move the task";
    case "open_pr":
      return "Open a pull request";
    case "column":
      return statusLabel(n.status);
    case "text":
      return "Text";
    case "task":
      return "Task";
    case "project_prompt":
      return "Project prompt";
    case "compose":
      return "Compose";
    case "join":
      return "Join";
    case "switch":
      return "Switch";
  }
}

/** What a node does, under its title. */
export function nodeText(n: WorkflowNode) {
  switch (n.kind) {
    case "trigger":
      return triggerText(n);
    case "condition":
      return n.check === "task_type" || n.check === "label" ? `${CHECK_LABELS[n.check]}: ${n.value ?? "?"}` : CHECK_LABELS[n.check];
    case "agent":
      return `${n.output === "verdict" ? "Pass or issues" : "Writes text"}${n.input_only ? " · from the steps before" : ""}${n.skills?.length ? ` · /${n.skills[0]}` : ""}${n.tab ? ` · ${n.tab} tab` : ""}`;
    case "send_to_task":
      return `${n.message.trim() ? "Its own message" : "The issues found"} · up to ${n.max_rounds} round${n.max_rounds === 1 ? "" : "s"}`;
    case "set_status":
      return `To ${statusLabel(n.status)}`;
    case "open_pr":
      return `${n.draft ? "A draft · " : ""}Pushes the branch`;
    case "column":
      return columnText(n);
    case "text":
      return firstLine(n.text) || "Empty";
    case "task":
      return "Its title, description, branch…";
    case "project_prompt":
      return `The ${n.which} prompt`;
    case "compose":
      return firstLine(n.template) || "An empty template";
    case "join":
      return `${n.count} texts${n.separator === "\\n\\n" || n.separator === "\n\n" ? ", a blank line between" : ""}`;
    case "switch":
      return `${n.check === "task_type" || n.check === "label" ? `${CHECK_LABELS[n.check]}: ${n.value ?? "?"}` : CHECK_LABELS[n.check]}?`;
  }
}

export const KIND_STYLE: Record<WorkflowNodeKindName, { icon: ReactNode; tone: string }> = {
  trigger: { icon: <Play size={12} />, tone: "text-emerald-400" },
  condition: { icon: <GitFork size={12} />, tone: "text-amber-400" },
  agent: { icon: <Bot size={12} />, tone: "text-accent" },
  send_to_task: { icon: <Send size={12} />, tone: "text-sky-400" },
  set_status: { icon: <ArrowRightLeft size={12} />, tone: "text-violet-400" },
  open_pr: { icon: <GitPullRequest size={12} />, tone: "text-teal-400" },
  column: { icon: <Columns3 size={12} />, tone: "text-emerald-400" },
  text: { icon: <Type size={12} />, tone: "text-amber-300" },
  task: { icon: <ClipboardList size={12} />, tone: "text-amber-300" },
  project_prompt: { icon: <ScrollText size={12} />, tone: "text-amber-300" },
  compose: { icon: <Braces size={12} />, tone: "text-amber-300" },
  join: { icon: <Rows3 size={12} />, tone: "text-amber-300" },
  switch: { icon: <ToggleLeft size={12} />, tone: "text-amber-300" },
};

/** What a node's values and inputs are called on the canvas. */
const DATA_LABELS: Record<string, string> = {
  next: "what happens next",
  pr: "pull request",
  in1: "1",
  in2: "2",
  in3: "3",
  in4: "4",
  in5: "5",
  in6: "6",
  in7: "7",
  in8: "8",
};
const dataLabel = (k: string) => DATA_LABELS[k] ?? k;

export const PORT_LABELS: Record<string, string> = {
  out: "then",
  yes: "yes",
  no: "no",
  done: "done",
  failed: "failed",
  pass: "pass",
  issues: "issues",
  exhausted: "out of rounds",
  opened: "opened",
  exists: "had one",
};

const SUMMARY_PROMPT =
  "Summarise what the work on {{task.key}} changed, for someone deciding whether to merge it: what it does and how, what was tested, and anything to check or decide before it's merged. Keep it short, with headings and lists where they help.";

/** The Review tab's reviews and summaries, as a workflow: its reviewers, fix rounds and summarizers. */
function fromReviewSettings(p: Project): WorkflowGraph {
  const reviewers: Reviewer[] = p.reviewers?.length ? p.reviewers : [{ claude_config_id: null, model: null, effort: null }];
  const agent = (r: Reviewer) => ({
    ...(r.claude_config_id ? { claude_config_id: r.claude_config_id } : {}),
    ...(r.model ? { model: r.model } : {}),
    ...(r.effort ? { effort: r.effort } : {}),
    skills: r.skills ?? [],
  });
  const nodes: WorkflowNode[] = [
    { id: "start", kind: "column", status: "in_review", prompt: "", x: 20, y: 120 },
    { id: "changed", kind: "condition", check: "changed", x: 220, y: 120 },
  ];
  const edges: WorkflowEdge[] = [{ from: "start", port: "done", to: "changed" }];
  reviewers.forEach((r, i) => {
    const id = reviewers.length > 1 ? `reviewer${i + 1}` : "reviewer";
    nodes.push({
      id,
      kind: "agent",
      name: reviewers.length > 1 ? `Reviewer ${i + 1}` : "Reviewer",
      prompt: r.prompt ?? "",
      output: "verdict",
      tab: "Review",
      ...agent(r),
      x: 420,
      y: 40 + i * 120,
    });
    edges.push({ from: "changed", port: "yes", to: id }, { from: id, port: "issues", to: "fix" });
  });
  nodes.push({ id: "fix", kind: "send_to_task", message: "", max_rounds: Math.max(1, p.review_rounds ?? 2), x: 640, y: 30 });
  if (p.auto_summary) {
    const summarizers: Reviewer[] = p.summarizers?.length ? p.summarizers : [{ claude_config_id: null, model: null, effort: null }];
    summarizers.forEach((r, i) => {
      const id = summarizers.length > 1 ? `summary${i + 1}` : "summary";
      nodes.push({
        id,
        kind: "agent",
        name: r.name || "Summary",
        prompt: r.prompt || SUMMARY_PROMPT,
        output: "text",
        tab: "Summary",
        ...agent(r),
        x: 640,
        y: 190 + i * 110,
        ...(reviewers.length > 1 ? { join: "all" as const } : {}),
      });
      reviewers.forEach((_, k) => edges.push({ from: reviewers.length > 1 ? `reviewer${k + 1}` : "reviewer", port: "pass", to: id }));
    });
  }
  return { nodes, edges };
}

/**
 * Starting points for a new workflow, drawn with column nodes (`legacyGraph` turns them into starts and moves for a
 * host from before them): `api` is the host's API version they need, `title` the new workflow's name.
 */
const PRESETS: { name: string; title?: string; hint?: string; api?: number; graph: (p: Project) => WorkflowGraph }[] = [
  {
    name: "Work, PR and review",
    title: "Work, pull request and review",
    hint: "A task's way across the board: the agent works in In progress, then the board opens its pull request and moves it to In review, where a reviewer sends the issues it finds back to the agent (which goes round again) or, once it passes, a summary is written.",
    api: COLUMN_WORKFLOWS_API,
    graph: () => ({
      nodes: [
        { id: "work", kind: "column", status: "in_progress", prompt: "", x: 20, y: 120 },
        { id: "commits", kind: "condition", check: "has_commits", x: 220, y: 120 },
        { id: "pr", kind: "open_pr", title: "", body: "", x: 420, y: 40 },
        { id: "review", kind: "column", status: "in_review", prompt: "", x: 650, y: 120 },
        { id: "reviewer", kind: "agent", name: "Reviewer", prompt: "", output: "verdict", tab: "Review", skills: [], x: 870, y: 120 },
        { id: "fix", kind: "send_to_task", message: "", max_rounds: 2, x: 1090, y: 40 },
        { id: "summary", kind: "agent", name: "Summary", prompt: SUMMARY_PROMPT, output: "text", tab: "Summary", skills: [], x: 1090, y: 190 },
        { id: "attention", kind: "column", status: "needs_attention", prompt: "", x: 650, y: 280 },
      ],
      edges: [
        { from: "work", port: "done", to: "commits" },
        { from: "commits", port: "yes", to: "pr" },
        { from: "commits", port: "no", to: "review" },
        { from: "pr", port: "opened", to: "review" },
        { from: "pr", port: "exists", to: "review" },
        { from: "pr", port: "failed", to: "attention" },
        { from: "review", port: "done", to: "reviewer" },
        { from: "reviewer", port: "issues", to: "fix" },
        { from: "reviewer", port: "pass", to: "summary" },
      ],
    }),
  },
  {
    name: "Open a PR when done",
    title: "Open a pull request, then review",
    hint: "When the task's agent is done in In progress, open a pull request for its branch (if it has commits of its own) and move the task to In review.",
    api: COLUMN_WORKFLOWS_API,
    graph: () => ({
      nodes: [
        { id: "start", kind: "column", status: "in_progress", prompt: "", x: 20, y: 120 },
        { id: "commits", kind: "condition", check: "has_commits", x: 220, y: 120 },
        { id: "pr", kind: "open_pr", title: "", body: "", x: 420, y: 40 },
        { id: "review", kind: "column", status: "in_review", prompt: "", x: 650, y: 20 },
        { id: "attention", kind: "column", status: "needs_attention", prompt: "", x: 650, y: 150 },
      ],
      edges: [
        { from: "start", port: "done", to: "commits" },
        { from: "commits", port: "yes", to: "pr" },
        { from: "commits", port: "no", to: "review" },
        { from: "pr", port: "opened", to: "review" },
        { from: "pr", port: "exists", to: "review" },
        { from: "pr", port: "failed", to: "attention" },
      ],
    }),
  },
  {
    name: "Summarise, then a skill",
    hint: "When a task moves to In review, summarise its changes, then have another agent process that summary with a skill, in a fresh context.",
    api: COLUMN_WORKFLOWS_API,
    graph: () => ({
      nodes: [
        { id: "start", kind: "column", status: "in_review", prompt: "", x: 20, y: 120 },
        { id: "summary", kind: "agent", name: "Summary", prompt: SUMMARY_PROMPT, output: "text", tab: "Summary", skills: [], x: 220, y: 120 },
        {
          id: "skill",
          kind: "agent",
          name: "Skill",
          prompt: "Process the summary above with your skill.",
          output: "text",
          tab: "Skill",
          skills: [],
          input_only: true,
          x: 440,
          y: 120,
        },
      ],
      edges: [
        { from: "start", port: "done", to: "summary" },
        { from: "summary", port: "done", to: "skill" },
      ],
    }),
  },
  {
    name: "From the Review tab",
    title: "Review and summarise",
    hint: "The reviewers, fix rounds and summarizers of this project's Review tab, as a workflow. Turn its reviews and summaries off there once this is on.",
    graph: fromReviewSettings,
  },
  {
    name: "Review and summarise",
    graph: () => ({
      nodes: [
        { id: "start", kind: "column", status: "in_review", prompt: "", x: 20, y: 120 },
        { id: "changed", kind: "condition", check: "changed", x: 220, y: 120 },
        { id: "reviewer", kind: "agent", name: "Reviewer", prompt: "", output: "verdict", tab: "Review", skills: [], x: 420, y: 100 },
        { id: "fix", kind: "send_to_task", message: "", max_rounds: 2, x: 640, y: 30 },
        {
          id: "summary",
          kind: "agent",
          name: "Summary",
          prompt: SUMMARY_PROMPT,
          output: "text",
          tab: "Summary",
          skills: [],
          x: 640,
          y: 190,
        },
      ],
      edges: [
        { from: "start", port: "done", to: "changed" },
        { from: "changed", port: "yes", to: "reviewer" },
        { from: "reviewer", port: "issues", to: "fix" },
        { from: "reviewer", port: "pass", to: "summary" },
      ],
    }),
  },
  { name: "Blank", graph: () => ({ nodes: [{ id: "start", kind: "trigger", on: "manual", x: 20, y: 120 }], edges: [] }) },
];

const NODE_W = 180;
const HEAD = 46;
const PORT_H = 18;
const IN_Y = 15;
const portsOf = (n: WorkflowNode) => workflowPorts(n);
const outsOf = (n: WorkflowNode) => workflowDataOutputs(n);
const insOf = (n: WorkflowNode) => workflowDataInputs(n);
/** A node's rows: its outcomes and values on the right, then its inputs on the left (as Blender lays out a node). */
const nodeH = (n: WorkflowNode) => HEAD + (portsOf(n).length + outsOf(n).length + insOf(n).length) * PORT_H + 6;
const portY = (i: number) => HEAD + i * PORT_H + PORT_H / 2;
const outY = (n: WorkflowNode, k: string) => portY(portsOf(n).length + Math.max(0, outsOf(n).indexOf(k)));
const inY = (n: WorkflowNode, k: string) => portY(portsOf(n).length + outsOf(n).length + Math.max(0, insOf(n).indexOf(k)));

function edgePath(x1: number, y1: number, x2: number, y2: number) {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

type Pt = { x: number; y: number };

/** Points along `edgePath`'s curve, to tell whether a cut crosses it. */
function edgePoints(x1: number, y1: number, x2: number, y2: number, n = 24): Pt[] {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  const [ax, bx, cx, ex] = [x1, x1 + dx, x2 - dx, x2];
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    pts.push({ x: w[0] * ax + w[1] * bx + w[2] * cx + w[3] * ex, y: (w[0] + w[1]) * y1 + (w[2] + w[3]) * y2 });
  }
  return pts;
}

/** Whether segments ab and cd cross. */
function crosses(a: Pt, b: Pt, c: Pt, d: Pt) {
  const side = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return side(c, d, a) * side(c, d, b) < 0 && side(a, b, c) * side(a, b, d) < 0;
}

/** Whether a knife line drawn through `cut` crosses a curve through `curve`. */
function cutCrosses(cut: Pt[], curve: Pt[]) {
  for (let i = 1; i < cut.length; i++) for (let j = 1; j < curve.length; j++) if (crosses(cut[i - 1], cut[i], curve[j - 1], curve[j])) return true;
  return false;
}

/**
 * Whether `to` reaches `from` already, so an edge from `from` to `to` would make a loop. A path into a column ends
 * there (the next run starts from it), so going round through a column is no loop.
 */
function reaches(g: WorkflowGraph, to: string, from: string) {
  const column = (id: string) => g.nodes.find((n) => n.id === id)?.kind === "column";
  if (column(to)) return false;
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of g.edges) if (e.input == null && e.from === id && !column(e.to)) stack.push(e.to);
  }
  return false;
}

/** Whether a wire from data node `from` into data node `to` would make its value depend on itself. */
function dataLoop(g: WorkflowGraph, from: string, to: string) {
  const data = (id: string) => {
    const n = g.nodes.find((x) => x.id === id);
    return !!n && isDataNode(n);
  };
  if (!data(from) || !data(to)) return false;
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of g.edges) if (e.input != null && e.from === id && data(e.to)) stack.push(e.to);
  }
  return false;
}

/** A free id for a new node of a kind, e.g. `agent2`. */
function freshId(g: WorkflowGraph, base: string) {
  for (let i = 1; ; i++) {
    const id = `${base}${i}`;
    if (!g.nodes.some((n) => n.id === id)) return id;
  }
}

/** Where the canvas is looking: its offset on screen, and its zoom. */
type View = { x: number; y: number; k: number };
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;

/**
 * Where a new node of height `h` goes: the first place in view (`area`, in the graph's coordinates) clear of the others,
 * or else below them all.
 */
function freeSpot(g: WorkflowGraph, h: number, area: { left: number; top: number; width: number; height: number }) {
  const left = Math.max(0, area.left);
  const top = Math.max(0, area.top);
  const right = area.left + area.width - NODE_W - 20;
  const bottom = area.top + area.height - h - 20;
  const clear = (x: number, y: number) =>
    g.nodes.every((n) => x + NODE_W + 20 <= n.x || n.x + NODE_W + 20 <= x || y + h + 20 <= n.y || n.y + nodeH(n) + 20 <= y);
  for (let y = Math.ceil((top + 20) / 10) * 10; y <= bottom; y += 30)
    for (let x = Math.ceil((left + 20) / 10) * 10; x <= right; x += 40) if (clear(x, y)) return { x, y };
  return { x: 20, y: Math.max(0, ...g.nodes.map((n) => n.y + nodeH(n))) + 30 };
}

/** The steps the editor adds: `api` is the host's API version they need, `before` the one they go with. */
const NEW_NODES: {
  kind: Exclude<WorkflowNodeKindName, "trigger">;
  label: string;
  base: string;
  api?: number;
  before?: number;
  make: (g: WorkflowGraph) => Partial<WorkflowNode>;
}[] = [
  {
    kind: "column",
    label: "Column",
    base: "column",
    api: COLUMN_WORKFLOWS_API,
    // The first column the graph has no node for.
    make: (g) => ({
      kind: "column",
      status: (["in_progress", "in_review", "ready_for_merge", "needs_attention", "todo", "backlog", "done"] as Status[]).find(
        (st) => !g.nodes.some((n) => n.kind === "column" && n.status === st),
      ),
      prompt: "",
    }),
  },
  { kind: "condition", label: "Check", base: "check", make: () => ({ kind: "condition", check: "changed" }) },
  { kind: "agent", label: "Agent", base: "agent", make: () => ({ kind: "agent", name: "Agent", prompt: "", output: "text", tab: null, skills: [] }) },
  {
    kind: "agent",
    label: "Review",
    base: "review",
    make: () => ({ kind: "agent", name: "Reviewer", prompt: "", output: "verdict", tab: "Review", skills: [] }),
  },
  {
    kind: "agent",
    label: "Summary",
    base: "summary",
    make: () => ({ kind: "agent", name: "Summary", prompt: SUMMARY_PROMPT, output: "text", tab: "Summary", skills: [] }),
  },
  {
    kind: "agent",
    label: "Skill on its input",
    base: "skill",
    api: COLUMN_WORKFLOWS_API,
    make: () => ({
      kind: "agent",
      name: "Skill",
      prompt: "Process what the steps before you wrote with your skill.",
      output: "text",
      tab: null,
      skills: [],
      input_only: true,
    }),
  },
  { kind: "open_pr", label: "Open a PR", base: "pr", api: COLUMN_WORKFLOWS_API, make: () => ({ kind: "open_pr", title: "", body: "" }) },
  { kind: "send_to_task", label: "Send to task", base: "send", make: () => ({ kind: "send_to_task", message: "", max_rounds: 2 }) },
  {
    kind: "set_status",
    label: "Move task",
    base: "move",
    before: COLUMN_WORKFLOWS_API,
    make: () => ({ kind: "set_status", status: "needs_attention" }),
  },
];

/** The data nodes the editor adds, which build the text that goes into steps' inputs. */
const NEW_VALUES: { kind: WorkflowNodeKindName; label: string; base: string; make: () => Partial<WorkflowNode> }[] = [
  { kind: "text", label: "Text", base: "text", make: () => ({ kind: "text", text: "" }) },
  { kind: "task", label: "Task", base: "task", make: () => ({ kind: "task" }) },
  { kind: "project_prompt", label: "Project prompt", base: "prompt", make: () => ({ kind: "project_prompt", which: "start" }) },
  { kind: "compose", label: "Compose", base: "compose", make: () => ({ kind: "compose", template: "{{a}}\n\n{{b}}" }) },
  { kind: "join", label: "Join", base: "join", make: () => ({ kind: "join", separator: "\n\n", count: 2 }) },
  { kind: "switch", label: "Switch", base: "switch", make: () => ({ kind: "switch", check: "has_pr" }) },
];

type Selection = { node: string } | { edge: number } | null;
type Gesture =
  | { kind: "move"; id: string; dx: number; dy: number }
  | { kind: "link"; from: string; port: string; data: boolean; x: number; y: number }
  /** Dragging the canvas around (from where the pointer and the view were). */
  | { kind: "pan"; sx: number; sy: number; ox: number; oy: number }
  /** A right-drag drawing a knife line: the wires it crosses are cut, as in Blender. */
  | { kind: "cut"; pts: Pt[] }
  | null;

function WorkflowEditor({
  project,
  workflow,
  initialName,
  initialGraph,
  onSaved,
  onClose,
}: {
  project: Project;
  workflow: Workflow | null;
  initialName: string;
  initialGraph: WorkflowGraph;
  onSaved: () => void;
  onClose: () => void;
}) {
  const hostId = project.host_id;
  const host = useHost(hostId);
  const columns = hostSupports(host, COLUMN_WORKFLOWS_API);
  const newNodes = NEW_NODES.filter((s) => (!s.api || hostSupports(host, s.api)) && (!s.before || !hostSupports(host, s.before)));
  const [name, setName] = useState(initialName);
  const [enabled, setEnabled] = useState(workflow?.enabled ?? true);
  const [graph, setGraph] = useState<WorkflowGraph>(() => structuredClone(initialGraph));
  const [sel, setSel] = useState<Selection>(() => ({ node: initialGraph.nodes.find((n) => n.kind === "trigger" || n.kind === "column")?.id ?? "" }));
  const [gesture, setGesture] = useState<Gesture>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inner = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const confirm = useConfirm();
  const dirty = name !== initialName || JSON.stringify(graph) !== JSON.stringify(initialGraph) || enabled !== (workflow?.enabled ?? true);

  /** Where a pointer is, in the graph's coordinates (the canvas layer's box is moved and scaled by the view). */
  const at = (e: { clientX: number; clientY: number }) => {
    const r = inner.current!.getBoundingClientRect();
    const k = viewRef.current.k;
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };
  /** Zooms to `k`, keeping the viewport's point (`cx`, `cy`), by default its middle, where it is. */
  const zoomTo = (k: number, cx?: number, cy?: number) =>
    setView((v) => {
      const el = scroller.current;
      const nk = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
      const [px, py] = [cx ?? (el?.clientWidth ?? 800) / 2, cy ?? (el?.clientHeight ?? 460) / 2];
      return { k: nk, x: px - ((px - v.x) * nk) / v.k, y: py - ((py - v.y) * nk) / v.k };
    });
  /** Fits the whole graph in view (Blender's View All). */
  const fit = () => {
    const el = scroller.current;
    if (!el || !graph.nodes.length) return setView({ x: 0, y: 0, k: 1 });
    const minX = Math.min(...graph.nodes.map((n) => n.x));
    const minY = Math.min(...graph.nodes.map((n) => n.y));
    const maxX = Math.max(...graph.nodes.map((n) => n.x + NODE_W));
    const maxY = Math.max(...graph.nodes.map((n) => n.y + nodeH(n)));
    const k = Math.min(1, Math.max(MIN_ZOOM, Math.min((el.clientWidth - 60) / (maxX - minX), (el.clientHeight - 60) / (maxY - minY))));
    setView({ k, x: (el.clientWidth - (maxX - minX) * k) / 2 - minX * k, y: (el.clientHeight - (maxY - minY) * k) / 2 - minY * k });
  };
  // The wheel zooms around the pointer, as Blender's does (a listener of its own: React's wheel handlers are passive).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomTo(viewRef.current.k * Math.exp(-step * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!gesture) return;
    const move = (e: PointerEvent) => {
      const p = at(e);
      if (gesture.kind === "move") {
        const x = Math.max(0, Math.round((p.x - gesture.dx) / 10) * 10);
        const y = Math.max(0, Math.round((p.y - gesture.dy) / 10) * 10);
        setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === gesture.id ? { ...n, x, y } : n)) }));
      } else if (gesture.kind === "pan") {
        setView((v) => ({ ...v, x: gesture.ox + e.clientX - gesture.sx, y: gesture.oy + e.clientY - gesture.sy }));
      } else if (gesture.kind === "cut") {
        setGesture({ ...gesture, pts: [...gesture.pts, p] });
      } else setGesture({ ...gesture, x: p.x, y: p.y });
    };
    const up = (e: PointerEvent) => {
      if (gesture.kind === "cut" && gesture.pts.length > 1) {
        // The wires the knife line crosses go.
        const cut = gesture.pts;
        const kept = graph.edges.filter((ed) => {
          const ends = edgeEnds(ed);
          return !ends || !cutCrosses(cut, edgePoints(ends.x1, ends.y1, ends.x2, ends.y2));
        });
        if (kept.length !== graph.edges.length) {
          setGraph((g) => ({ ...g, edges: kept }));
          setSel(null);
        }
      }
      if (gesture.kind === "link") {
        const at = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        if (gesture.data) {
          // A value goes into an input: the socket it's dropped on, or a node's only input.
          const socket = at?.closest<HTMLElement>("[data-input]")?.dataset.input;
          const nodeId = socket ? socket.slice(0, socket.lastIndexOf(".")) : at?.closest<HTMLElement>("[data-node]")?.dataset.node;
          const target = graph.nodes.find((n) => n.id === nodeId);
          const input = socket ? socket.slice(socket.lastIndexOf(".") + 1) : target && insOf(target).length === 1 ? insOf(target)[0] : null;
          if (nodeId && input) connectData(gesture.from, gesture.port, nodeId, input);
          else if (nodeId) setErr("Drop the value on one of the step's inputs (the diamonds on its left).");
        } else {
          const to = at?.closest<HTMLElement>("[data-node]")?.dataset.node;
          if (to) connect(gesture.from, gesture.port, to);
        }
      }
      setGesture(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gesture]);

  const connect = (from: string, port: string, to: string) => {
    setErr(null);
    const target = graph.nodes.find((n) => n.id === to);
    if (!target || to === from) return;
    if (target.kind === "trigger") return setErr("Nothing goes into the start: it's where a run begins.");
    if (isDataNode(target)) return setErr(`${nodeTitle(target)} gives values: wire a value into one of its inputs instead.`);
    if (target.kind === "column" && target.status === "done") return setErr("Nothing goes into Done: a task is done once it's merged, from Ready for merge.");
    if (graph.edges.some((e) => e.from === from && e.port === port && e.to === to)) return;
    if (reaches(graph, to, from))
      return setErr("That would make a loop. To go round again, go through a column, or send to the task's agent: its next turn starts the workflow again.");
    setGraph((g) => ({ ...g, edges: [...g.edges, { from, port, to }] }));
  };
  /** A data wire from `from`'s value `port` into `to`'s `input`, in place of the one there. */
  const connectData = (from: string, port: string, to: string, input: string) => {
    setErr(null);
    if (from === to && isDataNode(graph.nodes.find((n) => n.id === from)!)) return;
    if (dataLoop(graph, from, to)) return setErr("That would make the value depend on itself.");
    setGraph((g) => ({ ...g, edges: [...g.edges.filter((e) => !(e.to === to && e.input === input)), { from, port, to, input }] }));
  };
  const unwire = (to: string, input: string) => setGraph((g) => ({ ...g, edges: g.edges.filter((e) => !(e.to === to && e.input === input)) }));
  const addNode = (spec: { base: string; make: (g: WorkflowGraph) => Partial<WorkflowNode> }) => {
    const id = freshId(graph, spec.base);
    const node = { ...spec.make(graph), id, x: 0, y: 0 } as WorkflowNode;
    const el = scroller.current;
    const v = viewRef.current;
    Object.assign(
      node,
      freeSpot(graph, nodeH(node), { left: -v.x / v.k, top: -v.y / v.k, width: (el?.clientWidth ?? 800) / v.k, height: (el?.clientHeight ?? 460) / v.k }),
    );
    setGraph((g) => ({ ...g, nodes: [...g.nodes, node] }));
    setSel({ node: id });
  };
  const removeNode = (id: string) => {
    setGraph((g) => ({ nodes: g.nodes.filter((n) => n.id !== id), edges: g.edges.filter((e) => e.from !== id && e.to !== id) }));
    setSel(null);
  };
  const removeEdge = (i: number) => {
    setGraph((g) => ({ ...g, edges: g.edges.filter((_, k) => k !== i) }));
    setSel(null);
  };
  /** Whether a node can go: not the start a workflow can't do without. */
  const removable = (n: WorkflowNode, g = graph) => n.kind !== "trigger" || (columns && g.nodes.some((x) => x.kind === "column"));
  // Delete, Backspace or X removes the selected node or line, as in Blender (not while typing in a field).
  const selRef = useRef(sel);
  selRef.current = sel;
  const graphRef = useRef(graph);
  graphRef.current = graph;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace" && e.key !== "x" && e.key !== "X") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      const cur = selRef.current;
      if (!cur) return;
      if ("edge" in cur) {
        e.preventDefault();
        removeEdge(cur.edge);
        return;
      }
      const n = graphRef.current.nodes.find((x) => x.id === cur.node);
      if (n && removable(n, graphRef.current)) {
        e.preventDefault();
        removeNode(n.id);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns]);
  const updateNode = (id: string, patch: Partial<WorkflowNode>) =>
    setGraph((g) => {
      const nodes = g.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as WorkflowNode) : n));
      // A wire into an input the node no longer has (a name gone from a template, say) goes with it.
      const changed = nodes.find((n) => n.id === id)!;
      const inputs = workflowDataInputs(changed);
      return { nodes, edges: g.edges.filter((e) => e.to !== id || e.input == null || inputs.includes(e.input)) };
    });
  const renameNode = (id: string, raw: string) => {
    const next = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    if (!next || next === id || graph.nodes.some((n) => n.id === next)) return;
    setGraph((g) => ({
      nodes: g.nodes.map((n) => (n.id === id ? { ...n, id: next } : n)),
      edges: g.edges.map((e) => ({ ...e, from: e.from === id ? next : e.from, to: e.to === id ? next : e.to })),
    }));
    setSel({ node: next });
  };

  const save = async () => {
    setErr(null);
    if (!name.trim()) return setErr("Give it a name.");
    setBusy(true);
    try {
      if (workflow) await api.updateWorkflow(hostId, workflow.id, { name: name.trim(), graph, enabled });
      else await api.createWorkflow(hostId, project.id, { name: name.trim(), graph, enabled });
      onSaved();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const close = () =>
    dirty
      ? confirm.ask({
          title: "Discard changes",
          body: "Close the workflow without saving your changes?",
          action: "Discard",
          danger: true,
          onConfirm: async () => onClose(),
        })
      : onClose();

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const width = Math.max(1000, ...graph.nodes.map((n) => n.x + NODE_W + 80));
  const height = Math.max(420, ...graph.nodes.map((n) => n.y + nodeH(n) + 60));
  const selected = sel && "node" in sel ? byId.get(sel.node) : undefined;
  const selectedEdge = sel && "edge" in sel ? graph.edges[sel.edge] : undefined;
  const portPos = (n: WorkflowNode, port: string) => ({ x: n.x + NODE_W, y: n.y + portY(Math.max(0, portsOf(n).indexOf(port))) });
  const outPos = (n: WorkflowNode, k: string) => ({ x: n.x + NODE_W, y: n.y + outY(n, k) });
  /** Where an edge's curve starts and ends. */
  function edgeEnds(e: WorkflowEdge) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return null;
    const p = e.input != null ? outPos(a, e.port) : portPos(a, e.port);
    return { x1: p.x, y1: p.y, x2: b.x, y2: b.y + (e.input != null ? inY(b, e.input) : IN_Y) };
  }

  return (
    <Modal title={workflow ? `Edit ${workflow.name}` : "New workflow"} onClose={close} onSubmit={save} width="max-w-[1400px]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-60 flex-1">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Review and summarise" autoFocus={!workflow} />
            </Field>
          </div>
          <div className="pb-1.5">
            <Toggle checked={enabled} onChange={setEnabled} label="On" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] text-faint">Add a step:</span>
          {newNodes.map((s) => (
            <Button key={s.label} size="sm" variant="ghost" disabled={graph.nodes.length >= (columns ? 80 : 40)} onClick={() => addNode(s)}>
              <span className={KIND_STYLE[s.kind].tone}>{KIND_STYLE[s.kind].icon}</span> {s.label}
            </Button>
          ))}
          <span className="ml-auto text-[11.5px] text-faint">
            Drag from a step's outcome to another step to connect them. Right-drag across lines to cut them; Delete or X removes what's selected. Drag the
            background to pan, scroll to zoom.
          </span>
        </div>
        {columns && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] text-faint">Add a value:</span>
            {NEW_VALUES.map((v) => (
              <Button key={v.label} size="sm" variant="ghost" disabled={graph.nodes.length >= 80} onClick={() => addNode(v)}>
                <span className={KIND_STYLE[v.kind].tone}>{KIND_STYLE[v.kind].icon}</span> {v.label}
              </Button>
            ))}
            <span className="ml-auto text-[11.5px] text-faint">Drag from a value (◆ on the right) to an input (◆ on the left) to build a prompt.</span>
          </div>
        )}
        <div className="flex min-h-0 gap-3 narrow:flex-col">
          <div
            ref={scroller}
            data-testid="workflow-viewport"
            className={clsx(
              "relative h-[460px] min-w-0 flex-1 touch-none overflow-hidden rounded-md border border-line bg-[radial-gradient(circle,rgba(255,255,255,0.06)_1px,transparent_1px)]",
              gesture?.kind === "pan" ? "cursor-grabbing" : gesture?.kind === "cut" ? "cursor-crosshair" : "cursor-default",
            )}
            style={{ backgroundSize: `${20 * view.k}px ${20 * view.k}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
            onContextMenu={(e) => e.preventDefault()}
            onPointerDown={(e) => {
              const background = e.target === e.currentTarget || e.target === inner.current || (e.target as Element).tagName === "svg";
              if (e.button === 2) {
                // Right-drag cuts wires (Blender's knife, with Ctrl there), over nodes as well.
                e.preventDefault();
                setGesture({ kind: "cut", pts: [at(e)] });
              } else if (e.button === 1 || (e.button === 0 && background)) {
                e.preventDefault();
                if (e.button === 0) setSel(null);
                setGesture({ kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y });
              }
            }}
          >
            <div
              ref={inner}
              className="absolute top-0 left-0 select-none"
              style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: "0 0" }}
              data-testid="workflow-canvas"
            >
              <svg className="pointer-events-none absolute inset-0 overflow-visible" width={width} height={height}>
                {graph.edges.map((e, i) => {
                  const a = byId.get(e.from);
                  const b = byId.get(e.to);
                  if (!a || !b) return null;
                  const data = e.input != null;
                  const p = data ? outPos(a, e.port) : portPos(a, e.port);
                  const d = edgePath(p.x, p.y, b.x, b.y + (data ? inY(b, e.input!) : IN_Y));
                  const on = sel && "edge" in sel && sel.edge === i;
                  return (
                    <g
                      key={`${e.from}-${e.port}-${e.to}-${e.input ?? ""}`}
                      className="pointer-events-auto cursor-pointer"
                      onPointerDown={(ev) => {
                        if (ev.button !== 0) return;
                        ev.stopPropagation();
                        setSel({ edge: i });
                      }}
                    >
                      <path
                        d={d}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={12}
                        data-edge={data ? `${e.from}.${e.port}->${e.to}.${e.input}` : `${e.from}.${e.port}->${e.to}`}
                      />
                      <path
                        d={d}
                        fill="none"
                        className={on ? "stroke-accent" : data ? "stroke-amber-400/70" : "stroke-line-strong"}
                        strokeWidth={on ? 2.5 : data ? 1.5 : 1.75}
                      />
                    </g>
                  );
                })}
                {gesture?.kind === "link" &&
                  (() => {
                    const a = byId.get(gesture.from);
                    if (!a) return null;
                    const p = gesture.data ? outPos(a, gesture.port) : portPos(a, gesture.port);
                    return (
                      <path
                        d={edgePath(p.x, p.y, gesture.x, gesture.y)}
                        fill="none"
                        className={gesture.data ? "stroke-amber-400" : "stroke-accent"}
                        strokeWidth={1.75}
                        strokeDasharray="4 3"
                      />
                    );
                  })()}
                {gesture?.kind === "cut" && (
                  <polyline
                    points={gesture.pts.map((p) => `${p.x},${p.y}`).join(" ")}
                    fill="none"
                    className="stroke-red-400"
                    strokeWidth={1.5 / view.k}
                    strokeDasharray={`${5 / view.k} ${4 / view.k}`}
                    data-testid="workflow-cut"
                  />
                )}
              </svg>
              {graph.nodes.map((n) => {
                const style = KIND_STYLE[n.kind];
                const on = selected?.id === n.id;
                const linked = (p: string) => graph.edges.some((e) => e.from === n.id && e.port === p);
                return (
                  <div
                    key={n.id}
                    data-node={n.id}
                    className={clsx(
                      "absolute cursor-grab rounded-md border bg-panel shadow-sm active:cursor-grabbing",
                      on ? "border-accent ring-2 ring-accent/20" : "border-line-strong",
                    )}
                    style={{ left: n.x, top: n.y, width: NODE_W, height: nodeH(n) }}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      setSel({ node: n.id });
                      const p = at(e);
                      setGesture({ kind: "move", id: n.id, dx: p.x - n.x, dy: p.y - n.y });
                    }}
                  >
                    {n.kind !== "trigger" && !isDataNode(n) && (
                      <span className="absolute -left-1.5 h-3 w-3 rounded-full border border-line-strong bg-raised" style={{ top: IN_Y - 6 }} />
                    )}
                    <div className="space-y-0.5 px-2.5 pt-1.5">
                      <div className={clsx("flex items-center gap-1.5 text-[12.5px] font-medium", style.tone)}>
                        {style.icon}
                        <span className="truncate text-fg">{nodeTitle(n)}</span>
                        {n.join === "all" && <span className="ml-auto text-[10.5px] text-faint">all inputs</span>}
                      </div>
                      <div className="truncate text-[11px] text-faint" title={nodeText(n)}>
                        {nodeText(n)}
                      </div>
                    </div>
                    {portsOf(n).map((p, i) => (
                      <div
                        key={p}
                        className="absolute right-0 flex items-center gap-1.5 text-[11px] text-muted"
                        style={{ top: portY(i) - PORT_H / 2, height: PORT_H }}
                      >
                        <span>{PORT_LABELS[p] ?? p}</span>
                        <span
                          role="button"
                          aria-label={`Connect ${nodeTitle(n)}: ${PORT_LABELS[p] ?? p}`}
                          data-port={`${n.id}.${p}`}
                          className={clsx(
                            "-mr-1.5 h-3 w-3 cursor-crosshair rounded-full border",
                            linked(p) ? "border-accent bg-accent" : "border-line-strong bg-raised hover:border-accent",
                          )}
                          onPointerDown={(e) => {
                            if (e.button !== 0) return;
                            e.stopPropagation();
                            const at0 = at(e);
                            setGesture({ kind: "link", from: n.id, port: p, data: false, x: at0.x, y: at0.y });
                          }}
                        />
                      </div>
                    ))}
                    {outsOf(n).map((k) => (
                      <div
                        key={`out-${k}`}
                        className="absolute right-0 flex items-center gap-1.5 text-[11px] text-amber-200/80"
                        style={{ top: outY(n, k) - PORT_H / 2, height: PORT_H }}
                      >
                        <span>{dataLabel(k)}</span>
                        <span
                          role="button"
                          aria-label={`Wire ${nodeTitle(n)}: ${dataLabel(k)}`}
                          data-output={`${n.id}.${k}`}
                          className={clsx(
                            "-mr-1.5 h-2.5 w-2.5 rotate-45 cursor-crosshair border",
                            graph.edges.some((e) => e.input != null && e.from === n.id && e.port === k)
                              ? "border-amber-400 bg-amber-400"
                              : "border-amber-400/70 bg-raised hover:bg-amber-400/60",
                          )}
                          onPointerDown={(e) => {
                            if (e.button !== 0) return;
                            e.stopPropagation();
                            const at0 = at(e);
                            setGesture({ kind: "link", from: n.id, port: k, data: true, x: at0.x, y: at0.y });
                          }}
                        />
                      </div>
                    ))}
                    {insOf(n).map((k) => {
                      const w = workflowWire(graph, n.id, k);
                      return (
                        <div
                          key={`in-${k}`}
                          data-input={`${n.id}.${k}`}
                          className="absolute left-0 flex w-full items-center gap-1.5 pr-2 text-[11px] text-amber-200/80"
                          style={{ top: inY(n, k) - PORT_H / 2, height: PORT_H }}
                        >
                          <span
                            className={clsx(
                              "-ml-1.5 h-2.5 w-2.5 shrink-0 rotate-45 border",
                              w ? "border-amber-400 bg-amber-400" : "border-amber-400/70 bg-raised",
                            )}
                          />
                          <span className="shrink-0">{dataLabel(k)}</span>
                          <span className="truncate text-faint">{w ? `← ${nodeTitle(byId.get(w.from) ?? n)} · ${dataLabel(w.port)}` : ownText(n, k)}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <div
              className="absolute right-2 bottom-2 flex items-center gap-0.5 rounded-md border border-line bg-panel/90 p-0.5 text-[11.5px] shadow-sm"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <Button size="sm" variant="ghost" title="Zoom out" onClick={() => zoomTo(view.k / 1.25)}>
                −
              </Button>
              <button
                type="button"
                className="w-11 text-center text-muted tabular-nums hover:text-fg"
                title="Back to 100%"
                data-testid="workflow-zoom"
                onClick={() => zoomTo(1)}
              >
                {Math.round(view.k * 100)}%
              </button>
              <Button size="sm" variant="ghost" title="Zoom in" onClick={() => zoomTo(view.k * 1.25)}>
                +
              </Button>
              <Button size="sm" variant="ghost" title="Fit the whole workflow in view" onClick={fit}>
                Fit
              </Button>
            </div>
          </div>
          <div className="w-80 shrink-0 space-y-3 overflow-y-auto narrow:w-full md:max-h-[460px]" data-testid="workflow-inspector">
            {selected ? (
              <NodeInspector
                key={selected.id}
                project={project}
                node={selected}
                inputs={graph.edges.filter((e) => e.to === selected.id).length}
                graph={graph}
                onUnwire={(input) => unwire(selected.id, input)}
                onChange={(patch) => updateNode(selected.id, patch)}
                onRename={(id) => renameNode(selected.id, id)}
                onRemove={removable(selected) ? () => removeNode(selected.id) : undefined}
              />
            ) : selectedEdge ? (
              <div className="space-y-2 text-[12.5px]">
                <div className="font-medium">{selectedEdge.input != null ? "Wire" : "Connection"}</div>
                <div className="text-muted">
                  {selectedEdge.input != null ? (
                    <>
                      <b>{nodeTitle(byId.get(selectedEdge.from)!)}</b>'s <i>{dataLabel(selectedEdge.port)}</i> goes into{" "}
                      <b>{nodeTitle(byId.get(selectedEdge.to)!)}</b>'s <i>{dataLabel(selectedEdge.input)}</i>.
                    </>
                  ) : (
                    <>
                      When <b>{nodeTitle(byId.get(selectedEdge.from)!)}</b> ends with <i>{PORT_LABELS[selectedEdge.port] ?? selectedEdge.port}</i>,{" "}
                      <b>{nodeTitle(byId.get(selectedEdge.to)!)}</b> runs.
                    </>
                  )}
                </div>
                <Button size="sm" variant="ghost" onClick={() => removeEdge((sel as { edge: number }).edge)}>
                  <Trash2 size={12} /> Remove
                </Button>
              </div>
            ) : (
              <div className="space-y-2 text-[12px] text-faint">
                <p>Click a step to change it.</p>
                <p>
                  A step runs once a step before it ends on an outcome connected to it, or once all of them have (<i>all inputs</i>). One whose inputs can't
                  come is skipped.
                </p>
                {columns ? (
                  <p>
                    A line into a <b>column</b> moves the task there, and the run goes on from that column once its work is done: what comes after a column is
                    the next run's. <b>Send to the task's agent</b> ends the run too: the agent's work then goes on from In progress. After its rounds, its{" "}
                    <i>out of rounds</i> outcome runs instead, or the task moves to Needs attention.
                  </p>
                ) : (
                  <p>
                    <b>Send to the task's agent</b> ends the run. Once the agent's turn ends and the task enters the start's column again, the workflow runs
                    again; after its rounds, its <i>out of rounds</i> outcome runs instead, or the task moves to Needs attention.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
        {err && <div className="rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{err}</div>}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={save}>
            {workflow ? "Save" : "Create workflow"}
          </Button>
        </div>
      </div>
      {confirm.dialog}
    </Modal>
  );
}

const selectClass = "h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none";
const TEMPLATES =
  "{{task.key}}, {{task.title}}, {{task.description}}, {{branch}}, {{commit}}, {{workflow}}, {{issues}}, and {{<step id>.text}} or {{<step id>.issues}}";

/** The selected node's settings. */
function NodeInspector({
  project,
  node: n,
  inputs,
  graph,
  onUnwire,
  onChange,
  onRename,
  onRemove,
}: {
  project: Project;
  node: WorkflowNode;
  inputs: number;
  graph: WorkflowGraph;
  onUnwire: (input: string) => void;
  onChange: (patch: Partial<WorkflowNode>) => void;
  onRename: (id: string) => void;
  /** None for the start a workflow can't do without. */
  onRemove?: () => void;
}) {
  const host = useHost(project.host_id);
  const configs = useAvailableConfigs(project.host_id, project.profile_id, project);
  const [id, setId] = useState(n.id);
  const [skills, setSkills] = useState(n.kind === "agent" ? (n.skills ?? []).join(", ") : "");
  const statuses = hostStatuses(host);
  const style = KIND_STYLE[n.kind];
  return (
    <div className="space-y-3 text-[12.5px]">
      <div className={clsx("flex items-center gap-1.5 font-medium", style.tone)}>
        {style.icon}
        <span className="text-fg">{n.kind === "trigger" ? "Start" : nodeTitle(n)}</span>
        {onRemove && (
          <Button size="sm" variant="ghost" className="ml-auto" title="Remove this step" onClick={onRemove}>
            <Trash2 size={12} />
          </Button>
        )}
      </div>
      <Field label="Id" hint="How templates name its output, e.g. {{reviewer.text}}.">
        <Input
          className="h-7 font-mono text-[12px]"
          value={id}
          onChange={(e) => setId(e.target.value.replace(/[^A-Za-z0-9_-]/g, ""))}
          onBlur={() => (id ? onRename(id) : setId(n.id))}
        />
      </Field>
      {n.kind === "trigger" && hostSupports(host, COLUMN_WORKFLOWS_API) && (
        <p className="text-[11.5px] text-faint">
          Where a run you start from the task's details begins. Without a start, a workflow run by hand begins at its column for the task's column. Runs of
          their own begin at the columns.
        </p>
      )}
      {n.kind === "trigger" && !hostSupports(host, COLUMN_WORKFLOWS_API) && (
        <>
          <Field label="Starts">
            <select
              className={selectClass}
              value={n.on === "status" ? n.status : ""}
              onChange={(e) => onChange(e.target.value ? { on: "status", status: e.target.value as Status } : { on: "manual", status: null })}
            >
              <option value="">Only when run by hand</option>
              {statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  When a task moves to {s.label}
                </option>
              ))}
            </select>
          </Field>
          <p className="text-[11.5px] text-faint">Any workflow can be run on a task by hand too, from the task's details.</p>
        </>
      )}
      {n.kind === "column" && <ColumnInspector node={n} graph={graph} statuses={statuses} onChange={onChange} onUnwire={onUnwire} />}
      {isDataNode(n) && <ValueInspector node={n} graph={graph} onChange={onChange} onUnwire={onUnwire} />}
      {n.kind === "condition" && (
        <>
          <Field label="Checks whether">
            <select
              className={selectClass}
              value={n.check}
              onChange={(e) => {
                const check = e.target.value as WorkflowCheck;
                onChange({ check, value: check === "task_type" ? "code" : check === "label" ? LABELS[0] : null });
              }}
            >
              {WORKFLOW_CHECKS.map((c) => (
                <option key={c} value={c}>
                  {CHECK_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
          {n.check === "task_type" && (
            <Field label="Type">
              <select className={selectClass} value={n.value ?? "code"} onChange={(e) => onChange({ value: e.target.value })}>
                <option value="code">Code</option>
                <option value="scratch">Scratch</option>
              </select>
            </Field>
          )}
          {n.check === "label" && (
            <Field label="Label">
              <select className={selectClass} value={n.value ?? LABELS[0]} onChange={(e) => onChange({ value: e.target.value })}>
                {LABELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {n.check === "changed" && (
            <p className="text-[11.5px] text-faint">
              Yes when the task's branch or its agent's last run differ from the workflow's last finished run on it, and always when it's run by hand.
            </p>
          )}
        </>
      )}
      {n.kind === "agent" && (
        <>
          <Field label="Name">
            <Input className="h-7" value={n.name} maxLength={60} onChange={(e) => onChange({ name: e.target.value })} />
          </Field>
          <Field label="Output">
            <select className={selectClass} value={n.output} onChange={(e) => onChange({ output: e.target.value as "text" | "verdict" })}>
              <option value="text">Text: its last message</option>
              <option value="verdict">Verdict: pass, or the serious issues it found</option>
            </select>
          </Field>
          <Field label="Tab" hint="The task panel tab its output shows in. Steps can share one.">
            <Input className="h-7" value={n.tab ?? ""} maxLength={30} placeholder="No tab" onChange={(e) => onChange({ tab: e.target.value || null })} />
          </Field>
          <div className="space-y-1.5">
            <span className="block text-xs font-medium text-muted">Agent</span>
            <ReviewerRow
              hostId={project.host_id}
              configs={configs}
              models={{ project: project.model }}
              value={{ claude_config_id: n.claude_config_id ?? null, model: n.model ?? null, effort: n.effort ?? null }}
              onChange={(v) => v && onChange({ claude_config_id: v.claude_config_id, model: v.model, effort: v.effort })}
              removable={false}
            />
          </div>
          <Field
            label="Instructions"
            hint={
              <>
                Blank is the review instructions for a verdict, or "report on the work" for text. Templates: <code className="text-[11px]">{TEMPLATES}</code>.
              </>
            }
          >
            <Wired graph={graph} node={n} input="prompt" onUnwire={onUnwire}>
              <Textarea rows={6} className="text-[12.5px]" value={n.prompt} onChange={(e) => onChange({ prompt: e.target.value })} />
            </Wired>
          </Field>
          <Field label="Skills" hint="Skills it uses, separated by commas.">
            <Input
              className="h-7"
              value={skills}
              placeholder="e.g. security-review"
              onChange={(e) => {
                setSkills(e.target.value);
                onChange({
                  skills: e.target.value
                    .split(",")
                    .map((s) => s.trim().replace(/^[/$]/, ""))
                    .filter(Boolean),
                });
              }}
            />
          </Field>
          {(n.input_only || hostSupports(host, COLUMN_WORKFLOWS_API)) && (
            <Toggle checked={!!n.input_only} onChange={(v) => onChange({ input_only: v || undefined })} label="Work only on what the steps before it wrote" />
          )}
          <p className="text-[11.5px] text-faint">
            It runs in a thread of its own on the task's worktree, with read-only tools, in a fresh conversation each run. It's given the output of the agent
            steps before it{n.input_only ? ", and isn't told where the task's work is" : ""}.
          </p>
        </>
      )}
      {n.kind === "send_to_task" && (
        <>
          <Field
            label="Message"
            hint={
              <>
                Blank sends the serious issues the verdict steps found. Templates: <code className="text-[11px]">{TEMPLATES}</code>.
              </>
            }
          >
            <Wired graph={graph} node={n} input="message" onUnwire={onUnwire}>
              <Textarea rows={5} className="text-[12.5px]" value={n.message} onChange={(e) => onChange({ message: e.target.value })} />
            </Wired>
          </Field>
          <Field
            label="Rounds"
            hint="How many times in a row it sends before its out of rounds outcome runs (or, with nothing connected, the task moves to Needs attention)."
          >
            <div className="w-24">
              <Input
                type="number"
                min={1}
                max={20}
                value={n.max_rounds}
                onChange={(e) => onChange({ max_rounds: Math.max(1, Math.min(20, Math.floor(Number(e.target.value) || 1))) })}
              />
            </div>
          </Field>
        </>
      )}
      {n.kind === "open_pr" && (
        <>
          <Field
            label="Title"
            hint={
              <>
                Blank is the task's key and title. Templates: <code className="text-[11px]">{TEMPLATES}</code>.
              </>
            }
          >
            <Wired graph={graph} node={n} input="title" onUnwire={onUnwire}>
              <Input className="h-7" value={n.title} placeholder="{{task.key}}: {{task.title}}" onChange={(e) => onChange({ title: e.target.value })} />
            </Wired>
          </Field>
          <Field label="Body" hint="Blank is the task's agent's last message. An agent step before it can write one: {{<step id>.text}}.">
            <Wired graph={graph} node={n} input="body" onUnwire={onUnwire}>
              <Textarea rows={5} className="text-[12.5px]" value={n.body} onChange={(e) => onChange({ body: e.target.value })} />
            </Wired>
          </Field>
          <Toggle checked={!!n.draft} onChange={(v) => onChange({ draft: v || undefined })} label="Open it as a draft" />
          <p className="text-[11.5px] text-faint">
            The board pushes the task's branch and opens its pull request into the branch it started from, as the project's GitHub account. <i>Had one</i> when
            the task has a pull request already; <i>failed</i> when its branch has no commits of its own, or GitHub refused.
          </p>
        </>
      )}
      {n.kind === "set_status" && (
        <Field label="Moves the task to" hint="Moving it doesn't start this workflow again.">
          <select className={selectClass} value={n.status} onChange={(e) => onChange({ status: e.target.value as Status })}>
            {statuses
              .filter((s) => s.id !== "done")
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
          </select>
        </Field>
      )}
      {n.kind !== "trigger" && inputs > 1 && (
        <Field label="Runs when">
          <select className={selectClass} value={n.join ?? "any"} onChange={(e) => onChange({ join: e.target.value === "all" ? "all" : undefined })}>
            <option value="any">Any of its inputs arrives</option>
            <option value="all">All of its inputs arrive</option>
          </select>
        </Field>
      )}
      {n.kind === "trigger" && !onRemove && (
        <div className="flex items-center gap-1.5 text-[11.5px] text-faint">
          <Flag size={11} /> {hostSupports(host, COLUMN_WORKFLOWS_API) ? "A workflow needs a start or a column." : "Every workflow has one start."}
        </div>
      )}
    </div>
  );
}

/** A column node's settings: its column, the prompt its agent is sent there, and when its work is done. */
function ColumnInspector({
  node: n,
  graph,
  statuses,
  onChange,
  onUnwire,
}: {
  node: Extract<WorkflowNode, { kind: "column" }>;
  graph: WorkflowGraph;
  statuses: { id: Status; label: string }[];
  onChange: (patch: Partial<WorkflowNode>) => void;
  onUnwire: (input: string) => void;
}) {
  const taken = new Set(graph.nodes.filter((x) => x.kind === "column" && x.id !== n.id).map((x) => (x as { status: Status }).status));
  const promptless = n.status === "needs_attention" || n.status === "done";
  const merge = n.status === "ready_for_merge";
  const note = doneNote(graph, n.id);
  const waits = workflowWaits(n, graph);
  // The note goes where `next` is wired, if it is, rather than at the end.
  const placed = graph.edges.some((e) => e.input != null && e.from === n.id && e.port === "next");
  return (
    <>
      <Field label="Column" hint="A workflow has one step for each column.">
        <select
          className={selectClass}
          value={n.status}
          onChange={(e) => {
            const status = e.target.value as Status;
            const none = status === "needs_attention" || status === "done";
            onChange({ status, ...(none ? { prompt: "" } : {}), ...(none || status === "ready_for_merge" ? { done_when: undefined } : {}) });
          }}
        >
          {statuses.map((st) => (
            <option key={st.id} value={st.id} disabled={taken.has(st.id)}>
              {st.label}
            </option>
          ))}
        </select>
      </Field>
      {!promptless && (
        <Field
          label={n.status === "in_progress" ? "Start prompt" : merge ? "How to merge" : "Prompt"}
          hint={
            n.status === "in_progress"
              ? "What the task's agent starts with, after the task's title and description. Blank is the project's start prompt."
              : merge
                ? "The agent's merge instructions, in place of the project's. Blank is the project's."
                : "Sent to the task's agent when the task enters the column. Blank sends nothing, and what comes after runs at once."
          }
        >
          <Wired graph={graph} node={n} input="prompt" onUnwire={onUnwire}>
            <Textarea rows={5} className="text-[12.5px]" value={n.prompt} onChange={(e) => onChange({ prompt: e.target.value })} />
          </Wired>
        </Field>
      )}
      {waits && !merge && (
        <Field label="Done when">
          <select
            className={selectClass}
            value={n.done_when ?? "run_end"}
            onChange={(e) => onChange({ done_when: e.target.value === "finish" ? "finish" : undefined })}
          >
            <option value="run_end">The agent's turn ends (not asking you anything)</option>
            <option value="finish">The agent says so, with finish_work</option>
          </select>
        </Field>
      )}
      {note && (
        <div className="space-y-1">
          <span className="block text-xs font-medium text-muted">{placed ? "What happens next, where it's wired" : "Added to the prompt"}</span>
          <p className="rounded border border-line/70 bg-raised/40 p-2 text-[11.5px] whitespace-pre-wrap text-muted" data-testid="column-done-note">
            {note}
          </p>
        </div>
      )}
      <p className="text-[11.5px] text-faint">
        {merge
          ? "Its done comes once the task is merged."
          : waits
            ? n.done_when === "finish"
              ? "Its done comes once the agent calls finish_work and ends its turn: a turn that ends without it, or with a question for you, leaves the task in Needs attention until the agent is done. Meanwhile the task stays in In progress rather than going to In review."
              : "Its done comes once the agent's turn ends: one that asks you something leaves the task in Needs attention until the agent is done. Meanwhile the task stays in In progress rather than going to In review: with nothing after done, it goes there then."
            : "Its done comes as soon as a task moves here."}{" "}
        A line into it moves the task here.
      </p>
    </>
  );
}

/** An input's own field, or, when a value is wired into it, where the value comes from and a way to unwire it. */
function Wired({
  graph,
  node,
  input,
  onUnwire,
  children,
}: {
  graph: WorkflowGraph;
  node: WorkflowNode;
  input: string;
  onUnwire: (input: string) => void;
  children: ReactNode;
}) {
  const w = workflowWire(graph, node.id, input);
  if (!w) return <>{children}</>;
  const from = graph.nodes.find((x) => x.id === w.from);
  return (
    <div
      className="flex items-center gap-2 rounded border border-amber-400/40 bg-amber-400/5 px-2 py-1.5 text-[12px] text-muted"
      data-testid={`wired-${input}`}
    >
      <span className="h-2 w-2 shrink-0 rotate-45 bg-amber-400" />
      <span className="min-w-0 flex-1 truncate">
        From <b>{from ? nodeTitle(from) : w.from}</b> · {dataLabel(w.port)}
      </span>
      <Button size="sm" variant="ghost" title="Unwire it, to use its own text" onClick={() => onUnwire(input)}>
        <Unplug size={12} />
      </Button>
    </div>
  );
}

/** An input's own text, in a line, as its row on the canvas shows it when nothing is wired into it. */
function ownText(n: WorkflowNode, input: string): string {
  const own =
    n.kind === "column" || n.kind === "agent"
      ? n.prompt
      : n.kind === "send_to_task"
        ? n.message
        : n.kind === "open_pr"
          ? input === "title"
            ? n.title
            : n.body
          : "";
  return firstLine(own);
}

/** A data node's settings. */
function ValueInspector({
  node: n,
  graph,
  onChange,
  onUnwire,
}: {
  node: WorkflowNode;
  graph: WorkflowGraph;
  onChange: (patch: Partial<WorkflowNode>) => void;
  onUnwire: (input: string) => void;
}) {
  const inputs = workflowDataInputs(n);
  const uses = graph.edges.filter((e) => e.input != null && e.from === n.id).length;
  return (
    <>
      {n.kind === "text" && (
        <Field
          label="Text"
          hint={
            <>
              Templates: <code className="text-[11px]">{TEMPLATES}</code>.
            </>
          }
        >
          <Textarea rows={6} className="text-[12.5px]" value={n.text} onChange={(e) => onChange({ text: e.target.value })} />
        </Field>
      )}
      {n.kind === "task" && <p className="text-[11.5px] text-faint">The task's title, description, key, branch, commit, pull request and labels, as values.</p>}
      {n.kind === "project_prompt" && (
        <Field label="Prompt" hint="The project's own, from its Prompts settings, or the board's if it has none.">
          <select className={selectClass} value={n.which} onChange={(e) => onChange({ which: e.target.value as "start" | "review" | "merge" })}>
            <option value="start">Starting a task</option>
            <option value="review">Reviewing its changes</option>
            <option value="merge">Merging it</option>
          </select>
        </Field>
      )}
      {n.kind === "compose" && (
        <Field
          label="Template"
          hint={
            <>
              Each <code className="text-[11px]">{"{{name}}"}</code> without a dot is an input to wire a value into; unwired, it's the template's own value
              (such as <code className="text-[11px]">{"{{issues}}"}</code>) or left as it is. Templates: <code className="text-[11px]">{TEMPLATES}</code>.
            </>
          }
        >
          <Textarea rows={6} className="font-mono text-[12px]" value={n.template} onChange={(e) => onChange({ template: e.target.value })} />
        </Field>
      )}
      {n.kind === "join" && (
        <>
          <Field label="Inputs">
            <div className="w-24">
              <Input
                type="number"
                min={1}
                max={8}
                value={n.count}
                onChange={(e) => onChange({ count: Math.max(1, Math.min(8, Math.floor(Number(e.target.value) || 1))) })}
              />
            </div>
          </Field>
          <Field label="Between them" hint="\n is a new line. The inputs without text are left out.">
            <Input
              className="h-7 font-mono text-[12px]"
              value={n.separator.replaceAll("\n", "\\n")}
              onChange={(e) => onChange({ separator: e.target.value.replaceAll("\\n", "\n") })}
            />
          </Field>
        </>
      )}
      {n.kind === "switch" && (
        <>
          <Field label="Gives its yes input when">
            <select
              className={selectClass}
              value={n.check}
              onChange={(e) => {
                const check = e.target.value as WorkflowCheck;
                onChange({ check, value: check === "task_type" ? "code" : check === "label" ? LABELS[0] : null });
              }}
            >
              {(["has_pr", "task_type", "label"] as const).map((c) => (
                <option key={c} value={c}>
                  {CHECK_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
          {n.check === "task_type" && (
            <Field label="Type">
              <select className={selectClass} value={n.value ?? "code"} onChange={(e) => onChange({ value: e.target.value })}>
                <option value="code">Code</option>
                <option value="scratch">Scratch</option>
              </select>
            </Field>
          )}
          {n.check === "label" && (
            <Field label="Label">
              <select className={selectClass} value={n.value ?? LABELS[0]} onChange={(e) => onChange({ value: e.target.value })}>
                {LABELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </>
      )}
      {inputs.length > 0 && (
        <div className="space-y-1">
          <span className="block text-xs font-medium text-muted">Inputs</span>
          {inputs.map((k) => (
            <div key={k} className="flex items-center gap-2 text-[12px] text-muted">
              <span className="w-14 shrink-0 font-mono text-[11.5px]">{dataLabel(k)}</span>
              <div className="min-w-0 flex-1">
                <Wired graph={graph} node={n} input={k} onUnwire={onUnwire}>
                  <span className="text-[11.5px] text-faint">Nothing wired</span>
                </Wired>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="text-[11.5px] text-faint">
        A value is read when the step it goes into runs: a step's output is from its run, or the workflow's last run on the task that ran it.{" "}
        {uses ? `It goes into ${uses} input${uses === 1 ? "" : "s"}.` : "Wire it into an input to use it."}
      </p>
    </>
  );
}
