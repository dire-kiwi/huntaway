import type { ThreadKind } from "@huntaway/contracts"
import { assistant } from "../../prompts/assistant.ts"
import { codeTask } from "../../prompts/codeTask.ts"
import { codexPlanMode } from "../../prompts/codexPlanMode.ts"
import { desktopNote } from "../../prompts/desktopNote.ts"
import { docsNote } from "../../prompts/docsNote.ts"
import { documentsOnly } from "../../prompts/documentsOnly.ts"
import { codexGithubNote, githubNote } from "../../prompts/github.ts"
import { group } from "../../prompts/group.ts"
import { labels } from "../../prompts/labels.ts"
import { pen } from "../../prompts/pen.ts"
import { pens } from "../../prompts/pens.ts"
import { profilesNote } from "../../prompts/profilesNote.ts"
import { reviewThread } from "../../prompts/reviewThread.ts"
import { routine } from "../../prompts/routine.ts"
import { scratch } from "../../prompts/scratch.ts"
import { tempFolder } from "../../prompts/tempFolder.ts"
import { keyPrefix } from "./context.ts"
import type { PromptContext } from "./context.ts"

// What a run is told on top of its agent's own system prompt (huntaway's agent/runner/prompt.ts system_prompt and
// instructions): Claude Code's `--append-system-prompt-file`, or Codex's developer instructions. The old function's
// branch per kind of thread is a table over `ThreadKind`.

/** What goes before a task's number in its key: its project's, else the letter for its kind. */
const keyOf = (kind: ThreadKind, c: PromptContext, number: number) => `${keyPrefix(kind, c.task, c.project)}-${number}`

/** A thread under a task: told of that task, and of its worktree when it is ready. */
const underTask =
  (role: "review" | "summary" | "workflow") =>
  (_: ThreadKind, c: PromptContext): string =>
    reviewThread({
      role,
      key: `${c.project?.key ?? "T"}-${c.parent?.number ?? 0}`,
      title: c.parent?.title ?? "?",
      worktree: c.parent?.worktree_ready === true ? { path: c.parent.worktree_path, branch: c.parent.branch } : null,
    })

/** Each kind's own prompt, from who it is to how it finishes. */
const ownPrompt: { readonly [Tag in ThreadKind["_tag"]]: (kind: ThreadKind, c: PromptContext) => string } = {
  Code: (_, c) =>
    codeTask({
      key: c.project?.key ?? "T",
      number: c.task.number,
      title: c.task.title,
      project: c.project,
      pullRequests: c.project === null || c.project.pull_requests,
      worktree_path: c.task.worktree_path,
      branch: c.task.branch,
      base_branch: c.task.base_branch,
      start_from: c.task.start_from,
      merges_into: c.task.merges_into,
      github_stack: c.task.github_stack,
      target: c.target,
      github: c.github,
      ghTools: c.ghTools,
      boardPr: c.boardPr,
    }),
  Document: (kind, c) =>
    documentsOnly({
      key: keyOf(kind, c, c.task.number),
      title: c.task.title,
      id: c.task.id,
      files: c.docs,
      project: c.project,
      group: c.task.group_name !== null ? { name: c.task.group_name, projects: c.group } : null,
    }),
  Scratch: (kind, c) =>
    scratch({ key: keyOf(kind, c, c.task.number), title: c.task.title, id: c.task.id, sharedFolder: c.task.work_dir !== null, project: c.project }),
  Group: (_, c) => group({ number: c.task.number, title: c.task.title, id: c.task.id, group: c.task.group_name ?? "", projects: c.group }),
  Assistant: (_, c) => assistant({ number: c.task.number, id: c.task.id, workDir: c.task.work_dir, codex: c.codex }),
  Routine: (_, c) => routine({ number: c.task.number, id: c.task.id, parentId: c.task.parent_id ?? "", workDir: c.task.work_dir }),
  PensRoot: (_, c) => pens({ number: c.task.number, id: c.task.id, codex: c.codex }),
  Pen: (_, c) => pen({ number: c.task.number, id: c.task.id, codex: c.codex }),
  Review: underTask("review"),
  Summary: underTask("summary"),
  WorkflowStep: underTask("workflow"),
}

/** Whether it is a thread under a task (a reviewer, a summarizer, a workflow's step). */
const isUnderTask = (kind: ThreadKind) => kind._tag === "Review" || kind._tag === "Summary" || kind._tag === "WorkflowStep"

/**
 * What a thread's agent is told, in paragraphs separated by blank lines (`instructions` adds more): its kind's own
 * prompt, then what its labels ask for (a task that makes only documents was told already).
 */
export const basePrompt = (kind: ThreadKind, c: PromptContext): string => {
  const own = ownPrompt[kind._tag](kind, c)
  return kind._tag === "Document" ? own : own + labels(c.docs)
}

/** Whether `profile` lets the agents of the profile named `name` in. */
const grants = (profile: PromptContext["profiles"][number], name: string) => profile.name === name || profile.agent_access.some((n) => n === "*" || n === name)

/**
 * What a run is told after `base`: Codex's plan mode, GitHub, the docs and desktop servers, its temp folder, which
 * profiles' boards it reaches, a pen thread's pen and the assistant's memory (last), each when it applies.
 */
export const instructions = (base: string, kind: ThreadKind, c: PromptContext): string => {
  let s = base
  if (c.codex && c.plan) s += codexPlanMode
  if (c.ghTools && c.codex) s += codexGithubNote(c.githubAccount)
  else if (c.ghTools) s += githubNote(c.githubAccount)
  if (c.docsTools && !isUnderTask(kind)) s += docsNote(c.codex)
  if (c.desktopHost !== null && c.desktopHost !== "") s += desktopNote(c.codex, c.desktopHost)
  if (c.tmp !== null) s += tempFolder(c.tmp, isUnderTask(kind))
  // Which profiles' boards it can't use, so it asks rather than make a project that may be there.
  if (!isUnderTask(kind)) {
    const others = c.profiles.filter((p) => p.id !== c.profile.id)
    const names = (ps: typeof others) => ps.map((p) => p.name)
    s += profilesNote(c.profile.name, names(others.filter((p) => grants(p, c.profile.name))), names(others.filter((p) => !grants(p, c.profile.name))))
  }
  s += c.pen
  s += c.memory
  return s
}

/** The whole of what a run of a thread of `kind` is told on top of its agent's own system prompt. */
export const systemPrompt = (kind: ThreadKind, c: PromptContext): string => instructions(basePrompt(kind, c), kind, c)
