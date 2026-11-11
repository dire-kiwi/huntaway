import { useState } from "react"
import { failedChecks, prChecks, type HostTask as Task } from "@huntaway/client"
import { CircleX, Loader2 } from "lucide-react"
import { rpc } from "../../../../state/rpc"
import { Ago, Button, ErrorBox, useAsyncAction } from "../../../ui"

/**
 * Fix broken checks for an open task's pull request (`tasks.fixChecks`), with its failed checks as the board last read
 * them. The button is there without them too: a pull request that no read watches (in a project that neither watches
 * pull requests in review nor moves them to Done when merged, or a task idle in another column) has none, or an
 * outdated one, and the button reads it afresh, sending the failures it finds or saying there are none.
 */
export function FailedChecks({ task }: { task: Task }) {
  const { busy, error, run } = useAsyncAction()
  // The head commit whose failures were sent, while it's still the one that failed.
  const [sent, setSent] = useState<string | null>(null)
  if (!task.pr_url || task.status === "done") return null
  const checks = failedChecks(task)
  const fix = () => run(async () => setSent((await rpc(task.host_id, "tasks.fixChecks", { id: task.id })).pr_checks?.head ?? null))
  const button = (
    <Button
      size="sm"
      disabled={busy}
      onClick={() => void fix()}
      title="Read the pull request's checks now and send the agent the failed ones, with the ends of their logs, asking it to fix them and push"
    >
      {busy && <Loader2 size={12} className="animate-spin" />}
      Fix broken checks
    </Button>
  )
  if (!checks) {
    const last = prChecks(task)
    return (
      <div className="mt-2 space-y-2" data-checks="none">
        <div className="flex items-center gap-2">
          {button}
          <span className="text-[11px] text-faint">
            {last ? (
              <>
                Checks {last.outcome === "none" ? "none" : last.outcome} on <span className="font-mono">{last.head.slice(0, 7)}</span> as last read,{" "}
                <Ago at={last.since} />
              </>
            ) : (
              "Reads the pull request's checks now"
            )}
          </span>
        </div>
        {error && <ErrorBox>{error}</ErrorBox>}
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
      <div className="mt-2 flex items-center gap-2">
        {button}
        {sent === checks.head && <span className="text-[11px] text-muted">Sent to the agent</span>}
        {checks.pending > 0 && <span className="ml-auto text-[11px] text-faint">{checks.pending} still running</span>}
      </div>
      {error && <ErrorBox className="mt-2">{error}</ErrorBox>}
    </div>
  )
}
