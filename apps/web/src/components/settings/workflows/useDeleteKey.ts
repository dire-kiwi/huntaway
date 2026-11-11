import type { WorkflowGraph, WorkflowNode } from "@huntaway/contracts"
import { useEffect, useEffectEvent } from "react"
import type { Selection } from "./useGraph"

/** Delete, Backspace or X removes what's selected, as in Blender (not while typing in a field). */
export function useDeleteKey({
  sel,
  graph,
  removable,
  removeEdge,
  removeNode,
}: {
  sel: Selection
  graph: WorkflowGraph
  removable: (n: WorkflowNode, g?: WorkflowGraph) => boolean
  removeEdge: (i: number) => void
  removeNode: (id: string) => void
}): void {
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.key !== "Delete" && e.key !== "Backspace" && e.key !== "x" && e.key !== "X") return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const t = e.target instanceof HTMLElement ? e.target : null
    if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return
    if (!sel) return
    if ("edge" in sel) {
      e.preventDefault()
      removeEdge(sel.edge)
      return
    }
    const n = graph.nodes.find((x) => x.id === sel.node)
    if (n && removable(n, graph)) {
      e.preventDefault()
      removeNode(n.id)
    }
  })
  useEffect(() => {
    const key = (e: KeyboardEvent) => onKey(e)
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [])
}
