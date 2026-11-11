import { toJson } from "../../ui/json"
import { useEffect, useState, type RefObject } from "react"
import type { Status } from "@huntaway/contracts"
import { isFiltering, isSortKey, type SortKey } from "../boardQuery"
import { ARCHIVED_KEY, BACKLOG_KEY, isView, loadQuery, queryKey, SORT_KEY, VIEW_KEY, type BoardView } from "./model"

/**
 * What the board shows: its view, its filters (kept by `boardKey`), search and sort, and which of its columns and
 * sections are open. `kanbanRef` is the kanban board, which scrolls back to the backlog as it opens.
 */
export function useBoardQuery(boardKey: string, kanbanRef: RefObject<HTMLDivElement | null>) {
  const [view, setView] = useState<BoardView>(() => {
    const v = localStorage.getItem(VIEW_KEY)
    return isView(v) ? v : "board"
  })
  const [collapsed, setCollapsed] = useState<Set<Status>>(() => new Set())
  const [backlogOpen, setBacklogOpen] = useState(() => localStorage.getItem(BACKLOG_KEY) === "open")
  const [archivedOpen, setArchivedOpen] = useState(() => localStorage.getItem(ARCHIVED_KEY) === "open")
  const [query, setQuery] = useState(() => loadQuery(boardKey))
  // What's typed in the search box, kept here as the box moves between the header and the row below it.
  const [search, setSearch] = useState("")
  useEffect(() => {
    if (isFiltering(query)) sessionStorage.setItem(queryKey(boardKey), toJson(query))
    else sessionStorage.removeItem(queryKey(boardKey))
  }, [boardKey, query])
  const [sort, setSort] = useState<SortKey>(() => {
    const s = localStorage.getItem(SORT_KEY)
    return isSortKey(s) ? s : "manual"
  })
  const changeSort = (s: SortKey) => {
    setSort(s)
    localStorage.setItem(SORT_KEY, s)
  }

  const changeView = (v: BoardView) => {
    setView(v)
    localStorage.setItem(VIEW_KEY, v)
  }

  const toggleBacklog = () => {
    setBacklogOpen(!backlogOpen)
    localStorage.setItem(BACKLOG_KEY, backlogOpen ? "closed" : "open")
    // The column opens at the start, which may be scrolled out of view: bring it back.
    if (!backlogOpen) requestAnimationFrame(() => kanbanRef.current?.scrollTo({ left: 0, behavior: "smooth" }))
  }

  const toggleArchived = (open = !archivedOpen) => {
    setArchivedOpen(open)
    localStorage.setItem(ARCHIVED_KEY, open ? "open" : "closed")
  }
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
