import { FolderGit2, GitBranch, Play, RefreshCw, Settings2 } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";
import { api, type Project } from "../api";
import { navigate } from "../router";
import { useStore } from "../store";
import { Thread } from "./Thread";
import { Button, IconButton, SUBMIT_KEYS, Textarea } from "./ui";

/** How often the project is looked at again while it isn't ready: its agent (or the user, in a terminal) makes it so. */
const RECHECK_MS = 3000;

/**
 * In place of a project's board while its folder can't have worktrees yet (see needsWorktreeSetup): what's missing, and
 * the project's setup thread, whose agent helps get it ready. Once it is, the board comes back with the thread's task on it.
 */
export function WorktreeSetup({ project, hostName }: { project: Project; hostName?: string }) {
  const hostId = project.host_id;
  const task = useStore((s) => (project.setup_task_id ? s.tasks[project.setup_task_id] : undefined));
  const taskCount = useStore((s) => Object.values(s.tasks).filter((t) => t.project_id === project.id && t.host_id === hostId && t.kind === "task").length);
  const [checking, setChecking] = useState(false);
  const recheck = () =>
    api
      .getProject(hostId, project.id)
      .then((p) => useStore.getState().upsertProject({ ...p, host_id: hostId }))
      .catch(() => {});
  useEffect(() => {
    const timer = setInterval(recheck, RECHECK_MS);
    return () => clearInterval(timer);
  }, [hostId, project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // As soon as a turn ends, rather than at the next look.
  const running = !!task?.running;
  useEffect(() => {
    if (!running) recheck();
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const withoutWorktrees = async () => {
    setBusy(true);
    setErr(null);
    try {
      const p = await api.updateProject(hostId, project.id, { use_worktrees: false });
      useStore.getState().upsertProject({ ...p, host_id: hostId });
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };
  const missing = !project.is_git ? "isn't a git repository yet" : "is a git repository with no commits yet";

  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5">
        <FolderGit2 size={16} className="text-muted" />
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="shrink-0 text-[14px] font-semibold">{project.name}</h1>
          <span className="truncate font-mono text-[11.5px] text-faint">
            {hostName && <span className="mr-1.5 font-sans text-muted">{hostName} ·</span>}
            {project.repo_path}
          </span>
        </div>
        <div className="no-drag ml-auto flex items-center gap-1.5">
          <IconButton title="Project settings" onClick={() => navigate({ name: "projectSettings", projectId: project.id })}>
            <Settings2 size={15} />
          </IconButton>
        </div>
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-amber-500/[0.06] px-5 py-2.5 text-[12.5px]" data-worktree-setup>
        <GitBranch size={14} className="shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1 text-muted">
          <span className="text-fg">The project's folder {missing}.</span> Each task gets its own git worktree and branch, so its tasks
          wait until the folder is a git repository with a commit to branch from. The board comes back once it is.
          {taskCount > 0 && ` Its ${taskCount === 1 ? "task is" : `${taskCount} tasks are`} kept until then.`}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={checking}
            title="Look at the folder again"
            onClick={() => {
              setChecking(true);
              recheck().finally(() => setChecking(false));
            }}
          >
            <RefreshCw size={13} className={checking ? "animate-spin" : undefined} /> Check again
          </Button>
          <Button size="sm" disabled={busy} onClick={withoutWorktrees} title="Tasks work in the project's folder itself, one at a time. You can turn worktrees back on in the project's settings.">
            Use without worktrees
          </Button>
        </div>
      </div>
      {err && <div className="shrink-0 border-b border-line px-5 py-2 text-[12px] text-red-400">{err}</div>}
      <main className="min-h-0 flex-1">
        {task ? <Thread key={`${task.host_id}:${task.id}`} task={task} cwd={project.repo_path} /> : <StartSetup project={project} missing={missing} onError={setErr} />}
      </main>
    </div>
  );
}

/**
 * Before the project has a setup thread: what its agent will do, and anything the user wants to tell it first. Errors go
 * to `onError`, above the thread: one whose agent couldn't start is still made, and shown in place of this.
 */
function StartSetup({ project, missing, onError }: { project: Project; missing: string; onError: (e: string | null) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      const t = await api.startSetupThread(project.host_id, project.id, text);
      const s = useStore.getState();
      s.upsertTask({ ...t, host_id: project.host_id });
      // So the thread shows now, rather than when the project's event comes in.
      s.upsertProject({ ...project, setup_task_id: t.id });
    } catch (e) {
      onError(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      start();
    }
  };
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-4 px-5 py-10">
        <div className="space-y-1.5">
          <h2 className="text-[15px] font-semibold">Get {project.name} ready for worktrees</h2>
          <p className="text-[13px] text-muted">
            <span className="font-mono text-[12px]">{project.repo_path}</span> {missing}. An agent can help: it looks at what's in the folder,
            makes it a git repository with a <span className="font-mono text-[12px]">.gitignore</span> for what shouldn't be committed, makes
            the first commit and, if you want, puts it on GitHub. It asks you before anything that's hard to undo.
          </p>
        </div>
        <Textarea
          rows={3}
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder="Anything it should know first? (optional) E.g. which files to leave out, the branch name, or the GitHub repository to use"
        />
        <div className="flex items-center justify-end gap-2">
          <span className="text-[11.5px] text-faint">{SUBMIT_KEYS}</span>
          <Button variant="primary" disabled={busy} onClick={start}>
            <Play size={13} /> Start setup thread
          </Button>
        </div>
      </div>
    </div>
  );
}
