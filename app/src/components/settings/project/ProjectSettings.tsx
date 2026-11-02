import clsx from "clsx";
import { Bot, GitBranch, Loader2, MessageSquareText, Puzzle, ScanSearch, SlidersHorizontal, SquareTerminal, Zap } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { api, hostStatuses, hostSupports, type Project } from "../../../api";
import { groupNames } from "../../../projectGroups";
import { navigate } from "../../../router";
import { useHost, useStore } from "../../../store";
import { ProjectAgentTools } from "../AgentTools";
import { ArchiveProjectModal } from "../ArchivedProjects";
import { ProjectAutomations } from "../Automations";
import { Button, ConfirmModal, MenuButton } from "../../ui";
import { AgentsTab } from "./AgentsTab";
import { GeneralTab } from "./GeneralTab";
import { PromptsTab } from "./PromptsTab";
import { ReviewTab } from "./ReviewTab";
import { ProjectStatusScripts } from "./StatusScriptsTab";
import { WorktreesTab } from "./WorktreesTab";

type ProjectTab = "general" | "agents" | "worktrees" | "review" | "prompts" | "scripts" | "tools" | "automations";

/** The project settings' sections, in their order down the side. `fields` are the ones saved with Save
 *  changes, so a section with unsaved changes is marked; the others save as they're changed. */
const PROJECT_TABS: { id: ProjectTab; label: string; icon: ReactNode; description: string; fields: (keyof Project)[] }[] = [
  {
    id: "general",
    label: "General",
    icon: <SlidersHorizontal size={14} />,
    description: "The project's name, key and folder.",
    fields: ["name", "key", "repo_path", "group_name"],
  },
  {
    id: "agents",
    label: "Agents",
    icon: <Bot size={14} />,
    description: "How the project's agents run. Each setting overrides the profile's or the host's.",
    fields: ["model", "claude_config_ids", "github_account", "permission_mode"],
  },
  {
    id: "worktrees",
    label: "Worktrees",
    icon: <GitBranch size={14} />,
    description: "Where tasks do their work, the files each task's worktree gets from the repository, and the scripts that set up and tear it down.",
    fields: ["base_branch", "use_worktrees", "worktrees_root", "copy_files", "link_folders", "setup_script", "teardown_script"],
  },
  {
    id: "review",
    label: "Review",
    icon: <ScanSearch size={14} />,
    description:
      "Reviewer agents that check each task's changes before it's merged, a summary of the changes once they pass, whether it gets a pull request, where that's previewed, whether merges wait for your approval, and what happens once it's merged.",
    fields: [
      "auto_review",
      "review_rounds",
      "reviewers",
      "auto_summary",
      "summarizer",
      "pull_requests",
      "subproject_pull_requests",
      "done_when_merged",
      "merge_approval",
      "require_pr_approval",
      "watch_pull_requests",
      "pr_preview_url",
    ],
  },
  {
    id: "prompts",
    label: "Prompts",
    icon: <MessageSquareText size={14} />,
    description: "What the board tells agents as a task moves across the board. Agents can change these too, when you ask them.",
    fields: ["start_prompt", "review_prompt", "merge_prompt"],
  },
  {
    id: "scripts",
    label: "Status scripts",
    icon: <SquareTerminal size={14} />,
    description:
      "Run with bash when a task moves to another column, in its worktree (or the repository without one), e.g. to send a notification or clean up a finished build. Output shows in the task's thread.",
    fields: ["status_script", "status_scripts"],
  },
  { id: "tools", label: "Skills and MCP", icon: <Puzzle size={14} />, description: "The skills and MCP servers the project's agents get. Saved as you change them.", fields: [] },
  {
    id: "automations",
    label: "Automations",
    icon: <Zap size={14} />,
    description: "Create a task, or send a message to one, on a schedule or when a webhook is delivered (a new GitHub issue, say). Saved as you change them.",
    fields: [],
  },
];

/** Whether an edit to a field changes it: a blank text is no value, as saving makes it. */
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a === "" ? null : (a ?? null)) === JSON.stringify(b === "" ? null : (b ?? null));

export function ProjectSettings({ projectId, tab }: { projectId: string; tab?: string }) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const upsertProject = useStore((s) => s.upsertProject);
  // Only the fields changed here, over the project as it is now, so saving doesn't undo changes
  // made meanwhile elsewhere (e.g. an agent's update_project) to the others. They're kept across
  // the tabs, and saved together.
  const [edits, setEdits] = useState<Partial<Project>>({});
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [moveRepo, setMoveRepo] = useState(false);
  const host = useHost(project?.host_id);
  const hostMode = useStore((s) => (project ? s.hostSettings[project.host_id]?.default_permission_mode : null)) ?? "default";
  const allProjects = useStore((s) => s.projects);
  const groups = useMemo(() => (project ? groupNames(allProjects, project.host_id) : []), [allProjects, project]);
  if (!project) return <div className="p-8 text-muted">Project not found.</div>;
  const form: Project = { ...project, ...edits };
  const shown: Record<ProjectTab, boolean> = {
    general: true,
    agents: true,
    worktrees: true,
    review: project.auto_review !== undefined || project.done_when_merged !== undefined || hostSupports(host, 72),
    prompts: hostSupports(host, 27),
    scripts: hostSupports(host, 37),
    tools: hostSupports(host, 21),
    automations: hostSupports(host, 63),
  };
  const tabs = PROJECT_TABS.filter((t) => shown[t.id]);
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];
  const set = <K extends keyof Project>(k: K, v: Project[K]) => {
    setEdits((e) => ({ ...e, [k]: v }));
    setSaved(false);
  };
  const repoChanged = "repo_path" in edits && edits.repo_path?.trim() !== project.repo_path;
  const changed = (k: keyof Project) => k in edits && !sameValue(edits[k], project[k]);
  const unsaved = tabs.filter((t) => t.fields.some(changed));
  const save = async () => {
    setErr(null);
    setSaving(true);
    const body: Partial<Project> & { move_repo?: boolean } = { ...edits };
    if (repoChanged && moveRepo) body.move_repo = true;
    if ("base_branch" in body) body.base_branch = body.base_branch || null;
    if ("model" in body) body.model = body.model || null;
    if ("group_name" in body) body.group_name = body.group_name?.trim() || null;
    if ("github_account" in body) body.github_account = body.github_account || null;
    if ("pr_preview_url" in body) body.pr_preview_url = body.pr_preview_url?.trim() || null;
    if ("claude_config_ids" in body) body.claude_config_ids = body.claude_config_ids?.length ? body.claude_config_ids : null;
    try {
      const p = await api.updateProject(project.host_id, projectId, body);
      // Shows what was saved (e.g. a blank prompt is the default) without waiting for its event.
      upsertProject({ ...p, host_id: project.host_id });
      // Keeps anything changed while it was saving.
      setEdits((e) => Object.fromEntries(Object.entries(e).filter(([k, v]) => v !== edits[k as keyof Project])));
      setMoveRepo(false);
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    setEdits({});
    setMoveRepo(false);
    setErr(null);
    setSaved(false);
  };
  // The save bar is on the sections saved with it, and on the others while there's something to save.
  const showSave = current.fields.length > 0 || unsaved.length > 0;
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
            {tabs.map((t) => (
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
          </nav>
          <div id="project-tab-panel" role="tabpanel" aria-labelledby={`project-tab-${current.id}`} className="min-w-0 flex-1 space-y-6">
            <div className="space-y-1">
              <h2 className="text-[15px] font-semibold">{current.label}</h2>
              <p className="text-[12.5px] text-faint">{current.description}</p>
            </div>

            {current.id === "general" && (
              <GeneralTab
                project={project}
                form={form}
                host={host}
                groups={groups}
                repoChanged={repoChanged}
                moveRepo={moveRepo}
                setMoveRepo={setMoveRepo}
                onArchive={() => setArchiving(true)}
                onDelete={() => setConfirm(true)}
                set={set}
              />
            )}

            {current.id === "agents" && <AgentsTab form={form} host={host} hostMode={hostMode} set={set} />}

            {current.id === "worktrees" && <WorktreesTab project={project} form={form} host={host} set={set} />}

            {current.id === "review" && <ReviewTab form={form} host={host} set={set} />}

            {current.id === "prompts" && <PromptsTab project={project} form={form} host={host} set={set} />}

            {current.id === "scripts" && <ProjectStatusScripts project={form} perColumn={hostSupports(host, 38)} statuses={hostStatuses(host)} onChange={set} />}

            {current.id === "tools" && <ProjectAgentTools project={project} />}

            {current.id === "automations" && <ProjectAutomations project={project} />}
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
          onConfirm={async () => {
            await api.deleteProject(form.host_id, projectId);
            navigate({ name: "home" }, true);
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </div>
  );
}
