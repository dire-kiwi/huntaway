import { WORKFLOW_MAX_WEIGHT, WORKFLOW_PATHS, type WorkflowGraph, type WorkflowNode } from "@huntaway/contracts"
import { Plus, Trash2 } from "lucide-react"
import { Button, Input, Toggle } from "../../ui"
import type { NodePatch } from "./graph"
import { nodeTitle, pathShare } from "./text"

/** An A/B test's settings: its paths' weights, and whether a task keeps the path it took. */
export function SplitInspector({
  node: n,
  graph,
  onChange,
  onRemovePath,
}: {
  node: Extract<WorkflowNode, { readonly kind: "split" }>
  graph: WorkflowGraph
  onChange: (patch: NodePatch) => void
  onRemovePath: (i: number) => void
}) {
  const setWeight = (i: number, v: string) => {
    const w = Math.max(0, Math.min(WORKFLOW_MAX_WEIGHT, Number(v) || 0))
    onChange({ weights: n.weights.map((x, k) => (k === i ? w : x)) })
  }
  const target = (port: string) => {
    const to = graph.edges.filter((e) => e.input === undefined && e.from === n.id && e.port === port).map((e) => graph.nodes.find((x) => x.id === e.to))
    return to.length ? to.map((x) => (x ? nodeTitle(x) : "?")).join(", ") : "Nothing connected"
  }
  const total = n.weights.reduce((a, w) => a + w, 0)
  return (
    <>
      <div className="space-y-1.5" data-testid="split-paths">
        <span className="block text-xs font-medium text-muted">Paths</span>
        {n.weights.map((w, i) => {
          const path = WORKFLOW_PATHS[i] ?? ""
          const letter = path.toUpperCase()
          return (
            // Paths have no identity but their place: removing one moves the ones after it up a letter.
            <div key={path} className="flex items-center gap-2 text-[12px]">
              <span className="w-4 shrink-0 font-medium text-fg">{letter}</span>
              <div className="w-20 shrink-0">
                <Input
                  type="number"
                  min={0}
                  max={WORKFLOW_MAX_WEIGHT}
                  className="h-7"
                  aria-label={`Weight of path ${letter}`}
                  value={w}
                  onChange={(e) => setWeight(i, e.target.value)}
                />
              </div>
              <span className="w-10 shrink-0 text-right text-muted tabular-nums">{pathShare(n.weights, i)}%</span>
              <span className="min-w-0 flex-1 truncate text-faint" title={target(path)}>
                → {target(path)}
              </span>
              {n.weights.length > 2 && (
                <Button size="sm" variant="ghost" title={`Remove path ${letter}`} onClick={() => onRemovePath(i)}>
                  <Trash2 size={12} />
                </Button>
              )}
            </div>
          )
        })}
        {n.weights.length < WORKFLOW_PATHS.length && (
          <Button size="sm" variant="ghost" onClick={() => onChange({ weights: [...n.weights, 50] })}>
            <Plus size={12} /> Add a path
          </Button>
        )}
        {total <= 0 && <p className="text-[11.5px] text-red-400">Give a path a weight above 0.</p>}
      </div>
      <Toggle checked={!!n.each_run} onChange={(v) => onChange({ each_run: v || undefined })} label="Pick again each run" />
      <p className="text-[11.5px] text-faint">
        A run takes one of its paths at random, each as likely as its weight says (out of all of them), to compare two reviewers on the same kind of work, say.{" "}
        {n.each_run ? "Each run picks again." : "A task keeps the path it took the first time, so the same reviewer sees all of its rounds."} Its <i>path</i>{" "}
        value (and <code className="text-[11px]">{`{{${n.id}.path}}`}</code>) is the path it took: A, B…
      </p>
    </>
  )
}
