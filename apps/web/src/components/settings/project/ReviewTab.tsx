import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  api,
  hostSupports,
  MERGE_APPROVAL_API,
  MULTI_SUMMARIZER_API,
  PR_APPROVAL_API,
  PROFILE_REVIEWERS_API,
  type ClaudeConfig,
  type Host,
  type Project,
  type Reviewer,
  type WatchPullRequests,
} from "../../../api";
import { useStore } from "../../../store";
import {
  DEFAULT_REVIEWER,
  InheritPicker,
  isDefaultReviewer,
  ReviewerList,
  ReviewerRow,
  reviewerLabel,
  SummarizerList,
  useReviewerExtras,
} from "../../task/Reviewers";
import { Field, Input, Toggle } from "../../ui";

/** The Review tab: reviews, summaries, pull requests and their previews, merge approval, and what happens once a task is merged. */
export function ReviewTab({ form, host, set }: { form: Project; host: Host | undefined; set: <K extends keyof Project>(k: K, v: Project[K]) => void }) {
  return (
    <>
      {form.auto_review !== undefined && (
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
                value={form.review_rounds ?? 2}
                onChange={(e) => set("review_rounds", Math.max(0, Math.min(20, Math.floor(Number(e.target.value) || 0))))}
              />
            </div>
          </Field>
          {hostSupports(host, 29) && <ProjectReviewers project={form} host={host} onChange={(v) => set("reviewers", v)} />}
        </>
      )}

      {hostSupports(host, 84) && form.auto_summary !== undefined && (
        <>
          <div className="space-y-1.5">
            <Toggle checked={form.auto_summary} onChange={(v) => set("auto_summary", v)} label="Summarise each task's changes once its review passes" />
            <div className="text-[12px] text-faint">
              An agent reads the work in its own thread and writes a summary of what changed, which the task opens on while it waits in In review. Summarise now
              in the task's Summary tab writes one at any time.
            </div>
          </div>
          <ProjectSummarizer
            project={form}
            host={host}
            onChange={(v) => {
              // Older hosts have the one, null for the profile's.
              if (hostSupports(host, MULTI_SUMMARIZER_API)) set("summarizers", v);
              else set("summarizer", v[0] ?? null);
            }}
          />
        </>
      )}

      {form.pull_requests !== undefined && (
        <>
          <div className="space-y-1.5">
            <Toggle checked={form.pull_requests} onChange={(v) => set("pull_requests", v)} label="Open a pull request for each task" />
            <div className="text-[12px] text-faint">
              When the repository is on GitHub, a task's agent pushes its branch and opens a pull request before it finishes. Turned off, agents are told not to
              push or open one unless you ask, even if the project's own instructions (in CLAUDE.md, say) say to. Subprojects follow this setting too.
            </div>
          </div>
          <div className="space-y-1.5">
            <Toggle
              checked={form.subproject_pull_requests ?? true}
              onChange={(v) => set("subproject_pull_requests", v)}
              label="Open a pull request for each task in a subproject"
            />
            <div className="text-[12px] text-faint">
              The same for the tasks in the project's subprojects, whose pull requests target the subproject's branch. Turned off, their work is merged into the
              subproject's branch without one.
            </div>
          </div>
        </>
      )}

      {hostSupports(host, MERGE_APPROVAL_API) && <ProjectMergeApproval project={form} onChange={(v) => set("merge_approval", v)} />}

      {hostSupports(host, PR_APPROVAL_API) && <ProjectPrApproval project={form} onChange={(v) => set("require_pr_approval", v)} />}

      {form.done_when_merged !== undefined && (
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
      )}

      {hostSupports(host, 72) && (
        <Field
          label="Watch pull requests in review"
          hint="While a task is in In review, the board reads its pull request every couple of minutes and sends its agent what's new, which starts its turn. Only comments and reviews from people who can push to the repository (its owner, members and collaborators) count, not those from bots or from the agents' own GitHub account (yours too, if you share it)."
        >
          <select
            value={form.watch_pull_requests ?? "off"}
            onChange={(e) => set("watch_pull_requests", e.target.value as WatchPullRequests)}
            className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
          >
            <option value="off">Off</option>
            <option value="failures">Failed checks and conflicts wake the agent</option>
            <option value="all">Failed checks, conflicts, comments and reviews wake the agent</option>
          </select>
        </Field>
      )}

      {hostSupports(host, 79) && (
        <Field
          label="Pull request previews"
          hint="Where each task's pull request is previewed, with {pr} for its number. A task with a pull request gets it as its preview URL, which its card links to while it's in In review, and those it has already are filled in when you save. A preview URL set by hand stays."
        >
          <Input value={form.pr_preview_url ?? ""} placeholder="https://pr{pr}.example.com/" onChange={(e) => set("pr_preview_url", e.target.value)} />
        </Field>
      )}
    </>
  );
}

/** Whether the project's merges wait for your approval of a summary: its own say, or its profile's. */
function ProjectMergeApproval({ project, onChange }: { project: Project; onChange: (on: boolean | null) => void }) {
  const profile = useStore((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id));
  const value = project.merge_approval == null ? "profile" : project.merge_approval ? "on" : "off";
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
  );
}

/** Whether a task needs an approving review on its pull request on GitHub to go to Ready for merge: the project's own say, or its profile's. */
function ProjectPrApproval({ project, onChange }: { project: Project; onChange: (on: boolean | null) => void }) {
  const profile = useStore((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id));
  const value = project.require_pr_approval == null ? "profile" : project.require_pr_approval ? "on" : "off";
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
  );
}

/** Who reviews each task: the profile's reviewers (API 87), or the project's own, at first one with the task's config. */
function ProjectReviewers({ project, host, onChange }: { project: Project; host: Host | undefined; onChange: (v: Reviewer[]) => void }) {
  const configs = useStore(useShallow((s) => s.claudeConfigs.filter((c) => c.host_id === project.host_id)));
  const profile = useStore((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id));
  const inherits = hostSupports(host, PROFILE_REVIEWERS_API);
  const own = !!project.reviewers?.length;
  const extras = useReviewerExtras(project.host_id, project.id, project.review_prompt);
  const profiles = profile?.reviewers?.length ? profile.reviewers : [DEFAULT_REVIEWER];
  return (
    <Field
      label="Reviewers"
      hint="Each reviews in a thread of its own, e.g. one with Codex and one with Claude, and can have its own instructions and skills. Once they've all finished, the serious issues they found go to the task's agent together."
    >
      <div className="space-y-2">
        {inherits && (
          <InheritPicker
            own={own}
            onChange={(v) => onChange(v ? profiles : [])}
            what="reviewers"
            profileHas={`${profiles.map((r) => reviewerLabel(r, configs)).join("; ")}. Change them in Settings → Profiles.`}
          />
        )}
        {(own || !inherits) && (
          <ReviewerList
            hostId={project.host_id}
            configs={configs}
            models={{ project: project.model, profile: profile?.default_model }}
            value={project.reviewers ?? []}
            onChange={onChange}
            extras={extras}
          />
        )}
      </div>
    </Field>
  );
}

/** Who summarises each task's changes: the profile's summarizers (API 87), or the project's own; from API 103 there can be several. */
function ProjectSummarizer({ project, host, onChange }: { project: Project; host: Host | undefined; onChange: (v: Reviewer[]) => void }) {
  const configs = useStore(useShallow((s) => s.claudeConfigs.filter((c) => c.host_id === project.host_id)));
  const profile = useStore((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id));
  const inherits = hostSupports(host, PROFILE_REVIEWERS_API);
  const several = hostSupports(host, MULTI_SUMMARIZER_API);
  const skills = useProjectSkillNames(project, several);
  // A host from before API 103 has just the one.
  const own = several ? !!project.summarizers?.length : project.summarizer != null;
  const profiles: Reviewer[] = several ? (profile?.summarizers?.length ? profile.summarizers : [DEFAULT_REVIEWER]) : [profile?.summarizer ?? DEFAULT_REVIEWER];
  const models = { project: project.model, profile: profile?.default_model };
  return (
    <Field
      label={several ? "Summarizers" : "Summarizer"}
      hint={
        several
          ? "The agents that write the summaries, each in a thread of its own. Give them different skills or prompts to compare which summarises best. A quick, cheap model is usually enough."
          : "The agent that writes the summaries. A quick, cheap model is usually enough."
      }
    >
      <div className="space-y-2">
        {inherits && (
          <InheritPicker
            own={own}
            onChange={(v) => onChange(v ? profiles : [])}
            what={several ? "summarizers" : "summarizer"}
            profileHas={`${profiles.map((r) => summarizerLabel(r, configs)).join("; ")}. Change ${several ? "them" : "it"} in Settings → Profiles.`}
          />
        )}
        {(own || !inherits) &&
          (several ? (
            <SummarizerList hostId={project.host_id} configs={configs} models={models} value={project.summarizers ?? []} onChange={onChange} skills={skills} />
          ) : (
            <ReviewerRow
              hostId={project.host_id}
              configs={configs}
              models={models}
              value={project.summarizer ?? DEFAULT_REVIEWER}
              // A host from before API 87 saves one with the defaults as none, the task's config;
              // from then on it's this project's choice, over the profile's.
              onChange={(v) => onChange(inherits ? [v ?? DEFAULT_REVIEWER] : isDefaultReviewer(v) ? [] : [v!])}
              removable={false}
            />
          ))}
      </div>
    </Field>
  );
}

/** Who a summarizer is: its name, if it has one, and its agent, with the skills it uses. */
function summarizerLabel(r: Reviewer, configs: ClaudeConfig[]) {
  return [r.name, reviewerLabel(r, configs), r.skills?.length ? `skills ${r.skills.join(", ")}` : "", r.prompt ? "own prompt" : ""].filter(Boolean).join(" · ");
}

/** The names of the skills the project's agents have from the board (its own and the host's global ones), to pick from. */
function useProjectSkillNames(project: Project, on: boolean): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!on) return;
    let live = true;
    api
      .agentTools(project.host_id, project.id)
      .then((t) => live && setNames([...new Set([...t.skills, ...(t.global_skills ?? [])].map((s) => s.name))].sort()))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [on, project.host_id, project.id]);
  return names;
}
