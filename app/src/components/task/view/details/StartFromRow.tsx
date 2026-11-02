import { api, type Project, type StartFrom, type Task } from "../../../../api";
import { useStore } from "../../../../store";
import { errorText } from "../../../ui";
import { Row, TextInput } from "./Section";

/** What a task's start_from says, as it's typed: another task's key, a branch, `#12` (or a pull request's URL) or a commit. */
function startFromText(sf: StartFrom | null | undefined, other: Task | undefined, project?: Project | null): string | null {
  if (!sf) return null;
  switch (sf.type) {
    case "branch":
      return sf.branch;
    case "task":
      return other ? `${project?.key ?? "T"}-${other.number}` : "a deleted task";
    case "pull_request":
      return sf.repo ? `https://github.com/${sf.repo}/pull/${sf.number}` : `#${sf.number}`;
    case "commit":
      return sf.commit;
  }
}

/**
 * What the task's worktree starts from (API 95): until its branch exists, another task's key (stacking it on that task's
 * branch), a branch, a pull request or a commit, or blank for the base branch; then what it started from, if anything.
 * A subproject's tasks start from its branch.
 */
export function StartFromRow({ task, project, onError }: { task: Task; project?: Project | null; onError: (e: string | null) => void }) {
  const other = useStore((s) => (task.start_from?.type === "task" ? s.tasks[task.start_from.task_id] : undefined));
  const text = startFromText(task.start_from, other, project);
  if (task.parent_id) return null;
  // Until the branch is made (a setup that failed before then can be tried again from elsewhere).
  if (task.branch || !["none", "error"].includes(task.worktree_state)) {
    return text ? (
      <Row label="Started from">
        <span className="font-mono text-[11.5px] break-all">{text}</span>
      </Row>
    ) : null;
  }
  return (
    <Row label="Starts from">
      <TextInput
        value={text}
        placeholder={`${task.base_branch || project?.base_branch || "the base branch"}, or a task, branch, #PR or commit`}
        onSave={(v) => {
          onError(null);
          api.updateTask(task.host_id, task.id, { start_from: v || null }).catch((e) => onError(`Couldn't change where it starts from: ${errorText(e)}`));
        }}
      />
    </Row>
  );
}
