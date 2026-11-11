import { isMerged, type HostTask as Task } from "@huntaway/client"
import { TaskId } from "@huntaway/contracts"
import { useState } from "react"
import { board } from "../../../../state/board"
import { closeTask, closeTaskModal, navigate } from "../../../../state/route"
import { isTagged, rpc } from "../../../../state/rpc"
import { isGroupTask, profileNameOf, useProject } from "../../../boardHelpers"
import { keyList, useReaching } from "../../../board/MergesInto"
import { useOpenLevels } from "../../../board/StackedOn"
import { ConfirmModal, Toggle } from "../../../ui"
import type { Mode } from "../layout"

// A subproject's tasks were a legacy branch, and are gone.

export function TeardownModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const [force, setForce] = useState(false)
  const [deleteBranch, setDeleteBranch] = useState(false)
  return (
    <ConfirmModal
      title="Tear down worktree"
      width="max-w-lg"
      body={
        <>
          <p>
            Runs the project's teardown script, then removes the worktree directory. The branch <span className="font-mono text-fg">{task.branch}</span> is kept
            unless you delete it, so the agent can pick up where it left off later.
          </p>
          <Toggle checked={force} onChange={setForce} label="Discard uncommitted changes" />
          <Toggle checked={deleteBranch} onChange={setDeleteBranch} label="Also delete the branch" />
        </>
      }
      action="Tear down"
      danger
      onConfirm={() => rpc(task.host_id, "git.teardownWorktree", { id: TaskId.make(task.id), force, delete_branch: deleteBranch })}
      onClose={onClose}
    />
  )
}

export function DeleteTaskModal({ task, mode, onClose }: { task: Task; mode: Mode; onClose: () => void }) {
  const [deleteBranch, setDeleteBranch] = useState(false)
  // The tasks merging into it that aren't done (API 128): their merges wait for you to say where they go.
  const incoming = useReaching(task.id)
  // And the stack levels on it (API 142), unless it's merged (they go where it went).
  const levels = useOpenLevels(task.status === "done" && isMerged(task) ? null : task.id)
  const project = useProject(task.project_id)
  const go = async () => {
    const pid = task.project_id
    // Gone already (deleted from another window, say) is as good as deleted.
    await rpc(task.host_id, "tasks.delete", { id: TaskId.make(task.id), delete_branch: deleteBranch }).catch((e: unknown) => {
      if (!isTagged(e, "NotFound")) throw e
    })
    if (mode === "modal") closeTaskModal(true)
    else if (mode !== "page") closeTask(true)
    else if (pid) navigate({ name: "board", projectId: pid }, true)
    else if (isGroupTask(task) && task.group_name) navigate({ name: "group", hostId: task.host_id, group: task.group_name }, true)
    else {
      const profile = profileNameOf(board.get(), task)
      if (profile) navigate({ name: "profile", profile }, true)
    }
  }
  return (
    <ConfirmModal
      title="Delete task"
      width="max-w-lg"
      body={
        <>
          <p>This stops any running agent, deletes the thread, and removes its worktree, discarding any uncommitted changes.</p>
          {incoming.length > 0 && (
            <p className="text-amber-200/90">
              {keyList(incoming, project)} {incoming.length === 1 ? "merges" : "merge"} into it:{" "}
              {incoming.length === 1 ? "its merge waits" : "their merges wait"}, and you'll be asked where {incoming.length === 1 ? "it goes" : "they go"} now.
            </p>
          )}
          {levels.length > 0 && (
            <p className="text-amber-200/90">
              {keyList(levels, project)} {levels.length === 1 ? "lands" : "land"} after it: {levels.length === 1 ? "its merge waits" : "their merges wait"}, and
              you'll be asked where {levels.length === 1 ? "it goes" : "they go"} now.
            </p>
          )}
          {task.branch && <Toggle checked={deleteBranch} onChange={setDeleteBranch} label={`Also delete branch ${task.branch}`} />}
        </>
      }
      action="Delete"
      danger
      onConfirm={go}
      onClose={onClose}
    />
  )
}
