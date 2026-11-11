// The thread's model and effort, in its message box beside the permission mode: what its next run starts with.
import type { HostTask as Task } from "@huntaway/client"
import { Effort } from "@huntaway/contracts"
import { Schema } from "effect"
import { useState } from "react"
import { effortOptions, inheritedModel, modelOptions } from "../../../agents"
import { useBoard } from "../../../state/board"
import { rpc } from "../../../state/rpc"
import { useProject } from "../../boardHelpers"
import { ModelPicker } from "../../layout/newTask/ModelPicker"
import { errorText } from "../../ui"
import { useThreadConfig } from "../view/hooks"

const pickerClass =
  "h-6 min-w-0 max-w-40 shrink rounded-md border border-line bg-transparent px-1 text-[11.5px] text-muted outline-none hover:border-line-strong hover:bg-white/5"

const isEffort = Schema.is(Effort)

export function ModelEffort({ task }: { task: Task }) {
  const project = useProject(task.project_id)
  const hostEffort = useBoard((s) => s.hostSettings[task.host_id]?.default_effort)
  const profileModel = useBoard((s) => s.profiles.find((p) => p.host_id === task.host_id && p.id === task.profile_id)?.default_model)
  const hostModel = useBoard((s) => s.hostSettings[task.host_id]?.default_model)
  const threadConfig = useThreadConfig(task).current
  // A Codex config's models (`configs.models`) are not yet on this server (M5): Claude's aliases are offered.
  const models = null
  const [err, setErr] = useState<string | null>(null)
  const change = (fields: { model?: string | null; effort?: Effort | null }, what: string) => {
    setErr(null)
    rpc(task.host_id, "tasks.update", { id: task.id, patch: fields }).catch((e: unknown) => setErr(`Couldn't change the ${what}: ${errorText(e)}`))
  }
  return (
    <>
      <ModelPicker
        value={task.model ?? ""}
        options={modelOptions(threadConfig, models)}
        commitOnBlur
        className={pickerClass}
        // What the default resolves to; with none set (cleared in the host settings), the one its own latest reply came from.
        inherited={inheritedModel(threadConfig, models, project?.model, profileModel, hostModel) || (task.model ? null : task.context?.model)}
        onChange={(m) => change({ model: m || null }, "model")}
      />
      <select
        className={pickerClass}
        title="Effort"
        value={task.effort ?? ""}
        onChange={(e) => change({ effort: isEffort(e.target.value) ? e.target.value : null }, "effort")}
      >
        <option value="">{hostEffort ? `Default effort (${hostEffort})` : "Default effort"}</option>
        {[...new Set([...effortOptions(threadConfig, models, task.model ?? ""), ...(task.effort ? [task.effort] : [])])].map((e) => (
          <option key={e} value={e}>
            {e} effort
          </option>
        ))}
      </select>
      {err && (
        <span className="truncate text-[11px] text-red-400" title={err}>
          {err}
        </span>
      )}
    </>
  )
}
