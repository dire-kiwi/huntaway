import clsx from "clsx";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { api, hostSupports, type Host, type MergedWorktreeResult, type Project } from "../../../api";
import { Button, Field, Input, Textarea, Toggle } from "../../ui";

/** The Worktrees tab: whether tasks get worktrees, where, what each gets from the repository, and its scripts. */
export function WorktreesTab({
  project,
  form,
  host,
  set,
}: {
  project: Project;
  form: Project;
  host: Host | undefined;
  set: <K extends keyof Project>(k: K, v: Project[K]) => void;
}) {
  return (
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
