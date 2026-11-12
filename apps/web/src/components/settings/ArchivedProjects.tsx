import { Exit } from "effect"
import { Archive, ArchiveRestore } from "lucide-react"
import { useMemo, useState } from "react"
import { mutate, type HostProject as Project } from "@huntaway/client"
import { parse } from "../../router"
import { navigate } from "../../state/route"
import { Button, Modal, ModalFooter, timeAgo } from "../ui"
import { exitError, runExit, useMutation } from "../../state/mutation"
import { board, useBoard } from "../../state/board"
import { profileNames } from "../boardHelpers"

/**
 * Archives `project`: it goes off the board (the sidebar, its profile's and group's boards, agents'
 * project lists) until it's unarchived in Settings. Leaves a page about the project for the home page.
 */
export function ArchiveProjectModal({ project, onClose }: { project: Project; onClose: () => void }) {
  // Not the dialog's own action (useMutation): the project's event can take it off the page before the answer comes,
  // which would interrupt that, and what comes after (going home) has to happen still.
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const archive = (): void => {
    setErr(null)
    setBusy(true)
    void runExit(mutate("projects.update", project.host_id, { id: project.id, patch: { archived: true } })).then((exit) => {
      if (!Exit.isSuccess(exit)) {
        setErr(exitError(exit))
        setBusy(false)
        return
      }
      const s = board.get()
      const route = parse(window.location.pathname)
      const panel = new URLSearchParams(window.location.search).get("task")
      const taskId = route.name === "task" ? route.taskId : panel
      const here = ("projectId" in route && route.projectId === project.id) || (!!taskId && s.tasks[taskId]?.project_id === project.id)
      onClose()
      if (here) navigate({ name: "home" }, true)
    })
  }
  return (
    <Modal title={`Archive ${project.name}`} onClose={onClose}>
      <p className="mb-4 text-[13px] text-muted">
        The project goes off the board: out of the sidebar, the inbox and its group, and agents can&apos;t add tasks to it. Its tasks, worktrees and branches
        are kept. To bring it back, unarchive it in Settings → Archived projects.
      </p>
      <ModalFooter>
        {err && <div className="mb-3 text-xs text-red-400">{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={archive}>
            <Archive size={13} /> Archive project
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  )
}

const key = (p: Project): string => `${p.host_id}:${p.id}`

/**
 * The archived projects of every profile, on every host that has them, to unarchive. They are the board's (`archived`,
 * kept by its `project` events), so the list follows an archive or unarchive anywhere without being fetched again.
 */
export function ArchivedProjectsPanel() {
  const hosts = useBoard((s) => s.hosts)
  const profiles = useBoard((s) => s.profiles)
  const archived = useBoard((s) => s.archived)
  const list = useMemo(() => archived.toSorted((a, b) => (b.archived_at ?? "").localeCompare(a.archived_at ?? "")), [archived])
  const [state, update] = useMutation("projects.update")
  // The project last unarchived here: the one the button waits for, and the one the error names.
  const [last, setLast] = useState<Project | null>(null)
  if (!profiles.length) return null
  const manyProfiles = profileNames(profiles).length > 1
  const manyHosts = new Set(profiles.map((p) => p.host_id)).size > 1
  const unarchive = (p: Project): void => {
    setLast(p)
    void update(p.host_id, { id: p.id, patch: { archived: false } })
  }
  const err = state.error !== null && last ? `Unarchiving ${last.name}: ${state.error}` : null
  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold">Archived projects</h2>
      <div className="rounded-xl border border-line">
        {!list.length ? (
          <div className="px-4 py-3 text-[12.5px] text-faint">
            No archived projects. Archive one from its menu in the sidebar (right-click it) or its settings.
          </div>
        ) : (
          list.map((p) => (
            <div key={key(p)} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">
                  {p.name} <span className="text-faint">{p.key}</span>
                </div>
                <div className="truncate text-[11.5px] text-faint">
                  {[
                    manyProfiles && profiles.find((x) => x.host_id === p.host_id && x.id === p.profile_id)?.name,
                    manyHosts && hosts.find((h) => h.id === p.host_id)?.name,
                    p.archived_at && `archived ${timeAgo(p.archived_at)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              <Button size="sm" disabled={state.busy && last !== null && key(last) === key(p)} onClick={() => unarchive(p)}>
                <ArchiveRestore size={13} /> Unarchive
              </Button>
            </div>
          ))
        )}
      </div>
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
    </section>
  )
}
