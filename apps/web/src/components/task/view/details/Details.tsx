import { documentsOnly, isAssistant, isPenThread, isPensThread, isScratch, taskLabels, type HostTask as Task } from "@huntaway/client"
import { clsx } from "clsx"
import { TaskId, type TaskPatch } from "@huntaway/contracts"
import { Copy, GitBranch, Loader2, Trash2 } from "lucide-react"
import { useState } from "react"
import { useBoard } from "../../../../state/board"
import { exitError, useMutation } from "../../../../state/mutation"
import { isGroupTask, useProject } from "../../../boardHelpers"
import { Dependencies } from "../../../board/Dependencies"
import { useConfirmDone } from "../../../board/ConfirmDone"
import { IncomingSection, MergesIntoSection, useIncoming } from "../../../board/MergesInto"
import { levelsTitle, stackedBelowId, stackedOnTitle, useLevels } from "../../../board/StackedOn"
import { LevelsSection, StackedOnSection } from "../../../board/stackSections"
import { Button, PrIcon, PreviewDot, showsPreview, Toggle } from "../../../ui"
import { LinkedTasks, usesAsana } from "../../ExternalLinks"
import { TitleSection } from "../Title"
import type { Mode } from "../layout"
import { AgentSection } from "./AgentSection"
import { DescriptionSection } from "./DescriptionSection"
import { FailedChecks } from "./FailedChecks"
import { LabelsSection } from "./LabelsSection"
import { DeleteTaskModal, TeardownModal } from "./Modals"
import { Row, Section, TextInput } from "./Section"
import { StartFromRow } from "./StartFromRow"
import { StatusSection } from "./StatusSection"
import { CreatedTasksSection, FanoutSection } from "./TaskLists"
import { TrackedWork } from "./TrackedWork"
// 6.7
import { RulesSection } from "../../ApprovalRules"
// 6.6
import { useWorkflowRuns, WorkflowsList } from "../../Workflows"

// Step 1 (docs/plan/09-frontend.md). Subprojects were a legacy branch and are gone. The task's workflows (6.6), the
// assistant's approval rules (6.7), the stack sections "Stacked on" and "Landing after this" (4.8) and the Asana links
// (6.11) are back.

export function Details({ task, mode, className }: { task: Task; mode: Mode; className: string }) {
  const project = useProject(task.project_id)
  const asana = usesAsana(useBoard((s) => s.profiles.find((p) => p.host_id === task.host_id && p.id === task.profile_id)))
  // A group task has no repository, so nothing to review, merge or depend on. A plan, artifact or
  // diagram has no branch to merge either.
  const groupTask = isGroupTask(task)
  const docsOnly = documentsOnly(task)
  // A scratch task has no repository either.
  const scratch = isScratch(task)
  // Nor does the profile's assistant, which lasts: it isn't moved between columns, reviewed or merged.
  // The pens thread (API 127) lasts too, as does each pen's own (API 128).
  const pensThread = isPensThread(task)
  const penThread = isPenThread(task)
  const assistant = isAssistant(task)
  const lasting = assistant || pensThread || penThread
  const pen = useBoard((s) => (penThread ? s.pens.find((p) => p.host_id === task.host_id && p.thread_id === task.id) : undefined))
  const host = useBoard((s) => s.hosts.find((h) => h.id === task.host_id))
  // What went wrong with each part, until it's tried again.
  const [errs, setErrs] = useState<Partial<Record<"worktree" | "preview" | "pr", string>>>({})
  const setErr = (part: keyof typeof errs, msg: string | null) =>
    setErrs((e) => {
      const next = { ...e }
      if (msg === null) delete next[part]
      else next[part] = msg
      return next
    })
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [teardown, setTeardown] = useState(false)
  const [, update] = useMutation("tasks.update")
  /** Changes the task, and says why it couldn't under `part`. */
  const change = (part: keyof typeof errs, patch: TaskPatch, clear: boolean) => {
    if (clear) setErr(part, null)
    void update(task.host_id, { id: task.id, patch }).then((exit) => {
      const why = exitError(exit)
      if (why !== null) setErr(part, why)
    })
  }
  // A worktree being set up from here (the button's, until the call ends).
  const [{ busy: wtBusy }, setupWorktree] = useMutation("git.setupWorktree")
  const setUp = () => {
    setErr("worktree", null)
    void setupWorktree(task.host_id, { id: TaskId.make(task.id) }).then((exit) => {
      const why = exitError(exit)
      if (why !== null) setErr("worktree", why)
    })
  }

  const { confirmDone, dialog: doneDialog } = useConfirmDone()
  // What its work merges into (API 128): a code task in a project, which merge as they did.
  const incoming = useIncoming(task.id)
  const workflows = useWorkflowRuns(task)
  // The stack levels on it, and the one it's stacked on (API 142), apart from what it merges into.
  const levels = useLevels(task.id)
  const mergeable = task.kind === "task" && !!task.project_id && !groupTask && !docsOnly && !scratch && !lasting && !task.parent_id
  // It needs a worktree; once it's done, only to show where it went.
  const showMergesInto = mergeable && (task.use_worktree || !!task.branch || !!task.merges_into) && (task.status !== "done" || !!task.merges_into)

  return (
    <aside className={className}>
      {!lasting && <StatusSection task={task} host={host} confirmDone={confirmDone} />}

      <TitleSection task={task} />

      {assistant && <TrackedWork task={task} />}

      {/* The assistant's is the conversation itself. */}
      {!assistant && <DescriptionSection task={task} />}

      {/* With Asana turned off for the profile, only to show (and unlink) the links it has. */}
      {task.kind === "task" && ((asana && !lasting) || task.external_links.length > 0) && (
        <Section title="Asana">
          <LinkedTasks task={task} canLink={asana} />
        </Section>
      )}

      {task.fanout_id && <FanoutSection task={task} />}

      {(groupTask || taskLabels(task).includes("plan")) && <CreatedTasksSection task={task} />}

      {task.kind === "task" && !assistant && <LabelsSection task={task} />}

      {scratch && (
        <Section title="Scratch">
          <div className="space-y-1">
            <div className="text-[12.5px] text-muted">
              {task.project_id
                ? "Its agent works in the task's own folder, with no worktree, and reads the repository."
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

      {pensThread && (
        <Section title="Pens thread">
          <div className="text-[12.5px] text-muted">
            This profile's pens thread: one lasting conversation that arranges the pens, the tabs over the profile's board. Tell it what you're working on and
            it sets them up; it doesn't change the tasks themselves unless you ask.
          </div>
        </Section>
      )}

      {penThread && (
        <Section title="Pen thread">
          <div className="text-[12.5px] text-muted">
            {pen ? `The ${pen.name} pen's own thread` : "The thread of a pen that's gone"}: one lasting conversation about the pen's tasks. Its agent is told
            which tasks are in the pen, puts the tasks it creates there, and keeps notes on what the pen is for. It's renamed with the pen, and deleted with it.
          </div>
        </Section>
      )}

      {assistant && (
        <Section title="Rules" collapsible="rules">
          <RulesSection task={task} />
        </Section>
      )}

      {task.kind === "task" && !groupTask && !scratch && !lasting && (
        <Section title="Depends on">
          <Dependencies task={task} project={project} />
        </Section>
      )}

      {!lasting && (
        <Section
          title="Preview"
          right={showsPreview(task) && task.preview_url && <PreviewDot url={task.preview_url} host={task.host_id} label className="text-[11.5px] text-faint" />}
        >
          <TextInput
            value={task.preview_url ?? null}
            placeholder="https://… (where to try this task)"
            onSave={(url) => change("preview", { preview_url: url || null }, true)}
          />
          {errs.preview && <div className="mt-2 rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{errs.preview}</div>}
        </Section>
      )}

      {!!workflows?.workflows.length && (
        <Section title="Workflows">
          <WorkflowsList task={task} />
        </Section>
      )}

      {task.kind === "task" && !groupTask && !docsOnly && !scratch && !lasting && (
        <Section title="Pull request" right={task.pr_url && <PrIcon url={task.pr_url} label className="text-[11.5px] text-faint" />}>
          <TextInput
            value={task.pr_url ?? null}
            placeholder="https://… (found with gh once the agent opens one)"
            onSave={(url) => change("pr", { pr_url: url || null }, true)}
          />
          {errs.pr && <div className="mt-2 rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{errs.pr}</div>}
          <FailedChecks task={task} />
        </Section>
      )}

      {/* A stack level that's merging or done says where it goes under "Stacked on" (or "Lands after") instead. */}
      {showMergesInto && !(stackedBelowId(task) && (task.merging || task.status === "done")) && (
        <Section title="Merges into">
          <MergesIntoSection task={task} project={project} />
        </Section>
      )}

      {incoming.length > 0 && (
        <Section title="Merging into this">
          <IncomingSection task={task} project={project} />
        </Section>
      )}

      {stackedBelowId(task) && (
        <Section title={stackedOnTitle(task)}>
          <StackedOnSection task={task} project={project} />
        </Section>
      )}

      {levels.length > 0 && (
        <Section title={levelsTitle(levels)}>
          <LevelsSection task={task} project={project} />
        </Section>
      )}

      {!groupTask && !docsOnly && !scratch && !lasting && (
        <Section title="Worktree">
          {!task.use_worktree && task.worktree_state === "none" ? (
            <div className="space-y-2">
              <div className="text-[12.5px] text-muted">Runs directly in the project repository.</div>
              {project?.use_worktrees !== undefined && project.is_git && (
                <Toggle checked={false} onChange={(v) => change("worktree", { use_worktree: v }, false)} label="Use a worktree" />
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
              <StartFromRow task={task} project={project} onError={(e) => setErr("worktree", e)} />
              {task.worktree_path && (
                <Row label="Path">
                  <span className="group flex items-start gap-1 font-mono text-[11px]">
                    <span className="break-all">{task.worktree_path}</span>
                    <button
                      className="shrink-0 text-faint hover:text-fg"
                      onClick={() => void navigator.clipboard?.writeText(task.worktree_path ?? "")}
                      title="Copy path"
                    >
                      <Copy size={11} />
                    </button>
                  </span>
                </Row>
              )}
              {task.worktree_error && (
                <div className="rounded bg-red-500/10 p-2 font-mono text-[11px] whitespace-pre-wrap text-red-300">{task.worktree_error}</div>
              )}
              <div className="flex flex-wrap gap-2 pt-2">
                {task.worktree_state !== "ready" && (
                  <Button size="sm" disabled={wtBusy || task.running} onClick={setUp}>
                    {wtBusy ? <Loader2 size={12} className="animate-spin" /> : null} Set up
                  </Button>
                )}
                {task.worktree_state === "ready" && (
                  <Button size="sm" disabled={wtBusy || task.running} onClick={() => setTeardown(true)}>
                    Tear down…
                  </Button>
                )}
                {task.worktree_state === "none" && (
                  <Button size="sm" variant="ghost" onClick={() => change("worktree", { use_worktree: false }, false)}>
                    Don't use a worktree
                  </Button>
                )}
              </div>
            </div>
          )}
          {errs.worktree && <div className="mt-2 rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{errs.worktree}</div>}
        </Section>
      )}

      <AgentSection task={task} />

      {/* The assistant lasts: it can't be deleted. */}
      {!assistant && (
        <div className="px-4 py-4">
          <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={12} /> Delete task
          </Button>
        </div>
      )}

      {teardown && <TeardownModal task={task} onClose={() => setTeardown(false)} />}
      {confirmDelete && <DeleteTaskModal task={task} mode={mode} onClose={() => setConfirmDelete(false)} />}
      {doneDialog}
    </aside>
  )
}
