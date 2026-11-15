// The Routines tab of a profile's assistant (6.7): its profile's automations that wake it, each with its next run, its
// last result (quiet, reported, skipped and why), what it's cost, and Run now, pause and edit. 6.5's `automations.*`
// with the profile as owner, read again on `automations_changed`. Under them, the routines left behind on this board's
// host when a profile's assistant moved to another (`RoutinesLeftBehind`, 7.4).
import { useAtomValue } from "@effect/atom-react"
import { automationsAtom, experimentsAtom, mutate, query, type HostTask as Task } from "@huntaway/client"
import { ProfileId, type Automation, type Weekday } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Cause, Exit } from "effect"
import { Loader2, Plus } from "lucide-react"
import { useState } from "react"
import { useAction, useMutation } from "../../state/mutation"
import { openTask } from "../../state/route"
import { AutomationEditor } from "../settings/automations/AutomationEditor"
import { AutomationRow } from "../settings/automations/AutomationRow"
import { WEEKDAYS } from "../settings/automations/draft"
import { activeText, usd } from "../settings/automations/text"
import { TimesInput } from "../settings/automations/TimesInput"
import { Button, resultValue, useConfirm } from "../ui"
import { RoutinesLeftBehind } from "./RoutinesLeftBehind"

/** What the confirm dialog waits for: the exit's value, or its failure as the rejection it shows. */
const settled = <A, E>(exit: Exit.Exit<A, E>): Promise<A> => (Exit.isSuccess(exit) ? Promise.resolve(exit.value) : Promise.reject(Cause.squash(exit.cause)))

/** The assistant's routines: `assistant` is the profile's assistant, whose host and profile they're on. */
export function Routines({ assistant }: { assistant: Task }) {
  const { host_id: hostId, profile_id: profileId } = assistant
  const { data, failed } = useAtomValue(automationsAtom({ host_id: hostId, profile_id: profileId }))
  const list = data?.automations ?? null
  const tz = data?.time_zone ?? null
  const [action, run] = useAction()
  // A delete's failure is the confirm dialog's to show.
  const [, remove] = useAction()
  // A routine saved in the editor clears the error of a change before it.
  const [cleared, setCleared] = useState<unknown>(undefined)
  const err = action.failure === cleared ? null : action.error
  const [editing, setEditing] = useState<Automation | "new" | null>(null)
  const confirm = useConfirm()
  // The check-ins experiment: its template, until there's a routine of its name.
  const checkIns = useAtomValue(experimentsAtom, (on) => on.includes("check_ins"))
  const [settingUp, setSettingUp] = useState(false)
  const hasCheckIn = list?.some((a) => a.name === CHECK_IN) ?? true
  return (
    <div className="h-full overflow-y-auto" data-testid="routines">
      <div className="mx-auto max-w-3xl space-y-3 px-5 py-5">
        <div className="flex items-center gap-3">
          <p className="flex-1 text-[12.5px] text-muted">
            Routines wake your assistant on a schedule or a webhook. By default each run works in a thread of its own and posts a report here, or stays quiet
            when there's nothing new. Ask the assistant to set one up, or add one yourself.
          </p>
          {checkIns && !hasCheckIn && !settingUp && (
            <Button size="sm" onClick={() => setSettingUp(true)}>
              <Plus size={13} /> Add check-ins
            </Button>
          )}
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus size={13} /> New routine
          </Button>
        </div>
        {checkIns && !hasCheckIn && settingUp && <CheckInSetup hostId={hostId} profileId={profileId} onClose={() => setSettingUp(false)} />}
        {list && list.length > 0 && (
          <div className="divide-y divide-line/70 rounded-md border border-line/70">
            {list.map((a) => (
              <RoutineRow
                key={a.id}
                routine={a}
                hostId={hostId}
                tz={tz}
                onToggle={(enabled) => void run(mutate("automations.update", hostId, { id: a.id, patch: { enabled } }))}
                onEdit={() => setEditing(a)}
                onRun={() => run(mutate("automations.run", hostId, { id: a.id }))}
                onDelete={() =>
                  confirm.ask({
                    title: `Delete routine ${a.name}`,
                    body: `Delete the routine "${a.name}"? Its run history goes with it; its reports stay in the thread.`,
                    action: "Delete routine",
                    danger: true,
                    onConfirm: () => remove(mutate("automations.delete", hostId, { id: a.id })).then(settled),
                  })
                }
              />
            ))}
          </div>
        )}
        <RoutinesLeftBehind assistant={assistant} />
        {list && !list.length && <div className="text-[12px] text-faint">No routines yet. Try asking the assistant: "Every weekday at 8, check my inbox."</div>}
        {(err ?? failed) && <div className="text-xs text-red-400">{err ?? failed}</div>}
        {confirm.dialog}
        {editing && (
          <AutomationEditor
            owner={{ hostId, profileId }}
            automation={editing === "new" ? null : editing}
            tz={tz}
            onSaved={() => setCleared(action.failure)}
            onClose={() => setEditing(null)}
          />
        )}
      </div>
    </div>
  )
}

function RoutineRow({
  routine: a,
  ...row
}: { routine: Automation } & Pick<Parameters<typeof AutomationRow>[0], "hostId" | "tz" | "onToggle" | "onEdit" | "onRun" | "onDelete">) {
  const last = a.last_run
  const mode = a.action.kind === "message_assistant" && a.action.mode === "thread" ? "in the assistant's thread" : "in a fresh thread"
  const guards = [a.active_hours && `active ${activeText(a.active_hours)}`, a.precheck && "with a precheck"].filter(Boolean).join(", ")
  const lastTask = last?.task_id
  return (
    <AutomationRow
      {...row}
      automation={a}
      testId="routine"
      detail={
        <>
          {mode}
          {guards && ` · ${guards}`}
        </>
      }
      aside={
        <span className="shrink-0 text-right text-[11.5px] text-faint" title="What its runs cost today, and all its runs kept">
          {usd(a.cost_today_usd)} today{a.budget_usd ? ` of ${usd(a.budget_usd)}` : ""}
          <br />
          {usd(a.cost_usd)} in all
        </span>
      }
      webhookRun={{ label: "Run now", title: "Run it now, with an empty delivery" }}
      lastDetail={
        last && (
          <>
            {last.status !== "ok" && last.detail && <span className="truncate">{last.detail.replace(/^Skipped: /, "")}</span>}
            {last.task && lastTask && (
              <span
                role="link"
                className="truncate font-mono hover:text-fg hover:underline"
                onClick={(e) => {
                  e.stopPropagation()
                  openTask(lastTask)
                }}
              >
                {last.task.key}
              </span>
            )}
          </>
        )
      }
      off="Paused"
    />
  )
}

/** The check-in routine's name (the server's `checkInText.ts`). */
const CHECK_IN = "Check-in"

/**
 * The check-ins experiment's template: at the times and on the days picked, the assistant messages the user only if
 * something needs them (`assistant.addCheckIn`). Google is offered once it's connected. It goes once the routine's event
 * comes.
 */
function CheckInSetup({ hostId, profileId, onClose }: { hostId: string; profileId: string; onClose: () => void }) {
  const profile_id = ProfileId.make(profileId)
  const [times, setTimes] = useState<string[]>(["11:00", "16:30"])
  const [days, setDays] = useState<Weekday[]>(["mon", "tue", "wed", "thu", "fri"])
  const [google, setGoogle] = useState(false)
  const connected = resultValue(useAtomValue(query("assistant.google", hostId, { profile_id })))?.connected === true
  const [{ busy, error }, addCheckIn] = useMutation("assistant.addCheckIn")
  const add = () => void addCheckIn(hostId, { profile_id, times, weekdays: days, google: connected && google })
  return (
    <div className="space-y-3 rounded-xl border border-line p-4 text-[13px]" data-testid="check-in-setup">
      <div className="text-fg">Check-ins</div>
      <p className="text-[12.5px] text-muted">
        At these times your assistant looks over your boards (what needs you, what's ready to review, your tracked work and routines) and messages you only if
        something needs you; otherwise it stays quiet. It skips a check-in while you're talking to it (a message in the last 20 minutes). It's a routine called{" "}
        {CHECK_IN}, which you can change like any other.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-muted">
        At
        <TimesInput initial={times} onChange={setTimes} />
        on
        <div className="flex items-center gap-1" role="group" aria-label="Days">
          {WEEKDAYS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days.includes(d)}
              onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : WEEKDAYS.filter((x) => x === d || days.includes(x)))}
              className={clsx(
                "h-7 rounded-md border px-2 text-[12px] capitalize",
                days.includes(d) ? "border-accent/60 bg-accent/15 text-fg" : "border-line text-muted hover:text-fg",
              )}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      {connected && (
        <label className="flex items-center gap-2 text-[12.5px] text-muted">
          <input type="checkbox" className="accent-accent" checked={google} onChange={(e) => setGoogle(e.target.checked)} />
          Look at today's mail and calendar too (Google)
        </label>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" disabled={busy || times.some((t) => t === "") || times.length === 0 || days.length === 0} onClick={add}>
          {busy && <Loader2 size={12} className="animate-spin" />} Add check-ins
        </Button>
        <Button size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {error && <div className="text-[12px] text-red-400">{error}</div>}
    </div>
  )
}
