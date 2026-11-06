import { useMemo, useRef, useState } from "react";
import type { GitCommit, GitStash, GitStatus, Turn } from "../../../api";
import { fileRows, type FileRow } from "../diffs";
import type { Side } from "./model";

const TREE_KEY = "ia.changes.tree";

export type GitSelection = ReturnType<typeof useGitSelection>;

/**
 * Where you are in the Changes tab: the panel, whether you've gone into the main one (Enter), and what's selected in
 * each list, by key; one that's gone gives way to the row now where it was. The files are a tree (folders fold) or a
 * flat list, kept in this browser. `turns` are the agent's, oldest first.
 */
export function useGitSelection(status: GitStatus | null, turns: Turn[] | undefined) {
  const [side, setSide] = useState<Side>("files");
  const [inMain, setInMain] = useState(false);
  const [tree, setTree] = useState(() => localStorage.getItem(TREE_KEY) !== "flat");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [fileKey, setFileKey] = useState<string | null>(null);
  const [commitSha, setCommitSha] = useState<string | null>(null);
  const [stashSha, setStashSha] = useState<string | null>(null);
  const [turnN, setTurnN] = useState<number | null>(null);

  const files = useMemo(() => status?.files ?? [], [status]);
  const commits = useMemo(() => status?.commits ?? [], [status]);
  const stashes = useMemo(() => status?.stashes ?? [], [status]);
  const rows = useMemo(() => fileRows(files, tree, collapsed), [files, tree, collapsed]);
  // Newest first.
  const turnList = useMemo(() => [...(turns ?? [])].reverse(), [turns]);

  const lastIdx = useRef({ files: 0, commits: 0, stash: 0, turns: 0 });
  const pick = <T>(list: T[], which: "files" | "commits" | "stash" | "turns", at: (t: T) => boolean) => {
    let i = list.findIndex(at);
    if (i < 0) i = Math.min(lastIdx.current[which], list.length - 1);
    lastIdx.current[which] = Math.max(0, i);
    return i;
  };
  const fileIdx = pick(rows, "files", (r) => r.key === fileKey);
  const fileRow = rows[fileIdx] as FileRow | undefined;
  const commitIdx = pick(commits, "commits", (c) => c.sha === commitSha);
  const commit = commits[commitIdx] as GitCommit | undefined;
  const stashIdx = pick(stashes, "stash", (s) => s.sha === stashSha);
  const stash = stashes[stashIdx] as GitStash | undefined;
  const turnIdx = pick(turnList, "turns", (t) => t.n === turnN);
  const turn = turnList[turnIdx] as Turn | undefined;

  /** Moves the selection in a list. */
  const moveIn = (s: Side, by: number | "first" | "last") => {
    const n = s === "files" ? rows.length : s === "commits" ? commits.length : s === "stash" ? stashes.length : s === "turns" ? turnList.length : 0;
    if (!n) return;
    const at = s === "files" ? fileIdx : s === "commits" ? commitIdx : s === "stash" ? stashIdx : turnIdx;
    const i = by === "first" ? 0 : by === "last" ? n - 1 : Math.max(0, Math.min(n - 1, at + by));
    if (s === "files") setFileKey(rows[i].key);
    else if (s === "commits") setCommitSha(commits[i].sha);
    else if (s === "stash") setStashSha(stashes[i].sha);
    else if (s === "turns") setTurnN(turnList[i].n);
  };
  const setTreeMode = (t: boolean) => {
    setTree(t);
    localStorage.setItem(TREE_KEY, t ? "tree" : "flat");
  };

  return {
    side,
    setSide,
    inMain,
    setInMain,
    tree,
    setTreeMode,
    collapsed,
    setCollapsed,
    files,
    commits,
    stashes,
    rows,
    turnList,
    fileIdx,
    fileRow,
    setFileKey,
    commitIdx,
    commit,
    setCommitSha,
    stashIdx,
    stash,
    setStashSha,
    turnIdx,
    turn,
    setTurnN,
    moveIn,
  };
}
