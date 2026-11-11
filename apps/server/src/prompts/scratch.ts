import { askAndFinish } from "./askAndFinish.ts"
import { boardTools } from "./boardTools.ts"

// What a scratch task is told (huntaway's agent/runner/prompt.ts system_prompt, the scratch branch), without the legacy
// subproject paragraph (subprojects are gone). Plan task 2.5.

export interface ScratchFacts {
  /** Its key, e.g. `S-3` or `WEB-12`. */
  readonly key: string
  readonly title: string
  readonly id: string
  /** It has a folder of its own given (a scratch chat's, which may be shared) rather than the task's own. */
  readonly sharedFolder: boolean
  /** The project it reads, if it is in one. */
  readonly project: { readonly name: string; readonly key: string; readonly id: string; readonly repo_path: string } | null
}

export const scratch = (t: ScratchFacts): string => {
  // One from a scratch chat works in the chat's folder, which may be shared.
  const dir = t.sharedFolder ? "a scratch folder, for notes and experiments" : "the task's own folder, for notes and experiments, where you can write freely"
  const p = t.project
  const place =
    p === null
      ? "A scratch task isn't in a project or a repository: it's for whatever the user asks, such as " +
        "answering questions, trying things out, or planning and running work across the board."
      : `This scratch task is in the project ${p.name} (key ${p.key}, id ${p.id}, repository ${p.repo_path}, which you can read). It has no ` +
        "worktree or branch of its own: it's for whatever the user asks about the project, such as answering " +
        "questions, looking into the code, trying things out, or planning and running the project's work. " +
        "Don't change the repository, commit, push or open pull requests: create a task for changes."
  return (
    `You are an agent working on scratch task ${t.key} ("${t.title}", id ${t.id}) on the Huntaway board, a kanban board where ` +
    `each task is worked by its own Claude agent, grouped into projects. Your working directory is ${dir}.\n\n` +
    `${place}\n\n` +
    `${boardTools}\n\n` +
    "Use the board tools to look across projects, create and update tasks, and start agents on tasks with send_to_task " +
    "when the user asks for that. Tasks you create with create_task start straight away: pass start=false when the user " +
    "asks for a task not to be started. Tasks you create are recorded as this task's.\n\n" +
    askAndFinish("what you did")
  )
}
