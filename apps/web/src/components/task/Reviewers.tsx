import { agentOf, type HostAgentConfig as ClaudeConfig } from "@huntaway/client"
import { AgentConfigId, type Reviewer } from "@huntaway/contracts"
import { Trash2 } from "lucide-react"
import { effortOptions, inheritedModel, modelOptions, useAgentModels } from "../../agents"
import { useBoard } from "../../state/board"
import { ModelPicker, pickerClass } from "../layout/newTask/ModelPicker"
import { IconButton } from "../ui"

// 6.6 brings over the one row a workflow's agent step picks its agent with. The rest of the old Reviewers.tsx (the
// project's and profile's reviewer and summarizer lists, their instructions and skills, whose they are) comes with the
// settings that show them (6.12).

/** The models a reviewer's blank model falls back to before the host's: the project's and the profile's. */
export interface InheritedModels {
  project?: string | null | undefined
  profile?: string | null | undefined
}

/** One reviewer (or a summarizer, or an agent step): its agent config, model and effort. */
export function ReviewerRow({
  hostId,
  configs,
  models: inherit,
  value,
  onChange,
  removable,
}: {
  hostId: string
  configs: ReadonlyArray<ClaudeConfig>
  models: InheritedModels
  value: Reviewer
  onChange: (v: Reviewer | null) => void
  removable: boolean
}) {
  const config = configs.find((c) => c.id === value.claude_config_id)
  const models = useAgentModels(hostId, config)
  const hostSettings = useBoard((s) => s.hostSettings[hostId])
  const model = value.model ?? ""
  const efforts = effortOptions(config, models, model)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={pickerClass}
        title="Agent config"
        value={value.claude_config_id ?? ""}
        // Another agent has other models.
        onChange={(e) =>
          onChange(Object.assign({}, value, { claude_config_id: e.target.value ? AgentConfigId.make(e.target.value) : null, model: null, effort: null }))
        }
      >
        <option value="">The task's config</option>
        {configs.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {agentOf(c) === "codex" ? " (Codex)" : ""}
          </option>
        ))}
        {value.claude_config_id && !config && <option value={value.claude_config_id}>Deleted config (uses the task's)</option>}
      </select>
      <ModelPicker
        value={model}
        onChange={(m) => onChange(Object.assign({}, value, { model: m || null }))}
        options={modelOptions(config, models)}
        placeholder={agentOf(config) === "codex" ? "model id, e.g. gpt-6.1-sol" : undefined}
        inherited={inheritedModel(config, models, inherit.project, inherit.profile, hostSettings?.default_model)}
      />
      <select
        className={pickerClass}
        title="Effort"
        value={value.effort ?? ""}
        onChange={(e) => onChange(Object.assign({}, value, { effort: e.target.value || null }))}
      >
        <option value="">{hostSettings?.default_effort ? `Default effort (${hostSettings.default_effort})` : "Default effort"}</option>
        {efforts.map((e) => (
          <option key={e} value={e}>
            {e} effort
          </option>
        ))}
        {value.effort && !efforts.includes(value.effort) && <option value={value.effort}>{value.effort} effort</option>}
      </select>
      {removable && (
        <IconButton title="Remove this reviewer" onClick={() => onChange(null)}>
          <Trash2 size={13} />
        </IconButton>
      )}
    </div>
  )
}
