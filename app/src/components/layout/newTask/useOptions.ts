import { useState } from "react";
import { canRunAgents, worktreesOn, type Task } from "../../../api";
import { ADD_ANOTHER_KEY, startKey } from "./draft";
import type { Tokens } from "./useTokens";
import type { Where } from "./useWhere";

export type Options = ReturnType<typeof useOptions>;

/** The dialog's toggles: its own worktree, starting its agent now (remembered where it goes) and "Add another". */
export function useOptions({ host, inProject, prefId }: Where, { codeTask, fanout, asSubproject }: Tokens, subproject: Task | undefined) {
  const agents = canRunAgents(host);
  // Follows the project until it's changed here.
  const [worktreeChoice, setWorktree] = useState<boolean | null>(null);
  const worktreePref = worktreeChoice ?? (!!inProject && worktreesOn(inProject));
  // Tasks made from one prompt each get a worktree too, so their agents don't change the same checkout (as in t3code).
  const worktree = !!inProject && codeTask && (worktreePref || fanout || asSubproject || !!subproject);
  const [startPref, setStartPref] = useState(() => localStorage.getItem(startKey(prefId)) === "1");
  const start = agents && startPref;
  const setStart = (v: boolean) => {
    setStartPref(v);
    localStorage.setItem(startKey(prefId), v ? "1" : "0");
  };
  const [addAnother, setAddAnother] = useState(() => localStorage.getItem(ADD_ANOTHER_KEY) === "1");
  const changeAddAnother = (v: boolean) => {
    setAddAnother(v);
    localStorage.setItem(ADD_ANOTHER_KEY, v ? "1" : "0");
  };
  return { agents, setWorktree, worktree, setStartPref, start, setStart, addAnother, changeAddAnother };
}
