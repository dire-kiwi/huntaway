import { useAtomValue } from "@effect/atom-react"
import { workflowsAtom, type HostAgentConfig as ClaudeConfig } from "@huntaway/client"
import { WatchPullRequests, type Reviewer, type Workflow } from "@huntaway/contracts"
import { Schema } from "effect"
import { useShallow } from "../../boardHelpers"
import { useBoard } from "../../../state/board"
import { DEFAULT_REVIEWER, InheritPicker, ReviewerList, reviewerLabel, SummarizerList, useReviewerExtras } from "../../task/Reviewers"
import { Field, Input, Toggle } from "../../ui"
import type { ProjectForm, SetField } from "./ProjectSettings"

// Every host has every setting here, so the old API gates and the single summarizer are gone, and subprojects' pull
// requests with subprojects (docs/plan/09-frontend.md). The project's workflows (6.6) are named in `WorkflowsNote`. The
// skills a summarizer picks from are the agent tools' (6.4).

const isWatch = Schema.is(WatchPullRequests)

/** The Review tab: reviews, summaries, pull requests and their previews, merge approval, and what happens once a task is merged. */
export function ReviewTab({ form, set }: { form: ProjectForm; set: SetField }) {
  // A project that uses workflows has its workflows' steps review and summarise its tasks (HA-277), not these settings.
  const inWorkflows = form.use_workflows
  return (
    <>
      <WorkflowsNote project={form} />
      {!inWorkflows && (
        <>
          <div className="space-y-1.5">
            <Toggle checked={form.auto_review} onChange={(v) => set("auto_review", v)} label="Review each task's changes when it moves to In review" />
            <div className="text-[12px] text-faint">
              A reviewer agent checks the branch's pull request in its own thread, and sends serious issues back to the task's agent to fix.
            </div>
          </div>
          <Field
            label="Fix rounds"
            hint="How many times in a row a review's serious issues go back to the agent to fix. After that, the task moves to Needs attention."
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
        </>
      )}

      {!inWorkflows && (
        <>
          <div className="space-y-1.5">
            <Toggle checked={form.auto_summary} onChange={(v) => set("auto_summary", v)} label="Summarise each task's changes once its review passes" />
            <div className="text-[12px] text-faint">
              An agent reads the work in its own thread and writes a summary of what changed, which the task opens on while it waits in In review. Summarise now
              in the task's Summary tab writes one at any time.
            </div>
          </div>
          <ProjectSummarizer project={form} onChange={(v) => set("summarizers", v)} />
        </>
      )}

      <div className="space-y-1.5">
        <Toggle checked={form.pull_requests} onChange={(v) => set("pull_requests", v)} label="Open a pull request for each task" />
        <div className="text-[12px] text-faint">
          When the repository is on GitHub, a task's agent pushes its branch and opens a pull request before it finishes. Turned off, agents are told not to
          push or open one unless you ask, even if the project's own instructions (in CLAUDE.md, say) say to.
        </div>
      </div>
      <ProjectMergeApproval project={form} onChange={(v) => set("merge_approval", v)} />

      <ProjectPrApproval project={form} onChange={(v) => set("require_pr_approval", v)} />

      <div className="space-y-1.5">
        <Toggle
          checked={form.done_when_merged}
          onChange={(v) => set("done_when_merged", v)}
          label="Move a task to Done when its pull request is merged on GitHub"
        />
        <div className="text-[12px] text-faint">
          Every few minutes, the pull requests of tasks in In review or Needs attention are checked. A merged one moves its task to Done and removes its
          worktree if nothing in it would be lost; one closed without merging moves its task to Needs attention.
        </div>
      </div>

      <Field
        label="Watch pull requests in review"
        hint="While a task is in In review, the board reads its pull request every couple of minutes and sends its agent what's new, which starts its turn. Only comments and reviews from people who can push to the repository (its owner, members and collaborators) count, not those from bots or from the agents' own GitHub account (yours too, if you share it)."
      >
        <select
          value={form.watch_pull_requests}
          onChange={(e) => {
            const v = e.target.value
            if (isWatch(v)) set("watch_pull_requests", v)
          }}
          className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
        >
          <option value="off">Off</option>
          <option value="failures">Failed checks and conflicts wake the agent</option>
          <option value="all">Failed checks, conflicts, comments and reviews wake the agent</option>
        </select>
      </Field>

      <Field
        label="Pull request previews"
        hint="Where each task's pull request is previewed, with {pr} for its number. A task with a pull request gets it as its preview URL, which its card links to while it's in In review, and those it has already are filled in when you save. A preview URL set by hand stays."
      >
        <Input value={form.pr_preview_url ?? ""} placeholder="https://pr{pr}.example.com/" onChange={(e) => set("pr_preview_url", e.target.value)} />
      </Field>
    </>
  )
}

/** Whether the project's merges wait for your approval of a summary: its own say, or its profile's. */
function ProjectMergeApproval({ project, onChange }: { project: ProjectForm; onChange: (on: boolean | null) => void }) {
  const profile = useBoard((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id))
  const value = project.merge_approval == null ? "profile" : project.merge_approval ? "on" : "off"
  return (
    <Field
      label="Approve merges"
      hint="When a task moves to Ready for merge, its agent summarizes what will be merged, without merging, and you approve or deny the merge in its thread. Only once you approve is the agent asked to merge; until then its gh tools refuse to merge. Denied, the task goes back to In review."
    >
      <select
        value={value}
        onChange={(e) => onChange(e.target.value === "profile" ? null : e.target.value === "on")}
        className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
      >
        <option value="profile">The profile's setting ({profile?.merge_approval ? "approve each merge first" : "merge without asking"})</option>
        <option value="on">Approve each merge first</option>
        <option value="off">Merge without asking</option>
      </select>
    </Field>
  )
}

/** Whether a task needs an approving review on its pull request on GitHub to go to Ready for merge: the project's own say, or its profile's. */
function ProjectPrApproval({ project, onChange }: { project: ProjectForm; onChange: (on: boolean | null) => void }) {
  const profile = useBoard((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id))
  const value = project.require_pr_approval == null ? "profile" : project.require_pr_approval ? "on" : "off"
  return (
    <Field
      label="Require GitHub approval"
      hint="A task can only be moved to Ready for merge once its pull request has an approving review on GitHub (and none asking for changes). Where the task gets a pull request but it has none yet, or GitHub can't be read, the move is refused. Tasks whose merges open no pull request (see the pull request settings above) aren't held."
    >
      <select
        value={value}
        onChange={(e) => onChange(e.target.value === "profile" ? null : e.target.value === "on")}
        className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
      >
        <option value="profile">The profile's setting ({profile?.require_pr_approval ? "require an approving review" : "no review needed"})</option>
        <option value="on">Require an approving review</option>
        <option value="off">No review needed</option>
      </select>
    </Field>
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
      hint="Each reviews in a thread of its own, e.g. one with Codex and one with Claude, and can have its own instructions and skills. Once they've all finished, the serious issues they found go to the task's agent together."
    >
      <div className="space-y-2">
        <InheritPicker
          own={own}
          onChange={(v) => onChange(v ? profiles : [])}
          what="reviewers"
          profileHas={`${profiles.map((r) => reviewerLabel(r, configs)).join("; ")}. Change them in Settings → Profiles.`}
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
  const profiles = profile?.summarizers.length ? profile.summarizers : [DEFAULT_REVIEWER]
  const models = { project: project.model, profile: profile?.default_model }
  return (
    <Field
      label="Summarizers"
      hint="The agents that write the summaries, each in a thread of its own. Give them different skills or prompts to compare which summarises best. A quick, cheap model is usually enough."
    >
      <div className="space-y-2">
        <InheritPicker
          own={own}
          onChange={(v) => onChange(v ? profiles : [])}
          what="summarizers"
          profileHas={`${profiles.map((r) => summarizerLabel(r, configs)).join("; ")}. Change them in Settings → Profiles.`}
        />
        {own && <SummarizerList hostId={project.host_id} configs={configs} models={models} value={project.summarizers} onChange={onChange} />}
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
  const box = "space-y-1 rounded-md border border-line/70 bg-raised/40 p-2.5 text-[12px] text-muted"
  if (project.use_workflows) {
    const reviewing = list.filter((w) => w.enabled && agentsInReview(w))
    return (
      <div className={box} data-testid="review-workflows-note">
        <p>
          This project uses workflows instead of the board&apos;s own handling, so its tasks are reviewed and summarised by its workflows&apos; steps (see its
          Workflows tab), not by settings here.{" "}
          {reviewing.length
            ? `${reviewing.map((w) => `"${w.name}"`).join(", ")} ${reviewing.length === 1 ? "has" : "have"} agent steps in In review.`
            : "None of its workflows that's on has agent steps in In review: start one from Review and summarise, or From the Review tab."}
        </p>
        <p>
          Its tasks don&apos;t have the board&apos;s own Review and Summary tabs either: a workflow&apos;s agent steps show their output in tabs of their own (a
          step with the tab Review gives tasks a Review tab). They all come back if the project stops using workflows.
        </p>
      </div>
    )
  }
  const on = list.filter((w) => w.enabled)
  if (!on.length) return null
  return (
    <div className={box} data-testid="review-workflows-note">
      <p>
        {on.length === 1 ? "The workflow" : "The workflows"} {on.map((w) => `"${w.name}"`).join(", ")} only run{on.length === 1 ? "s" : ""} when it&apos;s run
        from a task: turn on <i>Use workflows instead of the board&apos;s default</i> in the Workflows tab for tasks moving across the board to start{" "}
        {on.length === 1 ? "it" : "them"}, in place of these settings.
      </p>
    </div>
  )
}
