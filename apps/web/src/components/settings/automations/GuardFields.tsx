import { clsx } from "clsx"
import { WEEKDAYS } from "./draft"
import { Field, Input, Toggle } from "../../ui"
import { DAY_LABELS } from "./text"
import type { Draft } from "./draft"

/** What a run is checked against first (API 110): the hours it may start in, a precheck command and a budget a day. */
export function GuardFields({ draft: d, set, routine }: { draft: Draft; set: <K extends keyof Draft>(k: K, v: Draft[K]) => void; routine: boolean }) {
  return (
    <div className="space-y-3 rounded-lg border border-line/70 p-3" data-testid="guards">
      <span className="text-xs font-medium text-muted">Before each run</span>
      <div className="space-y-2">
        <Toggle checked={d.active} onChange={(v) => set("active", v)} label="Only in active hours" />
        {d.active && (
          <div className="flex flex-wrap items-center gap-2 pl-1 text-[13px]">
            From
            <div className="w-32">
              <Input type="time" aria-label="Active from" value={d.activeStart} onChange={(e) => set("activeStart", e.target.value)} />
            </div>
            to
            <div className="w-32">
              <Input type="time" aria-label="Active until" value={d.activeEnd} onChange={(e) => set("activeEnd", e.target.value)} />
            </div>
            on
            {WEEKDAYS.map((w) => {
              const on = d.activeDays.includes(w)
              return (
                <button
                  key={w}
                  type="button"
                  onClick={() => set("activeDays", on ? d.activeDays.filter((x) => x !== w) : [...d.activeDays, w])}
                  className={clsx(
                    "h-7 w-10 rounded-md border text-[12px]",
                    on ? "border-accent/60 bg-accent/15 text-fg" : "border-line text-faint hover:text-muted",
                  )}
                >
                  {DAY_LABELS[w]}
                </button>
              )
            })}
            <div className="w-full text-[12px] text-faint">
              A scheduled run waits for them; a delivery outside them is skipped. No day picked means every day.
            </div>
          </div>
        )}
      </div>
      <Field
        label="Precheck"
        hint={`A bash command run first, in ${routine ? "the assistant's workspace" : "the project's folder"}: exit 1 skips the run (nothing new), and what it prints is {{precheck}}. Any other exit fails the run.`}
      >
        <Input className="font-mono text-[12px]" value={d.precheck} onChange={(e) => set("precheck", e.target.value)} placeholder="./new-mail.sh || exit 1" />
      </Field>
      <Field
        label="Budget a day (USD)"
        hint={`Once its runs today have cost this much, it's skipped until tomorrow. ${
          routine
            ? "A run costs what its thread (or the assistant's turn that took its message) costs."
            : "A run costs what the agent run it starts costs: a new task's first run, or the run that takes its message in (not the task's later work)."
        } Blank for no limit.`}
      >
        <div className="w-32">
          <Input type="number" min={0} step="0.05" value={d.budget} onChange={(e) => set("budget", e.target.value)} placeholder="no limit" />
        </div>
      </Field>
    </div>
  )
}
