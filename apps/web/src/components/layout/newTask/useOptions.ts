import { useState } from "react"
import { canRunAgents, worktreesOn, type HostProject as Project } from "@huntaway/client"
import { useShallow } from "../../boardHelpers"
import { useBoard } from "../../../state/board"
import { ADD_ANOTHER_KEY, startKey } from "./draft"
import type { Tokens } from "./useTokens"
import type { Where } from "./useWhere"

export type Options = ReturnType<typeof useOptions>

/** How many other projects a set across repositories takes (the server's `SET_OTHERS_MAX`). */
export const ALSO_IN_MAX = 7

/**
 * The dialog's toggles: its own worktree, starting its agent now (remembered where it goes) and "Add another"; and the
 * other projects it's made in too, as a set (HE-120), with the title the set needs.
 */
export function useOptions({ host, inProject, prefId }: Where, { codeTask, fanout, startFrom, mergesInto }: Tokens) {
  const agents = canRunAgents(host)
  // Follows the project until it's changed here.
  const [worktreeChoice, setWorktree] = useState<boolean | null>(null)
  const worktreePref = worktreeChoice ?? (!!inProject && worktreesOn(inProject))
  // Tasks made from one prompt each get a worktree too, so their agents don't change the same checkout (as in t3code).
  // And so does one that starts from somewhere, or merges into another task.
  const worktree = !!inProject && codeTask && (worktreePref || fanout || startFrom !== undefined || !!mergesInto)
  const [startPref, setStartPref] = useState(() => localStorage.getItem(startKey(prefId)) === "1")
  const start = agents && startPref
  const setStart = (v: boolean) => {
    setStartPref(v)
    localStorage.setItem(startKey(prefId), v ? "1" : "0")
  }
  const [addAnother, setAddAnother] = useState(() => localStorage.getItem(ADD_ANOTHER_KEY) === "1")
  const changeAddAnother = (v: boolean) => {
    setAddAnother(v)
    localStorage.setItem(ADD_ANOTHER_KEY, v ? "1" : "0")
  }
  // A set across repositories (HE-117): a code task with a worktree, starting from its project's base and merging into
  // it, made in other projects of its profile (on its host) whose tasks get worktrees too. Not one made with several
  // models, which would make a set for each.
  const setOk = !!inProject && codeTask && worktree && !fanout && startFrom === undefined && !mergesInto
  const setProjects: ReadonlyArray<Project> = useBoard(
    useShallow((s) =>
      setOk && inProject
        ? s.projects.filter((p) => p.host_id === inProject.host_id && p.profile_id === inProject.profile_id && p.id !== inProject.id && worktreesOn(p))
        : [],
    ),
  )
  const [alsoInPicked, setAlsoIn] = useState<ReadonlyArray<string>>([])
  // Cleared once it can't be a set (a `from:` or an `into:`, a scratch task, no worktree), and of a project it can't take
  // (the one it moved to), so taking that out again doesn't bring them back.
  const alsoIn = alsoInPicked.filter((id) => setProjects.some((p) => p.id === id))
  if (alsoIn.length !== alsoInPicked.length) setAlsoIn(alsoIn)
  const toggleAlsoIn = (id: string) => setAlsoIn((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : ids.length < ALSO_IN_MAX ? [...ids, id] : ids))
  // A set's tasks, branch and pen are named after it, so it's given here rather than written later from the description.
  const [alsoInTitle, setAlsoInTitle] = useState("")
  // The list of projects to pick from, opened from the options row; it stays open while some are picked.
  const [alsoInOpen, setAlsoInOpen] = useState(false)
  return {
    agents,
    setWorktree,
    worktree,
    setStartPref,
    start,
    setStart,
    addAnother,
    changeAddAnother,
    setProjects,
    alsoIn,
    setAlsoIn,
    toggleAlsoIn,
    alsoInTitle,
    setAlsoInTitle,
    alsoInOpen: setProjects.length > 0 && (alsoInOpen || alsoIn.length > 0),
    setAlsoInOpen,
  }
}
