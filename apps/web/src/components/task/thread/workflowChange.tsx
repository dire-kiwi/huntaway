import { WorkflowGraph, type WorkflowChange, type WorkflowView } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Option, Schema } from "effect"
import { ArrowRight } from "lucide-react"
import { graphText, KIND_STYLE, nodeText, nodeTitle, portLabel } from "../../settings/workflows/text"

// The detail of a workflow an agent asks to create, change or delete (the old task/Approvals.tsx's
// WorkflowChangeDetail), in its approval card (requestCards.tsx's WorkflowChangeCard).

/** A workflow's graph, as the approval carries it (`Schema.Unknown` on the wire); null when it isn't one. */
const graphOf = Schema.decodeUnknownOption(WorkflowGraph)
export const workflowGraph = (w: Pick<WorkflowView, "graph"> | null | undefined): WorkflowGraph | null => (w ? Option.getOrNull(graphOf(w.graph)) : null)

/** A workflow's steps, each with what it does and where its outcomes go, and an agent step's config and instructions. */
function WorkflowSteps({ w, tone = "to" }: { w: WorkflowView; tone?: "from" | "to" }) {
  const g = workflowGraph(w)
  const title = (id: string) => {
    const n = g?.nodes.find((x) => x.id === id)
    return n ? nodeTitle(n) : id
  }
  return (
    <div className={clsx("space-y-2 text-[12.5px]", tone === "from" && "text-muted")}>
      <div className="flex items-center gap-2">
        <span className="font-medium text-fg">{w.name}</span>
        {!w.enabled && <span className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-faint">Off</span>}
        {g && <span className="truncate text-faint">{graphText(g)}</span>}
      </div>
      {g && (
        <ol className="space-y-1.5">
          {g.nodes.map((n) => {
            const out = g.edges.filter((e) => e.from === n.id)
            const config = w.configs.find((c) => c.node === n.id)
            return (
              <li key={n.id} className="rounded-md border border-line/70 px-2.5 py-1.5">
                <div className={clsx("flex items-center gap-1.5", KIND_STYLE[n.kind].tone)}>
                  {KIND_STYLE[n.kind].icon}
                  <span className="font-medium text-fg">{nodeTitle(n)}</span>
                  <span className="truncate text-faint">· {nodeText(n, g)}</span>
                </div>
                {n.kind === "agent" && (
                  <div className="mt-1 space-y-1 text-[12px] text-muted">
                    <div>
                      {config ? `${config.name}${config.agent === "codex" ? " (Codex)" : ""}` : "The task's config"}
                      {n.model ? ` · ${n.model}` : ""}
                      {n.effort ? ` · ${n.effort} effort` : ""}
                      {n.skills?.length ? ` · skills: ${n.skills.join(", ")}` : ""}
                    </div>
                    {n.prompt.trim() && <div className="max-h-40 overflow-auto rounded bg-white/[0.03] px-2 py-1 whitespace-pre-wrap">{n.prompt}</div>}
                  </div>
                )}
                {n.kind === "send_to_task" && n.message.trim() && (
                  <div className="mt-1 max-h-40 overflow-auto rounded bg-white/[0.03] px-2 py-1 text-[12px] whitespace-pre-wrap text-muted">{n.message}</div>
                )}
                {out.length > 0 && (
                  <div className="mt-1 text-[11.5px] text-faint">
                    {out.map((e, i) => (
                      <span key={`${e.port}->${e.to}.${e.input ?? ""}`}>
                        {i > 0 && "; "}
                        {portLabel(n, e.port)} → {title(e.to)}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

const WORKFLOW_CHANGES: Record<string, string> = { name: "Name", graph: "Steps", enabled: "On" }

/** What an agent asked to do to a workflow: all of a new one, or a change from what it does now. */
export function WorkflowChangeDetail({ change }: { change: WorkflowChange }) {
  const { reason, workflow: w, before, op } = change
  return (
    <div className="space-y-3 text-[13px]">
      {reason && <div className="rounded-md border-l-2 border-line-strong bg-white/[0.03] px-3 py-2 text-muted">{reason}</div>}
      {op === "update" && before && (
        <ul className="space-y-1">
          {(change.changes ?? []).map((k) => (
            <li key={k} className="flex min-w-0 items-center gap-2">
              <span className="rounded bg-st-attention/15 px-1.5 py-0.5 text-[11px] text-st-attention">{WORKFLOW_CHANGES[k] ?? k}</span>
              {k === "name" && (
                <span className="flex min-w-0 items-center gap-2 font-mono text-[12px]">
                  <span className="truncate text-faint line-through">{before.name}</span>
                  <ArrowRight size={12} className="shrink-0 text-faint" />
                  <span className="truncate text-fg">{w.name}</span>
                </span>
              )}
              {k === "enabled" && <span className="text-[12px]">{w.enabled ? "Turns it on" : "Turns it off"}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className={clsx("rounded-md border bg-[#0c0c10] px-3 py-2", op === "delete" ? "border-red-500/30" : "border-st-attention/30")}>
        {op === "update" && <div className="mb-2 text-[12px] text-muted">As it would be:</div>}
        <WorkflowSteps w={w} />
      </div>
      {op === "update" && before && (change.changes ?? []).includes("graph") && (
        <details className="rounded-md border border-line px-3 py-2">
          <summary className="cursor-pointer text-[12px] text-muted">As it is now</summary>
          <div className="mt-2">
            <WorkflowSteps w={before} tone="from" />
          </div>
        </details>
      )}
      {op === "create" && (
        <p className="text-muted">
          Its agent steps run in threads of their own on the project's tasks, and it can send the tasks' agents messages and move the tasks.
        </p>
      )}
      {op === "delete" && <p className="text-muted">Its runs stop, and their output goes from the tasks' tabs.</p>}
    </div>
  )
}
