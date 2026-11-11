import { askAndFinish } from "./askAndFinish.ts"
import { boardTools } from "./boardTools.ts"
import { documentGuide, documentsNamed } from "./documentGuide.ts"
import type { DocumentFile } from "./documentGuide.ts"

// What a task that makes only documents is told (huntaway's agent/runner/prompt.ts system_prompt, the documents-only
// branch, with agent/documents.ts system_prompt): a plan, artifact or diagram task from before they were labels. Plan
// task 2.5.

export interface DocumentsOnlyFacts {
  /** Its key, e.g. `WEB-12`. */
  readonly key: string
  readonly title: string
  readonly id: string
  readonly files: ReadonlyArray<DocumentFile>
  readonly project: { readonly name: string; readonly repo_path: string } | null
  /** The group it is for, when it is in no project, and the group's projects. */
  readonly group: {
    readonly name: string
    readonly projects: ReadonlyArray<{ readonly name: string; readonly key: string; readonly repo_path: string }>
  } | null
}

/** What it is told to write and where, after who it is and where (agent/documents.ts system_prompt). */
const writes = (t: DocumentsOnlyFacts): string => {
  const { project, group, files } = t
  let s: string
  if (project !== null) s = ` Project: ${project.name} (repository ${project.repo_path}, which you can read).`
  else if (group !== null && group.projects.length === 0)
    s = ` The task isn't in a project but is for the group "${group.name}", which has no projects at the moment.`
  else if (group !== null) {
    const list = group.projects.map((p) => `${p.name} (key ${p.key}, repository ${p.repo_path})`)
    s = ` The task isn't in a project but is for the group "${group.name}", whose projects are: ${list.join("; ")}. You can read their repositories.`
  } else s = ""
  s +=
    `\n\nRather than changing code, this task makes documents: you write ${files.length === 0 ? "none at the moment, as it has no labels: ask the user what to make" : documentsNamed(files)}. ` +
    "Your working directory is the task's own folder, where you can write freely. " +
    `The board shows ${files.length === 1 ? "that file" : "each file"} in the task as it changes, and keeps a version from each turn. ` +
    "Don't change the repositories, commit, push or open pull requests."
  for (const [label] of files) s += documentGuide(label, true)
  return s
}

export const documentsOnly = (t: DocumentsOnlyFacts): string =>
  `You are an agent working on task ${t.key} ("${t.title}", id ${t.id}) on the Huntaway board, a kanban board where each ` +
  `task is worked by its own Claude agent.${writes(t)}\n\n${boardTools}\n\n${askAndFinish("what you made or changed")}`
