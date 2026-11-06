import { useState } from "react";
import { api, hostSupports, type Effort, type Host, type Project, type Task } from "../../../../api";
import { useStore } from "../../../../store";
import { AgentBadge, ConfigSelect, ConfigUsageNote, configDir } from "../../../settings/ClaudeConfigs";
import { effortOptions, inheritedModel, useAgentModels } from "../../../../agents";
import { ActivityTime, Ago, cost, ErrorBox, errorText, waitTitle } from "../../../ui";
import { useThreadConfig } from "../hooks";
import { Row, Section, TextInput } from "./Section";

/** The task's agent: where it runs, what with, and what it has cost. */
export function AgentSection({ task, host, project }: { task: Task; host: Host | undefined; project: Project | undefined }) {
  const hostCount = useStore((s) => s.hosts.length);
  const hostEffort = useStore((s) => s.hostSettings[task.host_id]?.default_effort);
  const threadConfig = useThreadConfig(task).current;
  const models = useAgentModels(threadConfig);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Section title="Agent">
      {hostCount > 1 && <Row label="Host">{host?.name ?? task.host_id.slice(0, 8)}</Row>}
      <Row label="Session">{task.session_id ? <span className="font-mono text-[11px]">{task.session_id}</span> : "—"}</Row>
      {task.running && task.run_started_at && (
        <Row label="Working">
          <ActivityTime task={task} />
        </Row>
      )}
      {task.running && task.agent_wait && <Row label="Waiting">{waitTitle(task.agent_wait)}</Row>}
      <Row label="Cost">{cost(task.cost_usd) ?? "—"}</Row>
      {hostSupports(host, 20) && <ConfigRow task={task} />}
      <Row label="Model">
        <TextInput
          value={task.model}
          placeholder={inheritedModel(threadConfig, models, project?.model) || "default"}
          onSave={(m) => {
            setErr(null);
            api.updateTask(task.host_id, task.id, { model: m || null }).catch((e) => setErr(`Couldn't change the model: ${errorText(e)}`));
          }}
        />
      </Row>
      {hostSupports(host, 14) && (
        <Row label="Effort">
          <select
            className="h-6 rounded border border-line bg-panel px-1 text-[12px] text-fg outline-none"
            value={task.effort ?? ""}
            onChange={(e) => {
              setErr(null);
              api
                .updateTask(task.host_id, task.id, { effort: (e.target.value || null) as Effort | null })
                .catch((err) => setErr(`Couldn't change the effort: ${errorText(err)}`));
            }}
          >
            <option value="">{hostEffort ? `default (${hostEffort})` : "default"}</option>
            {[...new Set([...effortOptions(threadConfig, models, task.model ?? ""), ...(task.effort ? [task.effort] : [])])].map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </Row>
      )}
      {task.auto_allow.length > 0 && <Row label="Allowed">{task.auto_allow.join(", ")}</Row>}
      <Row label="Created">
        <Ago at={task.created_at} />
      </Row>
      {err && <ErrorBox className="mt-2">{err}</ErrorBox>}
    </Section>
  );
}

/** The thread's agent config, which can change until its agent first starts. */
function ConfigRow({ task }: { task: Task }) {
  const { current, available } = useThreadConfig(task);
  const [err, setErr] = useState<string | null>(null);
  const options = current && !available.some((c) => c.id === current.id) ? [current, ...available] : available;
  const canChange = !task.session_id && !task.running && options.length > 1;
  if (!current) return task.session_id ? <Row label="Config">Claude's default config</Row> : null;
  return (
    <Row label="Config">
      {canChange ? (
        <ConfigSelect
          className="h-6 rounded border border-line bg-panel px-1 text-[12px] text-fg outline-none"
          configs={options}
          value={current.id}
          onChange={(id) => {
            setErr(null);
            api.updateTask(task.host_id, task.id, { claude_config_id: id }).catch((e) => setErr(e.message));
          }}
        />
      ) : (
        <span className="flex items-center gap-1.5" title={configDir(current)}>
          {current.name}
          <AgentBadge config={current} />
        </span>
      )}
      <ConfigUsageNote config={current} className="mt-0.5" />
      {err && <div className="text-[11.5px] text-red-400">{err}</div>}
    </Row>
  );
}
