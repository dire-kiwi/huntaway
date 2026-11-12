import { useAtom, useAtomMount, useAtomValue } from "@effect/atom-react"
import { boardAtom, mutate, query, usageKey } from "@huntaway/client"
import type { UsageAccount, UsageLimit } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import { ChevronDown, RefreshCw, TriangleAlert } from "lucide-react"
import { useBoard } from "../../state/board"
import { useNow } from "../../state/clock"
import { useAction } from "../../state/mutation"
import { usageOpenAtom } from "../../state/prefs"
import { timeAgo } from "../ui"
import { resetsIn, resetsPhrase, resetTime, usageAlert, usageConfigs, WARN_AT, type UsageAlert } from "../ui/usageConfigs"

/** The hosts with configs that show their usage (passed on only when the list changes). */
const usageHostsAtom = Atom.make((get): ReadonlyArray<string> => [
  ...new Set(
    get(boardAtom)
      .claudeConfigs.filter((c) => c.show_usage)
      .map((c) => c.host_id),
  ),
])

/**
 * Asks each of those hosts for its usage while the panel is mounted, every 5 minutes (the host caches for a few minutes
 * and agent runs push updates, so polling can be slow). The answers come as the board's `usage` events, not from here.
 */
const usagePollAtom = Atom.make((get) => {
  for (const h of get(usageHostsAtom)) get(query("host.usage", h, { refresh: false }, { refresh: "5 minutes" }))
})

function shortLabel(l: UsageLimit): string {
  if (l.id === "session") return "Session"
  if (l.id === "weekly") return "Weekly"
  return l.label.split(" · ").pop() ?? l.label
}

function LimitRow({ limit, now }: { limit: UsageLimit; now: number }) {
  const used = Math.min(100, Math.max(0, limit.percent))
  const left = Math.round(100 - used)
  const reset = limit.resets_at ? resetsIn(limit.resets_at, now) : ""
  const when = limit.resets_at ? ` · ${resetsPhrase(limit.resets_at, now)} (${resetTime(limit.resets_at)})` : ""
  const level = used >= 100 ? "out" : used >= WARN_AT ? "warn" : null
  return (
    <div
      className="flex items-center gap-1.5 text-[10.5px]"
      data-level={level ?? undefined}
      title={`${limit.label}: ${Math.round(used)}% used, ${left}% left${when}${level === "warn" ? `\nOver ${WARN_AT}%: pick another config for new work if you have one` : ""}`}
    >
      <span className="w-10 shrink-0 truncate text-faint">{shortLabel(limit)}</span>
      {/* Filled by what's left, like a fuel gauge. */}
      <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.07]">
        <span
          className={clsx("block h-full rounded-full", left <= 10 ? "bg-red-400" : level ? "bg-st-attention" : "bg-accent")}
          style={{ width: `${100 - used}%` }}
        />
      </span>
      <span className={clsx("w-7 shrink-0 text-right tabular-nums", left <= 10 ? "text-red-300" : level ? "text-st-attention" : "text-muted")}>{left}%</span>
      <span className="w-11 shrink-0 truncate text-right text-faint tabular-nums">{reset}</span>
    </div>
  )
}

/** One of a proxy's accounts, on one line: what's left of its session and weekly limits. */
function AccountRow({ account, now }: { account: UsageAccount; now: number }) {
  const shown = account.limits.filter((l) => l.id === "session" || l.id === "weekly")
  const detail = account.limits
    .map((l) => `${l.label}: ${Math.round(100 - Math.min(100, Math.max(0, l.percent)))}% left${l.resets_at ? `, ${resetsPhrase(l.resets_at, now)}` : ""}`)
    .join("\n")
  return (
    <div
      className="flex items-center gap-1.5 text-[10.5px]"
      data-account={account.name}
      title={[account.name, detail, account.error].filter(Boolean).join("\n")}
    >
      <span className={clsx("min-w-0 flex-1 truncate", account.error ? "text-faint" : "text-muted")}>{account.name}</span>
      {account.error && shown.length === 0 ? (
        <TriangleAlert size={10} className="shrink-0 text-st-attention" aria-label={account.error} />
      ) : (
        shown.map((l) => {
          const left = Math.round(100 - Math.min(100, Math.max(0, l.percent)))
          return (
            <span key={l.id} className={clsx("shrink-0 tabular-nums", left <= 10 ? "text-red-300" : l.percent >= WARN_AT ? "text-st-attention" : "text-faint")}>
              {l.id === "session" ? "S" : "W"} {left}%
            </span>
          )
        })
      )}
    </div>
  )
}

/** A config running low (`WARN_AT`% of a limit used) or out of usage, by its name in the sidebar. */
export function UsageAlertIcon({ alert, size = 11 }: { alert: UsageAlert | null; size?: number | undefined }) {
  if (!alert) return null
  return (
    <span
      title={alert.until ? `${alert.text} (${resetTime(alert.until)})` : alert.text}
      className={clsx("inline-flex shrink-0", alert.level === "out" ? "text-red-400" : "text-st-attention")}
    >
      <TriangleAlert size={size} aria-label={alert.level === "out" ? "Out of usage" : "Running low"} />
    </span>
  )
}

/** Usage remaining on the plans of the configs `profile` and its projects use (on every host) that are set to show it. */
export function UsagePanel({ profile }: { profile: string | undefined }) {
  const profiles = useBoard((s) => s.profiles)
  const configs = useBoard((s) => s.claudeConfigs)
  const projects = useBoard((s) => s.projects)
  const hosts = useBoard((s) => s.hosts)
  const usage = useBoard((s) => s.usage)
  const [openFlag, setOpenFlag] = useAtom(usageOpenAtom)
  const open = openFlag !== "0"
  useAtomMount(usagePollAtom)
  const usageHosts = useAtomValue(usageHostsAtom)
  const [{ busy: refreshing }, run] = useAction()
  const now = useNow(30_000)

  const rows = usageConfigs(configs, profiles, projects, profile)
    .map((c) => ({ key: usageKey(c.host_id, c.id), host_id: c.host_id, name: c.name, usage: usage[usageKey(c.host_id, c.id)] }))
    .flatMap((r) => (r.usage ? [{ ...r, usage: r.usage }] : []))
    .toSorted((a, b) => a.name.localeCompare(b.name))
  if (rows.length === 0) return null
  const multiHost = new Set(rows.map((r) => r.host_id)).size > 1

  const toggle = (): void => setOpenFlag(open ? "0" : "1")
  // Each host reads its usage again now rather than giving what it keeps; one that can't is left as it is.
  const refresh = (): void => {
    void run(Effect.forEach(usageHosts, (h) => Effect.ignore(mutate("host.usage", h, { refresh: true })), { concurrency: "unbounded" }))
  }

  return (
    <div className="border-t border-line px-2 py-2">
      <div className="flex items-center px-2 pb-1">
        <button onClick={toggle} className="flex items-center gap-1 text-[11px] font-semibold tracking-wide text-faint uppercase hover:text-muted">
          Usage left
          <ChevronDown size={12} className={clsx("transition-transform", !open && "-rotate-90")} />
        </button>
        {open && (
          <button onClick={refresh} title="Check usage now" className="ml-auto text-faint hover:text-muted">
            <RefreshCw size={11} className={clsx(refreshing && "animate-spin")} />
          </button>
        )}
      </div>
      {open && (
        <div className="max-h-56 space-y-2 overflow-y-auto px-2">
          {rows.map(({ key, host_id, name, usage: u }) => (
            <div key={key}>
              <div
                className="flex items-baseline gap-1 pb-0.5 text-[11.5px]"
                title={u.updated_at ? `Updated ${timeAgo(u.updated_at)}${u.error ? `\n${u.error}` : ""}` : (u.error ?? undefined)}
              >
                <span className="truncate text-fg">{name}</span>
                <UsageAlertIcon alert={usageAlert(u, now)} />
                {multiHost && <span className="truncate text-[10px] text-faint">· {hosts.find((h) => h.id === host_id)?.name}</span>}
                {u.plan && <span className={clsx("ml-auto shrink-0 text-[10px] text-faint", !u.accounts && "capitalize")}>{u.plan}</span>}
              </div>
              {u.limits.length > 0 ? (
                <div className="space-y-1">
                  {u.limits.map((l) => (
                    <LimitRow key={l.id} limit={l} now={now} />
                  ))}
                  {u.accounts && u.accounts.length > 0 && (
                    <div
                      className="space-y-0.5 border-l border-line pl-1.5"
                      title="The proxy's accounts: each row above is the account's that resets first, of those that can still serve it, unless it has used none"
                    >
                      {u.accounts.map((a) => (
                        <AccountRow key={a.name} account={a} now={now} />
                      ))}
                    </div>
                  )}
                </div>
              ) : u.accounts && u.accounts.length > 0 ? (
                <div className="space-y-0.5">
                  {u.accounts.map((a) => (
                    <AccountRow key={a.name} account={a} now={now} />
                  ))}
                </div>
              ) : (
                <div className="truncate text-[10.5px] text-faint" title={u.error ?? undefined}>
                  {u.error ?? "No usage yet"}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
