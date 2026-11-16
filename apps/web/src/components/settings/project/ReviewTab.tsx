import { useAtomValue } from "@effect/atom-react"
import { workflowsAtom, type HostAgentConfig as ClaudeConfig } from "@huntaway/client"
import type { Reviewer, Workflow } from "@huntaway/contracts"
import { useShallow } from "../../boardHelpers"
import { useBoard } from "../../../state/board"
import { DEFAULT_REVIEWER, InheritPicker, ReviewerList, reviewerLabel, SummarizerList, useReviewerExtras } from "../../task/Reviewers"
import { Field, Help, Input, ToggleField } from "../../ui"
import { Group } from "../parts"
import type { ProjectForm, SetField } from "./ProjectSettings"

// Every host has every setting here, so the old API gates and the single summarizer are gone (docs/plan/09-frontend.md).
// The project's workflows (6.6) are named in `WorkflowsNote`. The skills a summarizer picks from are the agent tools'
// (6.4). Pull requests and merging are their own tab (PullRequestsTab.tsx).

/** The Review tab: the reviews of each task's changes, and the summaries once they pass. */
export function ReviewTab({ form, set }: { form: ProjectForm; set: SetField }) {
  return (
    <>
      <WorkflowsNote project={form} />
      {/* A project that uses workflows has its workflows' steps review and summarise its tasks (HA-277), not these settings. */}
      {!form.use_workflows && (
        <>
          <ToggleField
            checked={form.auto_review}
            onChange={(v) => set("auto_review", v)}
            label="Review each task's changes when it moves to In review"
            help="A reviewer agent checks the changes in its own thread, and sends serious issues back to the task's agent to fix."
          />
          <Field
            label="Fix rounds"
            help="How many times in a row a review's serious issues go back to the agent to fix. After that, the task moves to Needs attention."
          >
            <div className="w-24">
              <Input
                type="number"
                min={0}
                max={20}
                value={form.review_rounds}
                onChange={(e) => set("review_rounds", Math.max(0, Math.min(20, Math.floor(Number(e.target.value) || 0))))}
              />
            </div>
          </Field>
          <ProjectReviewers project={form} onChange={(v) => set("reviewers", v)} />
          <Group title="Summaries">
            <ToggleField
              checked={form.auto_summary}
              onChange={(v) => set("auto_summary", v)}
              label="Summarise each task's changes once its review passes"
              help="An agent writes a summary of what changed in its own thread, which the task opens on while it waits in In review. Summarise now, in the task's Summary tab, writes one at any time."
            />
            <ProjectSummarizer project={form} onChange={(v) => set("summarizers", v)} />
          </Group>
        </>
      )}
    </>
  )
}

/** Who reviews each task: the profile's reviewers, or the project's own, at first one with the task's config. */
function ProjectReviewers({ project, onChange }: { project: ProjectForm; onChange: (v: ReadonlyArray<Reviewer>) => void }) {
  const configs = useBoard(useShallow((s) => s.claudeConfigs.filter((c) => c.host_id === project.host_id)))
  const profile = useBoard((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id))
  const own = project.reviewers.length > 0
  const extras = useReviewerExtras(project.host_id, project.id, project.review_prompt)
  const profiles = profile?.reviewers.length ? profile.reviewers : [DEFAULT_REVIEWER]
  return (
    <Field
      label="Reviewers"
      help="Each reviews in a thread of its own, with its own agent, instructions and skills. Once they've all finished, their serious issues go to the task's agent together."
    >
      <div className="space-y-2">
        <InheritPicker
          own={own}
          onChange={(v) => onChange(v ? profiles : [])}
          what="reviewers"
          profileHas={profiles.map((r) => reviewerLabel(r, configs)).join("; ")}
        />
        {own && (
          <ReviewerList
            hostId={project.host_id}
            configs={configs}
            models={{ project: project.model, profile: profile?.default_model }}
            value={project.reviewers}
            onChange={onChange}
            extras={extras}
          />
        )}
      </div>
    </Field>
  )
}

/** Who summarises each task's changes: the profile's summarizers, or the project's own, each in a thread of its own. */
function ProjectSummarizer({ project, onChange }: { project: ProjectForm; onChange: (v: ReadonlyArray<Reviewer>) => void }) {
  const configs = useBoard(useShallow((s) => s.claudeConfigs.filter((c) => c.host_id === project.host_id)))
  const profile = useBoard((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id))
  const own = project.summarizers.length > 0
  const extras = useReviewerExtras(project.host_id, project.id)
  const profiles = profile?.summarizers.length ? profile.summarizers : [DEFAULT_REVIEWER]
  const models = { project: project.model, profile: profile?.default_model }
  return (
    <Field
      label="Summarizers"
      help="The agents that write the summaries, each in a thread of its own. Give them different skills or prompts to compare them. A quick, cheap model is usually enough."
    >
      <div className="space-y-2">
        <InheritPicker
          own={own}
          onChange={(v) => onChange(v ? profiles : [])}
          what="summarizers"
          profileHas={profiles.map((r) => summarizerLabel(r, configs)).join("; ")}
        />
        {own && (
          <SummarizerList hostId={project.host_id} configs={configs} models={models} value={project.summarizers} onChange={onChange} skills={extras?.skills} />
        )}
      </div>
    </Field>
  )
}

/** Who a summarizer is: its name, if it has one, and its agent, with the skills it uses. */
function summarizerLabel(r: Reviewer, configs: ReadonlyArray<ClaudeConfig>): string {
  return [r.name, reviewerLabel(r, configs), r.skills?.length ? `skills ${r.skills.join(", ")}` : "", r.prompt ? "own prompt" : ""].filter(Boolean).join(" · ")
}

/** Whether a workflow has an agent step after its In review column (before another column): its tasks are reviewed there. */
function agentsInReview(w: Workflow): boolean {
  const g = w.graph
  const start = g.nodes.find((n) => n.kind === "column" && n.status === "in_review")
  const seen = new Set<string>(start ? [start.id] : [])
  const todo = [...seen]
  for (let id = todo.pop(); id !== undefined; id = todo.pop()) {
    for (const e of g.edges) {
      if (e.from !== id || e.input != null || seen.has(e.to)) continue
      const n = g.nodes.find((x) => x.id === e.to)
      if (!n || n.kind === "column") continue
      if (n.kind === "agent") return true
      seen.add(n.id)
      todo.push(n.id)
    }
  }
  return false
}

/**
 * Which of the project's workflows (HA-276) take over from these settings: with the project using workflows, those with
 * agent steps in In review review and summarise its tasks (HA-277); without, the ones that are on only run by hand.
 */
function WorkflowsNote({ project }: { project: ProjectForm }) {
  const list = useAtomValue(workflowsAtom({ host_id: project.host_id, project_id: project.id })).data ?? []
  const box = "flex items-start gap-1.5 rounded-md border border-line/70 bg-raised/40 p-2.5 text-[12px] text-muted"
  if (project.use_workflows) {
    const reviewing = list.filter((w) => w.enabled && agentsInReview(w))
    return (
      <div className={box} data-testid="review-workflows-note">
        <p className="min-w-0 flex-1">
          This project uses workflows, so their steps review and summarise its tasks, not settings here.{" "}
          {reviewing.length
            ? `${reviewing.map((w) => `"${w.name}"`).join(", ")} ${reviewing.length === 1 ? "has" : "have"} agent steps in In review.`
            : "None that's on has agent steps in In review: start one from Review and summarise, or From the Review tab."}
        </p>
        <Help label="Reviews with workflows">
          Its tasks don&apos;t have the board&apos;s own Review and Summary tabs either: a workflow&apos;s agent steps show their output in tabs of their own (a
          step with the tab Review gives tasks a Review tab). They all come back if the project stops using workflows, in its Workflows tab.
        </Help>
      </div>
    )
  }
  const on = list.filter((w) => w.enabled)
  if (!on.length) return null
  return (
    <div className={box} data-testid="review-workflows-note">
      <p className="min-w-0 flex-1">
        {on.map((w) => `"${w.name}"`).join(", ")} only run{on.length === 1 ? "s" : ""} when run from a task.
      </p>
      <Help label="Workflows run by hand">
        Turn on <i>Use workflows instead of the board&apos;s default</i> in the Workflows tab for tasks moving across the board to start{" "}
        {on.length === 1 ? "it" : "them"}, in place of these settings.
      </Help>
    </div>
  )
}
