import clsx from "clsx";
import { ArrowRightLeft, Bot, Flag, GitFork, Play, Plus, Send, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  api,
  hostStatuses,
  LABELS,
  STATUSES,
  WORKFLOW_CHECKS,
  workflowPorts,
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
import { ReviewerRow } from "../task/Reviewers";
import { Button, Field, Input, Modal, Textarea, Toggle, useConfirm } from "../ui";

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
      <p className="text-[12.5px] text-muted">
        A workflow starts when a task enters a column (or when you run it from the task), and runs its steps in order: checks, agents that read the work in
        threads of their own and write their output to a tab of the task, messages to the task's agent, and moves to another column. The review and summary in
        the Review tab can be set up as one: start from <i>Review and summarise</i>.
      </p>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <Button key={p.name} size="sm" onClick={() => setEditing({ workflow: null, name: p.name === "Blank" ? "" : p.name, graph: p.graph() })}>
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

/** What a workflow does, in a line: its trigger and steps. */
export function graphText(g: WorkflowGraph) {
  const t = g.nodes.find((n) => n.kind === "trigger");
  const when = t?.kind === "trigger" && t.on === "status" ? `When a task moves to ${statusLabel(t.status)}` : "Run by hand";
  const agents = g.nodes.filter((n) => n.kind === "agent").map((n) => (n.kind === "agent" ? n.name : ""));
  return [when, agents.length ? agents.join(", ") : "no agent steps"].join(" · ");
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
  }
}

/** What a node does, under its title. */
export function nodeText(n: WorkflowNode) {
  switch (n.kind) {
    case "trigger":
      return n.on === "status" ? `When a task moves to ${statusLabel(n.status)}` : "When run by hand";
    case "condition":
      return n.check === "task_type" || n.check === "label" ? `${CHECK_LABELS[n.check]}: ${n.value ?? "?"}` : CHECK_LABELS[n.check];
    case "agent":
      return `${n.output === "verdict" ? "Pass or issues" : "Writes text"}${n.tab ? ` · ${n.tab} tab` : ""}`;
    case "send_to_task":
      return `${n.message.trim() ? "Its own message" : "The issues found"} · up to ${n.max_rounds} round${n.max_rounds === 1 ? "" : "s"}`;
    case "set_status":
      return `To ${statusLabel(n.status)}`;
  }
}

export const KIND_STYLE: Record<WorkflowNodeKindName, { icon: ReactNode; tone: string }> = {
  trigger: { icon: <Play size={12} />, tone: "text-emerald-400" },
  condition: { icon: <GitFork size={12} />, tone: "text-amber-400" },
  agent: { icon: <Bot size={12} />, tone: "text-accent" },
  send_to_task: { icon: <Send size={12} />, tone: "text-sky-400" },
  set_status: { icon: <ArrowRightLeft size={12} />, tone: "text-violet-400" },
};

export const PORT_LABELS: Record<string, string> = {
  out: "then",
  yes: "yes",
  no: "no",
  done: "done",
  failed: "failed",
  pass: "pass",
  issues: "issues",
  exhausted: "out of rounds",
};

/** Starting points for a new workflow. */
const PRESETS: { name: string; graph: () => WorkflowGraph }[] = [
  {
    name: "Review and summarise",
    graph: () => ({
      nodes: [
        { id: "start", kind: "trigger", on: "status", status: "in_review", x: 20, y: 120 },
        { id: "changed", kind: "condition", check: "changed", x: 220, y: 120 },
        { id: "reviewer", kind: "agent", name: "Reviewer", prompt: "", output: "verdict", tab: "Review", skills: [], x: 420, y: 100 },
        { id: "fix", kind: "send_to_task", message: "", max_rounds: 2, x: 640, y: 30 },
        {
          id: "summary",
          kind: "agent",
          name: "Summary",
          prompt:
            "Summarise what the work on {{task.key}} changed, for someone deciding whether to merge it: what it does and how, what was tested, and anything to check or decide before it's merged. Keep it short, with headings and lists where they help.",
          output: "text",
          tab: "Summary",
          skills: [],
          x: 640,
          y: 190,
        },
      ],
      edges: [
        { from: "start", port: "out", to: "changed" },
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
const nodeH = (n: WorkflowNode) => HEAD + portsOf(n).length * PORT_H + 6;
const portY = (i: number) => HEAD + i * PORT_H + PORT_H / 2;

function edgePath(x1: number, y1: number, x2: number, y2: number) {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

/** Whether `to` reaches `from` already, so an edge from `from` to `to` would make a loop. */
function reaches(edges: WorkflowEdge[], to: string, from: string) {
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edges) if (e.from === id) stack.push(e.to);
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

/** Where a new node of height `h` goes: the first place in view clear of the others, or else below them all. */
function freeSpot(g: WorkflowGraph, h: number, view: HTMLElement | null) {
  const left = view?.scrollLeft ?? 0;
  const top = view?.scrollTop ?? 0;
  const right = left + (view?.clientWidth ?? 800) - NODE_W - 20;
  const bottom = top + (view?.clientHeight ?? 460) - h - 20;
  const clear = (x: number, y: number) =>
    g.nodes.every((n) => x + NODE_W + 20 <= n.x || n.x + NODE_W + 20 <= x || y + h + 20 <= n.y || n.y + nodeH(n) + 20 <= y);
  for (let y = Math.ceil((top + 20) / 10) * 10; y <= bottom; y += 30)
    for (let x = Math.ceil((left + 20) / 10) * 10; x <= right; x += 40) if (clear(x, y)) return { x, y };
  return { x: 20, y: Math.max(0, ...g.nodes.map((n) => n.y + nodeH(n))) + 30 };
}

const NEW_NODES: { kind: Exclude<WorkflowNodeKindName, "trigger">; label: string; base: string; make: () => Partial<WorkflowNode> }[] = [
  { kind: "condition", label: "Check", base: "check", make: () => ({ kind: "condition", check: "changed" }) },
  { kind: "agent", label: "Agent", base: "agent", make: () => ({ kind: "agent", name: "Agent", prompt: "", output: "text", tab: null, skills: [] }) },
  { kind: "send_to_task", label: "Send to task", base: "send", make: () => ({ kind: "send_to_task", message: "", max_rounds: 2 }) },
  { kind: "set_status", label: "Move task", base: "move", make: () => ({ kind: "set_status", status: "needs_attention" }) },
];

type Selection = { node: string } | { edge: number } | null;
type Gesture = { kind: "move"; id: string; dx: number; dy: number } | { kind: "link"; from: string; port: string; x: number; y: number } | null;

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
  const [name, setName] = useState(initialName);
  const [enabled, setEnabled] = useState(workflow?.enabled ?? true);
  const [graph, setGraph] = useState<WorkflowGraph>(() => structuredClone(initialGraph));
  const [sel, setSel] = useState<Selection>(() => ({ node: initialGraph.nodes.find((n) => n.kind === "trigger")?.id ?? "" }));
  const [gesture, setGesture] = useState<Gesture>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inner = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  const dirty = name !== initialName || JSON.stringify(graph) !== JSON.stringify(initialGraph) || enabled !== (workflow?.enabled ?? true);

  const at = (e: { clientX: number; clientY: number }) => {
    const r = inner.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  useEffect(() => {
    if (!gesture) return;
    const move = (e: PointerEvent) => {
      const p = at(e);
      if (gesture.kind === "move") {
        const x = Math.max(0, Math.round((p.x - gesture.dx) / 10) * 10);
        const y = Math.max(0, Math.round((p.y - gesture.dy) / 10) * 10);
        setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === gesture.id ? { ...n, x, y } : n)) }));
      } else setGesture({ ...gesture, x: p.x, y: p.y });
    };
    const up = (e: PointerEvent) => {
      if (gesture.kind === "link") {
        const to = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-node]")?.dataset.node;
        if (to) connect(gesture.from, gesture.port, to);
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
    if (graph.edges.some((e) => e.from === from && e.port === port && e.to === to)) return;
    if (reaches(graph.edges, to, from))
      return setErr("That would make a loop. To go round again, send to the task's agent: its next turn starts the workflow again.");
    setGraph((g) => ({ ...g, edges: [...g.edges, { from, port, to }] }));
  };
  const addNode = (spec: (typeof NEW_NODES)[number]) => {
    const id = freshId(graph, spec.base);
    const node = { ...spec.make(), id, x: 0, y: 0 } as WorkflowNode;
    Object.assign(node, freeSpot(graph, nodeH(node), scroller.current));
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
  const updateNode = (id: string, patch: Partial<WorkflowNode>) =>
    setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as WorkflowNode) : n)) }));
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
          {NEW_NODES.map((s) => (
            <Button key={s.kind} size="sm" variant="ghost" disabled={graph.nodes.length >= 40} onClick={() => addNode(s)}>
              <span className={KIND_STYLE[s.kind].tone}>{KIND_STYLE[s.kind].icon}</span> {s.label}
            </Button>
          ))}
          <span className="ml-auto text-[11.5px] text-faint">Drag from a step's outcome to another step to connect them. Click a line to remove it.</span>
        </div>
        <div className="flex min-h-0 gap-3 narrow:flex-col">
          <div
            ref={scroller}
            className="h-[460px] min-w-0 flex-1 overflow-auto rounded-md border border-line bg-[radial-gradient(circle,rgba(255,255,255,0.06)_1px,transparent_1px)] [background-size:20px_20px]"
            onPointerDown={(e) => {
              if (e.target === e.currentTarget || e.target === inner.current) setSel(null);
            }}
          >
            <div ref={inner} className="relative select-none" style={{ width, height }} data-testid="workflow-canvas">
              <svg className="pointer-events-none absolute inset-0" width={width} height={height}>
                {graph.edges.map((e, i) => {
                  const a = byId.get(e.from);
                  const b = byId.get(e.to);
                  if (!a || !b) return null;
                  const p = portPos(a, e.port);
                  const d = edgePath(p.x, p.y, b.x, b.y + IN_Y);
                  const on = sel && "edge" in sel && sel.edge === i;
                  return (
                    <g
                      key={`${e.from}-${e.port}-${e.to}`}
                      className="pointer-events-auto cursor-pointer"
                      onPointerDown={(ev) => (ev.stopPropagation(), setSel({ edge: i }))}
                    >
                      <path d={d} fill="none" stroke="transparent" strokeWidth={12} data-edge={`${e.from}.${e.port}->${e.to}`} />
                      <path d={d} fill="none" className={on ? "stroke-accent" : "stroke-line-strong"} strokeWidth={on ? 2.5 : 1.75} />
                    </g>
                  );
                })}
                {gesture?.kind === "link" &&
                  (() => {
                    const a = byId.get(gesture.from);
                    if (!a) return null;
                    const p = portPos(a, gesture.port);
                    return <path d={edgePath(p.x, p.y, gesture.x, gesture.y)} fill="none" className="stroke-accent" strokeWidth={1.75} strokeDasharray="4 3" />;
                  })()}
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
                    {n.kind !== "trigger" && (
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
                            setGesture({ kind: "link", from: n.id, port: p, x: at0.x, y: at0.y });
                          }}
                        />
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="w-80 shrink-0 space-y-3 overflow-y-auto narrow:w-full md:max-h-[460px]" data-testid="workflow-inspector">
            {selected ? (
              <NodeInspector
                key={selected.id}
                project={project}
                node={selected}
                inputs={graph.edges.filter((e) => e.to === selected.id).length}
                onChange={(patch) => updateNode(selected.id, patch)}
                onRename={(id) => renameNode(selected.id, id)}
                onRemove={() => removeNode(selected.id)}
              />
            ) : selectedEdge ? (
              <div className="space-y-2 text-[12.5px]">
                <div className="font-medium">Connection</div>
                <div className="text-muted">
                  When <b>{nodeTitle(byId.get(selectedEdge.from)!)}</b> ends with <i>{PORT_LABELS[selectedEdge.port] ?? selectedEdge.port}</i>,{" "}
                  <b>{nodeTitle(byId.get(selectedEdge.to)!)}</b> runs.
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
                <p>
                  <b>Send to the task's agent</b> ends the run. Once the agent's turn ends and the task enters the start's column again, the workflow runs
                  again; after its rounds, its <i>out of rounds</i> outcome runs instead, or the task moves to Needs attention.
                </p>
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
  onChange,
  onRename,
  onRemove,
}: {
  project: Project;
  node: WorkflowNode;
  inputs: number;
  onChange: (patch: Partial<WorkflowNode>) => void;
  onRename: (id: string) => void;
  onRemove: () => void;
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
        {n.kind !== "trigger" && (
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
      {n.kind === "trigger" && (
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
            <Textarea rows={6} className="text-[12.5px]" value={n.prompt} onChange={(e) => onChange({ prompt: e.target.value })} />
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
          <p className="text-[11.5px] text-faint">It runs in a thread of its own on the task's worktree, with read-only tools.</p>
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
            <Textarea rows={5} className="text-[12.5px]" value={n.message} onChange={(e) => onChange({ message: e.target.value })} />
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
      {n.kind === "trigger" && (
        <div className="flex items-center gap-1.5 text-[11.5px] text-faint">
          <Flag size={11} /> Every workflow has one start.
        </div>
      )}
    </div>
  );
}
