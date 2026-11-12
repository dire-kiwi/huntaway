// The thread's model and effort, in its message box beside the permission mode: what its next run starts with.
import type { HostTask as Task } from "@huntaway/client"
import { Effort } from "@huntaway/contracts"
import { Schema } from "effect"
import { Cpu, Gauge } from "lucide-react"
import { useState } from "react"
import { effortOptions, inheritedModel, modelOptions, useAgentModels } from "../../../agents"
import { useBoard } from "../../../state/board"
import { useMutation } from "../../../state/mutation"
import { useProject } from "../../boardHelpers"
import { useThreadConfig } from "../view/hooks"
import { PickerMenu, type PickerOption } from "./PickerMenu"

const isEffort = Schema.is(Effort)

export function ModelEffort({ task }: { task: Task }) {
  const project = useProject(task.project_id)
  const hostEffort = useBoard((s) => s.hostSettings[task.host_id]?.default_effort)
  const profileModel = useBoard((s) => s.profiles.find((p) => p.host_id === task.host_id && p.id === task.profile_id)?.default_model)
  const hostModel = useBoard((s) => s.hostSettings[task.host_id]?.default_model)
  const threadConfig = useThreadConfig(task).current
  // A Codex config's models (`configs.models`), or Claude's aliases.
  const models = useAgentModels(task.host_id, threadConfig)
  const [changing, setChanging] = useState("")
  const [typing, setTyping] = useState(false)
  const [{ error }, update] = useMutation("tasks.update")
  const change = (fields: { model?: string | null; effort?: Effort | null }, what: string) => {
    setChanging(what)
    void update(task.host_id, { id: task.id, patch: fields })
  }
  const err = error === null ? null : `Couldn't change the ${changing}: ${error}`
  const offered = modelOptions(threadConfig, models)
  const model = task.model ?? ""
  // What the default resolves to; with none set (cleared in the host settings), the one its own latest reply came from.
  const inherited = inheritedModel(threadConfig, models, project?.model, profileModel, hostModel) || (task.model ? null : task.context?.model)
  const modelItems: PickerOption[] = [
    { value: "", label: "Default model", hint: inherited ? `Uses ${inherited}` : "The project's, profile's or host's" },
    ...offered.map((m) => ({ value: m.id, label: m.label, hint: m.label.toLowerCase() === m.id.toLowerCase() ? undefined : m.id })),
    ...(model && !offered.some((m) => m.id === model) ? [{ value: model, label: model }] : []),
    { value: CUSTOM, label: "Specific model…", hint: "A model id, typed in", divider: true },
  ]
  const modelLabel = model ? (offered.find((m) => m.id === model)?.label ?? model) : inherited ? `${inherited} (default)` : "Default model"
  const efforts = [...new Set([...effortOptions(threadConfig, models, model), ...(task.effort ? [task.effort] : [])])]
  const effortItems: PickerOption[] = [
    { value: "", label: "Default effort", hint: hostEffort ? `Uses ${hostEffort}` : "The agent's own" },
    ...efforts.map((e) => ({ value: e, label: `${e} effort` })),
  ]
  const effortLabel = task.effort ? `${task.effort} effort` : hostEffort ? `${hostEffort} effort (default)` : "Default effort"
  const footer = task.running ? "Changes apply from the agent's next run." : undefined
  return (
    <>
      {typing ? (
        <ModelInput
          value={model}
          onDone={(m) => {
            setTyping(false)
            if (m !== model) change({ model: m || null }, "model")
          }}
        />
      ) : (
        <PickerMenu
          title="Model"
          icon={<Cpu size={12} />}
          label={modelLabel}
          options={modelItems}
          value={model}
          footer={footer}
          onPick={(m) => (m === CUSTOM ? setTyping(true) : m !== model && change({ model: m || null }, "model"))}
        />
      )}
      <PickerMenu
        title="Effort"
        icon={<Gauge size={12} />}
        label={effortLabel}
        options={effortItems}
        value={task.effort ?? ""}
        footer={footer}
        onPick={(e) => e !== (task.effort ?? "") && change({ effort: isEffort(e) ? e : null }, "effort")}
      />
      {err && (
        <span className="truncate text-[11px] text-red-400" title={err}>
          {err}
        </span>
      )}
    </>
  )
}

const CUSTOM = "__custom"

/** A specific model id, typed in place of the menu: saved once, on Enter or on leaving the field. */
function ModelInput({ value, onDone }: { value: string; onDone: (model: string) => void }) {
  const [draft, setDraft] = useState(value)
  return (
    <input
      autoFocus
      aria-label="Model id"
      value={draft}
      placeholder="model id, e.g. claude-opus-5-5"
      className="h-6 w-52 min-w-0 shrink rounded-md border border-accent/60 bg-panel px-1.5 font-mono text-[11.5px] text-fg outline-none placeholder:text-faint"
      // Selected, so typing replaces the model it starts from.
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onDone(draft.trim())}
      onKeyDown={(e) => {
        // Enter confirms the model rather than sending the message.
        if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
    />
  )
}
