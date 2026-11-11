import type { ReactNode } from "react"
import { loadActiveProfile } from "../../../activeProfile"
import { href, parse } from "../../../router"
import { useBoard } from "../../../state/board"
import { openTaskModal, usePanel, useTaskModal } from "../../../state/route"
import { resolveTaskRef } from "./taskRefs"

/** The task whose page, panel or dialog is open, which a key without a profile is looked for beside. */
function useNearTaskId(): string | undefined {
  const panel = usePanel()
  const modal = useTaskModal()
  if (modal) return modal
  if (panel) return panel.taskId
  const r = parse(window.location.pathname)
  return r.name === "task" ? r.taskId : undefined
}

/** A key marked by `remarkTaskRefs`: a link that opens its task in a dialog over the page, or the text it was when there's no such task. */
export function TaskRef({ taskKey, profile, children }: { taskKey?: string | undefined; profile?: string | undefined; children?: ReactNode }) {
  const nearId = useNearTaskId()
  const active = loadActiveProfile()
  const found = useBoard((s) => {
    const r = resolveTaskRef(s, taskKey ?? "", profile ?? "", nearId ? s.tasks[nearId] : undefined, active)
    return r && `${r.task.id}\n${r.qualified ? 1 : 0}\n${r.task.title}`
  })
  if (!found || !taskKey) return <>{children}</>
  const [id = "", qualified, ...title] = found.split("\n")
  const link = (
    <a
      href={href({ name: "task", taskId: id })}
      title={title.join("\n")}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        e.stopPropagation()
        // Over the page, rather than moving to its board (HA-326).
        openTaskModal(id)
      }}
    >
      {qualified === "1" || !profile ? children : taskKey}
    </a>
  )
  // A word before the key that isn't a profile's name stays text before the link.
  return qualified === "1" || !profile ? (
    link
  ) : (
    <>
      {profile}:{link}
    </>
  )
}
