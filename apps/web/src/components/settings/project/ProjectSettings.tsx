import { STATUSES, type HostProject as Project } from "@huntaway/client"
import type { ProjectPatch } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Exit } from "effect"
import { Bot, GitBranch, GitPullRequest, Loader2, MessageSquareText, Puzzle, ScanSearch, SlidersHorizontal, SquareTerminal, Workflow, Zap } from "lucide-react"
import { Fragment, useMemo, useState, type ReactNode } from "react"
import { profileGroupNames } from "../../../projectGroups"
import { useBoard } from "../../../state/board"
import { exitError, useMutation } from "../../../state/mutation"
import { navigate } from "../../../state/route"
import { ArchiveProjectModal } from "../ArchivedProjects"
import { ProjectAgentTools } from "../AgentTools"
import { ProjectAutomations } from "../Automations"
import { GuideLink } from "../GuideLink"
import { ProjectWorkflows } from "../Workflows"
import { Button, ConfirmModal, MenuButton } from "../../ui"
import { toJson } from "../../ui/json"
import { AgentsTab } from "./AgentsTab"
import { PanelHeading } from "../parts"
import { GeneralTab } from "./GeneralTab"
import { PromptsTab } from "./PromptsTab"
import { PullRequestsTab } from "./PullRequestsTab"
import { ReviewTab } from "./ReviewTab"
import { ProjectStatusScripts } from "./StatusScriptsTab"
import { WorktreesTab } from "./WorktreesTab"

// Every host has every tab, so the old API gates are gone (docs/plan/09-frontend.md). The tabs that are other
// areas' are theirs: Skills and MCP (6.4), Automations (6.5), Workflows (6.6). What a setting does is behind the ?
// beside its label (`Help`), not in a line under it (HE-32).

/** A project's fields as the form edits them. */
export type ProjectForm = { -readonly [K in keyof Project]: Project[K] }
/** Changes one field of the form. */
export type SetField = <K extends keyof Project>(k: K, v: Project[K]) => void

type ProjectTab = "general" | "agents" | "tools" | "worktrees" | "prompts" | "review" | "pull-requests" | "workflows" | "automations" | "scripts"

/** One of the project settings' sections. `description` is a line under its heading, and `help` the rest, behind
 *  the heading's ?. `fields` are the ones saved with Save changes, so a section with unsaved changes is marked; the
 *  others save as they're changed. */
interface TabDef {
  id: ProjectTab
  label: string
  icon: ReactNode
  description: string
  help?: ReactNode
  fields: (keyof Project)[]
}

const GENERAL: TabDef = {
  id: "general",
  label: "General",
  icon: <SlidersHorizontal size={14} />,
  description: "The project's name, key and folder.",
  fields: ["name", "key", "repo_path", "group_name"],
}

/** The sections in their groups down the side: the project, its agents, a task's way to merged, and what runs by itself. */
const TAB_GROUPS: ReadonlyArray<ReadonlyArray<TabDef>> = [
  [GENERAL],
  [
    {
      id: "agents",
      label: "Agents",
      icon: <Bot size={14} />,
      description: "How the project's agents run. What's left unset follows the profile or the host.",
      fields: ["model", "output_style", "claude_config_ids", "github_account", "permission_mode"],
    },
    {
      id: "tools",
      label: "Skills and MCP",
      icon: <Puzzle size={14} />,
      description: "The skills and MCP servers the project's agents get. Saved as you change them.",
      fields: [],
    },
  ],
  [
    {
      id: "worktrees",
      label: "Worktrees",
      icon: <GitBranch size={14} />,
      description: "Where tasks do their work, and how a task's worktree is set up and removed.",
      fields: ["base_branch", "use_worktrees", "worktrees_root", "copy_files", "link_folders", "setup_script", "teardown_script"],
    },
    {
      id: "prompts",
      label: "Prompts",
      icon: <MessageSquareText size={14} />,
      description: "What the board tells agents as a task moves across it.",
      help: "Each is the host's default until the project has its own. Agents can change them too, when you ask them.",
      fields: ["start_prompt", "review_prompt", "merge_prompt"],
    },
    {
      id: "review",
      label: "Review",
      icon: <ScanSearch size={14} />,
      description: "Agents that review and summarise each task's changes.",
      fields: ["auto_review", "review_rounds", "reviewers", "auto_summary", "summarizers"],
    },
    {
      id: "pull-requests",
      label: "Pull requests",
      icon: <GitPullRequest size={14} />,
      description: "Each task's pull request, and when it's merged.",
      fields: ["pull_requests", "watch_pull_requests", "pr_preview_url", "require_pr_approval", "merge_approval", "done_when_merged"],
    },
  ],
  [
    {
      id: "workflows",
      label: "Workflows",
      icon: <Workflow size={14} />,
      description: "A task's way across the board, drawn as steps. Saved as you change them.",
      help: (
        <>
          <span className="block">
            Each <i>column</i> step is a column: a task entering it has its agent sent the column&apos;s prompt, and once that work is done the steps after it
            run (checks, agents that review or report in tabs of the task, pull requests, messages to the task&apos;s agent, and the next column).
          </span>
          <span className="block">
            <i>Board&apos;s default</i> is what the board does without workflows, as one to change. <GuideLink page="workflows">Workflows</GuideLink> in the
            guide explains each step.
          </span>
        </>
      ),
      fields: [],
    },
    {
      id: "automations",
      label: "Automations",
      icon: <Zap size={14} />,
      description: "Create a task, or message one, on a schedule or from a webhook. Saved as you change them.",
      fields: [],
    },
    {
      id: "scripts",
      label: "Status scripts",
      icon: <SquareTerminal size={14} />,
      description: "Run with bash when a task moves to another column.",
      help: (
        <>
          <span className="block">
            They run in the task&apos;s worktree (or the repository without one), e.g. to send a notification or clean up a finished build. Output shows in the
            task&apos;s thread.
          </span>
          <span className="block">
            Variables: <code>$IA_OLD_STATUS</code>, <code>$IA_NEW_STATUS</code> (e.g. in_review), <code>$IA_TASK_KEY</code>, <code>$IA_TASK_TITLE</code>,{" "}
            <code>$IA_RESOLUTION</code>, <code>$IA_PR_URL</code> and the setup script&apos;s.
          </span>
        </>
      ),
      fields: ["status_script", "status_scripts"],
    },
  ],
]

const PROJECT_TABS: ReadonlyArray<TabDef> = TAB_GROUPS.flat()

/** Whether an edit to a field changes it: a blank text is no value, as saving makes it. */
const sameValue = (a: unknown, b: unknown): boolean => toJson(a === "" ? null : (a ?? null)) === toJson(b === "" ? null : (b ?? null))

export function ProjectSettings({ projectId, tab }: { projectId: string; tab?: string | undefined }) {
  const project = useBoard((s) => s.projects.find((p) => p.id === projectId))
  // Only the fields changed here, over the project as it is now, so saving doesn't undo changes
  // made meanwhile elsewhere (e.g. an agent's update_project) to the others. They're kept across
  // the tabs, and saved together.
  const [edits, setEdits] = useState<Partial<ProjectForm>>({})
  const [saved, setSaved] = useState(false)
  const [{ busy: saving, error: saveError }, update] = useMutation("projects.update")
  // Discard hides the last save's error until the next save.
  const [discarded, setDiscarded] = useState(false)
  const err = discarded ? null : saveError
  const [, remove] = useMutation("projects.delete")
  const [confirm, setConfirm] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [moveRepo, setMoveRepo] = useState(false)
  const hostMode = useBoard((s) => (project ? s.hostSettings[project.host_id]?.default_permission_mode : null)) ?? "default"
  const allProjects = useBoard((s) => s.projects)
  const groups = useMemo(() => (project ? profileGroupNames(allProjects, project) : []), [allProjects, project])
  if (!project) return <div className="p-8 text-muted">Project not found.</div>
  const form: ProjectForm = Object.assign({}, project, edits)
  const tabs = PROJECT_TABS
  const current = tabs.find((t) => t.id === tab) ?? GENERAL
  const set: SetField = (k, v) => {
    setEdits((e) => ({ ...e, [k]: v }))
    setSaved(false)
  }
  const repoChanged = "repo_path" in edits && edits.repo_path?.trim() !== project.repo_path
  const changed = (k: keyof Project): boolean => k in edits && !sameValue(edits[k], project[k])
  const unsaved = tabs.filter((t) => t.fields.some(changed))
  const save = (): void => {
    setDiscarded(false)
    const { host_id: _host, ...fields } = edits
    const patch: { -readonly [K in keyof ProjectPatch]: ProjectPatch[K] } = Object.assign({}, fields)
    if (repoChanged && moveRepo) patch.move_repo = true
    if ("base_branch" in patch) patch.base_branch = patch.base_branch || null
    if ("model" in patch) patch.model = patch.model || null
    if ("output_style" in patch) patch.output_style = patch.output_style?.trim() || null
    if ("group_name" in patch) patch.group_name = patch.group_name?.trim() || null
    if ("github_account" in patch) patch.github_account = patch.github_account || null
    if ("pr_preview_url" in patch) patch.pr_preview_url = patch.pr_preview_url?.trim() || null
    if ("claude_config_ids" in patch) patch.claude_config_ids = patch.claude_config_ids?.length ? patch.claude_config_ids : null
    void update(project.host_id, { id: project.id, patch }).then((exit) => {
      if (!Exit.isSuccess(exit)) return
      // Keeps anything changed while it was saving; the project as saved comes with its event.
      setEdits((e) => Object.fromEntries(Object.entries(e).filter(([k, v]) => v !== Reflect.get(edits, k))))
      setMoveRepo(false)
      setSaved(true)
    })
  }
  const discard = (): void => {
    setEdits({})
    setMoveRepo(false)
    setDiscarded(true)
    setSaved(false)
  }
  // The save bar is on the sections saved with it, and on the others while there's something to save.
  const showSave = current.fields.length > 0 || unsaved.length > 0
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5 narrow:px-3">
        <MenuButton />
        <button className="no-drag text-[12.5px] text-muted hover:text-fg" onClick={() => navigate({ name: "board", projectId })}>
          {project?.name}
        </button>
        <span className="text-faint">/</span>
        <h1 className="text-[14px] font-semibold">Settings</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* The tabs and the open one are together in the middle, the tabs staying put as it scrolls. */}
        <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6 narrow:gap-4 narrow:p-4 md:flex-row md:gap-10">
          <nav
            role="tablist"
            aria-label="Project settings"
            aria-orientation="vertical"
            className="flex shrink-0 gap-0.5 overflow-x-auto md:sticky md:top-6 md:w-48 md:flex-col md:self-start"
          >
            {TAB_GROUPS.map((group, i) => (
              <Fragment key={group[0]?.id}>
                {/* A line between the groups: across the side list, down the row of tabs when they're along the top. */}
                {i > 0 && <span aria-hidden className="mx-1.5 w-px shrink-0 self-stretch bg-line md:mx-2.5 md:my-2 md:h-px md:w-auto" />}
                {group.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    id={`project-tab-${t.id}`}
                    aria-selected={t === current}
                    aria-controls="project-tab-panel"
                    onClick={() => navigate({ name: "projectSettings", projectId, tab: t.id }, true)}
                    className={clsx(
                      "flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]",
                      t === current ? "bg-raised text-fg" : "text-muted hover:bg-white/[0.04] hover:text-fg",
                    )}
                  >
                    <span className={t === current ? "text-accent" : "text-faint"}>{t.icon}</span>
                    <span className="flex-1 whitespace-nowrap">{t.label}</span>
                    {unsaved.includes(t) && <span className="h-1.5 w-1.5 rounded-full bg-accent" title="Unsaved changes" aria-label="Unsaved changes" />}
                  </button>
                ))}
              </Fragment>
            ))}
          </nav>
          <div id="project-tab-panel" role="tabpanel" aria-labelledby={`project-tab-${current.id}`} className="min-w-0 flex-1 space-y-6">
            {/* Keyed, so help that's kept open closes with its tab. */}
            <PanelHeading key={current.id} title={current.label} description={current.description} help={current.help} />

            {current.id === "general" && (
              <GeneralTab
                project={project}
                form={form}
                groups={groups}
                repoChanged={repoChanged}
                moveRepo={moveRepo}
                setMoveRepo={setMoveRepo}
                onArchive={() => setArchiving(true)}
                onDelete={() => setConfirm(true)}
                set={set}
              />
            )}

            {current.id === "agents" && <AgentsTab form={form} hostMode={hostMode} set={set} />}

            {current.id === "worktrees" && <WorktreesTab project={project} form={form} set={set} />}

            {current.id === "review" && <ReviewTab form={form} set={set} />}

            {current.id === "pull-requests" && <PullRequestsTab form={form} set={set} />}

            {current.id === "prompts" && <PromptsTab project={project} form={form} set={set} />}

            {current.id === "scripts" && <ProjectStatusScripts project={form} statuses={STATUSES} onChange={set} />}

            {current.id === "tools" && <ProjectAgentTools project={project} />}

            {current.id === "automations" && <ProjectAutomations project={project} />}

            {current.id === "workflows" && <ProjectWorkflows project={project} />}
          </div>
        </div>
      </div>
      {showSave && (
        <footer className="shrink-0 border-t border-line">
          {/* Lined up with the open tab: past the tabs' width and the gap after them. */}
          <div className="mx-auto flex max-w-4xl items-center gap-3 px-6 py-3 narrow:px-4 md:pl-64">
            <Button variant="primary" disabled={saving || !unsaved.length} onClick={save}>
              {saving && <Loader2 size={13} className="animate-spin" />} Save changes
            </Button>
            {unsaved.length > 0 && (
              <Button variant="ghost" disabled={saving} onClick={discard}>
                Discard
              </Button>
            )}
            {err ? (
              <span className="min-w-0 text-xs text-red-400">{err}</span>
            ) : unsaved.length > 0 ? (
              <span className="min-w-0 truncate text-[12px] text-faint">Unsaved changes in {unsaved.map((t) => t.label).join(", ")}</span>
            ) : (
              saved && <span className="text-[12px] text-emerald-400">Saved</span>
            )}
          </div>
        </footer>
      )}
      {archiving && <ArchiveProjectModal project={project} onClose={() => setArchiving(false)} />}
      {confirm && (
        <ConfirmModal
          title="Delete project"
          body="This deletes the project, its tasks and their threads, and removes their worktrees. Task branches stay in the repository."
          action="Delete project"
          danger
          width="max-w-lg"
          onConfirm={() =>
            remove(project.host_id, { id: project.id }).then((exit) => {
              // The dialog shows why it failed, as it does a rejected confirm.
              if (!Exit.isSuccess(exit)) return Promise.reject(new Error(exitError(exit) ?? "Not deleted."))
              navigate({ name: "home" }, true)
              return undefined
            })
          }
          onClose={() => setConfirm(false)}
        />
      )}
    </div>
  )
}
