import { WatchPullRequests } from "@huntaway/contracts"
import { Schema } from "effect"
import { useBoard } from "../../../state/board"
import { Field, Input, ToggleField } from "../../ui"
import { Group, selectClass } from "../parts"
import type { ProjectForm, SetField } from "./ProjectSettings"

// Every host has every setting here, so the old API gates are gone, and subprojects' pull requests with subprojects
// (docs/plan/09-frontend.md). These were the second half of the Review tab (HE-32).

const isWatch = Schema.is(WatchPullRequests)

/** The Pull requests tab: whether tasks get pull requests, what's watched on them and where they're previewed, then what a merge waits for and what follows it. */
export function PullRequestsTab({ form, set }: { form: ProjectForm; set: SetField }) {
  return (
    <>
      <ToggleField
        checked={form.pull_requests}
        onChange={(v) => set("pull_requests", v)}
        label="Open a pull request for each task"
        help="When the repository is on GitHub, a task's agent pushes its branch and opens a pull request before it finishes. Turned off, agents don't push or open one unless you ask, whatever the project's own instructions say."
      />
      <Field
        label="Watch pull requests in review"
        help="While a task is in In review, the board reads its pull request every couple of minutes and sends its agent what's new, which starts its turn. Comments and reviews count only from people who can push to the repository, not from bots or the agents' own GitHub account."
      >
        <select
          value={form.watch_pull_requests}
          onChange={(e) => {
            const v = e.target.value
            if (isWatch(v)) set("watch_pull_requests", v)
          }}
          className={selectClass}
        >
          <option value="off">Off</option>
          <option value="failures">Failed checks and conflicts wake the agent</option>
          <option value="all">Failed checks, conflicts, comments and reviews wake the agent</option>
        </select>
      </Field>
      <Field
        label="Pull request previews"
        help={
          <>
            Where each task&apos;s pull request is previewed, with <code>{"{pr}"}</code> for its number. The task&apos;s card links to it while it&apos;s in In
            review. A preview URL set by hand stays.
          </>
        }
      >
        <Input value={form.pr_preview_url ?? ""} placeholder="https://pr{pr}.example.com/" onChange={(e) => set("pr_preview_url", e.target.value)} />
      </Field>
      <Group title="Merging">
        <ProjectPrApproval project={form} onChange={(v) => set("require_pr_approval", v)} />
        <ProjectMergeApproval project={form} onChange={(v) => set("merge_approval", v)} />
        <ToggleField
          checked={form.done_when_merged}
          onChange={(v) => set("done_when_merged", v)}
          label="Move a task to Done when its pull request is merged on GitHub"
          help="Checked every few minutes for tasks in In review or Needs attention. A merged one's worktree is removed too, if nothing in it would be lost; one closed without merging moves its task to Needs attention."
        />
      </Group>
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
      help="When a task moves to Ready for merge, its agent first summarizes what will be merged, and merges only once you approve in its thread. Denied, the task goes back to In review."
    >
      <select value={value} onChange={(e) => onChange(e.target.value === "profile" ? null : e.target.value === "on")} className={selectClass}>
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
      help="A task can only move to Ready for merge once its pull request has an approving review on GitHub, and none asking for changes. Tasks that get no pull request aren't held."
    >
      <select value={value} onChange={(e) => onChange(e.target.value === "profile" ? null : e.target.value === "on")} className={selectClass}>
        <option value="profile">The profile's setting ({profile?.require_pr_approval ? "require an approving review" : "no review needed"})</option>
        <option value="on">Require an approving review</option>
        <option value="off">No review needed</option>
      </select>
    </Field>
  )
}
