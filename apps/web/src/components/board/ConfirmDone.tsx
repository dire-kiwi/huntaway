import { useCallback, useState } from "react"
import { taskKey, type HostTask as Task } from "@huntaway/client"
import type { Resolution } from "@huntaway/contracts"
import { useProject } from "../boardHelpers"
import { Button, Modal, ModalFooter, prLabel, RESOLUTION_LABELS } from "../ui"
import { keyList, openIncomingNow } from "./MergesInto"
import { openLevelsNow } from "./StackedOn"

/**
 * Asks before a task moves into Done with `resolution` (Done by default) when that leaves something behind:
 * with the Done resolution, work that isn't merged; with another, tasks merging into it (API 128), whose merges then
 * wait for you to say where they go. `confirmDone(task, resolution)` resolves to whether to go ahead. Render `dialog`
 * while it asks. A check that fails doesn't stop the move.
 */
export function useConfirmDone() {
  const [asking, setAsking] = useState<{ task: Task; resolution: Resolution; incoming: Task[]; levels: Task[]; answer: (go: boolean) => void } | null>(null)
  const confirmDone = useCallback(async (task: Task, resolution: Resolution = "done") => {
    if (task.status === "done") return true
    const incoming = openIncomingNow(task.id)
    // And the stack levels on it.
    const levels = openLevelsNow(task.id)
    const ask = () => {
      const { promise, resolve: answer } = Promise.withResolvers<boolean>()
      setAsking((before) => {
        // Asked about another task meanwhile: that move doesn't happen.
        before?.answer(false)
        return { task, resolution, incoming, levels, answer }
      })
      return promise
    }
    // Closed without being merged: the tasks merging into it wait for you.
    if (resolution !== "done") return incoming.length || levels.length ? ask() : true
    // With Done, the old board asked whether the task's work is merged (`api.unmerged`): not yet on this server, which
    // has no git until M4, so the move goes ahead.
    return true
  }, [])
  const close = (go: boolean) => {
    asking?.answer(go)
    setAsking(null)
  }
  const dialog =
    asking &&
    (asking.resolution === "done" ? (
      <UnmergedModal task={asking.task} incoming={asking.incoming} levels={asking.levels} onClose={() => close(false)} onConfirm={() => close(true)} />
    ) : (
      <ClosingModal
        task={asking.task}
        resolution={asking.resolution}
        incoming={asking.incoming}
        levels={asking.levels}
        onClose={() => close(false)}
        onConfirm={() => close(true)}
      />
    ))
  return { confirmDone, dialog }
}

function UnmergedModal({
  task,
  incoming,
  levels,
  onClose,
  onConfirm,
}: {
  task: Task
  incoming: Task[]
  levels: Task[]
  onClose: () => void
  onConfirm: () => void
}) {
  const project = useProject(task.project_id)
  const key = taskKey(task)
  const base = task.base_branch || project?.base_branch || "its base branch"
  return (
    <Modal title="Move to Done without merging?" onClose={onClose} onSubmit={onConfirm} width="max-w-md">
      <div className="space-y-4 text-[13px]">
        <p className="text-muted">
          <span className="text-fg">
            {key} {task.title}
          </span>{" "}
          has work that isn't merged into {base}
          {task.pr_url && <> (its pull request {prLabel(task.pr_url)} isn't merged)</>}. Moving it to Done doesn't merge it: Ready for merge has its agent do
          that. Its branch and worktree are kept.
        </p>
        {incoming.length > 0 && (
          <p className="text-amber-200/90">
            {keyList(incoming, project)} {incoming.length === 1 ? "merges" : "merge"} into it: {incoming.length === 1 ? "it merges" : "they merge"} into {base}{" "}
            instead.
          </p>
        )}
        {levels.length > 0 && (
          <p className="text-amber-200/90">
            {keyList(levels, project)} {levels.length === 1 ? "lands" : "land"} after it: the board restacks {levels.length === 1 ? "it" : "them"} onto {base}{" "}
            as if it were merged, without its commits.
          </p>
        )}
        <ModalFooter className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Move to Done
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  )
}

/** Closing a task (not done, won't fix) that others merge into: their merges wait for you to say where they go. */
function ClosingModal({
  task,
  resolution,
  incoming,
  levels,
  onClose,
  onConfirm,
}: {
  task: Task
  resolution: Resolution
  incoming: Task[]
  levels: Task[]
  onClose: () => void
  onConfirm: () => void
}) {
  const project = useProject(task.project_id)
  const key = taskKey(task)
  return (
    <Modal title={`Complete as ${RESOLUTION_LABELS[resolution].toLowerCase()}?`} onClose={onClose} onSubmit={onConfirm} width="max-w-md">
      <div className="space-y-4 text-[13px]">
        <p className="text-muted">
          <span className="text-fg">
            {key} {task.title}
          </span>{" "}
          is closed without being merged.
        </p>
        {incoming.length > 0 && (
          <p className="text-amber-200/90">
            {keyList(incoming, project)} {incoming.length === 1 ? "merges" : "merge"} into it: {incoming.length === 1 ? "its merge waits" : "their merges wait"}
            , and you'll be asked where {incoming.length === 1 ? "it goes" : "they go"} now (where it was going, one of them in its place, or closed too).
          </p>
        )}
        {levels.length > 0 && (
          <p className="text-amber-200/90">
            {keyList(levels, project)} {levels.length === 1 ? "lands" : "land"} after it: {levels.length === 1 ? "its merge waits" : "their merges wait"}, and
            you'll be asked where {levels.length === 1 ? "it goes" : "they go"} now (where it was going, one of them in its place, or closed too).
          </p>
        )}
        <ModalFooter className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Complete as {RESOLUTION_LABELS[resolution].toLowerCase()}
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  )
}
