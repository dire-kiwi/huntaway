import { FolderGit2 } from "lucide-react"
import { useState, type ReactNode } from "react"
import type { HostProfile as Profile, HostProject as Project } from "@huntaway/client"
import { lastValue, placeWords, resolveTokens, type Vocab } from "../taskTokens"
import { useHost } from "../../boardHelpers"
import { SCRATCH_TYPE } from "../../task/documentInfo"
import { draftKey, groupTarget, loadDraft, PROJECT_KEY, scratchTarget } from "./draft"
import type { EditorText } from "./useEditorText"
import { GROUP_WORD, NONE_WORD, typeWord, type NewTaskType } from "./words"
import { useBoard } from "../../../state/board"

/** Where the dialog was opened: NewTaskModal's props of the same names (`group` as `groupName`). */
export interface Opened {
  initial?: Project | undefined
  projects?: ReadonlyArray<Project> | undefined
  groupName?: string | undefined
  scratch?: Profile | null | undefined
}

export type Origin = ReturnType<typeof useOrigin>
export type Where = ReturnType<typeof useWhere>

/** Where the task goes without an `in:`, and the draft kept there. */
export function useOrigin({ initial, projects, groupName, scratch }: Opened) {
  const hosts = useBoard((s) => s.hosts)
  // A group task goes in the first project's profile and host, and remembers its options per group.
  const group = initial ? groupName : undefined
  // Where it goes without an `in:`: the project it's opened in, or no project or the group task, if that was last picked.
  // Once a task is created, where it went is where the next one starts (as it would in a new dialog).
  // It's kept by id, so it's the project as the board has it now (a refresh can find a repository became git's).
  const [base, setBase] = useState(() => ({
    projectId: initial?.id,
    noProject: !!scratch && (!initial || localStorage.getItem(PROJECT_KEY) === scratchTarget(scratch)),
    asGroup: !!group && !!initial && localStorage.getItem(PROJECT_KEY) === groupTarget(initial.host_id, group),
  }))
  const baseProject = (initial?.id === base.projectId ? initial : projects?.find((p) => p.id === base.projectId)) ?? initial
  const basePref =
    base.noProject && scratch
      ? scratchTarget(scratch)
      : base.asGroup && group && baseProject
        ? groupTarget(baseProject.host_id, group)
        : (baseProject?.id ?? "")
  // The draft is kept where the dialog starts, wherever its tokens send the task, so it comes back with them.
  const draft = draftKey(basePref)
  const [saved] = useState(() => loadDraft(draft))
  return { hosts, group, base, setBase, baseProject, draft, saved }
}

/** Where it goes (by an `in:`, or a type that goes elsewhere) and the types it can be there. */
export function useWhere({ projects, scratch }: Opened, { hosts, group, base, baseProject }: Origin, { completing, found }: EditorText) {
  // `in:`: a project by its key (with its host or profile where that's ambiguous, or the key is `none` or `group`), the
  // group task or no project.
  const profiles = useBoard((s) => s.profiles)
  const placeNames = placeWords(
    (projects ?? []).map((p) => ({
      key: p.key,
      host: hosts.find((h) => h.id === p.host_id)?.name ?? p.host_id,
      profile: profiles.find((x) => x.host_id === p.host_id && x.id === p.profile_id)?.name ?? p.profile_id,
    })),
    [GROUP_WORD, NONE_WORD],
  )
  const atVocab = [...placeNames, ...(group ? [GROUP_WORD] : []), ...(scratch ? [NONE_WORD] : [])]
  // An `in:` being typed waits while it could still become another (`in:S` of `in:SD`), so the task doesn't go somewhere
  // else on the way (which can drop its files and Asana tasks); it's taken once it's picked, finished with a space or
  // left, and before Ctrl+Enter creates the task (see submit).
  const typed = completing?.prefix === "in:" ? found.find((t) => t.start === completing.start) : undefined
  const heldBack = typed && atVocab.some((v) => v.length > typed.word.length && v.toLowerCase().startsWith(typed.word.toLowerCase())) ? typed : undefined
  const resolve = (vocab: Vocab) => resolveTokens(heldBack ? found.filter((t) => t !== heldBack) : found, vocab)
  // Meanwhile the task stays where the text last settled (also when the caret only moves into an `in:` already taken,
  // or when the dialog opens with the caret after one), so nothing goes until the `in:` being typed is done.
  const [settled, setSettled] = useState<{ at: string | undefined } | null>(null)
  const at = !heldBack ? lastValue(resolve({ "in:": atVocab }), "in:") : settled ? settled.at : lastValue(resolveTokens(found, { "in:": atVocab }), "in:")
  if (!settled || settled.at !== at) setSettled({ at })
  const atProject = at === undefined ? undefined : projects?.[placeNames.indexOf(at)]
  const project = atProject ?? baseProject
  // What it is: code (null) or a scratch task, whose agent works in its own folder on whatever it's asked (in no
  // project, or in the project). Each is offered where it can go. Labels come on top (see below).
  const projectScratch = !!project
  // The types it can be, by the project's host (or the scratch task's, in no project).
  const typeTabs: { id: NewTaskType; label: string; icon: ReactNode; hint: string }[] = [
    ...(project ? [{ id: null, label: "Task", icon: <FolderGit2 size={12} />, hint: "Its agent works on the code" }] : []),
    ...(scratch || projectScratch ? [SCRATCH_TYPE] : []),
  ]
  const typeOf = (word: string | undefined) => typeTabs.find((t) => typeWord(t.id) === word)
  const typeAsked = typeOf(lastValue(resolve({ "/": typeTabs.map((t) => typeWord(t.id)) }), "/"))?.id
  const asked = typeAsked !== undefined
  // Without an `in:`, a type keeps the task where it is, except that a scratch task starts out in no project when
  // that's offered, and another type in no project, or a scratch task in a group, goes in the project.
  let noProject = at === NONE_WORD
  let asGroup = at === GROUP_WORD
  if (!at) {
    noProject = base.noProject
    asGroup = base.asGroup && !!group
    if (asked && typeAsked === "scratch" && scratch && !noProject) [noProject, asGroup] = [true, false]
    else if (asked && noProject && typeAsked !== "scratch" && project) noProject = false
    else if (asked && asGroup && typeAsked === "scratch") asGroup = false
  }
  noProject = !!scratch && (noProject || !project)
  asGroup = asGroup && !noProject && !!group
  // Where it goes: the project's host and profile, or the scratch task's in no project.
  const target =
    noProject && scratch ? { host_id: scratch.host_id, profile_id: scratch.id } : { host_id: project?.host_id ?? "", profile_id: project?.profile_id ?? "" }
  const host = useHost(target.host_id)
  const prefId = noProject && scratch ? scratchTarget(scratch) : asGroup && group ? groupTarget(target.host_id, group) : (project?.id ?? "")
  // The project it's in, if it's in one.
  const inProject = noProject || asGroup ? undefined : project
  // The types it can be where it goes; one asked for that isn't falls back to the first that is.
  const offered: NewTaskType[] = noProject ? ["scratch"] : asGroup ? [null] : [null, ...(projectScratch ? ["scratch" as const] : [])]
  return { placeNames, atVocab, heldBack, resolve, project, typeTabs, typeOf, noProject, asGroup, target, host, prefId, inProject, offered }
}
