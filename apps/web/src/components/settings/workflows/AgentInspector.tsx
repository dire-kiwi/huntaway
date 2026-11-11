import type { HostAgentConfig as ClaudeConfig, HostProject as Project } from "@huntaway/client"
import { AgentConfigId, type WorkflowGraph, type WorkflowNode } from "@huntaway/contracts"
import { ReviewerRow } from "../../task/Reviewers"
import { Field, Input, Toggle } from "../../ui"
import { AgentStepTools } from "../AgentStepTools"
import { TemplateField } from "../TemplateField"
import { TEMPLATES, Wired, selectClass } from "./fields"
import type { NodePatch } from "./graph"

/** An agent step's settings: its name, output and tab, who runs it, its instructions and tools. */
export function AgentInspector({
  project,
  configs,
  node: n,
  graph,
  onChange,
  onUnwire,
}: {
  project: Project
  configs: ReadonlyArray<ClaudeConfig>
  node: Extract<WorkflowNode, { readonly kind: "agent" }>
  graph: WorkflowGraph
  onChange: (patch: NodePatch) => void
  onUnwire: (input: string) => void
}) {
  return (
    <>
      <Field label="Name">
        <Input className="h-7" value={n.name} maxLength={60} onChange={(e) => onChange({ name: e.target.value })} />
      </Field>
      <Field label="Output">
        <select className={selectClass} value={n.output} onChange={(e) => onChange({ output: e.target.value === "verdict" ? "verdict" : "text" })}>
          <option value="text">Text: its last message</option>
          <option value="verdict">Verdict: pass, or the serious issues it found</option>
        </select>
      </Field>
      <Field label="Tab" hint="The task panel tab its output shows in. Steps can share one.">
        <Input className="h-7" value={n.tab ?? ""} maxLength={30} placeholder="No tab" onChange={(e) => onChange({ tab: e.target.value || undefined })} />
      </Field>
      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-muted">Agent</span>
        <ReviewerRow
          hostId={project.host_id}
          configs={configs}
          models={{ project: project.model }}
          value={{ claude_config_id: n.claude_config_id ? AgentConfigId.make(n.claude_config_id) : null, model: n.model ?? null, effort: n.effort ?? null }}
          onChange={(v) => v && onChange({ claude_config_id: v.claude_config_id ?? undefined, model: v.model ?? undefined, effort: v.effort ?? undefined })}
          removable={false}
        />
      </div>
      <Field
        label="Instructions"
        hint={
          <>
            Blank is the review instructions for a verdict, or "report on the work" for text. Templates: <code className="text-[11px]">{TEMPLATES}</code>.
          </>
        }
      >
        <Wired graph={graph} node={n} input="prompt" onUnwire={onUnwire}>
          <TemplateField graph={graph} self={n.id} rows={6} className="text-[12.5px]" value={n.prompt} onChange={(prompt) => onChange({ prompt })} />
        </Wired>
      </Field>
      <AgentStepTools
        project={project}
        configId={n.claude_config_id ?? null}
        skills={n.skills ?? []}
        disabled={n.disabled_mcp_servers ?? []}
        onChange={(p) =>
          onChange({
            ...(p.skills && { skills: p.skills }),
            ...(p.disabled_mcp_servers && { disabled_mcp_servers: p.disabled_mcp_servers.length ? p.disabled_mcp_servers : undefined }),
          })
        }
      />
      <Toggle checked={!!n.input_only} onChange={(v) => onChange({ input_only: v || undefined })} label="Work only on what the steps before it wrote" />
      <Toggle
        checked={!!n.keep_conversation}
        onChange={(v) => onChange({ keep_conversation: v || undefined })}
        label="Keep its conversation from one run to the next"
      />
      <p className="text-[11.5px] text-faint">
        It runs in a thread of its own on the task's worktree, with read-only tools,{" "}
        {n.keep_conversation
          ? "and each run goes on from the conversation it had the last time (a reviewer remembers what it found in the rounds before), while its agent, model and effort stay the same"
          : "in a fresh conversation each run"}
        . It's given the output of the agent steps before it{n.input_only ? ", and isn't told where the task's work is" : ""}.
      </p>
    </>
  )
}
