import { useState } from "react";
import { api, ApiError, type Task } from "../../../../api";
import { closeTask, navigate } from "../../../../router";
import { isGroupTask, profileNameOf, useStore } from "../../../../store";
import { useSubprojectProgress } from "../../../board/TaskCard";
import { ConfirmModal, Toggle } from "../../../ui";
import { useSubproject } from "../hooks";
import type { Mode } from "../layout";

export function TeardownModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const [force, setForce] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  return (
    <ConfirmModal
      title="Tear down worktree"
      width="max-w-lg"
      body={
        <>
          <p>
            Runs the project's teardown script, then removes the worktree directory. The branch <span className="font-mono text-fg">{task.branch}</span> is
            kept unless you delete it, so the agent can pick up where it left off later.
          </p>
          <Toggle checked={force} onChange={setForce} label="Discard uncommitted changes" />
          <Toggle checked={deleteBranch} onChange={setDeleteBranch} label="Also delete the branch" />
        </>
      }
      action="Tear down"
      danger
      onConfirm={() => api.teardownWorktree(task.host_id, task.id, { force, delete_branch: deleteBranch })}
      onClose={onClose}
    />
  );
}

export function DeleteTaskModal({ task, mode, onClose }: { task: Task; mode: Mode; onClose: () => void }) {
  const [deleteBranch, setDeleteBranch] = useState(false);
  const subproject = useSubproject(task);
  const children = useSubprojectProgress(task.id)?.total ?? 0;
  const go = async () => {
    const pid = task.project_id;
    // Gone already (deleted from another window, say) is as good as deleted.
    await api.deleteTask(task.host_id, task.id, deleteBranch).catch((e) => {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    });
    if (mode !== "page") closeTask(true);
    else if (subproject) navigate({ name: "subproject", taskId: subproject.id }, true);
    else if (pid) navigate({ name: "board", projectId: pid }, true);
    else if (isGroupTask(task)) navigate({ name: "group", hostId: task.host_id, group: task.group_name! }, true);
    else {
      const profile = profileNameOf(useStore.getState(), task);
      if (profile) navigate({ name: "profile", profile }, true);
    }
  };
  return (
    <ConfirmModal
      title="Delete task"
      width="max-w-lg"
      body={
        <>
          <p>
            This stops any running agent, deletes the thread, and removes its worktree, discarding any uncommitted changes.
            {task.subproject && children > 0 && (
              <span className="text-amber-200/90">
                {" "}
                Its {children} task{children === 1 ? "" : "s"} {children === 1 ? "is" : "are"} deleted the same way.
              </span>
            )}
          </p>
          {task.branch && (
            <Toggle
              checked={deleteBranch}
              onChange={setDeleteBranch}
              label={task.subproject && children > 0 ? `Also delete branch ${task.branch} and its tasks' branches` : `Also delete branch ${task.branch}`}
            />
          )}
        </>
      }
      action="Delete"
      danger
      onConfirm={go}
      onClose={onClose}
    />
  );
}
