import clsx from "clsx";
import { Copy, GitBranch, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, CHECKS_API, documentsOnly, hostSupports, isAssistant, isScratch, LABELS_API, START_FROM_API, taskLabels, type Host, type Task } from "../../../../api";
import { isGroupTask, useProject, useStore } from "../../../../store";
import { Dependencies } from "../../../board/Dependencies";
import { useConfirmDone } from "../../../board/ConfirmDone";
import { LinkedTasks, LINKS_API, usesAsana } from "../../ExternalLinks";
import { useWorkflowRuns, WorkflowsList } from "../../Workflows";
import { Button, PrIcon, PreviewDot, showsPreview, Toggle } from "../../../ui";
import { TitleSection } from "../Title";
import type { Mode } from "../layout";
import { AgentSection } from "./AgentSection";
import { DescriptionSection } from "./DescriptionSection";
import { FailedChecks } from "./FailedChecks";
import { LabelsSection } from "./LabelsSection";
import { DeleteTaskModal, TeardownModal } from "./Modals";
import { Row, Section, TextInput } from "./Section";
import { StartFromRow } from "./StartFromRow";
import { StatusSection } from "./StatusSection";
import { SubprojectSection } from "./SubprojectSection";
import { CreatedTasksSection, FanoutSection } from "./TaskLists";

export function Details({ task, mode, className }: { task: Task; mode: Mode; className: string }) {
  const project = useProject(task.project_id);
  // A group task has no repository, so nothing to review, merge or depend on. A plan, artifact or
  // diagram has no branch to merge either.
  const groupTask = isGroupTask(task);
  const docsOnly = documentsOnly(task);
  // A scratch task has no repository either.
  const scratch = isScratch(task);
  // Nor does the profile's assistant, which lasts: it isn't moved between columns, reviewed or merged.
  const assistant = isAssistant(task);
  const host = useStore((s) => s.hosts.find((h) => h.id === task.host_id));
  const asana = usesAsana(useStore((s) => s.profiles.find((p) => p.host_id === task.host_id && p.id === task.profile_id)));
  const [wtBusy, setWtBusy] = useState(false);
  // What went wrong with each part, until it's tried again.
  const [errs, setErrs] = useState<Partial<Record<"worktree" | "preview" | "pr", string>>>({});
  const setErr = (part: keyof typeof errs, msg: string | null) => setErrs((e) => ({ ...e, [part]: msg ?? undefined }));
  const [teardown, setTeardown] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { confirmDone, dialog: doneDialog } = useConfirmDone();
  const workflows = useWorkflowRuns(task);
  const run = async (fn: () => Promise<unknown>) => {
    setWtBusy(true);
    setErr("worktree", null);
    try {
      await fn();
    } catch (e) {
      setErr("worktree", (e as Error).message);
    } finally {
      setWtBusy(false);
    }
  };

  return (
    <aside className={className}>
      {!assistant && <StatusSection task={task} host={host} confirmDone={confirmDone} />}

      <TitleSection task={task} />

      <DescriptionSection task={task} />

      {/* With Asana turned off for the profile, only to show (and unlink) the links it has. */}
      {hostSupports(host, LINKS_API) && task.kind === "task" && ((asana && !assistant) || !!task.external_links?.length) && (
        <Section title="Asana">
          <LinkedTasks task={task} canLink={asana} />
        </Section>
      )}

      {task.fanout_id && <FanoutSection task={task} />}

      {(groupTask || taskLabels(task).includes("plan")) && <CreatedTasksSection task={task} />}

      {task.kind === "task" && (hostSupports(host, LABELS_API) || taskLabels(task).length > 0) && <LabelsSection task={task} />}

      {scratch && (
        <Section title="Scratch">
          <div className="space-y-1">
            <div className="text-[12.5px] text-muted">
              {task.project_id
                ? `Its agent works in the task's own folder, with no worktree, and reads the repository${task.parent_id ? " and the subproject's worktree" : ""}.`
                : `In no project: its agent works in ${task.work_dir ? "this folder" : "the task's own folder"}, with no repository.`}
            </div>
            {task.work_dir && (
              <Row label="Folder">
                <span className="font-mono text-[11px] break-all">{task.work_dir}</span>
              </Row>
            )}
          </div>
        </Section>
      )}

      {assistant && (
        <Section title="Assistant">
          <div className="space-y-1">
            <div className="text-[12.5px] text-muted">
              This profile's assistant: one lasting conversation, outside every project. It has the profile's skills and MCP servers and the
              board's tools, and hands code work to project tasks. Its agent works in its own folder.
            </div>
            {task.work_dir && (
              <Row label="Folder">
                <span className="font-mono text-[11px] break-all">{task.work_dir}</span>
              </Row>
            )}
            <AssistantPlace host={host} />
          </div>
        </Section>
      )}

      {hostSupports(host, 24) && task.kind === "task" && !groupTask && !scratch && !assistant && (
        <Section title="Depends on">
          <Dependencies task={task} project={project} />
        </Section>
      )}

      {hostSupports(host, 8) && !assistant && (
        <Section title="Preview" right={showsPreview(task) && <PreviewDot url={task.preview_url!} label className="text-[11.5px] text-faint" />}>
          <TextInput
            value={task.preview_url ?? null}
            placeholder="https://… (where to try this task)"
            onSave={(url) => {
              setErr("preview", null);
              api.updateTask(task.host_id, task.id, { preview_url: url || null }).catch((e) => setErr("preview", e.message));
            }}
          />
          {errs.preview && <div className="mt-2 rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{errs.preview}</div>}
        </Section>
      )}

      {!!workflows?.workflows.length && (
        <Section title="Workflows">
          <WorkflowsList task={task} />
        </Section>
      )}

      {hostSupports(host, 26) && task.kind === "task" && !groupTask && !docsOnly && !scratch && !assistant && (
        <Section title="Pull request" right={task.pr_url && <PrIcon url={task.pr_url} label className="text-[11.5px] text-faint" />}>
          <TextInput
            value={task.pr_url ?? null}
            placeholder="https://… (found with gh once the agent opens one)"
            onSave={(url) => {
              setErr("pr", null);
              api.updateTask(task.host_id, task.id, { pr_url: url || null }).catch((e) => setErr("pr", e.message));
            }}
          />
          {errs.pr && <div className="mt-2 rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{errs.pr}</div>}
          {hostSupports(host, CHECKS_API) && <FailedChecks task={task} />}
        </Section>
      )}

      {hostSupports(host, 17) && task.kind === "task" && !groupTask && !docsOnly && !scratch && !assistant && <SubprojectSection task={task} />}

      {!groupTask && !docsOnly && !scratch && !assistant && (
        <Section title="Worktree">
          {!task.use_worktree && task.worktree_state === "none" ? (
            <div className="space-y-2">
              <div className="text-[12.5px] text-muted">Runs directly in the project repository.</div>
              {project?.use_worktrees !== undefined && project.is_git !== false && (
                <Toggle checked={false} onChange={(v) => api.updateTask(task.host_id, task.id, { use_worktree: v }).catch((e) => setErr("worktree", e.message))} label="Use a worktree" />
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <Row label="State">
                <span
                  className={clsx(
                    task.worktree_state === "ready" && "text-emerald-300",
                    task.worktree_state === "error" && "text-red-300",
                    (task.worktree_state === "setting_up" || task.worktree_state === "tearing_down") && "text-st-progress",
                  )}
                >
                  {task.worktree_state === "none"
                    ? task.branch
                      ? "removed (set up again on the next run)"
                      : "not created (created on first run)"
                    : task.worktree_state.replace("_", " ")}
                </span>
              </Row>
              {task.branch && (
                <Row label="Branch">
                  <span className="font-mono text-[11.5px] break-all">
                    <GitBranch size={11} className="mr-1 inline align-[-1px]" />
                    {task.branch}
                  </span>
                </Row>
              )}
              {task.base_branch && (
                <Row label="Base">
                  <span className="font-mono text-[11.5px]">{task.base_branch}</span>
                </Row>
              )}
              {hostSupports(host, START_FROM_API) && <StartFromRow task={task} project={project} onError={(e) => setErr("worktree", e)} />}
              {task.worktree_path && (
                <Row label="Path">
                  <span className="group flex items-start gap-1 font-mono text-[11px]">
                    <span className="break-all">{task.worktree_path}</span>
                    <button className="shrink-0 text-faint hover:text-fg" onClick={() => navigator.clipboard?.writeText(task.worktree_path!)} title="Copy path">
                      <Copy size={11} />
                    </button>
                  </span>
                </Row>
              )}
              {task.worktree_error && <div className="rounded bg-red-500/10 p-2 font-mono text-[11px] whitespace-pre-wrap text-red-300">{task.worktree_error}</div>}
              <div className="flex flex-wrap gap-2 pt-2">
                {task.worktree_state !== "ready" && (
                  <Button size="sm" disabled={wtBusy || task.running} onClick={() => run(() => api.setupWorktree(task.host_id, task.id))}>
                    {wtBusy ? <Loader2 size={12} className="animate-spin" /> : null} Set up
                  </Button>
                )}
                {task.worktree_state === "ready" && (
                  <Button size="sm" disabled={wtBusy || task.running} onClick={() => setTeardown(true)}>
                    Tear down…
                  </Button>
                )}
                {task.worktree_state === "none" && (
                  <Button size="sm" variant="ghost" onClick={() => api.updateTask(task.host_id, task.id, { use_worktree: false }).catch((e) => setErr("worktree", e.message))}>
                    Don't use a worktree
                  </Button>
                )}
              </div>
            </div>
          )}
          {errs.worktree && <div className="mt-2 rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{errs.worktree}</div>}
        </Section>
      )}

      <AgentSection task={task} host={host} project={project} />

      <div className="px-4 py-4">
        <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
          <Trash2 size={12} /> Delete task
        </Button>
      </div>

      {teardown && <TeardownModal task={task} onClose={() => setTeardown(false)} />}
      {confirmDelete && <DeleteTaskModal task={task} mode={mode} onClose={() => setConfirmDelete(false)} />}
      {doneDialog}
    </aside>
  );
}

/** Which host the assistant runs on, and whether its agents can use this board's tools from there (API 111). */
function AssistantPlace({ host }: { host: Host | undefined }) {
  const board = useStore((s) => s.hosts.find((h) => h.local));
  if (!host) return null;
  return (
    <>
      <Row label="Host">
        <span className="text-[12px]">{host.local ? `${host.name} (this board's host)` : `${host.name}${host.connected ? "" : " (offline)"}`}</span>
      </Row>
      {!host.local && (
        <Row label="This board">
          <span className="text-[12px] text-muted">
            {host.uplink
              ? `Its agents can use ${board?.name ?? "this board"}'s projects and tasks, with the access their profile has here.`
              : `Its agents can't use ${board?.name ?? "this board"}'s projects and tasks. Let them in Settings → Hosts (${host.name}).`}
          </span>
        </Row>
      )}
    </>
  );
}
