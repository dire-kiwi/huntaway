import { useEffect, useMemo, useState } from "react";
import { api, type DiffResult, type GitCommitShown, type GitStatus, type TurnDiff } from "../../../api";
import { parseDiff } from "../diffs";
import type { CommentSource } from "../lineComments";
import type { GitSelection } from "./useGitSelection";
import { errText, short } from "./model";

export type ShownDiffs = ReturnType<typeof useShownDiffs>;

/**
 * What the main panel shows for the panel you're in, other than a file's: the branch's changes against its base (the
 * Status panel's, fetched again when the status changes or a check is asked for, `askedTick`), a turn's, or a
 * commit's or stash's.
 */
export function useShownDiffs(h: string, id: string, sel: GitSelection, status: GitStatus | null, askedTick: number) {
  const { side, turn, commit, stash } = sel;
  const [branch, setBranch] = useState<DiffResult | null>(null);
  useEffect(() => {
    if (side !== "status") return;
    let stale = false;
    api
      .diff(h, id)
      // The same diff (most checks): the same object, so what's picked in it stays.
      .then((d) => !stale && setBranch((p) => (JSON.stringify(p) === JSON.stringify(d) ? p : d)))
      .catch((e) => !stale && setBranch({ available: false, reason: errText(e) }));
    return () => {
      stale = true;
    };
  }, [side, status, askedTick, h, id]);
  // A turn's changes.
  const [turnShown, setTurnShown] = useState<{ key: string; diff?: TurnDiff; error?: string } | null>(null);
  const turnKey = side === "turns" && turn?.diff && turn.before_n !== null ? `${turn.before_n}:${turn.n}` : null;
  useEffect(() => {
    if (!turnKey) return;
    let stale = false;
    const [from, to] = turnKey.split(":").map(Number);
    api
      .turnDiff(h, id, from, to)
      .then((diff) => !stale && setTurnShown({ key: turnKey, diff }))
      .catch((e) => !stale && setTurnShown({ key: turnKey, error: errText(e) }));
    return () => {
      stale = true;
    };
  }, [turnKey, h, id]);
  const [shown, setShown] = useState<{ sha: string; commit?: GitCommitShown; patch?: string; error?: string } | null>(null);
  const showSha = side === "commits" ? commit?.sha : side === "stash" ? stash?.sha : undefined;
  const shownFiles = useMemo(() => parseDiff(shown?.patch ?? ""), [shown]);
  const stashIndex = side === "stash" ? stash?.index : undefined;
  const shownSource = useMemo<CommentSource | undefined>(
    () => (!shown ? undefined : stashIndex !== undefined ? { key: `stash:${shown.sha}`, label: `stash@{${stashIndex}}` } : { key: `commit:${shown.sha}`, label: `commit ${short(shown.sha)}` }),
    [shown, stashIndex],
  );
  useEffect(() => {
    if (!showSha) return;
    let stale = false;
    const load: Promise<{ patch: string; message?: string }> = side === "stash" ? api.gitShowStash(h, id, showSha) : api.gitShow(h, id, showSha);
    load
      .then((r) => !stale && setShown({ sha: showSha, commit: "message" in r ? (r as GitCommitShown) : undefined, patch: r.patch }))
      .catch((e) => !stale && setShown({ sha: showSha, error: errText(e) }));
    return () => {
      stale = true;
    };
  }, [showSha, side, h, id]);
  return {
    branch,
    /** The selected turn's changes, once they've come. */
    turnShown: turnShown?.key === turnKey ? turnShown : null,
    /** The selected commit's or stash's, once they've come. */
    shown: shown && shown.sha === showSha ? shown : null,
    shownFiles,
    shownSource,
  };
}
