import type { HostProject as Project } from "@huntaway/client"
import { COLUMN_ROUNDS, Status, workflowWaits, type WorkflowGraph, type WorkflowNode } from "@huntaway/contracts"
import { Schema } from "effect"
import { Field, Input } from "../../ui"
import { TemplateField } from "../TemplateField"
import { Wired, selectClass } from "./fields"
import { doneNote, mergeNote, type NodePatch } from "./graph"

const isStatus = Schema.is(Status)

// Step 1: the board's own start and merge prompts (the old `api.defaultPrompts`) aren't on this server yet (the host's
// `defaultPrompts` comes with the project settings' Prompts tab, 6.12), so a blank prompt without the project's own
// says it's the board's default rather than showing it.

/** A column node's settings: its column, the prompt its agent is sent there, and when its work is done. */
export function ColumnInspector({
  project,
  node: n,
  graph,
  statuses,
  onChange,
  onUnwire,
}: {
  project: Project
  node: Extract<WorkflowNode, { readonly kind: "column" }>
  graph: WorkflowGraph
  statuses: ReadonlyArray<{ readonly id: Status; readonly label: string }>
  onChange: (patch: NodePatch) => void
  onUnwire: (input: string) => void
}) {
  const taken = new Set(graph.nodes.flatMap((x) => (x.kind === "column" && x.id !== n.id ? [x.status] : [])))
  const promptless = n.status === "needs_attention" || n.status === "done"
  const merge = n.status === "ready_for_merge"
  // A merge's done is the task being merged, not the agent's turn ending: its note says how to say it's merged, when the
  // workflow moves the task to Done (and there's none when the agent sets it done itself).
  const note = merge ? mergeNote(graph, n.id) : doneNote(graph, n.id)
  const waits = workflowWaits(n, graph)
  // The note goes where `next` is wired, if it is, rather than at the end.
  const placed = graph.edges.some((e) => e.input !== undefined && e.from === n.id && e.port === "next")
  const wired = graph.edges.find((e) => e.input === "prompt" && e.to === n.id)
  const own = n.prompt.trim()
  // A blank In progress or Ready for merge prompt is the project's (or else the board's default).
  const inherited = n.status === "in_progress" ? project.start_prompt?.trim() : merge ? project.merge_prompt?.trim() : ""
  const sent = wired ? null : own || inherited || ""
  const boardDefault = !wired && !sent && (n.status === "in_progress" || merge)
  return (
    <>
      <Field label="Column" hint="A workflow has one step for each column.">
        <select
          className={selectClass}
          value={n.status}
          onChange={(e) => {
            const status = e.target.value
            if (!isStatus(status)) return
            const none = status === "needs_attention" || status === "done"
            onChange({ status, ...(none ? { prompt: "" } : {}), ...(none || status === "ready_for_merge" ? { done_when: undefined } : {}) })
          }}
        >
          {statuses.map((st) => (
            <option key={st.id} value={st.id} disabled={taken.has(st.id)}>
              {st.label}
            </option>
          ))}
        </select>
      </Field>
      {!promptless && (
        <Field
          label={n.status === "in_progress" ? "Start prompt" : merge ? "How to merge" : "Prompt"}
          hint={
            n.status === "in_progress"
              ? "What the task's agent starts with, after the task's title and description. Blank is the project's start prompt."
              : merge
                ? "The agent's merge instructions, in place of the project's. Blank is the project's."
                : "Sent to the task's agent when the task enters the column. Blank sends nothing, and what comes after runs at once."
          }
        >
          <Wired graph={graph} node={n} input="prompt" onUnwire={onUnwire}>
            <TemplateField graph={graph} self={n.id} rows={5} className="text-[12.5px]" value={n.prompt} onChange={(prompt) => onChange({ prompt })} />
          </Wired>
        </Field>
      )}
      {waits && !merge && (
        <Field label="Done when">
          <select
            className={selectClass}
            value={n.done_when ?? "run_end"}
            onChange={(e) => onChange({ done_when: e.target.value === "finish" ? "finish" : undefined })}
          >
            <option value="run_end">The agent's turn ends (not asking you anything)</option>
            <option value="finish">The agent says so, with finish_work</option>
          </select>
        </Field>
      )}
      {n.status === "in_progress" && graph.edges.some((e) => e.input === undefined && e.to === n.id) && (
        <Field
          label="Rounds"
          hint={`A line back into In progress gives the agent its work again. How many times in a row it can before the task moves to Needs attention instead (${COLUMN_ROUNDS} when blank).`}
        >
          <div className="w-24">
            <Input
              type="number"
              min={1}
              max={20}
              placeholder={String(COLUMN_ROUNDS)}
              value={n.max_rounds ?? ""}
              onChange={(e) => onChange({ max_rounds: e.target.value === "" ? undefined : Math.max(1, Math.min(20, Math.floor(Number(e.target.value) || 1))) })}
            />
          </div>
        </Field>
      )}
      {/* A column that doesn't wait sends nothing (its done comes at once): only the value of its `next`, if it's wired. */}
      {!waits && placed && note && (
        <div className="space-y-1">
          <span className="block text-xs font-medium text-muted">What happens next, as its value gives it</span>
          <p className="rounded border border-line/70 bg-raised/40 p-2 text-[11.5px] whitespace-pre-wrap text-muted" data-testid="column-next-value">
            {note}
          </p>
        </div>
      )}
      {waits && (wired || sent || note || boardDefault) && (
        <div className="space-y-1" data-testid="column-prompt-preview">
          <span className="block text-xs font-medium text-muted">What the agent is sent</span>
          <div className="space-y-2 rounded border border-line/70 bg-raised/40 p-2 text-[11.5px] whitespace-pre-wrap text-muted">
            {merge && <p className="text-faint">The board's merge message first: which branch to merge into which, and that the task is merged.</p>}
            {wired ? (
              <p className="text-faint italic">The value wired into its prompt.</p>
            ) : sent ? (
              <p>
                {!own && <span className="block text-faint">{merge ? "The project's merge prompt:" : "The project's start prompt:"}</span>}
                {sent}
              </p>
            ) : boardDefault ? (
              <p className="text-faint italic">{merge ? "The board's default merge prompt." : "The board's default start prompt."}</p>
            ) : null}
            {merge && (
              <p className="text-faint">
                {note
                  ? "Then what to do if it can't merge, and how to say it's merged:"
                  : "Then what to do if it can't merge, and to set the task to Done once it is."}
              </p>
            )}
            {note && (
              <p data-testid="column-done-note">
                {placed && <span className="block text-faint">What happens next, where it's wired:</span>}
                {note}
              </p>
            )}
          </div>
        </div>
      )}
      <p className="text-[11.5px] text-faint">
        {merge
          ? note
            ? "Its done comes once the agent says the task is merged (with finish_work), and the line into Done moves it there."
            : "Its done comes once the task is merged: its agent sets it done. A line from its done into Done (directly, or after steps) has the workflow move it there instead, once the agent says it's merged."
          : waits
            ? n.done_when === "finish"
              ? "Its done comes once the agent calls finish_work and ends its turn: a turn that ends without it, or with a question for you, leaves the task in Needs attention until the agent is done. Meanwhile the task stays in In progress rather than going to In review."
              : "Its done comes once the agent's turn ends: one that asks you something leaves the task in Needs attention until the agent is done. Meanwhile the task stays in In progress rather than going to In review: with nothing after done, it goes there then."
            : "Its done comes as soon as a task moves here."}{" "}
        A line into it moves the task here.
      </p>
    </>
  )
}
