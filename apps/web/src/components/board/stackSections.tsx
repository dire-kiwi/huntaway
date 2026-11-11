// The task view's sections on a stack level (from StackedOn.tsx, apart so that StackedOn and MergesInto don't import
// each other: these show MergesInto's HeldChoice).
import { isMerged, type HostProject as Project, type HostTask as Task } from "@huntaway/client"
import { Layers } from "lucide-react"
import { openTask } from "../../state/route"
import { HeldChoice } from "./MergesInto"
import { githubStackUrl, keyOf, LevelIcon, LinkedTaskRow, onGitHub, restacker, statusLabel, useLevels, useStackState, type StackState } from "./StackedOn"

/**
 * The task view's "Stacked on" (a level in a stack on GitHub) or "Lands after": the task below, how its landing after
 * that one stands, and the choice its merge waits on once that's closed or deleted.
 */
export function StackedOnSection({ task, project }: { task: Task; project?: Project | null | undefined }) {
  const { st, belowId, below } = useStackState(task)
  const base = project?.base_branch || "the base branch"
  const by = restacker(task)
  const stackUrl = githubStackUrl(task)
  const text: Record<StackState, string | null> = {
    none: null,
    open:
      task.status === "ready_for_merge"
        ? `Its merge waits for that one to be merged. Then ${by} restacks it onto where that went, and it merges there.`
        : onGitHub(task)
          ? "Its pull request is in a stack on GitHub with that task's. It merges after that one: GitHub then restacks it onto where that went."
          : "Its pull request targets that task's branch, as an ordinary pull request (GitHub doesn't know they're related). It merges after that one: the board then restacks it onto where that went.",
    restack: `That one is merged: ${by} is restacking this onto where it went.`,
    conflict: "That one is merged, but the board couldn't restack this onto where it went: its agent is asked to. Its merge waits until then.",
    merged: task.status === "done" ? null : `That one is merged, so this goes where it went (${task.base_branch || base}).`,
    closed: null,
    deleted: null,
  }
  return (
    <div className="space-y-2">
      <div className="text-[12.5px] text-muted">
        {below ? (
          <button className="group text-left" onClick={() => openTask(below.id)}>
            <span className="font-mono text-[11.5px] text-faint">{keyOf(below, project)}</span>{" "}
            <span className="text-fg group-hover:underline">{below.title}</span> <span className="text-faint">({statusLabel(below)})</span>
          </button>
        ) : (
          "A task that's since been deleted."
        )}
      </div>
      {text[st] && <div className="text-[12px] text-faint">{text[st]}</div>}
      {stackUrl && task.status !== "done" && (
        <a className="flex items-center gap-1 text-[12px] text-muted hover:underline" href={stackUrl} target="_blank" rel="noreferrer">
          <Layers size={11} /> Stack #{task.github_stack} on GitHub
        </a>
      )}
      {(st === "closed" || st === "deleted") && task.status !== "done" && belowId && (
        <HeldChoice hostId={task.host_id} goneId={belowId} gone={below} project={project} stacked />
      )}
    </div>
  )
}

/** The task view's list of the stack levels on it, done ones too; and once it's closed without being merged, where the open ones go now. */
export function LevelsSection({ task, project }: { task: Task; project?: Project | null | undefined }) {
  const levels = useLevels(task.id)
  const closed = task.status === "done" && !isMerged(task)
  return (
    <div className="space-y-2">
      <ul className="space-y-0.5">
        {levels.map((t) => (
          <li key={t.id}>
            <LinkedTaskRow task={t} project={project} icon={<LevelIcon task={t} size={11} className="shrink-0 text-faint" />}>
              {t.status !== "done" && t.restack && (
                <span className="shrink-0 text-[11px] text-faint">{t.restack === "due" ? "restacking" : "restack conflict"}</span>
              )}
            </LinkedTaskRow>
          </li>
        ))}
      </ul>
      {!closed && task.status !== "done" && levels.some((t) => t.status !== "done") && (
        <div className="text-[12px] text-faint">
          They land after this task: once it's merged, they're restacked onto where it went
          {levels.some(onGitHub)
            ? levels.every(onGitHub)
              ? ", by GitHub (they're in a stack there with it)"
              : ", by GitHub for those stacked on it there and by the board for the others"
            : ", by the board"}
          .
        </div>
      )}
      {closed && <HeldChoice hostId={task.host_id} goneId={task.id} gone={task} project={project} stacked />}
    </div>
  )
}
