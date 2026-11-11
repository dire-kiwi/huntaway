import { failedChecks, prChecks, type HostTask as Task } from "@huntaway/client"
import { CircleX } from "lucide-react"
import { Ago } from "../../../ui"

// "Fix broken checks" (the old `api.fixChecks`, which reads the pull request's checks and sends the failures to the
// agent) comes with pull requests (4.5): until then this shows the checks as the board last read them.

/** An open task's pull request's failed checks, as the board last read them. */
export function FailedChecks({ task }: { task: Task }) {
  if (!task.pr_url || task.status === "done") return null
  const checks = failedChecks(task)
  if (!checks) {
    const last = prChecks(task)
    if (!last) return null
    return (
      <div className="mt-2 space-y-2" data-checks="none">
        <span className="text-[11px] text-faint">
          Checks {last.outcome === "none" ? "none" : last.outcome} on <span className="font-mono">{last.head.slice(0, 7)}</span> as last read,{" "}
          <Ago at={last.since} />
        </span>
      </div>
    )
  }
  const n = checks.failed.length + checks.more_failed
  return (
    <div className="mt-2 rounded-md border border-red-500/20 bg-red-500/[0.06] p-2 text-[12px]">
      <div className="flex items-center gap-1.5 text-red-300">
        <CircleX size={12} className="shrink-0" />
        <span>
          {n} check{n === 1 ? "" : "s"} failed on <span className="font-mono text-[11.5px]">{checks.head.slice(0, 7)}</span>
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-faint">
          <Ago at={checks.since} title={`Read from GitHub ${new Date(checks.since).toLocaleString()} or since`} />
        </span>
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {checks.failed.map((c) => (
          <li key={`${c.name}\n${c.url ?? ""}`} className="flex min-w-0 items-baseline gap-1.5">
            {c.url ? (
              <a href={c.url} target="_blank" rel="noreferrer" className="truncate text-fg hover:underline">
                {c.name}
              </a>
            ) : (
              <span className="truncate text-fg">{c.name}</span>
            )}
            <span className="shrink-0 text-[11px] text-faint">{c.conclusion.replace(/_/g, " ")}</span>
          </li>
        ))}
        {checks.more_failed > 0 && <li className="text-faint">and {checks.more_failed} more</li>}
      </ul>
      {checks.pending > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <span className="ml-auto text-[11px] text-faint">{checks.pending} still running</span>
        </div>
      )}
    </div>
  )
}
