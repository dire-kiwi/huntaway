import { useCallback, useState } from "react";
import { api, hostSupports, type Task } from "../api";
import { taskKey, useProject, useStore } from "../store";
import { Button, Modal, ModalFooter, prLabel } from "./ui";

/** Hosts from this API version say whether a task's work is merged (`api.unmerged`). */
export const UNMERGED_API = 75;

/**
 * Asks before a task whose work isn't merged moves into Done (with the Done resolution): `confirmDone(task)` resolves
 * to whether to go ahead. Render `dialog` while it asks. A check that fails doesn't stop the move.
 */
export function useConfirmDone() {
  const [asking, setAsking] = useState<{ task: Task; answer: (go: boolean) => void } | null>(null);
  const confirmDone = useCallback(async (task: Task) => {
    const host = useStore.getState().hosts.find((h) => h.id === task.host_id);
    if (task.status === "done" || task.kind !== "task" || !task.project_id || task.task_type || !hostSupports(host, UNMERGED_API)) return true;
    const unmerged = await api.unmerged(task.host_id, task.id).then((r) => r.unmerged, () => false);
    if (!unmerged) return true;
    return new Promise<boolean>((answer) =>
      setAsking((before) => {
        // Asked about another task meanwhile: that move doesn't happen.
        before?.answer(false);
        return { task, answer };
      }),
    );
  }, []);
  const close = (go: boolean) => {
    asking?.answer(go);
    setAsking(null);
  };
  const dialog = asking && <UnmergedModal task={asking.task} onClose={() => close(false)} onConfirm={() => close(true)} />;
  return { confirmDone, dialog };
}

function UnmergedModal({ task, onClose, onConfirm }: { task: Task; onClose: () => void; onConfirm: () => void }) {
  const project = useProject(task.project_id);
  const key = useStore((s) => taskKey(task, s.projects));
  const base = task.base_branch || project?.base_branch || "its base branch";
  return (
    <Modal title="Move to Done without merging?" onClose={onClose} onSubmit={onConfirm} width="max-w-md">
      <div className="space-y-4 text-[13px]">
        <p className="text-muted">
          <span className="text-fg">
            {key} {task.title}
          </span>{" "}
          has work that isn't merged into {base}
          {task.pr_url && <> (its pull request {prLabel(task.pr_url)} isn't merged)</>}. Moving it to Done doesn't merge it: Ready for merge has its
          agent do that. Its branch and worktree are kept.
        </p>
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
  );
}
