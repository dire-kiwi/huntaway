import { workflowDataInputs, type WorkflowGraph, type WorkflowNode } from "@huntaway/contracts"
import { Field, Input } from "../../ui"
import { TemplateField } from "../TemplateField"
import { CheckFields } from "./CheckFields"
import { TEMPLATES, Wired, selectClass } from "./fields"
import type { NodePatch } from "./graph"
import { dataLabel, kindTitle } from "./text"

const PROMPTS = ["start", "review", "merge"] as const
const isPrompt = (v: string): v is (typeof PROMPTS)[number] => PROMPTS.some((p) => p === v)

/** A data node's settings. */
export function ValueInspector({
  node: n,
  graph,
  onChange,
  onUnwire,
}: {
  node: WorkflowNode
  graph: WorkflowGraph
  onChange: (patch: NodePatch) => void
  onUnwire: (input: string) => void
}) {
  const inputs = workflowDataInputs(n)
  const uses = graph.edges.filter((e) => e.input !== undefined && e.from === n.id).length
  return (
    <>
      <Field label="Name" hint="What the canvas and the wires from it call it.">
        <Input
          className="h-7"
          value={n.label ?? ""}
          maxLength={60}
          placeholder={kindTitle(n)}
          onChange={(e) => onChange({ label: e.target.value || undefined })}
        />
      </Field>
      {n.kind === "text" && (
        <Field
          label="Text"
          hint={
            <>
              Templates: <code className="text-[11px]">{TEMPLATES}</code>.
            </>
          }
        >
          <TemplateField graph={graph} self={n.id} rows={6} className="text-[12.5px]" value={n.text} onChange={(text) => onChange({ text })} />
        </Field>
      )}
      {n.kind === "task" && <p className="text-[11.5px] text-faint">The task's title, description, key, branch, commit, pull request and labels, as values.</p>}
      {n.kind === "project_prompt" && (
        <Field label="Prompt" hint="The project's own, from its Prompts settings, or the board's if it has none.">
          <select className={selectClass} value={n.which} onChange={(e) => isPrompt(e.target.value) && onChange({ which: e.target.value })}>
            <option value="start">Starting a task</option>
            <option value="review">Reviewing its changes</option>
            <option value="merge">Merging it</option>
          </select>
        </Field>
      )}
      {n.kind === "compose" && (
        <Field
          label="Template"
          hint={
            <>
              Each <code className="text-[11px]">{"{{name}}"}</code> without a dot is an input to wire a value into; unwired, it's the template's own value
              (such as <code className="text-[11px]">{"{{issues}}"}</code>) or left as it is. Templates: <code className="text-[11px]">{TEMPLATES}</code>.
            </>
          }
        >
          <TemplateField
            graph={graph}
            self={n.id}
            rows={6}
            className="font-mono text-[12px]"
            value={n.template}
            onChange={(template) => onChange({ template })}
          />
        </Field>
      )}
      {n.kind === "join" && (
        <>
          <Field label="Inputs">
            <div className="w-24">
              <Input
                type="number"
                min={1}
                max={8}
                value={n.count}
                onChange={(e) => onChange({ count: Math.max(1, Math.min(8, Math.floor(Number(e.target.value) || 1))) })}
              />
            </div>
          </Field>
          <Field label="Between them" hint="\n is a new line. The inputs without text are left out.">
            <Input
              className="h-7 font-mono text-[12px]"
              value={n.separator.replaceAll("\n", "\\n")}
              onChange={(e) => onChange({ separator: e.target.value.replaceAll("\\n", "\n") })}
            />
          </Field>
        </>
      )}
      {n.kind === "switch" && <CheckFields label="Gives its yes input when" checks={["has_pr", "task_type", "label"]} node={n} onChange={onChange} />}
      {inputs.length > 0 && (
        <div className="space-y-1">
          <span className="block text-xs font-medium text-muted">Inputs</span>
          {inputs.map((k) => (
            <div key={k} className="flex items-center gap-2 text-[12px] text-muted">
              <span className="w-14 shrink-0 font-mono text-[11.5px]">{dataLabel(k)}</span>
              <div className="min-w-0 flex-1">
                <Wired graph={graph} node={n} input={k} onUnwire={onUnwire}>
                  <span className="text-[11.5px] text-faint">Nothing wired</span>
                </Wired>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="text-[11.5px] text-faint">
        A value is read when the step it goes into runs: a step's output is from its run, or the workflow's last run on the task that ran it.{" "}
        {uses ? `It goes into ${uses} input${uses === 1 ? "" : "s"}.` : "Wire it into an input to use it."}
      </p>
    </>
  )
}
