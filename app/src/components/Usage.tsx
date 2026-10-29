import clsx from "clsx";
import { ChevronDown, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { UsageLimit } from "../api";
import { usageKey, useStore } from "../store";
import { usageConfigs } from "../usageConfigs";
import { timeAgo } from "./ui";

const OPEN_KEY = "ia.usageOpen";
/** The host caches for a few minutes and agent runs push updates, so polling can be slow. */
const POLL_MS = 5 * 60 * 1000;

function shortLabel(l: UsageLimit) {
  if (l.id === "session") return "Session";
  if (l.id === "weekly") return "Weekly";
  return l.label.split(" · ").pop() ?? l.label;
}

/** "21m", "3h 5m", or a weekday and time further out. */
function resetsIn(iso: string, now: number) {
  const ms = new Date(iso).getTime() - now;
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "now";
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min}m`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ""}`;
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric" });
}

function LimitRow({ limit, now }: { limit: UsageLimit; now: number }) {
  const used = Math.min(100, Math.max(0, limit.percent));
  const left = Math.round(100 - used);
  const reset = limit.resets_at ? resetsIn(limit.resets_at, now) : "";
  const when = limit.resets_at ? new Date(limit.resets_at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null;
  return (
    <div
      className="flex items-center gap-1.5 text-[10.5px]"
      title={`${limit.label}: ${Math.round(used)}% used, ${left}% left${when ? ` · resets ${when}` : ""}`}
    >
      <span className="w-10 shrink-0 truncate text-faint">{shortLabel(limit)}</span>
      {/* Filled by what's left, like a fuel gauge. */}
      <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.07]">
        <span
          className={clsx("block h-full rounded-full", left <= 10 ? "bg-red-400" : left <= 30 ? "bg-st-attention" : "bg-accent")}
          style={{ width: `${100 - used}%` }}
        />
      </span>
      <span className={clsx("w-7 shrink-0 text-right tabular-nums", left <= 10 ? "text-red-300" : "text-muted")}>{left}%</span>
      <span className="w-11 shrink-0 truncate text-right text-faint tabular-nums">{reset}</span>
    </div>
  );
}

/** Usage remaining on the plans of the configs `profile` and its projects use (on every host) that are set to show it. */
export function UsagePanel({ profile }: { profile: string | undefined }) {
  const profiles = useStore((s) => s.profiles);
  const configs = useStore((s) => s.claudeConfigs);
  const projects = useStore((s) => s.projects);
  const hosts = useStore((s) => s.hosts);
  const usage = useStore((s) => s.usage);
  const loadUsage = useStore((s) => s.loadUsage);
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const poll = setInterval(() => loadUsage().catch(() => {}), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [loadUsage]);

  const rows = usageConfigs(configs, profiles, projects, profile)
    .map((c) => ({ key: usageKey(c.host_id, c.id), host_id: c.host_id, name: c.name, usage: usage[usageKey(c.host_id, c.id)] }))
    .filter((r) => r.usage)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (rows.length === 0) return null;
  const multiHost = new Set(rows.map((r) => r.host_id)).size > 1;

  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(OPEN_KEY, open ? "0" : "1");
    } catch {
      /* ignore */
    }
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      await loadUsage(true);
    } finally {
      setRefreshing(false);
      setNow(Date.now());
    }
  };

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
                {multiHost && <span className="truncate text-[10px] text-faint">· {hosts.find((h) => h.id === host_id)?.name}</span>}
                {u.plan && <span className="ml-auto shrink-0 text-[10px] text-faint capitalize">{u.plan}</span>}
              </div>
              {u.limits.length > 0 ? (
                <div className="space-y-1">
                  {u.limits.map((l) => (
                    <LimitRow key={l.id} limit={l} now={now} />
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
  );
}
