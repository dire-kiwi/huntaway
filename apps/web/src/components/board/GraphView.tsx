import { clsx } from "clsx"
import { useMemo } from "react"
import { backgroundIdle, isScratch, keyPrefix, taskLabels, type HostProject as Project, type HostTask as Task } from "@huntaway/client"
import { openTask, usePanelOpen } from "../../state/route"
import { useSelectable } from "../../selection"

import { RunningDot, StatusIcon, STATUS_COLOR } from "../ui"
import type { OnMenu, Progress } from "./TaskCard"
import { stackedBelowId } from "./StackedOn"
import { useBoard } from "../../state/board"

/**
 * The board's tasks as a map of how they came about and what waits on what: a task its agent
 * created follows its creator, a task that depends on another follows it, and a task that merges into or lands
 * after another follows it. Tasks made together from one prompt are boxed together. Tasks with no
 * links are left in a grid underneath.
 */

type EdgeKind = "created" | "depends" | "merges" | "stacked"
const EDGE_KINDS: EdgeKind[] = ["created", "depends", "merges", "stacked"]
interface Edge {
  from: string
  to: string
  kind: EdgeKind
}
interface Placed {
  task: Task
  /** Not on the board (another board's, or filtered out), shown for the link to it. */
  ghost: boolean
  x: number
  y: number
}

const NODE_W = 232
const NODE_H = 66
const GAP_X = 72
const GAP_Y = 14
const COMPONENT_GAP = 40

const EDGE_STYLE: Record<EdgeKind, { dash?: string | undefined; color: string; label: string }> = {
  created: { color: "var(--color-line-strong)", label: "created by" },
  depends: { dash: "5 4", color: "color-mix(in srgb, var(--color-st-attention) 55%, transparent)", label: "waits for" },
  merges: { color: "color-mix(in srgb, var(--color-st-done) 55%, transparent)", label: "merges into" },
  stacked: { dash: "8 3", color: "color-mix(in srgb, var(--color-st-review) 60%, transparent)", label: "lands after" },
}

/** Lays out each group of linked tasks left to right, a column per generation, and stacks the groups. */
function layout(shown: Task[], all: Readonly<Record<string, Task>>) {
  const nodes = new Map<string, { task: Task; ghost: boolean }>()
  const fanoutOf = (id: string) => nodes.get(id)?.task.fanout_id ?? id
  for (const t of shown) nodes.set(t.id, { task: t, ghost: false })
  // One link between two tasks: waiting on it says the most, then merging into it (API 128), then landing after it.
  const links = new Map<string, Edge>()
  const RANK: Record<EdgeKind, number> = { depends: 0, merges: 1, stacked: 2, created: 3 }
  const link = (from: string, to: string, kind: EdgeKind) => {
    if (!nodes.has(from)) {
      const t = all[from]
      if (!t) return
      nodes.set(from, { task: t, ghost: true })
    }
    const had = links.get(`${from}>${to}`)
    if (!had || RANK[kind] < RANK[had.kind]) links.set(`${from}>${to}`, { from, to, kind })
  }
  // (A copy: linking adds the tasks it links to that aren't shown.)
  for (const { task: t, ghost } of Array.from(nodes.values())) {
    if (ghost) continue
    if (t.created_by) link(t.created_by, t.id, "created")
    for (const d of t.depends_on ?? []) link(d, t.id, "depends")
    // To the task it merges into, which comes after it (shown faded if it's not on the board).
    const into = t.merges_into ? all[t.merges_into] : undefined
    if (into) {
      if (!nodes.has(into.id)) nodes.set(into.id, { task: into, ghost: true })
      link(t.id, into.id, "merges")
    }
    // From the task it's stacked on (API 142), which it lands after.
    const belowId = stackedBelowId(t)
    const below = belowId ? all[belowId] : undefined
    if (below) link(below.id, t.id, "stacked")
  }
  // Without the links a longer way round already makes (A → C when A → B → C): a plan leads to the
  // first of its tasks, and the rest follow from them, rather than a fan of lines across the whole map.
  const out = new Map<string, string[]>()
  for (const e of links.values()) out.set(e.from, [...(out.get(e.from) ?? []), e.to])
  const reaches = (from: string, to: string, skip: string) => {
    const seen = new Set<string>()
    const stack = (out.get(from) ?? []).filter((n) => n !== skip)
    while (stack.length) {
      const n = stack.pop()
      if (n === undefined) break
      if (n === to) return true
      if (seen.has(n)) continue
      seen.add(n)
      stack.push(...(out.get(n) ?? []))
    }
    return false
  }
  const edges = [...links.values()].filter((e) => !reaches(e.from, e.to, e.to))

  // Groups of linked tasks (made together from one prompt counts as linked).
  const parent = new Map<string, string>()
  const find = (a: string): string => {
    const p = parent.get(a) ?? a
    if (p === a) return a
    const r = find(p)
    parent.set(a, r)
    return r
  }
  const union = (a: string, b: string) => parent.set(find(a), find(b))
  for (const e of edges) union(e.from, e.to)
  const fanouts = new Map<string, string[]>()
  for (const [id, n] of nodes) if (n.task.fanout_id) fanouts.set(n.task.fanout_id, [...(fanouts.get(n.task.fanout_id) ?? []), id])
  for (const [first, ...rest] of fanouts.values()) for (const id of rest) if (first) union(first, id)
  const linked = new Set([...edges.flatMap((e) => [e.from, e.to]), ...[...fanouts.values()].filter((ids) => ids.length > 1).flat()])

  // A task's column: one past the furthest of what leads to it.
  const into = new Map<string, Edge[]>()
  for (const e of edges) into.set(e.to, [...(into.get(e.to) ?? []), e])
  const layer = new Map<string, number>()
  const depth = (id: string, seen = new Set<string>()): number => {
    const known = layer.get(id)
    if (known !== undefined) return known
    if (seen.has(id)) return 0
    seen.add(id)
    const d = Math.max(-1, ...(into.get(id) ?? []).map((e) => depth(e.from, seen))) + 1
    layer.set(id, d)
    return d
  }

  const groups = new Map<string, string[]>()
  for (const id of linked) groups.set(find(id), [...(groups.get(find(id)) ?? []), id])
  const created = (id: string) => nodes.get(id)?.task.created_at ?? ""
  // The biggest groups first, then the most recent.
  const ordered = [...groups.values()].toSorted(
    (a, b) => b.length - a.length || Math.max(...b.map((i) => Date.parse(created(i)))) - Math.max(...a.map((i) => Date.parse(created(i)))),
  )

  const placed: Placed[] = []
  const boxes: { x: number; y: number; w: number; h: number; n: number }[] = []
  let top = 0
  let width = 0
  for (const ids of ordered) {
    const cols: string[][] = []
    for (const id of ids) (cols[depth(id)] ??= []).push(id)
    const y = new Map<string, number>()
    const want = (id: string) => {
      const from = (into.get(id) ?? []).map((e) => y.get(e.from)).filter((v): v is number => v !== undefined)
      return from.length ? from.reduce((a, b) => a + b, 0) / from.length : -1
    }
    // Each column in the order of what leads to it, a task as near the middle of its parents as there's room for.
    cols.forEach((col, c) => {
      // Tasks from one prompt stay side by side: they go where the first of them wants to.
      const groupWant = new Map<string, number>()
      for (const id of col) groupWant.set(fanoutOf(id), Math.min(groupWant.get(fanoutOf(id)) ?? Infinity, want(id)))
      const wantOf = (id: string) => groupWant.get(fanoutOf(id)) ?? Infinity
      const order = col.toSorted((a, b) => wantOf(a) - wantOf(b) || fanoutOf(a).localeCompare(fanoutOf(b)) || created(a).localeCompare(created(b)))
      let next = 0
      for (const id of order) {
        const at = Math.max(next, c === 0 ? next : Math.max(0, want(id)))
        y.set(id, at)
        next = at + NODE_H + GAP_Y
      }
    })
    const height = Math.max(...y.values()) + NODE_H
    for (const id of ids) {
      const n = nodes.get(id)
      if (n) placed.push({ task: n.task, ghost: n.ghost, x: depth(id) * (NODE_W + GAP_X), y: top + (y.get(id) ?? 0) })
    }
    width = Math.max(width, cols.length * (NODE_W + GAP_X) - GAP_X)
    top += height + COMPONENT_GAP
  }
  // A box around each set of tasks from one prompt.
  const at = new Map<string, Placed>(placed.map((p) => [p.task.id, p]))
  for (const ids of fanouts.values()) {
    const ps = ids.map((id) => at.get(id)).filter((p): p is Placed => !!p)
    if (ps.length < 2) continue
    const x0 = Math.min(...ps.map((p) => p.x))
    const y0 = Math.min(...ps.map((p) => p.y))
    boxes.push({
      x: x0 - 8,
      y: y0 - 18,
      w: Math.max(...ps.map((p) => p.x)) - x0 + NODE_W + 16,
      h: Math.max(...ps.map((p) => p.y)) - y0 + NODE_H + 26,
      n: ps.length,
    })
  }
  const unlinked = shown.filter((t) => !linked.has(t.id))
  return { placed, edges: edges.filter((e) => at.has(e.from) && at.has(e.to)), boxes, width, height: Math.max(0, top - COMPONENT_GAP), unlinked, at }
}

function Node({
  task,
  ghost,
  project,
  progress,
  onMenu,
  style,
}: {
  task: Task
  ghost?: boolean | undefined
  project?: Project | undefined
  progress?: Progress | undefined
  onMenu?: OnMenu | undefined
  style?: React.CSSProperties | undefined
}) {
  const open = usePanelOpen(task.id)
  const selectable = useSelectable(task.id)
  return (
    <div
      {...(ghost ? undefined : selectable)}
      role="button"
      tabIndex={0}
      aria-current={open || undefined}
      onClick={() => openTask(task.id)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault()
          openTask(task.id)
        }
      }}
      onContextMenu={onMenu && ((e) => onMenu(e, task))}
      title={ghost ? `${task.title} (not on this board)` : task.title}
      style={{ ...style, borderLeftColor: STATUS_COLOR[task.status] }}
      className={clsx(
        "flex cursor-pointer flex-col justify-center overflow-hidden rounded-md border border-l-[3px] bg-panel-2 px-2.5 py-1.5 outline-none transition-colors hover:border-line-strong hover:bg-raised focus-visible:ring-1 focus-visible:ring-accent",
        ghost ? "border-dashed border-line opacity-55" : task.status === "needs_attention" ? "border-st-attention/40" : "border-line",
        open && "bg-raised ring-1 ring-accent/60",
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-faint">
        <StatusIcon status={task.status} size={12} />
        <span className="font-mono">
          {keyPrefix(task, project)}-{task.number}
        </span>
        {isScratch(task) && <span className="text-accent">scratch</span>}
        {taskLabels(task).map((l) => (
          <span key={l} className="text-accent">
            {l}
          </span>
        ))}
        {!!progress?.total && (
          <span className="tabular-nums">
            {progress.done}/{progress.total}
          </span>
        )}
        {task.running && !backgroundIdle(task) && <RunningDot className="ml-auto" />}
      </div>
      <div className={clsx("line-clamp-2 text-[12.5px] leading-snug", task.status === "done" ? "text-muted" : "text-fg")}>{task.title}</div>
    </div>
  )
}

export function GraphView({
  tasks,
  projectOf,
  progressOf,
  onMenu,
}: {
  tasks: Task[]
  projectOf: (t: Task) => Project | undefined
  progressOf: (t: Task) => Progress | undefined
  onMenu?: OnMenu | undefined
}) {
  const all = useBoard((s) => s.tasks)
  const projects = useBoard((s) => s.projects)
  const { placed, edges, boxes, width, height, unlinked, at } = useMemo(() => layout(tasks, all), [tasks, all])
  // A ghost's project may not be one of the board's.
  const projectFor = (t: Task) => projectOf(t) ?? projects.find((p) => p.host_id === t.host_id && p.id === t.project_id)
  const PAD = 24

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {placed.length > 0 ? (
        <>
          <div className="flex items-center gap-4 px-6 pt-4 text-[11px] text-faint">
            {EDGE_KINDS.map((k) => (
              <span key={k} className="flex items-center gap-1.5">
                <svg width="28" height="6">
                  <line x1="0" y1="3" x2="28" y2="3" stroke={EDGE_STYLE[k].color} strokeWidth={1.5} strokeDasharray={EDGE_STYLE[k].dash} />
                </svg>
                {k === "created"
                  ? "created"
                  : k === "depends"
                    ? "waits for (merged first)"
                    : k === "stacked"
                      ? "lands after (or stacked on, on GitHub)"
                      : EDGE_STYLE[k].label}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-5 rounded border border-dashed border-accent/40" /> one prompt, several agents
            </span>
          </div>
          <div className="relative" style={{ width: width + 2 * PAD, height: height + 2 * PAD }}>
            <svg className="pointer-events-none absolute inset-0" width={width + 2 * PAD} height={height + 2 * PAD}>
              <defs>
                {EDGE_KINDS.map((k) => (
                  <marker key={k} id={`arrow-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0 0 L8 4 L0 8 z" fill={EDGE_STYLE[k].color} />
                  </marker>
                ))}
              </defs>
              {boxes.map((b) => (
                <g key={`${b.x}:${b.y}`}>
                  <rect
                    x={PAD + b.x}
                    y={PAD + b.y}
                    width={b.w}
                    height={b.h}
                    rx={8}
                    fill="color-mix(in srgb, var(--color-accent) 4%, transparent)"
                    stroke="color-mix(in srgb, var(--color-accent) 35%, transparent)"
                    strokeDasharray="4 3"
                  />
                  <text x={PAD + b.x + 8} y={PAD + b.y + 12} fontSize={10.5} fill="var(--color-faint)">
                    one prompt · {b.n} agents
                  </text>
                </g>
              ))}
              {edges.map((e) => {
                const a = at.get(e.from)
                const b = at.get(e.to)
                if (!a || !b) return null
                const x1 = PAD + a.x + NODE_W
                const y1 = PAD + a.y + NODE_H / 2
                const x2 = PAD + b.x - 2
                const y2 = PAD + b.y + NODE_H / 2
                const bend = Math.max(30, (x2 - x1) / 2)
                const s = EDGE_STYLE[e.kind]
                return (
                  <path
                    key={`${e.from}>${e.to}`}
                    d={`M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={1.5}
                    strokeDasharray={s.dash}
                    markerEnd={`url(#arrow-${e.kind})`}
                  />
                )
              })}
            </svg>
            {placed.map((p) => (
              <Node
                key={p.task.id}
                task={p.task}
                ghost={p.ghost}
                project={projectFor(p.task)}
                progress={progressOf(p.task)}
                onMenu={p.ghost ? undefined : onMenu}
                style={{ position: "absolute", left: PAD + p.x, top: PAD + p.y, width: NODE_W, height: NODE_H }}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="px-6 pt-6 text-[12.5px] text-faint">
          No task on this board was created by another, waits for another, or was made from the same prompt as another, so there's nothing to link.
        </div>
      )}
      {unlinked.length > 0 && (
        <section className="px-6 pt-2 pb-6">
          <h2 className="mb-2 text-[12px] font-medium text-muted">
            Not linked to other tasks <span className="text-faint">{unlinked.length}</span>
          </h2>
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${NODE_W}px, 1fr))` }}>
            {unlinked.map((t) => (
              <Node key={t.id} task={t} project={projectOf(t)} progress={progressOf(t)} onMenu={onMenu} style={{ height: NODE_H }} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
