import { parseJson } from "../../ui/json"
import { Inbox, Kanban, List, Network } from "lucide-react"
import { Status } from "@huntaway/contracts"
import { Schema } from "effect"
import { EMPTY_QUERY, TASK_FLAGS, TASK_KINDS, type BoardQuery, type TaskFlag, type TaskKind } from "../boardQuery"

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
const isKind = (k: string): k is TaskKind => TASK_KINDS.some((x) => x.id === k)
const isFlag = (f: string): f is TaskFlag => TASK_FLAGS.some((x) => x.id === f)

// Columns that get a "new task" button. New work starts in To do or Backlog.
export const CAN_ADD: ReadonlySet<Status> = new Set<Status>(["todo", "backlog"])

// Board and List show the tasks by status; the others are other ways of looking at the same tasks (HA-5).
export const VIEWS = [
  { id: "board", label: "Board", icon: Kanban, title: "Board view: a column for each status" },
  { id: "list", label: "List", icon: List, title: "List view: a section for each status" },
  { id: "triage", label: "Triage", icon: Inbox, title: "Triage view: what needs you, most pressing first" },
  { id: "graph", label: "Graph", icon: Network, title: "Graph view: which tasks led to which, and what waits on what" },
] as const
export type BoardView = (typeof VIEWS)[number]["id"]
export const isView = (v: string | null): v is BoardView => VIEWS.some((x) => x.id === v)
export const VIEW_KEY = "ia.boardView"
// How wide a board has to be for every view's name to show in the view switch (see `labelled` in ViewToggle).
export const WIDE_VIEWS = 1500
// Whether the kanban board's Backlog column is open (it starts collapsed), on this client.
export const BACKLOG_KEY = "ia.board.backlog"
// Whether the list view's Archived section is open (it starts collapsed), on this client.
export const ARCHIVED_KEY = "ia.board.archived"
// How wide a board has to be for its search, filter and sort controls to go in its header (see TaskBoard).
export const WIDE_BOARD = 1180
// How the boards sort their tasks, on this client.
export const SORT_KEY = "ia.board.sort"
// The column each board shows in the narrow layout (one at a time), on this client.
export const columnKey = (board: string) => `ia.board.column.${board}`
// Each board's search and filters, in this tab (so they last over a reload, and don't stay on forever).
export const queryKey = (board: string) => `ia.board.query.${board}`

export function loadQuery(board: string): BoardQuery {
  try {
    const q = parseJson(sessionStorage.getItem(queryKey(board)) ?? "null")
    if (!q || typeof q !== "object") return EMPTY_QUERY
    const kept: Partial<Record<keyof BoardQuery, unknown>> = q
    // A search kept from before HA-306 is left: it no longer filters the board.
    return {
      statuses: strings(kept.statuses).filter(Schema.is(Status)),
      kinds: strings(kept.kinds).filter(isKind),
      projects: strings(kept.projects),
      flags: strings(kept.flags).filter(isFlag),
    }
  } catch {
    return EMPTY_QUERY
  }
}

/** Where a dragged task would go: its column, the card it would go before, and in rows of pens, the row (its key). */
export type DropTarget = { status: Status; before: string | null; lane?: string | undefined }
