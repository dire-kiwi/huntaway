// HE-59: a task whose session Claude Code moved to another model (Opus 5.5's safeguards flag a session and Opus 4.8
// answers it from then on), marked on its card and beside its thread's model picker until the session is back.
import type { HostTask as Task } from "@huntaway/client"
import { modelName, type ModelFallback } from "@huntaway/contracts"
import { clsx } from "clsx"
import { ShieldAlert } from "lucide-react"
import { localeString } from "../ui/dates"

/** What the mark says when hovered. */
export const fallbackTitle = (f: ModelFallback): string => {
  const [from, to] = [modelName(f.from), modelName(f.to)]
  const why = f.reason === "refusal" ? `${from}'s safeguards flagged this session` : `${from} failed`
  return `${why} (${localeString(f.at)}), so ${to} answers it instead of ${from}.`
}

/** The model answering a task's session instead of the one it asked for, if Claude Code fell back. */
export function ModelFallbackBadge({ task, className }: { task: Task; className?: string | undefined }) {
  const f = task.model_fallback
  if (!f) return null
  return (
    <span className={clsx(className, "text-amber-300")} title={fallbackTitle(f)}>
      <ShieldAlert size={11} className="shrink-0" /> {modelName(f.to)}
    </span>
  )
}
