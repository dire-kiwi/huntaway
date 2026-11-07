// Arranging a workflow's nodes (the editor's Arrange): its steps in columns by how far along a run they come, each
// value in the column before the step it goes into, and each column's nodes in the order that keeps the wires
// between them straightest, so that few cross.
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from "./api";

/** How the editor draws a node: its height, and where on it an edge leaves (`from`) and arrives (`to`). */
export interface LayoutGeometry {
  width: number;
  height: (n: WorkflowNode) => number;
  fromY: (n: WorkflowNode, e: WorkflowEdge) => number;
  toY: (n: WorkflowNode, e: WorkflowEdge) => number;
  isData: (n: WorkflowNode) => boolean;
}

const GAP_X = 90;
const GAP_Y = 30;
const ORIGIN = 20;
const SWEEPS = 8;
/** The board's columns in its order, which a loop's runs are taken to start from first. */
const COLUMNS = ["backlog", "todo", "in_progress", "in_review", "ready_for_merge", "needs_attention", "done"];

/** `graph` with its nodes moved to their arranged places (its edges as they are). */
export function arrange(graph: WorkflowGraph, geo: LayoutGeometry): WorkflowGraph {
  const nodes = graph.nodes;
  if (!nodes.length) return graph;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = graph.edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);
  const flow = edges.filter((e) => e.input == null && !geo.isData(byId.get(e.from)!) && !geo.isData(byId.get(e.to)!));
  const wires = edges.filter((e) => e.input != null);
  const steps = nodes.filter((n) => !geo.isData(n));

  // The lines that go back round (a review sending the task back to In progress) don't count for the columns:
  // a depth-first walk from where runs start finds them.
  const out = new Map<string, WorkflowEdge[]>(nodes.map((n) => [n.id, []]));
  for (const e of flow) out.get(e.from)!.push(e);
  const into = new Set(flow.map((e) => e.to));
  // Where runs start: steps nothing goes into, then (as a loop has none) the start, then the columns in the board's order.
  const rank = (n: WorkflowNode) =>
    n.kind === "trigger" ? -1 : n.kind === "column" ? COLUMNS.indexOf(n.status) + 1 || COLUMNS.length + 1 : COLUMNS.length + 2;
  const byStart = (a: WorkflowNode, b: WorkflowNode) => rank(a) - rank(b) || a.x - b.x || a.y - b.y;
  const roots = [...steps.filter((n) => !into.has(n.id)).sort(byStart), ...[...steps].sort(byStart)];
  const back = new Set<WorkflowEdge>();
  const state = new Map<string, "open" | "done">();
  const walk = (id: string) => {
    state.set(id, "open");
    for (const e of out.get(id)!) {
      const s = state.get(e.to);
      if (s === "open") back.add(e);
      else if (!s) walk(e.to);
    }
    state.set(id, "done");
  };
  for (const r of roots) if (!state.has(r.id)) walk(r.id);
  const forward = flow.filter((e) => !back.has(e));

  // A step's column: the longest way to it from a start.
  const col = new Map<string, number>();
  const ins = new Map<string, WorkflowEdge[]>(nodes.map((n) => [n.id, []]));
  for (const e of forward) ins.get(e.to)!.push(e);
  const stepCol = (id: string): number => {
    const known = col.get(id);
    if (known !== undefined) return known;
    col.set(id, 0);
    const c = Math.max(0, ...ins.get(id)!.map((e) => stepCol(e.from) + 1));
    col.set(id, c);
    return c;
  };
  for (const n of steps) stepCol(n.id);
  // A value's: the one before the first step (or value) it goes into; one that goes nowhere, the first.
  const uses = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of wires) uses.get(e.from)!.push(e.to);
  const seen = new Set<string>();
  const valueCol = (id: string): number => {
    const known = col.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const to = uses.get(id)!;
    const c = to.length ? Math.min(...to.map((t) => (geo.isData(byId.get(t)!) ? valueCol(t) : stepCol(t)) - 1)) : 0;
    col.set(id, c);
    return c;
  };
  for (const n of nodes) if (geo.isData(n)) valueCol(n.id);
  const least = Math.min(...col.values());
  const columns: WorkflowNode[][] = [];
  for (const n of nodes) (columns[col.get(n.id)! - least] ??= []).push(n);
  for (const c of columns) c?.sort((a, b) => a.y - b.y || a.x - b.x);

  // Places, column by column, each node as level as it can be with what it's joined to on the side being swept from.
  const place = new Map<string, { x: number; y: number }>();
  columns.forEach((c, i) => {
    let y = ORIGIN;
    for (const n of c ?? []) {
      place.set(n.id, { x: ORIGIN + i * (geo.width + GAP_X), y });
      y += geo.height(n) + GAP_Y;
    }
  });
  const ends = edges.filter((e) => !back.has(e));
  const level = (n: WorkflowNode, fromLeft: boolean): number | null => {
    const ys: number[] = [];
    for (const e of ends) {
      if (fromLeft && e.to === n.id) ys.push(place.get(e.from)!.y + geo.fromY(byId.get(e.from)!, e) - geo.toY(n, e));
      if (!fromLeft && e.from === n.id) ys.push(place.get(e.to)!.y + geo.toY(byId.get(e.to)!, e) - geo.fromY(n, e));
    }
    return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
  };
  const sweep = (c: WorkflowNode[], fromLeft: boolean) => {
    const wanted = new Map(c.map((n) => [n.id, level(n, fromLeft) ?? place.get(n.id)!.y]));
    c.sort((a, b) => wanted.get(a.id)! - wanted.get(b.id)!);
    let next = ORIGIN;
    for (const n of c) {
      const y = Math.max(next, Math.round(wanted.get(n.id)! / 10) * 10);
      place.get(n.id)!.y = y;
      next = y + geo.height(n) + GAP_Y;
    }
  };
  const filled = columns.filter(Boolean);
  for (let i = 0; i < SWEEPS; i++) {
    for (const c of filled.slice(1)) sweep(c, true);
    for (const c of filled.slice(0, -1).reverse()) sweep(c, false);
  }
  for (const c of filled.slice(1)) sweep(c, true);
  // The whole of it from the top.
  const top = Math.min(...[...place.values()].map((p) => p.y));
  return { ...graph, nodes: nodes.map((n) => ({ ...n, x: place.get(n.id)!.x, y: place.get(n.id)!.y - top + ORIGIN })) };
}
