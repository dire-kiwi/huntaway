// "Back to …": the link from a document to the page of the board it was opened from.
import { ArrowLeft } from "lucide-react"
import { parse } from "../../../router"
import { useBoard } from "../../../state/board"
import { BoardLink } from "./chrome"

/** What a page of the board is called in "Back to …": the task, project or profile it shows, or just where it is. */
function useWhere(from: string): string {
  return useBoard((s) => {
    const url = new URL(from, window.location.origin)
    const route = parse(url.pathname)
    const task = (id: string | null | undefined) => (id ? s.tasks[id] : undefined)
    const named = (t: ReturnType<typeof task>) => t?.title
    const panel = named(task(new URLSearchParams(url.search).get("task")))
    if (route.name === "task") return named(task(route.taskId)) ?? "the task"
    if (route.name === "board") return panel ?? s.projects.find((p) => p.id === route.projectId)?.name ?? "the board"
    if (route.name === "docs") return route.slug === undefined ? "the documents" : "the document"
    if (route.name === "profile") return panel ?? "the profile"
    if (route.name === "home") return "the board"
    return panel ?? "where you were"
  })
}

/** A link back to the page the user opened the document from (a message's link to it, say), if they came from one. */
export function BackLink({ from }: { from: string }) {
  const where = useWhere(from)
  return (
    <BoardLink
      to={from}
      className="no-drag flex min-w-0 max-w-[40%] shrink items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-[12.5px] text-muted hover:text-fg"
      title={`Back to ${where}`}
    >
      <ArrowLeft size={13} className="shrink-0" />
      <span className="truncate">Back to {where}</span>
    </BoardLink>
  )
}
