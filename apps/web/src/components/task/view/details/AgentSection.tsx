import type { HostTask as Task } from "@huntaway/client"
import { AgentConfigId } from "@huntaway/contracts"
import { useState } from "react"
import { useBoard } from "../../../../state/board"
import { rpc } from "../../../../state/rpc"
import { useHost } from "../../../boardHelpers"
import { ActivityTime, Ago, cost, errorText, waitTitle } from "../../../ui"
import { AgentMark } from "../../../ui/AgentIcon"
import { useThreadConfig } from "../hooks"
import { Row, Section } from "./Section"

// The config picker, its agent badge and its usage note were settings/ClaudeConfigs' (step 1 for settings, 6.12):
// until then the row picks from a plain list and names the config.

/** The task's agent: where it runs, what with, and what it has cost. Its model and effort are in the message box (see thread/ModelEffort). */
export function AgentSection({ task }: { task: Task }) {
  const hostCount = useBoard((s) => s.hosts.length)
  const host = useHost(task.host_id)
  return (
    <Section title="Agent" collapsible="agent">
      {hostCount > 1 && <Row label="Host">{host?.name ?? task.host_id.slice(0, 8)}</Row>}
      <Row label="Session">{task.session_id ? <span className="font-mono text-[11px]">{task.session_id}</span> : "—"}</Row>
      {task.running && task.run_started_at && (
        <Row label="Working">
          <ActivityTime task={task} />
        </Row>
      )}
      {task.running && task.agent_wait && <Row label="Waiting">{waitTitle(task.agent_wait)}</Row>}
      <Row label="Cost">{cost(task.cost_usd) ?? "—"}</Row>
      <ConfigRow task={task} />
      {task.auto_allow.length > 0 && <Row label="Allowed">{task.auto_allow.join(", ")}</Row>}
      <Row label="Created">
        <Ago at={task.created_at} />
      </Row>
    </Section>
  )
}

/** The thread's agent config, which can change until its agent first starts. */
function ConfigRow({ task }: { task: Task }) {
  const { current, available } = useThreadConfig(task)
  const [err, setErr] = useState<string | null>(null)
  const options = current && !available.some((c) => c.id === current.id) ? [current, ...available] : available
  const canChange = !task.session_id && !task.running && options.length > 1
  if (!current) return task.session_id ? <Row label="Config">Claude's default config</Row> : null
  return (
    <Row label="Config">
      {canChange ? (
        <select
          className="h-6 rounded border border-line bg-panel px-1 text-[12px] text-fg outline-none"
          value={current.id}
          onChange={(e) => {
            setErr(null)
            rpc(task.host_id, "tasks.update", { id: task.id, patch: { claude_config_id: AgentConfigId.make(e.target.value) } }).catch((x: unknown) =>
              setErr(errorText(x)),
            )
          }}
        >
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      ) : (
        <span className="flex items-center gap-1.5" title={current.config_dir}>
          {current.name}
          <AgentMark agent={current.agent} />
        </span>
      )}
      {err && <div className="text-[11.5px] text-red-400">{err}</div>}
    </Row>
  )
}
