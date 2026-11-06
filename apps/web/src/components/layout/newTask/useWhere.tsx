import { FolderGit2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, hostSupports, worktreesOn, type Profile, type Project, type Task } from "../../../api";
import { lastValue, placeWords, resolveTokens, type Vocab } from "../taskTokens";
import { useHost, useStore } from "../../../store";
import { SCRATCH_TYPE } from "../../task/Document";
import { draftKey, groupTarget, loadDraft, PROJECT_KEY, scratchTarget } from "./draft";
import type { EditorText } from "./useEditorText";
import { GROUP_WORD, NONE_WORD, SUBPROJECT_TYPE, typeWord, type NewTaskType } from "./words";

/** Where the dialog was opened: NewTaskModal's props of the same names (`group` as `groupName`). */
export interface Opened {
  initial?: Project;
  projects?: Project[];
  subproject?: Task;
  groupName?: string;
  scratch?: Profile | null;
}

export type Origin = ReturnType<typeof useOrigin>;
export type Where = ReturnType<typeof useWhere>;

/** Where the task goes without an `@`, and the draft kept there. */
export function useOrigin({ initial, projects, subproject, groupName, scratch }: Opened) {
  const hosts = useStore((s) => s.hosts);
  const initialHost = useHost(initial?.host_id);
  // A group task goes in the first project's profile and host, and remembers its options per group.
  const group = !!initial && !subproject && hostSupports(initialHost, 34) ? groupName : undefined;
  // Where it goes without an `@`: the project it's opened in, or no project or the group task, if that was last picked.
  // Once a task is created, where it went is where the next one starts (as it would in a new dialog).
  // It's kept by id, so it's the project as the board has it now (a refresh can find a repository became git's).
  const [base, setBase] = useState(() => ({
    projectId: initial?.id,
    noProject: !!scratch && (!initial || localStorage.getItem(PROJECT_KEY) === scratchTarget(scratch)),
    asGroup: !!group && !!initial && localStorage.getItem(PROJECT_KEY) === groupTarget(initial.host_id, group),
  }));
  const baseProject = (initial?.id === base.projectId ? initial : projects?.find((p) => p.id === base.projectId)) ?? initial;
  const basePref = base.noProject && scratch ? scratchTarget(scratch) : base.asGroup && group ? groupTarget(baseProject!.host_id, group) : baseProject!.id;
  // The draft is kept where the dialog starts, wherever its tokens send the task, so it comes back with them.
  const draft = draftKey(basePref, subproject?.id);
  const [saved] = useState(() => loadDraft(draft));
  return { hosts, group, base, setBase, baseProject, draft, saved };
}

/** Where it goes (by an `@`, or a type that goes elsewhere) and the types it can be there. */
export function useWhere({ projects, subproject, scratch }: Opened, { hosts, group, base, baseProject }: Origin, { completing, found }: EditorText) {
  // `@`: a project by its key (with its host or profile where that's ambiguous, or the key is `none` or `group`), the
  // group task or no project. A subproject's task stays in it.
  const profiles = useStore((s) => s.profiles);
  const placeNames = subproject
    ? []
    : placeWords(
        (projects ?? []).map((p) => ({
          key: p.key,
          host: hosts.find((h) => h.id === p.host_id)?.name ?? p.host_id,
          profile: profiles.find((x) => x.host_id === p.host_id && x.id === p.profile_id)?.name ?? p.profile_id,
        })),
        [GROUP_WORD, NONE_WORD],
      );
  const atVocab = subproject ? [] : [...placeNames, ...(group ? [GROUP_WORD] : []), ...(scratch ? [NONE_WORD] : [])];
  // An `@` being typed waits while it could still become another (`@S` of `@SD`), so the task doesn't go somewhere
  // else on the way (which can drop its files and Asana tasks); it's taken once it's picked, finished with a space or
  // left, and before Ctrl+Enter creates the task (see submit).
  const typed = completing?.prefix === "@" ? found.find((t) => t.start === completing.start) : undefined;
  const heldBack = typed && atVocab.some((v) => v.length > typed.word.length && v.toLowerCase().startsWith(typed.word.toLowerCase())) ? typed : undefined;
  const resolve = (vocab: Vocab) => resolveTokens(heldBack ? found.filter((t) => t !== heldBack) : found, vocab);
  // Meanwhile the task stays where the text last settled (also when the caret only moves into an `@` already taken,
  // or when the dialog opens with the caret after one), so nothing goes until the `@` being typed is done.
  const settledAt = useRef<{ at: string | undefined } | null>(null);
  if (!heldBack) settledAt.current = { at: lastValue(resolve({ "@": atVocab }), "@") };
  else settledAt.current ??= { at: lastValue(resolveTokens(found, { "@": atVocab }), "@") };
  const at = settledAt.current.at;
  const atProject = at === undefined ? undefined : projects?.[placeNames.indexOf(at)];
  const project = atProject ?? baseProject;
  // The project's host decides which types it offers, while the task is in no project too.
  const projectHost = useHost(project?.host_id);
  // What it is: code (null); a subproject, with its own board of tasks (API 17); or a scratch task, whose agent
  // works in its own folder on whatever it's asked (in no project, API 47, or in the project, API 51). Each is offered
  // where it can go. Labels come on top (see below).
  const canSubproject = !subproject && !!project && hostSupports(projectHost, 17) && worktreesOn(project);
  const projectScratch = !!project && hostSupports(projectHost, 51);
  // The types it can be, by the project's host (or the scratch task's, in no project).
  const typeTabs: { id: NewTaskType; label: string; icon: ReactNode; hint: string }[] = [
    ...(project ? [{ id: null, label: "Task", icon: <FolderGit2 size={12} />, hint: "Its agent works on the code" }] : []),
    ...(canSubproject ? [SUBPROJECT_TYPE] : []),
    ...(scratch || projectScratch ? [SCRATCH_TYPE] : []),
  ];
  const typeOf = (word: string | undefined) => typeTabs.find((t) => typeWord(t.id) === word);
  const typeAsked = typeOf(lastValue(resolve({ "/": typeTabs.map((t) => typeWord(t.id)) }), "/"))?.id;
  const asked = typeAsked !== undefined;
  // Without an `@`, a type keeps the task where it is, except that a scratch task starts out in no project when
  // that's offered, and another type in no project, or a scratch task or subproject in a group, goes in the project.
  let noProject = at === NONE_WORD;
  let asGroup = at === GROUP_WORD;
  if (!at) {
    noProject = base.noProject;
    asGroup = base.asGroup && !!group;
    if (asked && typeAsked === "scratch" && scratch && !noProject) [noProject, asGroup] = [true, false];
    else if (asked && noProject && typeAsked !== "scratch" && project) noProject = false;
    else if (asked && asGroup && (typeAsked === "scratch" || typeAsked === "subproject")) asGroup = false;
  }
  noProject = !!scratch && (noProject || !project);
  asGroup = asGroup && !noProject && !!group;
  // Where it goes: the project's host and profile, or the scratch task's in no project.
  const target = noProject ? { host_id: scratch!.host_id, profile_id: scratch!.id } : { host_id: project!.host_id, profile_id: project!.profile_id };
  const host = useHost(target.host_id);
  const prefId = noProject ? scratchTarget(scratch!) : asGroup ? groupTarget(target.host_id, group!) : project!.id;
  // The project it's in, if it's in one.
  const inProject = noProject || asGroup ? undefined : project;
  // The types it can be where it goes; one asked for that isn't falls back to the first that is.
  const offered: NewTaskType[] = noProject
    ? ["scratch"]
    : asGroup
      ? [null]
      : [null, ...(canSubproject ? ["subproject" as const] : []), ...(projectScratch ? ["scratch" as const] : [])];
  return { placeNames, atVocab, heldBack, resolve, project, typeTabs, typeOf, noProject, asGroup, target, host, prefId, inProject, offered };
}

/**
 * Whether the repo is a git repository can have changed since the board loaded the project
 * (an agent may have run `git init`), and it decides whether new tasks get a worktree.
 */
export function useProjectRefresh(project: Project | undefined) {
  useEffect(() => {
    if (!project) return;
    api
      .getProject(project.host_id, project.id)
      .then((p) => useStore.getState().upsertProject({ ...p, host_id: project.host_id }))
      .catch(() => {});
  }, [project?.host_id, project?.id]);
}
