import { clsx } from "clsx"
import { useState } from "react"
import { agentOf } from "@huntaway/client"
import { ProfileId, type Automation, type DocumentLabel } from "@huntaway/contracts"
import { effortOptions, inheritedModel, modelOptions, useAgentModels } from "../../../agents"
import { useBoard } from "../../../state/board"
import { useRpc } from "../../../state/rpc"
import { useAvailableConfigs, useShallow } from "../../boardHelpers"
import { ModelPicker } from "../../layout/newTask/ModelPicker"
import { Button, errorText, Field, Input, Modal, ModalFooter, SUBMIT_KEYS, Textarea, Toggle } from "../../ui"
import { type TimeZone, type Owner, DAY_LABELS } from "./text"
import { type Unit, type Draft, LABELS, localInput, draftOf, inputOf, WEEKDAYS } from "./draft"

const UNITS: ReadonlyArray<Unit> = ["minutes", "hours", "days"]
import { Segmented, selectClass } from "./controls"
import { GuardFields } from "./GuardFields"
import { WebhookFields } from "./WebhookFields"

export function AutomationEditor({
  owner,
  automation,
  tz,
  onSaved,
  onClose,
}: {
  owner: Owner
  automation: Automation | null
  tz: TimeZone | null
  onSaved: () => void
  onClose: () => void
}) {
  const { hostId, project } = owner
  const rpc = useRpc()
  // A profile's routine: it wakes the assistant, and makes no tasks.
  const routine = !project
  const what = routine ? "routine" : "automation"
  const [d, setD] = useState<Draft>(() => draftOf(automation, routine))
  const [saved, setSaved] = useState<Automation | null>(automation)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }))
  const configs = useAvailableConfigs(hostId, owner.profileId, project)
  // The model and effort are offered as the new task dialog offers them: for the config the task runs with.
  const configObj = configs.find((c) => c.id === d.config) ?? configs[0]
  const models = useAgentModels(hostId, configObj)
  const profileModel = useBoard((s) => s.profiles.find((p) => p.host_id === hostId && p.id === owner.profileId)?.default_model)
  const hostSettings = useBoard((s) => s.hostSettings[hostId])
  const efforts = effortOptions(configObj, models, d.model)
  // Models and efforts are the agent's own, so picking another agent starts them over.
  const setConfig = (id: string) =>
    setD((x) => {
      const other = agentOf(configs.find((c) => c.id === id) ?? configs[0]) !== agentOf(configObj)
      return { ...x, config: id, ...(other ? { model: "", effort: "" } : {}) }
    })
  const toggleLabel = (l: DocumentLabel) =>
    setD((x) => ({ ...x, labels: x.labels.includes(l) ? x.labels.filter((y) => y !== l) : LABELS.filter((y) => y === l || x.labels.includes(y)) }))
  const tasks = useBoard(
    useShallow((s) =>
      Object.values(s.tasks)
        .filter((t) => !!project && t.host_id === hostId && t.project_id === project.id && t.kind === "task")
        .toSorted((a, b) => b.number - a.number),
    ),
  )
  const save = async () => {
    setErr(null)
    if (!d.name.trim()) return setErr("Give it a name.")
    if (d.does === "create_task" && !d.title.trim()) return setErr("The task needs a title.")
    if (d.does === "send_to_task" && !d.taskId) return setErr("Pick the task to message.")
    if (d.does !== "create_task" && !d.message.trim()) return setErr("Write the message.")
    if (d.when === "cron" && d.cron.trim().split(/\s+/).length !== 5 && !d.cron.trim().startsWith("@")) return setErr("A cron expression has five fields.")
    // Only a time that's just been set (or a routine just turned on) has to be to come, as on the server: one that's run
    // (and so turned itself off) can still be renamed or edited.
    const atChanged = !saved || !saved.enabled || saved.trigger.kind !== "at" || localInput(saved.trigger.at) !== d.at
    if (d.when === "at" && d.enabled && atChanged && !(new Date(d.at).getTime() > Date.now())) return setErr("Pick a time to come.")
    setBusy(true)
    try {
      const b = inputOf(d, saved)
      const a = saved
        ? await rpc(hostId, "automations.update", { id: saved.id, patch: b })
        : project
          ? await rpc(hostId, "automations.create", { project_id: project.id, automation: b })
          : await rpc(hostId, "automations.create", { profile_id: ProfileId.make(owner.profileId), automation: b })
      onSaved()
      // A new webhook stays open, to show its URL, and the secret it was given until it closes.
      if (!saved && a.trigger.kind === "webhook") {
        setSaved(a)
        setD({ ...draftOf(a, routine), secret: d.secret })
        setBusy(false)
        return
      }
      onClose()
    } catch (e) {
      setErr(errorText(e))
      setBusy(false)
    }
  }
  const webhook = d.when === "webhook"
  const vars = webhook
    ? ["{{body.issue.title}}", "{{body.issue.html_url}}", "{{body.issue.body}}", "{{event}}", "{{action}}", "{{labels}}", "{{count}}"]
    : ["{{date}}", "{{time}}", "{{automation}}"]
  if (d.precheck.trim()) vars.push("{{precheck}}")
  const templateHint = (
    <>
      Templates take values like{" "}
      {vars.map((v, i) => (
        <span key={v}>
          {i > 0 && ", "}
          <code>{v}</code>
        </span>
      ))}
      .
      {(webhook || d.precheck.trim()) &&
        " A webhook's values and the precheck's output are wrapped in <untrusted-data> tags, and the agent is told not to follow instructions in them."}
    </>
  )
  return (
    <Modal title={saved ? `Edit ${saved.name}` : `New ${what}`} onClose={onClose} onSubmit={() => void save()} width="max-w-2xl">
      <div className="space-y-4">
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <Field label="Name">
            <Input
              value={d.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder={routine ? "Morning inbox check" : "Weekly dependency update"}
              autoFocus={!saved}
            />
          </Field>
          <div className="pb-1.5">
            <Toggle checked={d.enabled} onChange={(v) => set("enabled", v)} label="On" />
          </div>
        </div>

        <div className="space-y-3 rounded-lg border border-line/70 p-3">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-muted">When</span>
            <Segmented
              value={d.when}
              onChange={(v) => set("when", v)}
              options={[
                { id: "daily", label: "At a time of day" },
                { id: "interval", label: "Every…" },
                { id: "cron", label: "Cron" },
                { id: "at", label: "Once" },
                { id: "webhook", label: "From a webhook" },
              ]}
            />
          </div>
          {d.when === "interval" && (
            <div className="flex items-center gap-2 text-[13px]">
              Every
              <Input
                type="number"
                min={1}
                className="w-20"
                aria-label="Every"
                value={d.every}
                onChange={(e) => set("every", Math.max(1, Number(e.target.value) || 1))}
              />
              <select
                className={clsx(selectClass, "w-28")}
                aria-label="Unit"
                value={d.unit}
                onChange={(e) => {
                  const unit = UNITS.find((u) => u === e.target.value)
                  if (unit) set("unit", unit)
                }}
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
              <span className="text-[12px] text-faint">from when it's turned on (at least 5 minutes)</span>
            </div>
          )}
          {d.when === "daily" && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                At
                <Input type="time" className="w-28" aria-label="Time" value={d.time} onChange={(e) => set("time", e.target.value)} />
                on
                {WEEKDAYS.map((w) => {
                  const on = d.weekdays.includes(w)
                  return (
                    <button
                      key={w}
                      type="button"
                      onClick={() => set("weekdays", on ? d.weekdays.filter((x) => x !== w) : [...d.weekdays, w])}
                      className={clsx(
                        "h-7 w-10 rounded-md border text-[12px]",
                        on ? "border-accent/60 bg-accent/15 text-fg" : "border-line text-faint hover:text-muted",
                      )}
                    >
                      {DAY_LABELS[w]}
                    </button>
                  )
                })}
              </div>
              <div className="text-[12px] text-faint">
                In the host's time zone{tz ? ` (${[tz.name, tz.offset].filter(Boolean).join(", ")})` : ""}. No day picked means every day. A run missed by more
                than 10 minutes (the server was down) is skipped, not made up.
              </div>
            </div>
          )}
          {d.when === "cron" && (
            <div className="space-y-2">
              <Input
                className="font-mono"
                aria-label="Cron expression"
                value={d.cron}
                onChange={(e) => set("cron", e.target.value)}
                placeholder="0 8 * * mon-fri"
              />
              <div className="text-[12px] text-faint">
                Five fields: minute, hour, day of month, month, day of week (e.g. <code>*/30 9-17 * * mon-fri</code>), in the host's time zone
                {tz ? ` (${[tz.name, tz.offset].filter(Boolean).join(", ")})` : ""}. A run missed by more than 10 minutes is skipped.
              </div>
            </div>
          )}
          {d.when === "at" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-[13px]">
                At
                <div className="w-60">
                  <Input type="datetime-local" aria-label="At" value={d.at} onChange={(e) => set("at", e.target.value)} />
                </div>
              </div>
              <div className="text-[12px] text-faint">It runs once (late, if the server was down then), and then turns itself off.</div>
            </div>
          )}
          {webhook && <WebhookFields hostId={hostId} draft={d} saved={saved} set={set} onRotated={(a) => setSaved(a)} />}
        </div>

        <div className="space-y-3 rounded-lg border border-line/70 p-3">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-muted">Do</span>
            {routine ? (
              <Segmented
                value={d.mode}
                onChange={(v) => set("mode", v)}
                options={[
                  { id: "fresh", label: "Run in a fresh thread" },
                  { id: "thread", label: "Message the assistant" },
                ]}
              />
            ) : (
              <Segmented
                value={d.does}
                onChange={(v) => set("does", v)}
                options={[
                  { id: "create_task", label: "Create a task" },
                  { id: "send_to_task", label: "Message a task" },
                ]}
              />
            )}
          </div>
          {d.does === "message_assistant" ? (
            <>
              <div className="text-[12px] text-faint">
                {d.mode === "fresh"
                  ? "The assistant works on it in a thread of its own, with its workspace, memory and tools. Its last message is posted to the assistant's thread as a report, unless it replies NO_REPLY (there's nothing new): then the run is quiet."
                  : "The message goes straight into the assistant's thread, as if sent there, and it replies there."}
              </div>
              <Field label={d.mode === "fresh" ? "What to do" : "Message"} hint={templateHint}>
                <Textarea
                  rows={5}
                  className="font-mono text-[12px]"
                  value={d.message}
                  onChange={(e) => set("message", e.target.value)}
                  placeholder={d.mode === "fresh" ? "Check my inbox for anything that needs a reply today." : "Remind me to call Sam."}
                />
              </Field>
            </>
          ) : d.does === "create_task" ? (
            <>
              <Field label="Title">
                <Input
                  value={d.title}
                  onChange={(e) => set("title", e.target.value)}
                  placeholder={webhook ? "Triage: {{body.issue.title}}" : "Update dependencies ({{date}})"}
                />
              </Field>
              <Field label="Description" hint={templateHint}>
                <Textarea
                  rows={6}
                  className="font-mono text-[12px]"
                  value={d.description}
                  onChange={(e) => set("description", e.target.value)}
                  placeholder={
                    webhook ? "Triage this issue: {{body.issue.html_url}}\n\n{{body.issue.body}}" : "Update the dependencies and open a pull request."
                  }
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Type">
                  <select className={selectClass} value={d.taskType} onChange={(e) => set("taskType", e.target.value === "scratch" ? "scratch" : "")}>
                    <option value="">Code task</option>
                    <option value="scratch">Scratch task</option>
                  </select>
                </Field>
                {configs.length > 1 ? (
                  <Field label="Agent config">
                    <select className={selectClass} value={d.config} onChange={(e) => setConfig(e.target.value)}>
                      <option value="">Project default ({configs[0]?.name})</option>
                      {configs.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  <div />
                )}
                <Field label="Model">
                  <ModelPicker
                    className={selectClass}
                    value={d.model}
                    onChange={(m) => set("model", m)}
                    options={modelOptions(configObj, models)}
                    placeholder={agentOf(configObj) === "codex" ? "model id, e.g. gpt-6.1-sol" : undefined}
                    inherited={inheritedModel(configObj, models, project?.model, profileModel, hostSettings?.default_model)}
                  />
                </Field>
                <Field label="Effort">
                  <select className={selectClass} title="Effort" value={d.effort} onChange={(e) => set("effort", e.target.value)}>
                    <option value="">{hostSettings?.default_effort ? `Default effort (${hostSettings.default_effort})` : "Default effort"}</option>
                    {[...new Set([...efforts, ...(d.effort ? [d.effort] : [])])].map((e) => (
                      <option key={e} value={e}>
                        {e} effort
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field
                label="Labels"
                hint="Documents its agent writes besides its other work, each shown in a tab of the task: a plan it writes first, for you to agree on, an artifact (an HTML page) or a Mermaid diagram."
              >
                <div className="flex flex-wrap gap-1">
                  {LABELS.map((l) => (
                    <button
                      key={l}
                      type="button"
                      aria-pressed={d.labels.includes(l)}
                      onClick={() => toggleLabel(l)}
                      className={clsx(
                        "h-7 rounded-md border px-2.5 text-[12.5px] capitalize",
                        d.labels.includes(l) ? "border-accent/50 bg-accent/10 text-accent" : "border-line text-muted hover:text-fg",
                      )}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </Field>
              <div className="flex flex-wrap items-center gap-4">
                <Toggle checked={d.start} onChange={(v) => set("start", v)} label="Start its agent" />
                {!d.start && (
                  <label className="flex items-center gap-2 text-[13px] text-muted">
                    Put it in
                    <select
                      className={clsx(selectClass, "w-32")}
                      value={d.status}
                      onChange={(e) => set("status", e.target.value === "backlog" ? "backlog" : "todo")}
                    >
                      <option value="todo">To do</option>
                      <option value="backlog">Backlog</option>
                    </select>
                  </label>
                )}
              </div>
              {d.start && webhook && (
                <div className="text-[12px] text-st-attention">
                  Its agent runs with the project's permission mode on what the delivery says. Keep that mode asking for approval if anyone outside can trigger
                  it.
                </div>
              )}
            </>
          ) : (
            <>
              <Field label="Task" hint="One of this project's tasks. Messages to a task whose agent is running go to it as it works.">
                {/* (Only a project's automations message its tasks.) */}
                <select className={selectClass} value={d.taskId} onChange={(e) => set("taskId", e.target.value)}>
                  <option value="">Pick a task…</option>
                  {tasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {project?.key}-{t.number} {t.title}
                      {t.status === "done" ? " (done)" : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Message" hint={templateHint}>
                <Textarea
                  rows={5}
                  className="font-mono text-[12px]"
                  value={d.message}
                  onChange={(e) => set("message", e.target.value)}
                  placeholder={
                    webhook ? "A new comment on {{body.issue.html_url}}:\n\n{{body.comment.body}}" : "Check on the nightly build and fix what broke."
                  }
                />
              </Field>
            </>
          )}
        </div>
        <GuardFields draft={d} set={set} routine={routine} />
        <ModalFooter className="space-y-2">
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-[11.5px] text-faint">{SUBMIT_KEYS} to save</span>
            <Button variant="ghost" onClick={onClose}>
              {saved && !automation ? "Done" : "Cancel"}
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              {saved ? `Save ${what}` : `Add ${what}`}
            </Button>
          </div>
        </ModalFooter>
      </div>
    </Modal>
  )
}
