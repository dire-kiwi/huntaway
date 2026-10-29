import clsx from "clsx";
import { Clock, Link2, X } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, dependencyQueued, isMerged, type Project, type Task } from "../api";
import { openTask } from "../router";
import { useStore } from "../store";
import { CARD_BADGE, StatusIcon, Wide } from "./ui";

/** The tasks a task depends on that are still on the board, in its order. */
function useDependencies(task: Task): Task[] {
  return useStore(useShallow((s) => (task.depends_on ?? []).map((id) => s.tasks[id]).filter((t): t is Task => !!t)));
}

const keyOf = (t: Task, project?: Project | null) => `${project?.key ?? "T"}-${t.number}`;

/** On a card: queued for its dependencies, or which ones it's still waiting on. `compact`: icons and numbers, and the words once the card has room. */
export function DependencyBadge({ task, project, compact }: { task: Task; project?: Project; compact?: boolean }) {
  const unmet = useDependencies(task).filter((t) => !isMerged(t));
  if (dependencyQueued(task)) {
    const keys = unmet.map((t) => keyOf(t, project)).join(", ");
    return (
      <span className={clsx(CARD_BADGE, "text-muted")} title={`Queued: its agent starts once ${keys || "the tasks it depends on"} ${unmet.length === 1 ? "is" : "are"} merged`}>
        <Clock size={11} /> {compact ? <Wide>queued</Wide> : "queued"}
      </span>
    );
  }
  if (!unmet.length || task.status === "done") return null;
  // "138", or "IA-138" with room; "2", or "2 deps".
  const label = !compact ? (
    unmet.length === 1 ? keyOf(unmet[0], project) : `${unmet.length} deps`
  ) : unmet.length === 1 ? (
    <span>
      <Wide>{project?.key ?? "T"}-</Wide>
      {unmet[0].number}
    </span>
  ) : (
    <span>
      {unmet.length}
      <Wide> deps</Wide>
    </span>
  );
  return (
    <span className={CARD_BADGE} title={`Depends on ${unmet.map((t) => `${keyOf(t, project)} (${t.title})`).join(", ")} being merged`}>
      <Link2 size={11} /> {label}
    </span>
  );
}

/** The task view's list of dependencies, with adding and removing. */
export function Dependencies({ task, project }: { task: Task; project?: Project | null }) {
  const deps = useDependencies(task);
  // Tasks in the same project it could depend on: not itself, not already listed, not merged.
  const candidates = useStore(
    useShallow((s) =>
      Object.values(s.tasks)
        .filter((t) => t.kind === "task" && t.project_id === task.project_id && t.id !== task.id && !isMerged(t) && !(task.depends_on ?? []).includes(t.id))
        .sort((a, b) => b.number - a.number),
    ),
  );
  const [err, setErr] = useState<string | null>(null);
  const save = (ids: string[]) => {
    setErr(null);
    api.updateTask(task.host_id, task.id, { depends_on: ids }).catch((e) => setErr(e.message));
  };
  const unmet = deps.filter((t) => !isMerged(t));

  return (
    <div className="space-y-2">
      {deps.length > 0 ? (
        <ul className="space-y-0.5">
          {deps.map((d) => (
            <li key={d.id} className="group flex items-center gap-2 rounded-md px-1 py-1 text-[12.5px] hover:bg-white/[0.03]">
              <StatusIcon status={d.status} size={13} />
              <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => openTask(d.id)}>
                <span className="shrink-0 font-mono text-[11.5px] text-faint">{keyOf(d, project)}</span>
                <span className="truncate text-muted group-hover:text-fg">{d.title}</span>
              </button>
              {isMerged(d) && <span className="shrink-0 text-[11px] text-st-done">merged</span>}
              <button
                className="shrink-0 text-faint opacity-0 group-hover:opacity-100 hover:text-fg"
                title="Remove this dependency"
                onClick={() => save((task.depends_on ?? []).filter((id) => id !== d.id))}
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-[12.5px] text-faint">Starts whenever it's moved to In progress.</div>
      )}
      {unmet.length > 0 && !dependencyQueued(task) && !task.running && !["done", "ready_for_merge"].includes(task.status) && (
        <div className="text-[12px] text-faint">Moved to In progress, it waits for these to be merged before its agent starts.</div>
      )}
      {candidates.length > 0 && (
        <select
          value=""
          onChange={(e) => e.target.value && save([...(task.depends_on ?? []), e.target.value])}
          className="h-7 w-full rounded-md border border-line bg-panel px-2 text-[12px] text-muted outline-none"
        >
          <option value="">Add a task it depends on…</option>
          {candidates.map((t) => (
            <option key={t.id} value={t.id}>
              {keyOf(t, project)} {t.title}
            </option>
          ))}
        </select>
      )}
      {err && <div className="rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
    </div>
  );
}
