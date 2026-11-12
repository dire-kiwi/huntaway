import { useAtom } from "@effect/atom-react"
import { toJson } from "../../ui/json"
import { useEffect, useState, type RefObject } from "react"
import type { Status } from "@huntaway/contracts"
import { archivedSectionAtom, backlogAtom, boardSortAtom, boardViewAtom } from "../../../state/prefs"
import { isFiltering, isSortKey, type SortKey } from "../boardQuery"
import { loadQuery, queryKey } from "./model"

/**
 * What the board shows: its view, its filters (kept by `boardKey`), search and sort, and which of its columns and
 * sections are open. `kanbanRef` is the kanban board, which scrolls back to the backlog as it opens.
 */
export function useBoardQuery(boardKey: string, kanbanRef: RefObject<HTMLDivElement | null>) {
  // Kept in this browser, for every board: the view, the sort, and whether Backlog and Archived are open.
  const [view, changeView] = useAtom(boardViewAtom)
  const [collapsed, setCollapsed] = useState<Set<Status>>(() => new Set())
  const [backlog, setBacklog] = useAtom(backlogAtom)
  const backlogOpen = backlog === "open"
  const [archived, setArchived] = useAtom(archivedSectionAtom)
  const archivedOpen = archived === "open"
  const [query, setQuery] = useState(() => loadQuery(boardKey))
  // What's typed in the search box, kept here as the box moves between the header and the row below it.
  const [search, setSearch] = useState("")
  useEffect(() => {
    if (isFiltering(query)) sessionStorage.setItem(queryKey(boardKey), toJson(query))
    else sessionStorage.removeItem(queryKey(boardKey))
  }, [boardKey, query])
  const [keptSort, changeSort] = useAtom(boardSortAtom)
  const sort: SortKey = isSortKey(keptSort) ? keptSort : "manual"

  const toggleBacklog = () => {
    setBacklog(backlogOpen ? "closed" : "open")
    // The column opens at the start, which may be scrolled out of view: bring it back.
    if (!backlogOpen) requestAnimationFrame(() => kanbanRef.current?.scrollTo({ left: 0, behavior: "smooth" }))
  }

  const toggleArchived = (open = !archivedOpen) => setArchived(open ? "open" : "closed")
  // From the kanban board's Done column, which leaves archived tasks out.
  const showArchived = () => {
    changeView("list")
    toggleArchived(true)
    requestAnimationFrame(() => document.getElementById("archived-tasks")?.scrollIntoView({ behavior: "smooth", block: "start" }))
  }

  const toggleCollapsed = (status: Status) =>
    setCollapsed((c) => {
      const next = new Set(c)
      if (!next.delete(status)) next.add(status)
      return next
    })

  return {
    view,
    changeView,
    collapsed,
    toggleCollapsed,
    backlogOpen,
    toggleBacklog,
    archivedOpen,
    toggleArchived,
    showArchived,
    query,
    setQuery,
    search,
    setSearch,
    sort,
    changeSort,
  }
}

export type BoardQueryState = ReturnType<typeof useBoardQuery>
