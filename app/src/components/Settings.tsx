import clsx from "clsx";
import {
  Archive,
  ArchiveRestore,
  ArrowUp,
  Bot,
  Folder,
  FolderGit2,
  GitBranch,
  KeyRound,
  Loader2,
  MessageSquareText,
  Plus,
  Puzzle,
  ScanSearch,
  SlidersHorizontal,
  SquareTerminal,
  Trash2,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { effortOptions, inheritedModel, modelOptions, useAgentModels } from "../agents";
import {
  AGENTS,
  agentOf,
  api,
  getToken,
  LABELS,
  hostStatuses,
  hostSupports,
  PERMISSION_MODES,
  setToken,
  type Agent,
  type ClaudeConfig,
  type DocumentType,
  type Status,
  type PermissionMode,
  type DirListing,
  type HostInfo,
  type MergedWorktreeResult,
  type Project,
  type PromptField,
  type Reviewer,
  type SystemPromptOptions,
  type WatchPullRequests,
} from "../api";
import { clonePath, defaultCloneDir, loadProjectSource, saveProjectSource, type ProjectSource } from "../githubRepos";
import { groupNames } from "../projectGroups";
import { navigate, parse } from "../router";
import { defaultAgentHost, profileConfigLabel, profileNames, useHost, useStore } from "../store";
import { GlobalAgentToolsPanel, ProjectAgentTools } from "./AgentTools";
import { ProjectAutomations } from "./Automations";
import { ModelPicker } from "./NewTaskModal";
import { ClaudeConfigsPanel, ConfigPicker } from "./ClaudeConfigs";
import { GithubMark, GithubRepoPicker, type RepoChoice } from "./GithubRepos";
import { GithubAccountSelect, HostSelect, HostsPanel, ProfileForm, ProfilesPanel } from "./Hosts";
import { NotificationsPanel } from "./Notifications";
import { ServerPanel } from "./Server";
import { Button, ConfirmModal, Field, IconButton, Input, MenuButton, Modal, ModalFooter, Textarea, timeAgo, Toggle } from "./ui";

// ---------- directory picker ----------

const withSlash = (p: string) => (p.endsWith("/") ? p : p + "/");

function commonPrefix(names: string[]) {
  let out = names[0] ?? "";
  for (const n of names) while (!n.startsWith(out)) out = out.slice(0, -1);
  return out;
}

type DirEntry = DirListing["entries"][number];

/** Browse directories on a host. The listing follows what's typed: it shows the folder up to the
 *  last `/`, filtered by the rest. Tab or Enter completes, arrows pick, and `~/` expands. */
export function DirPicker({ hostId, value, onChange }: { hostId: string; value: string; onChange: (v: string) => void }) {
  const host = useHost(hostId);
  const [loaded, setLoaded] = useState<{ dir: string; listing?: DirListing; err?: string } | null>(null);
  const [active, setActive] = useState(-1);
  const valueRef = useRef(value);
  valueRef.current = value;
  const listRef = useRef<HTMLDivElement>(null);
  const slash = value.lastIndexOf("/");
  const dir = value.slice(0, slash + 1);
  const prefix = value.slice(slash + 1);

  // Start in the host's home folder.
  useEffect(() => {
    setLoaded(null);
    api.dirs(hostId).then(
      (l) => onChange(withSlash(l.path)),
      (e) => setLoaded({ dir: "", err: e.message }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  useEffect(() => {
    if (!dir) return;
    let stale = false;
    const t = setTimeout(
      () =>
        api.dirs(hostId, dir).then(
          (l) => {
            if (stale) return;
            if (dir.startsWith("~")) {
              // Expand ~ in place, keeping whatever was typed after the folder.
              const abs = withSlash(l.path);
              setLoaded({ dir: abs, listing: l });
              onChange(abs + valueRef.current.slice(dir.length));
            } else {
              setLoaded({ dir, listing: l });
            }
          },
          (e) => !stale && setLoaded({ dir, err: e.message }),
        ),
      120,
    );
    return () => {
      stale = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, dir]);

  const current = loaded?.dir === dir ? loaded : null;
  const listing = current?.listing;
  const lower = prefix.toLowerCase();
  const matches = (listing?.entries ?? []).filter((e) => (!e.hidden || prefix.startsWith(".")) && e.name.toLowerCase().startsWith(lower));
  const exact = listing?.entries.find((e) => e.name === prefix);

  useEffect(() => {
    setActive(-1);
  }, [value]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (e: DirEntry | string) => onChange(withSlash(typeof e === "string" ? e : e.path));
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && matches.length) {
      e.preventDefault();
      const n = matches.length;
      setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : a <= 0 ? n - 1 : a - 1));
    } else if (e.key === "Tab" && !e.shiftKey && (active >= 0 || (prefix && matches.length))) {
      e.preventDefault();
      if (active >= 0) pick(matches[active]);
      else if (matches.length === 1) pick(matches[0]);
      else {
        const common = commonPrefix(matches.map((m) => m.name));
        if (common.length >= prefix.length) onChange(dir + common);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0) pick(matches[active]);
      else if (exact) pick(exact);
    }
  };

  let status: string | null = null;
  if (listing && prefix !== "." && prefix !== "..") {
    const target = prefix ? exact : listing.exists === false ? undefined : listing;
    if (target) status = target.is_git ? "✓ Git repository. Tasks can use worktrees." : "Not a git repository. Worktrees are disabled.";
    else if (matches.length) status = "Tab to complete, or keep typing to name a new folder.";
    else if (hostSupports(host, 11)) status = "New folder. It's created when you add the project.";
    else status = "This folder doesn't exist.";
  }

  return (
    <div className="space-y-2">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="/path/to/repo"
        className="font-mono text-[12px]"
        autoFocus
        autoComplete="off"
        spellCheck={false}
      />
      <div ref={listRef} className="h-56 overflow-y-auto rounded-md border border-line bg-bg/60">
        {listing?.parent && !prefix && (
          <button type="button" onClick={() => pick(listing.parent!)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-muted hover:bg-white/[0.04]">
            <ArrowUp size={13} /> ..
          </button>
        )}
        {matches.map((e, i) => (
          <button
            type="button"
            key={e.path}
            data-active={i === active}
            onClick={() => pick(e)}
            className={clsx("flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-white/[0.04]", i === active && "bg-white/[0.07]")}
          >
            {e.is_git ? <FolderGit2 size={13} className="text-accent" /> : <Folder size={13} className="text-faint" />}
            <span className={e.is_git ? "text-fg" : "text-muted"}>{e.name}</span>
          </button>
        ))}
        {current?.err && <div className="p-3 text-[12px] text-red-400">{current.err}</div>}
        {value && !dir && <div className="p-3 text-[12px] text-faint">Enter an absolute path, or start with ~/</div>}
      </div>
      {status && <div className="text-[11.5px] text-faint">{status}</div>}
    </div>
  );
}

/** Adds a project, in `profile` to start with: a folder on a host, or a GitHub repository it clones (API 55). */
export function NewProjectModal({ profile, onClose }: { profile?: string; onClose: () => void }) {
  const [names] = useState(() => profileNames(useStore.getState().profiles));
  // With every profile on the board, the project's profile is picked here.
  const [profileName, setProfileName] = useState(profile && names.includes(profile) ? profile : names[0]);
  const [host, setHost] = useState(defaultAgentHost() ?? useStore.getState().localHostId!);
  const hostCount = useStore((s) => s.hosts.filter((h) => h.connected).length);
  const hostRow = useHost(host);
  const profileRow = useStore((s) => s.profiles.find((p) => p.host_id === host && p.name === profileName));
  const profileId = profileRow?.id;
  const [configDir, setConfigDir] = useState("~/.claude");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [key, setKey] = useState("");
  const [source, setSource] = useState(loadProjectSource);
  const fromGithub = source === "github" && hostSupports(hostRow, 55);
  const [repo, setRepo] = useState<RepoChoice | null>(null);
  // Where it's cloned: in the profile's clone folder, named after the repository, unless it's changed here.
  const cloneDir = profileRow?.clone_dir?.trim() || defaultCloneDir(profileName);
  const [dest, setDest] = useState<string | null>(null);
  const clonePathNow = repo ? (dest ?? clonePath(cloneDir, repo.name)) : "";
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A clone can take a while, and the dialog can be closed meanwhile. Open again on each mount, as
  // StrictMode mounts it twice in development.
  const closed = useRef(false);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
    };
  }, []);
  const pickSource = (s: ProjectSource) => {
    setSource(s);
    saveProjectSource(s);
    setErr(null);
  };
  const submit = async () => {
    setBusy(true);
    try {
      // The profile has to exist on the project's host first.
      let pid = profileId;
      if (!pid) {
        pid = (await api.createProfile(host, { name: profileName, claude_config_dir: configDir })).id;
        await useStore.getState().loadProfiles();
      }
      const p = fromGithub
        ? await api.cloneProject(host, pid, { repo: repo!.full_name, repo_path: clonePathNow.trim(), name, key: key || undefined })
        : await api.createProject(host, pid, { name, repo_path: path, key: key || undefined });
      useStore.getState().upsertProject({ ...p, host_id: host });
      if (closed.current) return;
      onClose();
      navigate({ name: "board", projectId: p.id });
    } catch (e) {
      if (closed.current) return;
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Add project" onClose={onClose} width="max-w-xl">
      <div className="space-y-4">
        {hostSupports(hostRow, 55) && (
          <div className="flex w-fit items-center gap-0.5 rounded-lg border border-line bg-panel p-0.5" role="radiogroup" aria-label="Add it from">
            {(
              [
                { id: "folder", label: "Folder", icon: <Folder size={12} />, hint: "A folder on the host: a repository, or a new folder" },
                { id: "github", label: "GitHub", icon: <GithubMark size={12} />, hint: "Clone one of the GitHub repositories gh can reach on the host" },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={source === t.id}
                title={t.hint}
                onClick={() => pickSource(t.id)}
                className={clsx("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px]", source === t.id ? "bg-raised text-fg" : "text-muted hover:text-fg")}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>
        )}
        {hostCount > 1 && (
          <Field label="Host" hint="The machine the repository is on. Its agents run there.">
            <HostSelect value={host} onChange={setHost} />
          </Field>
        )}
        {names.length > 1 && (
          <Field label="Profile" hint="The Claude profile the project's agents run under.">
            <select value={profileName} onChange={(e) => setProfileName(e.target.value)} className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none">
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        )}
        {fromGithub ? (
          <>
            <Field label="Repository">
              <GithubRepoPicker
                hostId={host}
                account={profileRow?.github_account || null}
                whose={profileRow?.github_account ? `${profileName}'s GitHub account` : "gh's active account"}
                value={repo}
                onChange={(r) => {
                  setRepo(r);
                  setDest(null);
                  setErr(null);
                }}
              />
            </Field>
            {repo && (
              <Field
                label={`Clone ${repo.full_name} into`}
                hint={
                  <>
                    A new folder, or an empty one. A clone of it that's there already is added as it is. {profileName}'s repositories go in{" "}
                    <span className="font-mono">{cloneDir}</span> (Settings → Profiles).
                  </>
                }
              >
                <Input className="font-mono text-[12px]" value={clonePathNow} onChange={(e) => setDest(e.target.value)} spellCheck={false} />
              </Field>
            )}
          </>
        ) : (
          <Field label="Repository folder">
            <DirPicker hostId={host} value={path} onChange={setPath} />
          </Field>
        )}
        {!profileId && (
          <Field label={`Claude config directory for "${profileName}" on this host`} hint="This host has no such profile yet; it's created with this directory.">
            <Input value={configDir} onChange={(e) => setConfigDir(e.target.value)} className="font-mono text-[12px]" />
          </Field>
        )}
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field label="Name">
            <Input
              value={name}
              placeholder={(fromGithub ? clonePathNow : path).split("/").filter(Boolean).pop() ?? "Project"}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Key">
            <Input value={key} placeholder="auto" onChange={(e) => setKey(e.target.value.toUpperCase())} maxLength={6} />
          </Field>
        </div>
        <ModalFooter className="space-y-4">
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {fromGithub ? (
              <Button variant="primary" disabled={busy || !repo || !clonePathNow.trim()} onClick={submit}>
                {busy && <Loader2 size={13} className="animate-spin" />} {busy ? "Cloning…" : "Clone and add project"}
              </Button>
            ) : (
              <Button variant="primary" disabled={busy || !path} onClick={submit}>
                Add project
              </Button>
            )}
          </div>
        </ModalFooter>
      </div>
    </Modal>
  );
}

// ---------- project settings ----------

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
    description: "Reviewer agents that check each task's changes before it's merged, where its pull request is previewed, and what happens once it's merged.",
    fields: ["auto_review", "review_rounds", "reviewers", "done_when_merged", "watch_pull_requests", "pr_preview_url"],
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
              <>
                <div className="space-y-2">
                  <div className="grid grid-cols-[1fr_120px] gap-3">
                    <Field label="Name">
                      <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
                    </Field>
                    <Field label="Key">
                      <Input value={form.key} maxLength={10} onChange={(e) => set("key", e.target.value.toUpperCase())} />
                    </Field>
                  </div>
                  {hostSupports(host, 45) && (form.key !== project.key || !!project.former_keys?.length) && (
                    <div className="text-xs text-faint">
                      Task keys change with the key. Old ones still find their tasks
                      {project.former_keys?.length ? ` (${[...project.former_keys].reverse().join(", ")})` : ""}.
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <Field
                    label="Repository path"
                    hint={
                      !hostSupports(host, 45) || !repoChanged
                        ? undefined
                        : moveRepo
                          ? `The folder moves here from ${project.repo_path}. Stop the project's agents first.`
                          : "Where the project's folder is now, if it has moved: it must be the same repository. Task worktrees are reconnected to it."
                    }
                  >
                    <Input className="font-mono text-[12px]" value={form.repo_path} onChange={(e) => set("repo_path", e.target.value)} />
                  </Field>
                  {hostSupports(host, 45) && repoChanged && <Toggle checked={moveRepo} onChange={setMoveRepo} label="Move the folder there" />}
                </div>
                {hostSupports(host, 32) && (
                  <Field label="Group" hint="Projects in a group are together on the sidebar, and the group has a board of all their tasks">
                    <Input value={form.group_name ?? ""} placeholder="No group" list="project-groups" onChange={(e) => set("group_name", e.target.value)} />
                    <datalist id="project-groups">
                      {groups.map((g) => (
                        <option key={g} value={g} />
                      ))}
                    </datalist>
                  </Field>
                )}
                <Field label="Scratch folder">
                  <Input className="font-mono text-[12px]" value={form.scratch_path} readOnly />
                </Field>
                <div className="space-y-3 rounded-xl border border-red-500/30 p-4">
                  <h3 className="text-[13px] font-semibold">Danger zone</h3>
                  {hostSupports(host, 46) && (
                    <div className="flex items-center gap-3">
                      <div className="flex-1 text-[12px] text-faint">
                        Takes the project off the board until it's unarchived in Settings. Its tasks, worktrees and branches are kept.
                      </div>
                      <Button className="shrink-0" onClick={() => setArchiving(true)}>
                        <Archive size={13} /> Archive project
                      </Button>
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <div className="flex-1 text-[12px] text-faint">Deletes the project, its tasks and their threads, and removes their worktrees.</div>
                    <Button variant="danger" className="shrink-0" onClick={() => setConfirm(true)}>
                      <Trash2 size={13} /> Delete project
                    </Button>
                  </div>
                </div>
              </>
            )}

            {current.id === "agents" && (
              <>
                <Field label="Model" hint="Overrides the profile default">
                  <Input value={form.model ?? ""} placeholder="profile default" onChange={(e) => set("model", e.target.value)} />
                </Field>
                <Field label="Permission mode" hint="With 'Ask', tool approvals show up in the thread and flag the task as needing attention.">
                  <select
                    value={form.permission_mode ?? ""}
                    onChange={(e) => set("permission_mode", (e.target.value || null) as PermissionMode | null)}
                    className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
                  >
                    {hostSupports(host, 2) && <option value="">Host default ({PERMISSION_MODES.find((m) => m.id === hostMode)?.label})</option>}
                    {PERMISSION_MODES.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} — {m.description}
                      </option>
                    ))}
                  </select>
                </Field>
                {hostSupports(host, 50) && <ProjectGithubAccount project={form} onChange={(a) => set("github_account", a)} />}
                {hostSupports(host, 20) && <ProjectConfigs project={form} onChange={(ids) => set("claude_config_ids", ids)} />}
              </>
            )}

            {current.id === "worktrees" && (
              <>
                <div className="space-y-1">
                  <Toggle checked={form.use_worktrees} onChange={(v) => set("use_worktrees", v)} label="New tasks use their own git worktree" />
                  {project.is_git === false && form.use_worktrees && (
                    <div className="text-[12px] text-faint">The folder isn't a git repository yet. New tasks get worktrees once it is.</div>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Base branch" hint="New worktree branches start from here">
                    <Input className="font-mono text-[12px]" value={form.base_branch ?? ""} placeholder="current HEAD" onChange={(e) => set("base_branch", e.target.value)} />
                  </Field>
                  <Field label="Worktrees folder">
                    <Input className="font-mono text-[12px]" value={form.worktrees_root} onChange={(e) => set("worktrees_root", e.target.value)} />
                  </Field>
                </div>
                {hostSupports(host, 82) && (
                  <div className="grid grid-cols-2 gap-3">
                    <Field
                      label="Files to copy"
                      hint={
                        <>
                          Git-ignored files copied from the repository folder into each new worktree, before the setup script. One .gitignore-style pattern
                          per line: <code>.env</code> at any depth, <code>/.env</code> only at the top. A <code>.worktreeinclude</code> in the repository is
                          read too. Files the worktree has already are left alone.
                        </>
                      }
                    >
                      <Textarea
                        rows={4}
                        className="font-mono text-[12px]"
                        placeholder={".env\n/config/*.local.json"}
                        value={form.copy_files ?? ""}
                        onChange={(e) => set("copy_files", e.target.value)}
                      />
                    </Field>
                    <Field
                      label="Folders to link"
                      hint="Git-ignored folders of the repository linked into each new worktree instead of copied, one path per line. Changes made through a link change the original; removing the worktree only removes the link."
                    >
                      <Textarea
                        rows={4}
                        className="font-mono text-[12px]"
                        placeholder={"node_modules\nmodels/cache"}
                        value={form.link_folders ?? ""}
                        onChange={(e) => set("link_folders", e.target.value)}
                      />
                    </Field>
                  </div>
                )}
                <Field
                  label="Setup script"
                  hint={
                    <>
                      Runs with bash in each new worktree, e.g. installing dependencies. Available variables: $IA_REPO_PATH,
                      $IA_WORKTREE_PATH, $IA_BRANCH, $IA_TASK_ID, $IA_TASK_NUMBER, $IA_PROJECT_KEY.
                    </>
                  }
                >
                  <Textarea
                    rows={5}
                    className="font-mono text-[12px]"
                    placeholder="npm install"
                    value={form.setup_script}
                    onChange={(e) => set("setup_script", e.target.value)}
                  />
                </Field>
                <Field label="Teardown script" hint="Runs in the worktree before it's removed (e.g. stopping dev servers, dropping a database).">
                  <Textarea
                    rows={3}
                    className="font-mono text-[12px]"
                    placeholder="docker compose down"
                    value={form.teardown_script}
                    onChange={(e) => set("teardown_script", e.target.value)}
                  />
                </Field>
                {hostSupports(host, 39) && <RemoveMergedWorktrees project={project} />}
              </>
            )}

            {current.id === "review" && form.auto_review !== undefined && (
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
                {hostSupports(host, 29) && <ProjectReviewers project={form} onChange={(v) => set("reviewers", v)} />}
              </>
            )}

            {current.id === "review" && form.done_when_merged !== undefined && (
              <div className="space-y-1.5">
                <Toggle checked={form.done_when_merged} onChange={(v) => set("done_when_merged", v)} label="Move a task to Done when its pull request is merged on GitHub" />
                <div className="text-[12px] text-faint">
                  Every few minutes, the pull requests of tasks in In review or Needs attention are checked. A merged one moves its task to Done and
                  removes its worktree if nothing in it would be lost; one closed without merging moves its task to Needs attention.
                </div>
              </div>
            )}

            {current.id === "review" && hostSupports(host, 72) && (
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

            {current.id === "review" && hostSupports(host, 79) && (
              <Field
                label="Pull request previews"
                hint="Where each task's pull request is previewed, with {pr} for its number. A task with a pull request gets it as its preview URL, which its card links to while it's in In review, and those it has already are filled in when you save. A preview URL set by hand stays."
              >
                <Input value={form.pr_preview_url ?? ""} placeholder="https://pr{pr}.example.com/" onChange={(e) => set("pr_preview_url", e.target.value)} />
              </Field>
            )}

            {current.id === "prompts" && <ProjectPrompts project={form} onChange={set} />}

            {current.id === "prompts" && hostSupports(host, 80) && <SystemPromptPreview project={project} />}

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

/** Removes the worktrees of the project's done tasks whose work is merged and that have nothing
 * uncommitted, then lists what it did with each done task's worktree. */
function RemoveMergedWorktrees({ project }: { project: Project }) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<MergedWorktreeResult[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setResults((await api.removeMergedWorktrees(project.host_id, project.id)).results);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const removed = results?.filter((r) => r.removed).length ?? 0;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={busy} onClick={run}>
          {busy && <Loader2 size={12} className="animate-spin" />} Remove merged worktrees
        </Button>
        {results && (
          <span className="text-[12px] text-muted">
            {results.length === 0 ? "No done tasks have worktrees." : `Removed ${removed}, kept ${results.length - removed}.`}
          </span>
        )}
      </div>
      <div className="text-[12px] text-faint">
        Removes the worktrees of done tasks whose work is merged and that have no uncommitted or untracked files (ignored files, such as build output,
        go with them). The tasks and branches are kept, and a task's worktree is set up again if its agent runs again.
      </div>
      {err && <div className="text-xs text-red-400">{err}</div>}
      {results && results.length > 0 && (
        <ul className="space-y-0.5 text-[12px]">
          {results.map((r) => (
            <li key={r.task_id} className="flex gap-2">
              <span className={clsx("shrink-0 font-mono", r.removed ? "text-emerald-400" : "text-faint")}>
                {project.key}-{r.number}
              </span>
              <span className="min-w-0 truncate">{r.title}</span>
              <span className="ml-auto max-w-[55%] shrink-0 truncate text-faint" title={r.detail}>
                {r.removed ? `removed, ${r.detail}` : `kept: ${r.detail}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const PROMPTS: { field: PromptField; label: string; hint: string }[] = [
  {
    field: "start_prompt",
    label: "In progress: starting a task",
    hint: "Sent to the task's agent when it starts, after the task's title and description (and before any message it's started with).",
  },
  {
    field: "review_prompt",
    label: "In review: reviewing its changes",
    hint: "What the reviewer looks for, when reviews are on. It comes after where the changes are; the board adds how to report the verdict.",
  },
  {
    field: "merge_prompt",
    label: "Ready for merge: merging it",
    hint: "How the agent merges. It comes after which branch to merge into which; the board adds asking you if it can't merge, and moving the task to Done.",
  },
];

/** The project's status script and, from API 38, a script per column (blank is none). */
function ProjectStatusScripts({
  project,
  perColumn,
  statuses,
  onChange,
}: {
  project: Project;
  perColumn: boolean;
  statuses: { id: Status; label: string }[];
  onChange: <K extends "status_script" | "status_scripts">(k: K, v: Project[K]) => void;
}) {
  const columns = project.status_scripts ?? {};
  return (
    <div className="space-y-4">
      <div className="text-[12px] text-faint">
        Available variables: $IA_OLD_STATUS, $IA_NEW_STATUS (e.g. in_review), $IA_TASK_KEY, $IA_TASK_TITLE, $IA_RESOLUTION, $IA_PR_URL and the setup
        script's.
      </div>
      <Field label="Any column" hint={perColumn ? "Runs on every move, before the column's own script." : undefined}>
        <Textarea
          rows={2}
          className="font-mono text-[12px]"
          placeholder={'notify-send "$IA_TASK_KEY moved to $IA_NEW_STATUS"'}
          value={project.status_script ?? ""}
          onChange={(e) => onChange("status_script", e.target.value)}
        />
      </Field>
      {perColumn &&
        statuses.map((s) => (
          <Field key={s.id} label={s.label}>
            <Textarea
              rows={2}
              className="font-mono text-[12px]"
              placeholder={`Runs when a task moves to ${s.label}`}
              value={columns[s.id] ?? ""}
              onChange={(e) => onChange("status_scripts", { ...columns, [s.id]: e.target.value })}
            />
          </Field>
        ))}
    </div>
  );
}

/** The instructions in the prompts the board sends as a task moves across it: the host's default
 * until the project has its own. */
function ProjectPrompts({ project, onChange }: { project: Project; onChange: (field: PromptField, v: string | null) => void }) {
  const [defaults, setDefaults] = useState<Record<PromptField, string> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.defaultPrompts(project.host_id).then(setDefaults, (e) => setErr((e as Error).message));
  }, [project.host_id]);
  return (
    <div className="space-y-5">
      {err && <div className="text-xs text-red-400">Couldn't load the default prompts: {err}</div>}
      {defaults &&
        PROMPTS.map(({ field, label, hint }) => {
          const own = project[field];
          const custom = own != null;
          return (
            <div key={field} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted">{label}</span>
                <span className={clsx("rounded px-1.5 text-[11px]", custom ? "bg-accent/15 text-accent" : "bg-line text-faint")}>{custom ? "Custom" : "Default"}</span>
                {custom && (
                  <button type="button" className="ml-auto text-[12px] text-muted hover:text-fg" onClick={() => onChange(field, null)}>
                    Reset to default
                  </button>
                )}
              </div>
              <Textarea
                rows={4}
                className="text-[12.5px]"
                value={own ?? defaults[field]}
                // Back to the default text is the default, so later changes to it apply.
                onChange={(e) => onChange(field, e.target.value === defaults[field] ? null : e.target.value)}
              />
              <span className="block text-xs text-faint">{hint}</span>
            </div>
          );
        })}
    </div>
  );
}

/** What the agent of a new thread in the project is told on top of its agent's own system prompt, for the options a
 *  thread is made with. Read-only: it's the board's, from the project's saved settings. */
function SystemPromptPreview({ project }: { project: Project }) {
  const [type, setType] = useState<NonNullable<SystemPromptOptions["type"]>>("task");
  const [labels, setLabels] = useState<DocumentType[]>([]);
  const [worktree, setWorktree] = useState<boolean | null>(null);
  const [runtime, setRuntime] = useState<Agent | null>(null);
  // Unset until it's switched, the thread's mode is the one it inherits (the project's, else the host's).
  const [plan, setPlan] = useState<boolean | null>(null);
  const [preview, setPreview] = useState<{ text: string; runtime: Agent; permission_mode: PermissionMode } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const worktrees = worktree ?? (project.use_worktrees && project.is_git !== false);
  const hostMode = useStore((s) => s.hostSettings[project.host_id]?.default_permission_mode);
  useEffect(() => {
    let live = true;
    const q: SystemPromptOptions = {
      type,
      labels: labels.join(","),
      worktree: type === "task" ? worktrees : undefined,
      runtime: runtime ?? undefined,
      permission_mode: plan === null ? undefined : plan ? "plan" : "default",
    };
    api.systemPromptPreview(project.host_id, project.id, q).then(
      (p) => {
        if (!live) return;
        setPreview(p);
        setErr(null);
      },
      (e) => live && setErr((e as Error).message),
    );
    return () => {
      live = false;
    };
    // Again when the project or the host's default mode changes, as they go into it.
  }, [project, hostMode, type, labels, worktrees, runtime, plan]);
  const shownRuntime = runtime ?? preview?.runtime ?? "claude";
  return (
    <div className="space-y-2.5 border-t border-line pt-5">
      <div className="space-y-1">
        <span className="block text-xs font-medium text-muted">System prompt</span>
        <span className="block text-xs text-faint">
          What the board adds to the agent's own system prompt for a new thread in this project, with the options picked here and the project's
          saved settings. It's for the project's next task number, with a placeholder title and id. It isn't editable.
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <select className={pickerClass} title="Type" aria-label="Type" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="task">Task</option>
          <option value="subproject">Subproject</option>
          <option value="scratch">Scratch task</option>
        </select>
        <select className={pickerClass} title="Agent" aria-label="Agent" value={shownRuntime} onChange={(e) => setRuntime(e.target.value as Agent)}>
          {AGENTS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1" role="group" aria-label="Labels">
          {LABELS.map((l) => {
            const on = labels.includes(l);
            return (
              <button
                key={l}
                type="button"
                aria-pressed={on}
                onClick={() => setLabels(on ? labels.filter((x) => x !== l) : LABELS.filter((x) => x === l || labels.includes(x)))}
                className={clsx(
                  "rounded-md border px-2 py-0.5 text-[12px]",
                  on ? "border-accent/50 bg-accent/15 text-accent" : "border-line text-muted hover:text-fg",
                )}
              >
                {l}
              </button>
            );
          })}
        </div>
        {type === "task" && <Toggle checked={worktrees} onChange={setWorktree} label="Own worktree" />}
        {shownRuntime === "codex" && <Toggle checked={plan ?? preview?.permission_mode === "plan"} onChange={setPlan} label="Plan mode" />}
      </div>
      {err ? (
        <div className="text-xs text-red-400">Couldn't load the system prompt: {err}</div>
      ) : (
        <pre
          aria-label="System prompt"
          className={clsx(
            "max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-line bg-panel px-2.5 py-2 font-sans text-[12.5px] text-fg",
            !preview && "text-faint",
          )}
        >
          {preview?.text ?? "Loading…"}
        </pre>
      )}
    </div>
  );
}

/** The project's own pick of Claude configs, or its profile's. */
function ProjectConfigs({ project, onChange }: { project: Project; onChange: (ids: string[] | null) => void }) {
  const profile = useStore((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id));
  const label = useStore((s) => (profile ? profileConfigLabel(s, profile) : ""));
  const own = project.claude_config_ids != null;
  return (
    <div className="space-y-3 rounded-xl border border-line p-4">
      <div className="space-y-1.5">
        <Toggle
          checked={own}
          onChange={(v) => onChange(v ? (profile?.claude_config_ids ?? []) : null)}
          label="Use its own agent configs"
        />
        <div className="text-[12px] text-faint">
          {own ? "New tasks pick from these; with more than one, they ask which, starting with the default." : `Uses the profile's: ${label}.`}
        </div>
      </div>
      {own && <ConfigPicker hostId={project.host_id} value={project.claude_config_ids ?? []} onChange={onChange} />}
    </div>
  );
}

/** The project's own GitHub account, or its profile's. */
function ProjectGithubAccount({ project, onChange }: { project: Project; onChange: (account: string | null) => void }) {
  const profile = useStore((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id));
  return (
    <Field label="GitHub account" hint="The account its agents act as on GitHub through their gh tools. Overrides the profile's.">
      <GithubAccountSelect
        hostId={project.host_id}
        value={project.github_account ?? ""}
        onChange={(a) => onChange(a || null)}
        inherit={(active) => `Profile's (${profile?.github_account || (active ? `gh's active account, ${active}` : "gh's active account")})`}
      />
    </Field>
  );
}

const DEFAULT_REVIEWER: Reviewer = { claude_config_id: null, model: null, effort: null };
const MAX_REVIEWERS = 6;
const pickerClass = "h-7 rounded-md border border-line bg-panel px-1.5 text-[12.5px] text-fg outline-none";

/** Who reviews each task: one reviewer with the task's config, until it has others. */
function ProjectReviewers({ project, onChange }: { project: Project; onChange: (v: Reviewer[]) => void }) {
  const configs = useStore(useShallow((s) => s.claudeConfigs.filter((c) => c.host_id === project.host_id)));
  const list = project.reviewers?.length ? project.reviewers : [DEFAULT_REVIEWER];
  const change = (i: number, r: Reviewer | null) => onChange(r ? list.map((x, j) => (j === i ? r : x)) : list.filter((_, j) => j !== i));
  return (
    <Field
      label="Reviewers"
      hint="Each reviews in a thread of its own, e.g. one with Codex and one with Claude. Once they've all finished, the serious issues they found go to the task's agent together."
    >
      <div className="space-y-2">
        {list.map((r, i) => (
          <ReviewerRow key={i} project={project} configs={configs} value={r} onChange={(v) => change(i, v)} removable={list.length > 1} />
        ))}
        {list.length < MAX_REVIEWERS && (
          <Button size="sm" variant="ghost" onClick={() => onChange([...list, DEFAULT_REVIEWER])}>
            <Plus size={12} /> Add reviewer
          </Button>
        )}
      </div>
    </Field>
  );
}

function ReviewerRow({
  project,
  configs,
  value,
  onChange,
  removable,
}: {
  project: Project;
  configs: ClaudeConfig[];
  value: Reviewer;
  onChange: (v: Reviewer | null) => void;
  removable: boolean;
}) {
  const config = configs.find((c) => c.id === value.claude_config_id);
  const models = useAgentModels(config);
  const profile = useStore((s) => s.profiles.find((p) => p.host_id === project.host_id && p.id === project.profile_id));
  const hostSettings = useStore((s) => s.hostSettings[project.host_id]);
  const model = value.model ?? "";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={pickerClass}
        title="Agent config"
        value={value.claude_config_id ?? ""}
        // Another agent has other models.
        onChange={(e) => onChange({ claude_config_id: e.target.value || null, model: null, effort: null })}
      >
        <option value="">The task's config</option>
        {configs.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {agentOf(c) === "codex" ? " (Codex)" : ""}
          </option>
        ))}
        {value.claude_config_id && !config && <option value={value.claude_config_id}>Deleted config (uses the task's)</option>}
      </select>
      <ModelPicker
        value={model}
        onChange={(m) => onChange({ ...value, model: m || null })}
        options={modelOptions(config, models)}
        placeholder={agentOf(config) === "codex" ? "model id, e.g. gpt-6.1-sol" : undefined}
        inherited={inheritedModel(config, models, project.model, profile?.default_model, hostSettings?.default_model)}
      />
      <select className={pickerClass} title="Effort" value={value.effort ?? ""} onChange={(e) => onChange({ ...value, effort: e.target.value || null })}>
        <option value="">{hostSettings?.default_effort ? `Default effort (${hostSettings.default_effort})` : "Default effort"}</option>
        {effortOptions(config, models, model).map((e) => (
          <option key={e} value={e}>
            {e} effort
          </option>
        ))}
        {value.effort && !effortOptions(config, models, model).includes(value.effort) && <option value={value.effort}>{value.effort} effort</option>}
      </select>
      {removable && (
        <IconButton title="Remove this reviewer" onClick={() => onChange(null)}>
          <Trash2 size={13} />
        </IconButton>
      )}
    </div>
  );
}

// ---------- app settings ----------

/**
 * Archives `project`: it goes off the board (the sidebar, its profile's and group's boards, agents'
 * project lists) until it's unarchived in Settings. Leaves a page about the project for the home page.
 */
export function ArchiveProjectModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const archive = async () => {
    setErr(null);
    setBusy(true);
    try {
      const p = await api.updateProject(project.host_id, project.id, { archived: true });
      const s = useStore.getState();
      const route = parse(window.location.pathname);
      const panel = new URLSearchParams(window.location.search).get("task");
      const taskId = route.name === "task" || route.name === "subproject" ? route.taskId : panel;
      const here = ("projectId" in route && route.projectId === project.id) || (!!taskId && s.tasks[taskId]?.project_id === project.id);
      s.upsertProject({ ...p, host_id: project.host_id });
      onClose();
      if (here) navigate({ name: "home" }, true);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Archive ${project.name}`} onClose={onClose}>
      <p className="mb-4 text-[13px] text-muted">
        The project goes off the board: out of the sidebar, the inbox and its group, and agents can&apos;t add tasks to it. Its tasks, worktrees and branches are
        kept. To bring it back, unarchive it in Settings → Archived projects.
      </p>
      <ModalFooter>
        {err && <div className="mb-3 text-xs text-red-400">{err}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={archive}>
            <Archive size={13} /> Archive project
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  );
}

/** The archived projects of every profile, on every host that has them, to unarchive. */
function ArchivedProjectsPanel() {
  const hosts = useStore((s) => s.hosts);
  const profiles = useStore((s) => s.profiles);
  // Changes when a project on the board is archived or unarchived, so the list is fetched again.
  const onBoard = useStore((s) => s.archived);
  const [list, setList] = useState<Project[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const from = useMemo(() => profiles.filter((p) => hostSupports(hosts.find((h) => h.id === p.host_id), 46)), [profiles, hosts]);
  useEffect(() => {
    let live = true;
    const lists = from.map((p) =>
      api
        .projects(p.host_id, p.id, true)
        .then((ps) => ps.map((x) => ({ ...x, host_id: p.host_id })))
        .catch(() => [] as Project[]),
    );
    Promise.all(lists).then((l) => live && setList(l.flat().sort((a, b) => (b.archived_at ?? "").localeCompare(a.archived_at ?? ""))));
    return () => {
      live = false;
    };
  }, [from, onBoard]);
  if (!from.length) return null;
  const key = (p: Project) => `${p.host_id}:${p.id}`;
  const manyProfiles = profileNames(profiles).length > 1;
  const manyHosts = new Set(from.map((p) => p.host_id)).size > 1;
  const unarchive = async (p: Project) => {
    setErr(null);
    setBusy(key(p));
    try {
      const saved = await api.updateProject(p.host_id, p.id, { archived: false });
      useStore.getState().upsertProject({ ...saved, host_id: p.host_id });
      setList((l) => l?.filter((x) => key(x) !== key(p)) ?? null);
    } catch (e) {
      setErr(`Unarchiving ${p.name}: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold">Archived projects</h2>
      <div className="rounded-xl border border-line">
        {list === null ? (
          <div className="px-4 py-3 text-[12.5px] text-faint">Loading…</div>
        ) : !list.length ? (
          <div className="px-4 py-3 text-[12.5px] text-faint">No archived projects. Archive one from its menu in the sidebar (right-click it) or its settings.</div>
        ) : (
          list.map((p) => (
            <div key={key(p)} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">
                  {p.name} <span className="text-faint">{p.key}</span>
                </div>
                <div className="truncate text-[11.5px] text-faint">
                  {[
                    manyProfiles && profiles.find((x) => x.host_id === p.host_id && x.id === p.profile_id)?.name,
                    manyHosts && hosts.find((h) => h.id === p.host_id)?.name,
                    p.archived_at && `archived ${timeAgo(p.archived_at)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              <Button size="sm" disabled={busy === key(p)} onClick={() => unarchive(p)}>
                <ArchiveRestore size={13} /> Unarchive
              </Button>
            </div>
          ))
        )}
      </div>
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
    </section>
  );
}

export function Settings() {
  const localHostId = useStore((s) => s.localHostId);
  const [info, setInfo] = useState<HostInfo | null>(null);
  const [showToken, setShowToken] = useState(false);
  useEffect(() => {
    if (localHostId) api.info(localHostId).then(setInfo).catch(() => {});
  }, [localHostId]);
  const port = window.location.port || (window.location.protocol === "https:" ? "443" : "80");
  const networkUrl = info ? `http://${info.hostname}:${port}/?token=${getToken()}` : "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5 narrow:px-3">
        <MenuButton />
        <h1 className="text-[14px] font-semibold">Settings</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-8 p-6 narrow:p-4">
          <HostsPanel />

          <ClaudeConfigsPanel />

          <ProfilesPanel />

          <GlobalAgentToolsPanel />

          <NotificationsPanel />

          <ArchivedProjectsPanel />

          <ServerPanel />

          <section>
            <h2 className="mb-3 text-[13px] font-semibold">Network access</h2>
            <div className="space-y-3 rounded-xl border border-line p-4 text-[12.5px] text-muted">
              <p>
                The server listens on all interfaces by default (<code>--host</code> / <code>IA_HOST</code> to change). Open this URL from another
                machine. The token in it grants full control, including running agents, so only share it over a trusted network such as a VPN or
                Tailscale.
              </p>
              <div className="flex items-center gap-2">
                <Input readOnly className="font-mono text-[11.5px]" value={showToken ? networkUrl : networkUrl.replace(/token=.*/, "token=••••••••")} />
                <Button size="sm" onClick={() => setShowToken(!showToken)}>
                  {showToken ? "Hide" : "Reveal"}
                </Button>
                <Button size="sm" onClick={() => navigator.clipboard?.writeText(networkUrl)}>
                  Copy
                </Button>
              </div>
              {info && (
                <div className="text-faint">
                  Data directory: <span className="font-mono">{info.data_dir}</span> · v{info.version}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export function Onboarding() {
  const host = useStore(() => defaultAgentHost());
  if (!host) {
    // A board-only hub: agents need a host that can run them.
    return (
      <div className="flex h-full items-center justify-center overflow-y-auto p-6">
        <div className="w-full max-w-2xl rounded-2xl border border-line bg-panel p-6">
          <h1 className="mb-1 text-[16px] font-semibold">Welcome to Huntaway</h1>
          <p className="mb-5 text-[13px] text-muted">
            This board doesn't run agents itself. Connect a machine that can, for example your workstation over SSH, then create a profile on it.
          </p>
          <HostsPanel />
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-line bg-panel p-6">
        <h1 className="mb-1 text-[16px] font-semibold">Welcome to Huntaway</h1>
        <p className="mb-5 text-[13px] text-muted">
          Create a profile to get started. Its agents use a Claude config directory, e.g. <code>~/.claude-work</code> or{" "}
          <code>~/.claude-personal</code>; more (including Codex ones) can be added under Settings → Agent configs.
        </p>
        <ProfileForm hostId={host} onDone={() => {}} />
      </div>
    </div>
  );
}

export function TokenScreen() {
  const [t, setT] = useState("");
  return (
    <div className="flex h-full items-center justify-center p-6">
      <form
        className="w-full max-w-sm space-y-4 rounded-2xl border border-line bg-panel p-6"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(t.trim());
          window.location.reload();
        }}
      >
        <div className="flex items-center gap-2 text-[15px] font-semibold">
          <KeyRound size={16} /> Access token required
        </div>
        <p className="text-[12.5px] text-muted">
          Run <code className="text-fg">huntaway token</code> on the server, or open the link it prints at startup.
        </p>
        <Input autoFocus type="password" value={t} onChange={(e) => setT(e.target.value)} placeholder="token" />
        <Button variant="primary" className="w-full" disabled={!t.trim()}>
          Connect
        </Button>
      </form>
    </div>
  );
}
