import type { Profile, Project, Task } from "@huntaway/contracts"
import { mentionedProject, mentionedTask, mentionsNote as note } from "../../prompts/mentions.ts"

// What a prompt is told of the projects and tasks it names by key (HA-400; huntaway's agent/runner/mentions.ts). The
// board's `@` list puts a key in the text (`HA`, `HA-12`, `work:SD-3`), which alone says nothing of what it is; so the
// prompt ends with a note that says, for each key that names a project or task the profile's agents can use.

// A word that may be a key, and what makes it one: as the web app marks them (refWords in refCompletion.ts).
const REF_WORD = /[\w.:-]+/g
const KEY_LIKE = /^(?:([\w.-]+):)?([A-Z][A-Z0-9]*)(?:-(\d+))?$/
/** No more than this many are described: a long text that lists keys says what they are itself. */
const MOST = 12

/** A key in a prompt: the profile it is qualified with (by name or id), the project's key or `S`, and the task's number. */
export interface MentionKey {
  readonly word: string
  readonly qualifier: string | null
  readonly key: string
  readonly number: number | null
}

/** The words of `text` that could be keys, each once: not part of a path, an address or another token (`#HA-12`). */
export const mentionKeys = (text: string): ReadonlyArray<MentionKey> => {
  const out = new Map<string, MentionKey>()
  for (const m of text.matchAll(REF_WORD)) {
    const word = m[0].replace(/[.:-]+$/, "")
    const parsed = KEY_LIKE.exec(word)
    const at = m.index
    if (parsed === null || /[/@#!^\\]/.test(text[at - 1] ?? "") || text[at + m[0].length] === "/") continue
    if (out.has(word)) continue
    const [, qualifier, key, number] = parsed
    out.set(word, { word, qualifier: qualifier ?? null, key: key ?? "", number: number === undefined ? null : Number(number) })
  }
  return [...out.values()]
}

/** A task a key may name: a project's task (kind task), or a scratch task or pens thread in no project (`S-<n>`). */
export type MentionTask = Pick<Task, "id" | "profile_id" | "project_id" | "number" | "title" | "status">

/** What the keys may name: every profile, their projects, and the tasks with the numbers the keys give. */
export interface MentionBoard {
  readonly profiles: ReadonlyArray<Pick<Profile, "id" | "name" | "agent_access">>
  readonly projects: ReadonlyArray<Pick<Project, "id" | "profile_id" | "key" | "name" | "repo_path" | "archived_at">>
  /** A project's task by number (`project_id` set), or a profile's `S-<n>` (`project_id` null). */
  readonly tasks: ReadonlyArray<MentionTask>
}

/** Whether `profile` lets the agents of the profile named `name` in. */
const grants = (profile: Pick<Profile, "name" | "agent_access">, name: string) =>
  profile.name === name || profile.agent_access.some((n) => n === "*" || n === name)

/** What `m` names for an agent of `task`'s profile: a line of the note, or null when it's nothing on its boards. */
const describe = (task: Pick<Task, "id" | "profile_id">, board: MentionBoard, m: MentionKey): string | null => {
  const own = board.profiles.find((p) => p.id === task.profile_id)
  if (own === undefined) return null
  // A key alone is on the profile's own board; another profile's is qualified, and has to let its agents in.
  const on =
    m.qualifier === null ? own : board.profiles.find((p) => (p.name === m.qualifier || p.id === m.qualifier) && (p.id === own.id || grants(p, own.name)))
  if (on === undefined) return null
  const project = board.projects.find((p) => p.profile_id === on.id && p.key === m.key && p.archived_at === null)
  const where = on.id === own.id ? null : on.name
  if (m.number === null) return project !== undefined ? mentionedProject(m.word, project, where) : null
  const t =
    project !== undefined
      ? board.tasks.find((x) => x.project_id === project.id && x.number === m.number)
      : m.key === "S"
        ? board.tasks.find((x) => x.project_id === null && x.profile_id === on.id && x.number === m.number)
        : undefined
  if (t === undefined || t.id === task.id) return null
  return mentionedTask(m.word, t, project?.name ?? null, where)
}

/**
 * The note that follows a prompt whose `text` names projects or tasks by key, or "" when it names none. Keys are read
 * as they're written, whole and in capitals; the task's own key isn't described.
 */
export const mentionsNote = (task: Pick<Task, "id" | "profile_id">, text: string, board: MentionBoard): string =>
  note(
    mentionKeys(text)
      .flatMap((m) => describe(task, board, m) ?? [])
      .slice(0, MOST),
  )
