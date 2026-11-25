import { Effect } from "effect"
import { useMemo, useState } from "react"
import { callRpc, isScratch, mutate, splitAttachments, taskKey, taskLabels, withAttachments, type HostTask as Task } from "@huntaway/client"
import { AttachmentId, TaskId } from "@huntaway/contracts"
import { Loader2 } from "lucide-react"
import { sortProjects } from "../../projectOrder"
import { useBoard } from "../../state/board"
import { useAction } from "../../state/mutation"
import { navigate } from "../../state/route"
import { profileNameOf } from "../boardHelpers"
import { Button, ErrorBox, Modal, ModalFooter, Select, type MenuItem } from "../ui"

/** The menu item that opens a {@link MoveTaskModal} for the task. */
export const moveItem = (onPick: () => void, divider = false): MenuItem => ({ label: "Move to project…", divider, onSelect: onPick })

/**
 * HE-110: moves a task to another project. A task can't change project (its key, branch and worktree are its
 * project's), so this makes a new task there with its title, prompt and labels, and then, if asked, deletes this one.
 * The new one is in To do (or Backlog, from there), with its agent not started.
 */
export function MoveTaskModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const projects = useBoard((s) => s.projects)
  const profiles = useBoard((s) => s.profiles)
  const choices = useMemo(() => sortProjects(projects.filter((p) => !(p.host_id === task.host_id && p.id === task.project_id))), [projects, task])
  // The profile's name beside each project, when any is another profile's (whose login its agent then runs under).
  const named = choices.some((p) => p.host_id !== task.host_id || p.profile_id !== task.profile_id)
  const [picked, setPicked] = useState("")
  const target = choices.find((p) => `${p.host_id}:${p.id}` === picked) ?? choices[0]
  const [{ busy, error }, run] = useAction()
  // The task made, if deleting this one then failed: trying again only deletes, rather than making another.
  const [made, setMade] = useState<{ id: string; key: string } | null>(null)

  /**
   * The description as the task on `host` has it. The files attached to it are paths on the task's host: to another
   * host they're copied (`attachments.get` here, `attachments.upload` there), and the list names the copies.
   */
  const descriptionOn = Effect.fn("descriptionOn")(function* (host: string) {
    const description = task.description ?? ""
    const { text, files } = splitAttachments(description)
    if (host === task.host_id || !files.length) return description
    const copies = yield* Effect.forEach(files, (f) =>
      callRpc(task.host_id, "attachments.get", { id: AttachmentId.make(f.id), name: f.name }).pipe(
        Effect.flatMap((a) => mutate("attachments.upload", host, { name: a.name, data: a.data })),
      ),
    )
    return withAttachments(text, copies)
  })

  /** Makes the new task in `to`. */
  const create = Effect.fn("createMoved")(function* (to: NonNullable<typeof target>) {
    const labels = taskLabels(task)
    const description = yield* descriptionOn(to.host_id)
    const t = yield* mutate("tasks.create", to.host_id, {
      task: {
        project_id: to.id,
        title: task.title,
        ...(description ? { description } : {}),
        status: task.status === "backlog" ? "backlog" : "todo",
        ...(labels.length ? { labels } : {}),
        ...(isScratch(task) ? { task_type: "scratch" as const } : {}),
      },
    })
    return { id: t.id, key: taskKey(t) }
  })

  const go = (deleteOriginal: boolean) => {
    const making = made ? Effect.succeed(made) : target ? create(target) : null
    if (busy || !making) return
    void run(
      Effect.gen(function* () {
        const copy = yield* making
        setMade(copy)
        // Gone already (deleted from another window, say) is as good as deleted.
        if (deleteOriginal) yield* mutate("tasks.delete", task.host_id, { id: TaskId.make(task.id) }).pipe(Effect.catchTag("NotFound", () => Effect.void))
        onClose()
        navigate({ name: "task", taskId: copy.id }, deleteOriginal)
      }),
    )
  }

  return (
    <Modal title={`Move ${taskKey(task)} to another project`} onClose={onClose} width="max-w-lg">
      <div className="space-y-4 text-[13px]">
        <div className="space-y-3 text-muted">
          {choices.length === 0 ? (
            <p>There's no other project to move it to.</p>
          ) : (
            <>
              <label className="flex items-center gap-3">
                <span className="text-fg">Project</span>
                <Select
                  aria-label="Project"
                  value={target ? `${target.host_id}:${target.id}` : ""}
                  onChange={setPicked}
                  disabled={busy || !!made}
                  className="min-w-0 flex-1"
                >
                  {choices.map((p) => {
                    const profile = named ? profileNameOf({ profiles }, p) : undefined
                    return (
                      <option key={`${p.host_id}:${p.id}`} value={`${p.host_id}:${p.id}`}>
                        {profile ? `${p.name} (${profile})` : p.name}
                      </option>
                    )
                  })}
                </Select>
              </label>
              <p>
                A new task is made there with this one's title, prompt and labels, in {task.status === "backlog" ? "Backlog" : "To do"}, with its agent not
                started. Its thread, branch and worktree stay with this one.
              </p>
              <p>Delete the original to move it, or keep it to have both. Deleting it stops any running agent and removes its worktree.</p>
            </>
          )}
        </div>
        <ModalFooter className="space-y-3">
          {error && <ErrorBox>{made ? `Made ${made.key}, but couldn't delete ${taskKey(task)}: ${error}` : `Couldn't move the task: ${error}`}</ErrorBox>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {choices.length > 0 && (
              <>
                <Button type="button" disabled={busy} onClick={() => go(false)}>
                  {made ? `Keep ${taskKey(task)}` : "Keep original"}
                </Button>
                <Button type="button" variant="danger" disabled={busy} onClick={() => go(true)}>
                  {busy && <Loader2 size={13} className="animate-spin" />} {made ? `Delete ${taskKey(task)}` : "Delete original"}
                </Button>
              </>
            )}
          </div>
        </ModalFooter>
      </div>
    </Modal>
  )
}
