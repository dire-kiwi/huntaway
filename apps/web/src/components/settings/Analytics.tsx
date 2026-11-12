import { clsx } from "clsx"
import { Schema } from "effect"
import { ChevronLeft, ChevronRight, Download, RefreshCw } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { addDays, addMonths, dayKey, hm, SCRATCH, startOfDay, startOfMonth, startOfWeek, toCsv, type Rules } from "./analytics/analytics"
import { nowMillis } from "../../state/clock"
import { navigate } from "../../state/route"
import { profileNames } from "../boardHelpers"
import { useBoard } from "../../state/board"
import { ContextStats } from "../task/ContextStats"
import { POOR_HIT, POOR_HIT_MIN, tokens } from "./tokenStatsData"
import { TokenStats } from "./TokenStats"
import { DiskUsage } from "./DiskUsage"
import { Button, download, IconButton, localeDateString, MenuButton } from "../ui"
import { isPreset, Preset, PRESETS, type Range, presetRange } from "./analytics/range"
import { usePersisted } from "./analytics/usePersisted"
import { stored } from "../../state/storage"
import { useActivity, useContext, useTokens } from "./analytics/useActivity"
import { useView } from "./analytics/useView"
import { Report } from "./analytics/Report"
import { MonthGrid, WeekGrid, DayDetail } from "./analytics/Calendar"

const selectClass = "h-7 rounded-md border border-line bg-panel px-1.5 text-[12.5px] text-fg outline-none"

const Tab = Schema.Literals(["report", "calendar", "context", "tokens", "disk"])
type Tab = typeof Tab.Type
const CalMode = Schema.Literals(["month", "week"])
type CalMode = typeof CalMode.Type

// What the page keeps of its choices, under the old keys and in the old format (usePersisted.ts).
const tabAtom = stored("ia.analytics.tab", Schema.NullOr(Schema.Struct({ value: Tab })), null)
const presetAtom = stored("ia.analytics.preset", Schema.NullOr(Schema.Struct({ value: Preset })), null)
const customAtom = stored("ia.analytics.custom", Schema.NullOr(Schema.Struct({ value: Schema.Struct({ from: Schema.String, to: Schema.String }) })), null)
const rulesAtom = stored("ia.analytics.rules", Schema.NullOr(Schema.Struct({ value: Schema.Struct({ idleMin: Schema.Finite, leadMin: Schema.Finite }) })), null)
const calModeAtom = stored("ia.analytics.calMode", Schema.NullOr(Schema.Struct({ value: CalMode })), null)

const fmtDay = (t: number) => localeDateString(t, { day: "numeric", month: "short", year: "numeric" })

/** The Analytics page, of profile `profile` (by name) or, when it's null, of every profile. */
export function Analytics({ profile }: { profile: string | null }) {
  const profiles = useBoard((s) => s.profiles)
  const names = useMemo(() => profileNames(profiles), [profiles])
  const loaded = useBoard((s) => s.loaded)
  const [tab, setTab] = usePersisted<Tab>(tabAtom, "report")
  const [preset, setPreset] = usePersisted<Preset>(presetAtom, "this_week")
  // The last seven days, until a range is picked.
  const [lastWeek] = useState(() => ({ from: dayKey(addDays(nowMillis(), -6)), to: dayKey(nowMillis()) }))
  const [custom, setCustom] = usePersisted<{ readonly from: string; readonly to: string }>(customAtom, lastWeek)
  const [rules, setRules] = usePersisted<Rules>(rulesAtom, { idleMin: 30, leadMin: 5 })
  const [project, setProject] = useState("all")
  // A profile's projects are its own.
  const [projectsOf, setProjectsOf] = useState(profile)
  if (projectsOf !== profile) {
    setProjectsOf(profile)
    setProject("all")
  }
  // A profile that isn't on the board (renamed, removed or mistyped): every profile's.
  useEffect(() => {
    if (profile !== null && loaded && !names.includes(profile)) navigate({ name: "analytics" }, true)
  }, [profile, loaded, names])
  const [calMode, setCalMode] = usePersisted<CalMode>(calModeAtom, "month")
  const [anchor, setAnchor] = useState(() => startOfDay(nowMillis()))
  const [selected, setSelected] = useState<number | null>(() => startOfDay(nowMillis()))

  const range = useMemo<Range>(() => {
    if (tab === "report" || tab === "context" || tab === "tokens") return presetRange(preset, custom)
    if (calMode === "week") {
      const from = startOfWeek(anchor)
      return { from, to: addDays(from, 7) }
    }
    // The whole grid, including the days of the neighbouring months it shows.
    const from = startOfWeek(startOfMonth(anchor))
    return { from, to: addDays(startOfWeek(addDays(addMonths(startOfMonth(anchor), 1), -1)), 7) }
  }, [tab, preset, custom, calMode, anchor])

  const activity = useActivity(range, rules, tab === "report" || tab === "calendar")
  const context = useContext(range, profile, tab === "context")
  const tokenStats = useTokens(range, profile, tab === "tokens")
  const { data, loading, reload } = tab === "context" ? context : tab === "tokens" ? tokenStats : activity
  const view = useView(activity.data, rules, profile, project)
  const projects = data ? Object.values(data.projects).filter((p) => p.id !== SCRATCH && (profile === null || p.profile === profile)) : []

  const exportCsv = () => {
    if (!view) return
    download(`prompt-activity-${dayKey(range.from)}-to-${dayKey(range.to - 1)}.csv`, toCsv(view.data, view.events, view.spans, view.runs), "text/csv")
  }

  const switchCal = (m: CalMode) => {
    // Show the picked day in the new view.
    if (selected !== null) setAnchor(selected)
    setCalMode(m)
  }

  const step = (n: number) => {
    const next = calMode === "week" ? addDays(anchor, 7 * n) : addMonths(anchor, n)
    setAnchor(next)
    setSelected(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5 narrow:px-3">
        <MenuButton />
        <h1 className="text-[14px] font-semibold">Analytics</h1>
        <div className="no-drag flex min-w-0 items-center gap-1 overflow-x-auto rounded-lg border border-line bg-panel p-0.5">
          {(["report", "calendar", "context", "tokens", "disk"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx("shrink-0 rounded-md px-2.5 py-1 text-[12px] capitalize", tab === t ? "bg-raised text-fg" : "text-muted hover:text-fg")}
            >
              {t}
            </button>
          ))}
        </div>
        {loading && tab !== "disk" && <span className="text-[11.5px] text-faint">Loading…</span>}
      </header>

      {names.length > 1 && (
        <div className="flex items-center border-b border-line px-5 py-2 narrow:px-3">
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto rounded-lg border border-line bg-panel p-0.5" role="tablist" aria-label="Profile">
            {[null, ...names].map((name) => (
              <button
                key={name ?? ""}
                role="tab"
                aria-selected={profile === name}
                onClick={() => navigate(name === null ? { name: "analytics" } : { name: "analytics", profile: name })}
                className={clsx("shrink-0 rounded-md px-2.5 py-1 text-[12px]", profile === name ? "bg-raised text-fg" : "text-muted hover:text-fg")}
              >
                {name ?? "All"}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === "disk" ? (
        <DiskUsage profile={profile} />
      ) : (
        <>
          {/* Filters: one row above everything they apply to. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2">
            {tab === "report" || tab === "context" || tab === "tokens" ? (
              <>
                <select className={selectClass} value={preset} onChange={(e) => isPreset(e.target.value) && setPreset(e.target.value)} title="Time range">
                  {PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                {preset === "custom" && (
                  <span className="flex items-center gap-1.5 text-[12px] text-faint">
                    <input
                      type="date"
                      className={selectClass}
                      value={custom.from}
                      onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })}
                    />
                    to
                    <input
                      type="date"
                      className={selectClass}
                      value={custom.to}
                      onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })}
                    />
                  </span>
                )}
                {preset !== "custom" && <span className="text-[12px] text-faint tabular-nums">{rangeLabel(range)}</span>}
              </>
            ) : (
              <>
                <div className="flex items-center gap-1 rounded-lg border border-line bg-panel p-0.5">
                  {(["month", "week"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => switchCal(m)}
                      className={clsx("rounded-md px-2 py-0.5 text-[12px] capitalize", calMode === m ? "bg-raised text-fg" : "text-muted hover:text-fg")}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <IconButton title="Previous" onClick={() => step(-1)}>
                  <ChevronLeft size={15} />
                </IconButton>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAnchor(startOfDay(nowMillis()))
                    setSelected(startOfDay(nowMillis()))
                  }}
                >
                  Today
                </Button>
                <IconButton title="Next" onClick={() => step(1)}>
                  <ChevronRight size={15} />
                </IconButton>
                <span className="text-[13px] font-medium">
                  {calMode === "month"
                    ? localeDateString(anchor, { month: "long", year: "numeric" })
                    : rangeLabel({ from: startOfWeek(anchor), to: addDays(startOfWeek(anchor), 7) })}
                </span>
              </>
            )}
            <select className={selectClass} value={project} onChange={(e) => setProject(e.target.value)} title="Project">
              <option value="all">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value={SCRATCH}>In no project</option>
            </select>
            <div className="ml-auto flex items-center gap-2">
              {tab !== "context" && tab !== "tokens" && (
                <>
                  <label className="flex items-center gap-1.5 text-[12px] text-faint" title="A longer gap between prompts counts as a break">
                    Break after
                    <select className={selectClass} value={rules.idleMin} onChange={(e) => setRules({ ...rules, idleMin: Number(e.target.value) })}>
                      {[10, 15, 30, 45, 60, 90, 120].map((m) => (
                        <option key={m} value={m}>
                          {hm(m * 60_000)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5 text-[12px] text-faint" title="Time credited to the first prompt after a break">
                    First prompt
                    <select className={selectClass} value={rules.leadMin} onChange={(e) => setRules({ ...rules, leadMin: Number(e.target.value) })}>
                      {[0, 2, 5, 10, 15].map((m) => (
                        <option key={m} value={m}>
                          {hm(m * 60_000)}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              <IconButton title="Refresh" onClick={reload}>
                <RefreshCw size={14} className={clsx(loading && "animate-spin")} />
              </IconButton>
              {tab === "report" && (
                <Button size="sm" onClick={exportCsv} disabled={!view} title="Prompts, active and agent hours per day and task">
                  <Download size={13} /> CSV
                </Button>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-6xl space-y-6 p-6">
              {data?.errors.map((e) => (
                <div key={e} className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-200">
                  {e}
                </div>
              ))}
              {view && tab === "report" && <Report view={view} />}
              {context.data && tab === "context" && <ContextStats data={context.data} project={project} />}
              {tokenStats.data && tab === "tokens" && <TokenStats data={tokenStats.data} project={project} />}
              {view && tab === "calendar" && (
                <>
                  {calMode === "month" ? (
                    <MonthGrid view={view} anchor={anchor} selected={selected} onSelect={setSelected} />
                  ) : (
                    <WeekGrid view={view} from={range.from} selected={selected} onSelect={setSelected} />
                  )}
                  {selected !== null && selected >= range.from && selected < range.to && <DayDetail view={view} day={selected} />}
                </>
              )}
              {tab === "tokens" ? (
                <p className="text-[11.5px] leading-relaxed text-faint">
                  Tokens are counted from each agent run's output once it ends, for the model that used them (subagents' included), and go to the day the run
                  started. A review or summary thread's tokens count towards the task it's for. Tokens are uncached input, cache reads and writes, and output.
                  Cost is what Claude Code reports; Codex doesn't say. Runs from before this version are counted from the output the board still keeps (two
                  weeks of it); older runs show only what they cost, marked *. Reviews count each reviewer's verdict in a round once. A task's first round and
                  its rounds of fixes are all of its rounds, those outside the range too, for the tasks reviewed in it; a round found issues if any of its
                  reviewers did. Minor issues are listed by reviews from this version on; earlier ones count as noting minor issues when their summary mentions
                  some. Follow-ups are tasks the reviewed task's agent created after such a review. The cache hit rate is the share of the input fed to models
                  (uncached input, cache reads and writes) that was read from the prompt cache; a thread under {Math.round(POOR_HIT * 100)}% on{" "}
                  {tokens(POOR_HIT_MIN)} or more is flagged, as its cache was written or missed more than read. Which cache writes went to (1 hour or 5 minutes)
                  is kept from this version on, for Claude: older runs' are unknown, and Codex doesn't say. What the cache saved isn't shown, as the board
                  doesn't keep models' prices (Claude Code reports only the cost).
                </p>
              ) : tab === "context" ? (
                <p className="text-[11.5px] leading-relaxed text-faint">
                  A turn's context is what its agent's session held when the turn ended, which the next prompt starts from: the system prompt, tools and the
                  conversation so far. Compactions are Idle (the board's, after a session sat idle for a while), /compact (sent by someone) and the agent's own
                  (as its context filled up). Turn sizes are recorded from this version on; compactions go back further, from what threads show.
                </p>
              ) : (
                <p className="text-[11.5px] leading-relaxed text-faint">
                  Active time credits each prompt with the time since your previous prompt on any task{profile !== null && ", in any profile"}, so reading an
                  agent's output and writing the next prompt counts toward the task you prompted. Gaps over {hm(rules.idleMin * 60_000)} are breaks; the first
                  prompt after one counts {hm(rules.leadMin * 60_000)}. Prompts are the messages you send, plus starting a task and moving it to Ready for
                  merge. Agent time is how long agents ran, including reviews.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function rangeLabel(r: Range) {
  const last = addDays(r.to, -1)
  return r.from === last ? fmtDay(r.from) : `${fmtDay(r.from)} – ${fmtDay(last)}`
}
